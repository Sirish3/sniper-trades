// 52-week-high ENTRY FILTER — a scoring model (0-24, graded A/B/C/D), layered
// ON TOP of (not replacing) the existing grade/signalType/tradePlan pipeline
// in weekHighScreener.js and positionPlan.js. Previously a 0-20 model without
// a market-stage dimension; REPLACED (not extended) on explicit user
// iteration to add Wyckoff/Weinstein-style stage classification and drop the
// serial-high check out of the hard-filter gate into a graduated scored
// factor instead of a binary one.
//
// Two-stage design:
//   STEP 2 hard filters (A-C) — eligibility only, all-or-nothing. A stock
//   failing any of these is dropped entirely: no score, not ranked, not
//   sized, not even market-staged. Missing data here does NOT default to a
//   neutral/passing value — you can't call something "confirmed liquid
//   enough" or "confirmed MACD-bullish" off data you don't have.
//   STEP 3 market stage — a best-effort ACCUMULATION/MARKUP/DISTRIBUTION/
//   DECLINE/UNCLEAR read, reusing existing indicators (Alligator phase, base
//   quality, 3-month return, ADX, MACD histogram direction) rather than
//   inventing new ones. Scored 0-2, ADDED SEPARATELY from the 11 factors
//   below (not one of them) — see gradeForScore.
//   STEP 4 scored factors (1-11) — only computed for stocks that cleared
//   the hard filters. Each factor is 0/1/2; missing data defaults to 1
//   (neutral) rather than 0 or 2, so an unknown never silently becomes the
//   best or worst possible reading for that factor.
//
// Kept deliberately separate from weekHighScreener.js's own A+/A/B/C
// gradeWeekHighSetup() — that's a different, pre-existing, mostly-continuous
// quality score already wired into signal classification. This module's
// grade is shown as "Entry Score" specifically to avoid being read as the
// same letter grade.

import { checkMarketRegime } from './marketRegime'
import { checkSectorRegimes } from './sectorRegime'

export const HARD_PCT_FROM_HIGH_MIN = -2
export const HARD_PCT_FROM_HIGH_MAX = 0
export const HARD_LIQUIDITY_FLOOR_USD = 15_000_000
export const EARNINGS_AVOID_TRADING_DAYS = 5

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// ── Regime — computed once per scan, reused as STEP 4 factor 11 ─────────
export async function fetchEntryFilterRegime() {
  const [marketResult, sectorResult] = await Promise.allSettled([
    checkMarketRegime(),
    checkSectorRegimes(),
  ])

  const marketAbove50 = marketResult.status === 'fulfilled' ? marketResult.value.spyAbove50 : null
  const sectorBySector = sectorResult.status === 'fulfilled' ? sectorResult.value.bySector : {}
  const warnings = []
  if (marketResult.status === 'rejected') warnings.push(`Market regime check failed: ${marketResult.reason?.message ?? 'unknown error'}`)
  if (sectorResult.status === 'fulfilled') warnings.push(...(sectorResult.value.warnings ?? []))
  else warnings.push('Sector regime check failed')

  return { marketAbove50, sectorBySector, warnings }
}

// FAVORABLE (both above 50MA), UNFAVORABLE (both below), MIXED (split, or
// either side unknown — unknown is treated as "not confirmed bad" rather
// than penalized to UNFAVORABLE outright).
function classifyRegimeFit(sector, regime) {
  const marketAbove50 = regime.marketAbove50
  const sectorAbove50 = regime.sectorBySector?.[sector]?.above50 ?? null
  const marketOk = marketAbove50 !== false
  const sectorOk = sectorAbove50 !== false
  let fit
  if (marketAbove50 === false && sectorAbove50 === false) fit = 'UNFAVORABLE'
  else if (marketOk && sectorOk && marketAbove50 != null && sectorAbove50 != null) fit = 'FAVORABLE'
  else fit = 'MIXED'
  return { fit, marketAbove50, sectorAbove50 }
}

// ── STEP 2: hard filters — eligibility gate, not scored ─────────────────
function evaluateHardFilters(r) {
  const failures = []

  if (r.pctFromHigh == null || r.pctFromHigh < HARD_PCT_FROM_HIGH_MIN || r.pctFromHigh > HARD_PCT_FROM_HIGH_MAX) {
    failures.push(`A: not within 2% of 52W high (${r.pctFromHigh != null ? r.pctFromHigh.toFixed(1) + '%' : 'unknown'})`)
  }
  if (r.macdPosture !== 'BULLISH') {
    failures.push(`B: MACD not confirmed bullish (${r.macdPosture ?? 'unknown'})`)
  }
  if (!r.emaFullStack) {
    failures.push('B: EMA stack not bullish (need 10>20>50)')
  }
  if (r.avgDollarVolume20 == null || r.avgDollarVolume20 < HARD_LIQUIDITY_FLOOR_USD) {
    failures.push(`C: liquidity below $15M/day (${r.avgDollarVolume20 != null ? '$' + (r.avgDollarVolume20 / 1e6).toFixed(1) + 'M' : 'unknown'})`)
  }

  return { eligible: failures.length === 0, failures }
}

