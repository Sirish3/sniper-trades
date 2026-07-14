// 52-week-high ENTRY FILTER — a scoring model (0-20, graded A/B/C/D), layered
// ON TOP of (not replacing) the existing grade/signalType/tradePlan pipeline
// in weekHighScreener.js and positionPlan.js. This module previously
// implemented a strict 14-rule PASS/CAUTION/FAIL gate; that was REPLACED
// (not extended) by this scoring model on explicit user feedback — a single
// missed rule shouldn't eliminate an otherwise-strong setup the way a hard
// gate does, so quality is now ranked continuously instead.
//
// Two-stage design:
//   STEP 2 hard filters (A-D) — eligibility only, all-or-nothing. A stock
//   failing any of these is dropped entirely: no score, not ranked, not
//   sized. Unlike every other check in this module, missing data here does
//   NOT default to a neutral/passing value (except rule B, which the spec
//   explicitly calls out) — you can't call something "confirmed liquid
//   enough" or "confirmed MACD-bullish" off data you don't have.
//   STEP 3 scored factors (1-10) — only computed for stocks that cleared
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
export const HARD_LIQUIDITY_FLOOR_USD = 20_000_000
export const EARNINGS_AVOID_TRADING_DAYS = 5

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// ── STEP 1: market/sector regime — context now, folded into score as
// factor 10 below, and drives position sizing indirectly via the resulting
// grade (not a separate halving step) ─────────────────────────────────────
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
  // B explicitly treats undeterminable as PASS per spec — null never fails this.
  if (r.firstNewHighIn3Months === false) {
    failures.push('B: repeated/serial new-high maker')
  }
  if (r.macdPosture !== 'BULLISH') {
    failures.push(`C: MACD not confirmed bullish (${r.macdPosture ?? 'unknown'})`)
  }
  if (!r.emaFullStack) {
    failures.push('C: EMA stack not bullish (need 10>20>50)')
  }
  if (r.avgDollarVolume20 == null || r.avgDollarVolume20 < HARD_LIQUIDITY_FLOOR_USD) {
    failures.push(`D: liquidity below $20M/day (${r.avgDollarVolume20 != null ? '$' + (r.avgDollarVolume20 / 1e6).toFixed(1) + 'M' : 'unknown'})`)
  }

  return { eligible: failures.length === 0, failures }
}

// ── STEP 3: scored factors, 0-2 each, missing data -> neutral 1 ─────────
function factor(n, label, points, detail) {
  return { n, label, points, detail }
}

function evaluateScoredFactors(r, regimeFit) {
  const factors = []

  factors.push(
    r.volRatio50AtBreakout == null
      ? factor(1, 'Breakout-day volume vs 50d avg', 1, 'Unknown (neutral)')
      : r.volRatio50AtBreakout >= 1.5
        ? factor(1, 'Breakout-day volume vs 50d avg', 2, `${r.volRatio50AtBreakout.toFixed(2)}x`)
        : r.volRatio50AtBreakout >= 1.0
          ? factor(1, 'Breakout-day volume vs 50d avg', 1, `${r.volRatio50AtBreakout.toFixed(2)}x`)
          : factor(1, 'Breakout-day volume vs 50d avg', 0, `${r.volRatio50AtBreakout.toFixed(2)}x`)
  )

  factors.push(
    r.baseQuality == null
      ? factor(2, 'Base quality (6-8wk, <20% range)', 1, 'Unknown (neutral)')
      : r.baseQuality.tight
        ? factor(2, 'Base quality (6-8wk, <20% range)', 2, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range`)
        : r.baseQuality.rangePct <= 30
          ? factor(2, 'Base quality (6-8wk, <20% range)', 1, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range — moderate`)
          : factor(2, 'Base quality (6-8wk, <20% range)', 0, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}% range — poor`)
  )

  // isAllTimeHigh is always null — Alpaca's free-tier history (~13 months)
  // can never confirm ATH status either way (see weekHighScreener.js). The
  // spec's own scale never scores this 0 (ATH=2, not-ATH=1), so rather than
  // invent a guess, this always awards the more conservative "not ATH" (1)
  // score — never the unverified ATH bonus.
  factors.push(factor(3, 'ATH vs. just 52W high', 1, "Can't be determined from this app's ~13mo history — scored as not-ATH"))

  factors.push(
    r.breakoutGapPct == null
      ? factor(4, 'Gap on breakout day', 1, 'Unknown (neutral)')
      : r.breakoutGapPct < 5
        ? factor(4, 'Gap on breakout day', 2, `${r.breakoutGapPct >= 0 ? '+' : ''}${r.breakoutGapPct.toFixed(1)}%`)
        : r.breakoutGapPct <= 10
          ? factor(4, 'Gap on breakout day', 1, `+${r.breakoutGapPct.toFixed(1)}%`)
          : factor(4, 'Gap on breakout day', 0, `+${r.breakoutGapPct.toFixed(1)}%`)
  )

  // Spec gives 55-75=2, 75-80=1, >80 or <50=0 — leaving 50-55 unstated;
  // grouped with "<50" (0) since it's still below the 55 "trending" floor.
  factors.push(
    r.rsiValue == null
      ? factor(5, 'RSI', 1, 'Unknown (neutral)')
      : r.rsiValue >= 55 && r.rsiValue <= 75
        ? factor(5, 'RSI', 2, r.rsiValue.toFixed(0))
        : r.rsiValue > 75 && r.rsiValue <= 80
          ? factor(5, 'RSI', 1, r.rsiValue.toFixed(0))
          : factor(5, 'RSI', 0, r.rsiValue.toFixed(0))
  )

  factors.push(
    r.extensionFrom50EmaPct == null
      ? factor(6, 'Extension from 50 EMA', 1, 'Unknown (neutral)')
      : r.extensionFrom50EmaPct < 15
        ? factor(6, 'Extension from 50 EMA', 2, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
        : r.extensionFrom50EmaPct <= 25
          ? factor(6, 'Extension from 50 EMA', 1, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
          : factor(6, 'Extension from 50 EMA', 0, `+${r.extensionFrom50EmaPct.toFixed(1)}%`)
  )

  factors.push(
    r.adxValue == null
      ? factor(7, 'ADX', 1, 'Unknown (neutral)')
      : r.adxValue >= 25
        ? factor(7, 'ADX', 2, r.adxValue.toFixed(0))
        : r.adxValue >= 20
          ? factor(7, 'ADX', 1, r.adxValue.toFixed(0))
          : factor(7, 'ADX', 0, r.adxValue.toFixed(0))
  )

  factors.push(
    r.rsRank == null
      ? factor(8, 'RS Rank', 1, 'Unknown (neutral)')
      : r.rsRank >= 85
        ? factor(8, 'RS Rank', 2, r.rsRank)
        : r.rsRank >= 70
          ? factor(8, 'RS Rank', 1, r.rsRank)
          : factor(8, 'RS Rank', 0, r.rsRank)
  )

  factors.push(
    r.earningsDaysAway != null && r.earningsDaysAway <= EARNINGS_AVOID_TRADING_DAYS
      ? factor(9, 'Earnings within 5 trading days', 0, `Earnings in ${r.earningsDaysAway}d`)
      : factor(9, 'Earnings within 5 trading days', 2, r.earningsDaysAway != null ? `Earnings in ${r.earningsDaysAway}d` : 'None known')
  )

  factors.push(
    factor(10, 'Regime fit', regimeFit.fit === 'FAVORABLE' ? 2 : regimeFit.fit === 'MIXED' ? 1 : 0, regimeFit.fit)
  )

  return factors
}

function gradeForScore(score) {
  if (score >= 16) return 'A'
  if (score >= 11) return 'B'
  if (score >= 6) return 'C'
  return 'D'
}

// Top/bottom-scoring factors as short strength/weakness labels for the
// one-line summary the spec asks for.
function summarizeFactors(factors) {
  const sorted = [...factors].sort((a, b) => b.points - a.points)
  const strengths = sorted.filter((f) => f.points === 2).slice(0, 3).map((f) => f.label)
  const weaknesses = [...sorted].reverse().filter((f) => f.points === 0).slice(0, 3).map((f) => f.label)
  return { strengths, weaknesses }
}

export function evaluateEntryFilter(r, regime) {
  const hard = evaluateHardFilters(r)
  if (!hard.eligible) {
    return { eligible: false, failures: hard.failures }
  }

  const regimeFit = classifyRegimeFit(r.sector, regime)
  const factors = evaluateScoredFactors(r, regimeFit)
  const score = factors.reduce((sum, f) => sum + f.points, 0)
  const grade = gradeForScore(score)
  const { strengths, weaknesses } = summarizeFactors(factors)

  return { eligible: true, score, grade, factors, regimeFit, strengths, weaknesses }
}

// Attaches `entryFilter` to every result in place — call after
// classifyWeekHighResults (needs rsRank already computed) and after
// fetchEntryFilterRegime (one regime fetch shared across the whole scan).
export function attachEntryFilters(results, regime) {
  for (const r of results) {
    r.entryFilter = evaluateEntryFilter(r, regime)
  }
}

// Risk % is now grade-driven (per spec) instead of a flat 1% + separate
// regime-halving step — regime's effect on sizing is already baked into the
// score (factor 10) and therefore the grade, so it isn't applied twice.
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