// ── STEP 3: market stage — best-effort Wyckoff/Weinstein-style read ─────
// Reuses existing indicators rather than inventing new ones:
//   - alligatorPhase (indicators.js): SLEEPING/WAKING/EATING_UP/EATING_DOWN,
//     already this app's trend-phase classifier.
//   - peakAge + baseQuality: was there a real base immediately before a
//     FRESH breakout (peakAge <= 2), i.e. "basing then confirming," vs. an
//     already-running trend making another new high.
//   - ret3m + adxValue + macdHistDirection: distinguishes an established,
//     still-strengthening trend (MARKUP) from one that's stretched and
//     rolling over despite still being near highs (DISTRIBUTION).
// A stock reaching this point has already passed the hard filters (near
// 52W high, EMA/MACD bullish), so DECLINE should be structurally
// unreachable except via the Alligator's own lagging EATING_DOWN read —
// the spec's own "should already be caught by Step 2, but double-check."
function classifyMarketStage(r) {
  if (!r.emaFullStack || r.macdPosture !== 'BULLISH' || r.alligatorPhase === 'EATING_DOWN') {
    return 'DECLINE'
  }

  const freshBreakout = r.peakAge != null && r.peakAge <= 2
  const hasPriorBase = r.baseQuality != null
  if (freshBreakout && hasPriorBase && r.alligatorPhase !== 'EATING_UP') {
    return 'ACCUMULATION' // basing, then this move IS the breakout confirmation
  }

  if (r.alligatorPhase === 'EATING_UP' && r.ret3m != null && r.ret3m > 0) {
    return 'MARKUP' // established, still-widening uptrend
  }

  if (r.adxValue != null && r.adxValue < 20 && r.macdHistDirection === 'FALLING') {
    return 'DISTRIBUTION' // near highs but trend strength fading / momentum rolling over
  }

  return 'UNCLEAR'
}

const STAGE_SCORE = { MARKUP: 2, ACCUMULATION: 2, UNCLEAR: 1, DISTRIBUTION: 0, DECLINE: 0 }

// ── STEP 4: scored factors, 0-2 each, missing data -> neutral 1 ─────────
function factor(n, label, points, detail) {
  return { n, label, points, detail }
}

function evaluateScoredFactors(r, regimeFit) {
  const factors = []

  factors.push(
    r.newHighCountIn3Months == null
      ? factor(1, 'First-time 52W high in 3mo', 1, 'Unknown (neutral)')
      : r.newHighCountIn3Months === 0
        ? factor(1, 'First-time 52W high in 3mo', 2, 'First-time')
        : r.newHighCountIn3Months <= 2
          ? factor(1, 'First-time 52W high in 3mo', 1, `${r.newHighCountIn3Months} prior highs in 3mo`)
          : factor(1, 'First-time 52W high in 3mo', 0, `${r.newHighCountIn3Months} prior highs in 3mo — serial`)
  )

  factors.push(
    r.volRatio50AtBreakout == null
      ? factor(2, 'Breakout-day volume vs 50d avg', 1, 'Unknown (neutral)')
      : r.volRatio50AtBreakout >= 1.5
        ? factor(2, 'Breakout-day volume vs 50d avg', 2, `${r.volRatio50AtBreakout.toFixed(2)}x`)
        : r.volRatio50AtBreakout >= 1.0
          ? factor(2, 'Breakout-day volume vs 50d avg', 1, `${r.volRatio50AtBreakout.toFixed(2)}x`)
          : factor(2, 'Breakout-day volume vs 50d avg', 0, `${r.volRatio50AtBreakout.toFixed(2)}x`)
  )

  factors.push(
    r.baseQuality == null
      ? factor(3, 'Base quality (6-8wk, <20% range)', 1, 'Unknown (neutral)')
      : r.baseQuality.tight
        ? factor(3, 'Base quality (6-8wk, <20% range)', 2, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range`)
        : r.baseQuality.rangePct <= 30
          ? factor(3, 'Base quality (6-8wk, <20% range)', 1, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range — moderate`)
          : factor(3, 'Base quality (6-8wk, <20% range)', 0, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range — poor`)
  )

  // isAllTimeHigh is always null — Alpaca's free-tier history (~13 months)
  // can never confirm ATH status either way (see weekHighScreener.js). The
  // spec's own scale never scores this 0 (ATH=2, not-ATH=1), so rather than
  // invent a guess, this always awards the more conservative "not ATH" (1)
  // score — never the unverified ATH bonus.
  factors.push(factor(4, 'ATH vs. just 52W high', 1, "Can't be determined from this app's ~13mo history — scored as not-ATH"))

  factors.push(
    r.breakoutGapPct == null
      ? factor(5, 'Gap on breakout day', 1, 'Unknown (neutral)')
      : r.breakoutGapPct < 5
        ? factor(5, 'Gap on breakout day', 2, `${r.breakoutGapPct >= 0 ? '+' : ''}${r.breakoutGapPct.toFixed(1)}%`)
        : r.breakoutGapPct <= 10
          ? factor(5, 'Gap on breakout day', 1, `+${r.breakoutGapPct.toFixed(1)}%`)
          : factor(5, 'Gap on breakout day', 0, `+${r.breakoutGapPct.toFixed(1)}%`)
  )

  // Spec: 55-72=2, 72-80=1, >80 or <50=0 — leaving 50-55 unstated; grouped
  // with "<50" (0) since it's still below the 55 "trending" floor.
  factors.push(
    r.rsiValue == null
      ? factor(6, 'RSI', 1, 'Unknown (neutral)')
      : r.rsiValue >= 55 && r.rsiValue <= 72
        ? factor(6, 'RSI', 2, r.rsiValue.toFixed(0))
        : r.rsiValue > 72 && r.rsiValue <= 80
          ? factor(6, 'RSI', 1, r.rsiValue.toFixed(0))
          : factor(6, 'RSI', 0, r.rsiValue.toFixed(0))
  )

  factors.push(
    r.extensionFrom50EmaPct == null
      ? factor(7, 'Extension from 50 EMA', 1, 'Unknown (neutral)')
      : r.extensionFrom50EmaPct < 15
        ? factor(7, 'Extension from 50 EMA', 2, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
        : r.extensionFrom50EmaPct <= 25
          ? factor(7, 'Extension from 50 EMA', 1, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
          : factor(7, 'Extension from 50 EMA', 0, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
  )

  factors.push(
    r.adxValue == null
      ? factor(8, 'ADX', 1, 'Unknown (neutral)')
      : r.adxValue >= 25
        ? factor(8, 'ADX', 2, r.adxValue.toFixed(0))
        : r.adxValue >= 20
          ? factor(8, 'ADX', 1, r.adxValue.toFixed(0))
          : factor(8, 'ADX', 0, r.adxValue.toFixed(0))
  )

  factors.push(
    r.rsRank == null
      ? factor(9, 'RS Rank', 1, 'Unknown (neutral)')
      : r.rsRank >= 85
        ? factor(9, 'RS Rank', 2, r.rsRank)
        : r.rsRank >= 70
          ? factor(9, 'RS Rank', 1, r.rsRank)
          : factor(9, 'RS Rank', 0, r.rsRank)
  )

  factors.push(
    r.earningsDaysAway != null && r.earningsDaysAway <= EARNINGS_AVOID_TRADING_DAYS
      ? factor(10, 'Earnings within 5 trading days', 0, `Earnings in ${r.earningsDaysAway}d`)
      : factor(10, 'Earnings within 5 trading days', 2, r.earningsDaysAway != null ? `Earnings in ${r.earningsDaysAway}d` : 'None known')
  )

  factors.push(
    factor(11, 'Regime fit', regimeFit.fit === 'FAVORABLE' ? 2 : regimeFit.fit === 'MIXED' ? 1 : 0, regimeFit.fit)
  )

  return factors
}

function gradeForScore(score) {
  if (score >= 19) return 'A'
  if (score >= 13) return 'B'
  if (score >= 7) return 'C'
  return 'D'
}

// Top/bottom-scoring factors as short strength/weakness labels — labels
// only, not raw values, since the raw indicator values are already shown
// once in the card's main stat grid; repeating "RSI: 65" here too is
// exactly the redundancy this output format is meant to avoid.
function summarizeFactors(factors) {
  const sorted = [...factors].sort((a, b) => b.points - a.points)
  const strengths = sorted.filter((f) => f.points === 2).slice(0, 3).map((f) => f.label)
  const weaknesses = [...sorted].reverse().filter((f) => f.points === 0).slice(0, 3).map((f) => f.label)
  return { strengths, weaknesses }
}

// Unresolved/UNKNOWN items only (per spec: "omit this line entirely if
// nothing to flag") — genuinely missing data this app couldn't verify,
// distinct from factors that scored poorly on real data.
function collectWatchOuts(r, factors, stage) {
  const watchOuts = []
  if (factors.some((f) => f.n === 1 && f.detail === 'Unknown (neutral)')) watchOuts.push('serial-high history unverified')
  if (factors.some((f) => f.n === 3 && f.detail === 'Unknown (neutral)')) watchOuts.push('base quality unverified')
  if (r.earningsDaysAway == null) watchOuts.push('earnings date unverified')
  if (stage === 'UNCLEAR') watchOuts.push('market stage unclear from available data')
  return watchOuts
}

// One-sentence deterministic risk note, built from whichever real
// (non-neutral) factor scored lowest — same "no invented figures, derived
// only from already-computed numbers" approach as weekHighScreener.js's
// generateThesis.
function buildKeyRisk(factors, stage) {
  if (stage === 'DISTRIBUTION') return 'Momentum is diverging while price holds near highs — a classic distribution warning.'
  const realZeroes = factors.filter((f) => f.points === 0 && f.detail !== 'Unknown (neutral)')
  if (realZeroes.length === 0) return 'No single factor stands out as a clear weakness — risk is broadly average for this setup.'
  const worst = realZeroes[0]
  return `${worst.label} is the weakest confirmed factor (${worst.detail}) — the setup depends on this improving or being tolerated.`
}

export function evaluateEntryFilter(r, regime) {
  const hard = evaluateHardFilters(r)
  if (!hard.eligible) {
    return { eligible: false, failures: hard.failures }
  }

  const stage = classifyMarketStage(r)
  const stageScore = STAGE_SCORE[stage]
  const regimeFit = classifyRegimeFit(r.sector, regime)
  const factors = evaluateScoredFactors(r, regimeFit)
  const factorScore = factors.reduce((sum, f) => sum + f.points, 0)
  const score = factorScore + stageScore
  const grade = gradeForScore(score)
  const { strengths, weaknesses } = summarizeFactors(factors)
  const watchOuts = collectWatchOuts(r, factors, stage)
  const keyRisk = buildKeyRisk(factors, stage)

  return { eligible: true, score, grade, stage, stageScore, factors, regimeFit, strengths, weaknesses, watchOuts, keyRisk }
}

// Attaches `entryFilter` to every result in place — call after
// classifyWeekHighResults (needs rsRank already computed) and after
// fetchEntryFilterRegime (one regime fetch shared across the whole scan).
export function attachEntryFilters(results, regime) {
  for (const r of results) {
    r.entryFilter = evaluateEntryFilter(r, regime)
  }
}

// Risk % is grade-driven — regime's effect on sizing is already baked into
// the score (factor 11) and therefore the grade, so it isn't applied twice.
const RISK_PCT_BY_GRADE = { A: 0.01, B: 0.01, C: 0.005, D: 0 }

// ── Additive simple stop/size calculator (literal spec formula) ────────────
// Deliberately NOT a replacement for positionPlan.js's selectStop/
// sizePosition (tightest-of-4-stops, risk-environment-scaled, portfolio/
// sector caps) — that engine is the one actually wired into "Build Trade
// Plans" / trims / thesis generation elsewhere in this app. This is a
// separate, explicitly-labeled quick-reference number: stop = max(5%,
// 1.5xATR) below entry (the wider/lower of the two prices), sized at the
// grade-driven risk% above.
export function computeSimpleTradePlan(r, accountSize) {
  const grade = r.entryFilter?.eligible ? r.entryFilter.grade : null
  if (grade === 'D' || grade == null) {
    return { viable: false, reason: grade === 'D' ? 'Grade D — skip despite passing hard filters' : 'Not eligible' }
  }
  if (r.price == null || r.atr14 == null) {
    return { viable: false, reason: 'Missing price or ATR data' }
  }

  const atrStopPrice = r.price - 1.5 * r.atr14
  const fixedStopPrice = r.price * 0.95
  // "max(5%, 1.5xATR) below entry" = the wider distance = the LOWER price.
  const stopPrice = Math.min(atrStopPrice, fixedStopPrice)
  const stopMethod = atrStopPrice <= fixedStopPrice ? '1.5x ATR' : '5% fixed'

  const riskPerShare = r.price - stopPrice
  if (riskPerShare <= 0) return { viable: false, reason: 'Stop is not below entry' }

  const riskPct = RISK_PCT_BY_GRADE[grade]
  const riskBudget = accountSize * riskPct
  const shares = Math.floor(riskBudget / riskPerShare)
  if (shares <= 0) return { viable: false, reason: 'Position size rounds to 0 shares' }

  const dollarRisk = shares * riskPerShare

  return {
    viable: true,
    entryPrice: round(r.price),
    atrStopPrice: round(atrStopPrice),
    fixedStopPrice: round(fixedStopPrice),
    stopPrice: round(stopPrice),
    stopMethod,
    riskPct: round((riskPerShare / r.price) * 100),
    accountRiskPct: round(riskPct * 100, 2),
    shares,
    dollarRisk: round(dollarRisk),
    dollarRiskPct: round((dollarRisk / accountSize) * 100, 2),
  }
}
