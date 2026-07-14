// THE single evaluation pipeline for a 52-week-high screener candidate.
// Replaces four functions that used to compute overlapping, sometimes-
// disagreeing opinions about the same stock independently:
//   - weekHighScreener.js's gradeWeekHighSetup()  -> grade
//   - weekHighScreener.js's classifySignalType()  -> signal timing
//   - stockAnalysis.js's analyzeStock()           -> its own BUY/WAIT/AVOID
//   - verdict.js's getVerdict()                   -> a THIRD BUY/WATCH/AVOID
// No other function in this app should compute a verdict, grade, or
// buy/avoid opinion — everything downstream (position sizing, "Build Trade
// Plans" eligibility, alerts, the UI) reads evaluateStock()'s single result.
//
// Pipeline, in order — later stages never run once an earlier one has
// disqualified the stock:
//   STAGE 0  6 hard disqualifiers (MUST tier) -> immediate 'AVOID' if any fail
//   STAGE 1  Market stage (context tag, doesn't gate anything)
//   STAGE 2  12 scored factors (SCORED tier), 0-2 points each, 0-24 total
//   STAGE 3  Grade from score: A/B/C/D
//   (internal) signal type: BUY_BREAKOUT/BUY_RETEST/WATCH/APPROACHING/null —
//     not a verdict itself, just a timing classification the verdict step
//     consumes, so it doesn't need to survive as its own export.
//   STAGE 4  Verdict — a PURE function of (grade, signalType) only
//   STAGE 5  entry/stop/size/riskDollars, sized off grade alone
//
// `reasons` is one flat array mixing both tiers (MUST entries carry
// `status`, SCORED entries carry `points`/`maxPoints`) — this is what
// AnalysisPanel renders as the criteria checklist, and what red/amber/green
// flags get filtered from at render time, instead of a separately computed
// flags object.

import { THRESHOLDS } from './screenerThresholds'
import { checkMarketRegime } from './marketRegime'
import { checkSectorRegimes } from './sectorRegime'

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function must(label, value, threshold, status) {
  return { tier: 'MUST', label, value, threshold, status }
}

function scored(n, label, points, value, threshold) {
  return { tier: 'SCORED', n, label, points, maxPoints: 2, value, threshold }
}

// ── STAGE 0: hard disqualifiers ─────────────────────────────────────────
// All 6 are evaluated unconditionally (cheap, pure) so `reasons` always
// carries the full MUST checklist for display, even though the pipeline
// short-circuits at the STAGE boundary (stages 1-5 never run) the moment
// any one of them fails.
const HARD_EARNINGS_DAYS = 3
const HARD_EXTENSION_1M_PCT = 35

function evaluateHardDisqualifiers(r) {
  const checks = []

  // Broadened from a literal "-2% to 0%" to also admit the retest pullback
  // zone (-10% to -1%, matching RETEST_PCT_FROM_HIGH_MIN/MAX below) — as
  // written, a strict -2%/0% gate would disqualify every retest setup
  // before it ever reached scoring, making Stage 4's WATCH_RETEST verdict
  // structurally unreachable (a retest is by definition a pullback below
  // the high). The finer-grained retest distinction (peak age, pullback
  // volume, candle direction, trend confirmation) still happens in the
  // internal signal-type step below — this check only rules out "too far
  // from any 52-week-high setup to be relevant at all."
  checks.push(
    must(
      'Price near 52W high',
      r.pctFromHigh != null ? `${r.pctFromHigh.toFixed(1)}%` : 'unknown',
      '-2% to 0% (breakout) or -10% to -1% (retest)',
      r.pctFromHigh != null && r.pctFromHigh >= -10 && r.pctFromHigh <= 0 ? 'PASS' : 'FAIL'
    )
  )

  checks.push(
    must(
      'MACD + EMA trend',
      `${r.macdPosture ?? 'unknown'} / ${r.emaFullStack ? '10>20>50' : 'not aligned'}`,
      'MACD bullish AND EMA stack aligned',
      r.macdPosture === 'BULLISH' && r.emaFullStack ? 'PASS' : 'FAIL'
    )
  )

  checks.push(
    must(
      'Liquidity',
      r.avgDollarVolume20 != null ? `$${(r.avgDollarVolume20 / 1e6).toFixed(1)}M` : 'unknown',
      '>= $15M/day',
      r.avgDollarVolume20 != null && r.avgDollarVolume20 >= 15_000_000 ? 'PASS' : 'FAIL'
    )
  )

  // Unknown AVWAP (no data) is never treated as a failure — same graceful-
  // degradation contract as everywhere else in this app.
  checks.push(
    must(
      'AVWAP from 52W high',
      r.avwapFromHigh != null ? `${r.avwapFromHigh.signal} ${r.avwapFromHigh.vsPricePct >= 0 ? '+' : ''}${r.avwapFromHigh.vsPricePct.toFixed(1)}%` : 'unknown',
      'not BEARISH',
      r.avwapFromHigh == null || r.avwapFromHigh.signal !== 'BEARISH' ? 'PASS' : 'FAIL'
    )
  )

  // Only a CONFIRMED date blocks — ESTIMATED/UNKNOWN carry too much error to
  // hard-disqualify on, same distinction this app makes everywhere earnings
  // is checked.
  const earningsSoon = r.earningsSource === 'CONFIRMED' && r.earningsDaysAway != null && r.earningsDaysAway <= HARD_EARNINGS_DAYS
  checks.push(
    must(
      'Earnings clear',
      r.earningsDaysAway != null ? `${r.earningsDaysAway}d away${r.earningsSource === 'ESTIMATED' ? ' (estimated)' : ''}` : 'unknown',
      `confirmed date > ${HARD_EARNINGS_DAYS} trading days out`,
      earningsSoon ? 'FAIL' : 'PASS'
    )
  )

  // Unknown 1-month return is never treated as a failure.
  checks.push(
    must(
      'Not parabolic (1m return)',
      r.ret1m != null ? `${r.ret1m >= 0 ? '+' : ''}${r.ret1m.toFixed(1)}%` : 'unknown',
      `<= ${HARD_EXTENSION_1M_PCT}%`,
      r.ret1m != null && r.ret1m > HARD_EXTENSION_1M_PCT ? 'FAIL' : 'PASS'
    )
  )

  return checks
}

// ── STAGE 1: market stage — best-effort Wyckoff/Weinstein-style read ────
// Reuses existing indicators rather than inventing new ones:
//   - alligatorPhase: SLEEPING/WAKING/EATING_UP/EATING_DOWN, this app's
//     existing trend-phase classifier.
//   - peakAge + baseQuality: was there a real base immediately before a
//     FRESH breakout (peakAge <= 2) — "basing then confirming."
//   - ret3m + adxValue + macdHistDirection: distinguishes an established,
//     still-strengthening trend (MARKUP) from one stretched and rolling
//     over despite still being near highs (DISTRIBUTION).
// A stock reaching this stage already passed Stage 0 (near 52W high, EMA/
// MACD bullish), so DECLINE should be structurally unreachable except via
// the Alligator's own lagging EATING_DOWN read — defensive, not expected.
export function classifyMarketStage(r) {
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
const SERIAL_HIGH_LOOKBACK_DAYS = 63
const EARNINGS_AVOID_TRADING_DAYS = 5

// ── STAGE 2: 12 scored factors, 0-2 each, 0-24 total ────────────────────
function classifyRegimeFit(sector, marketContext) {
  const marketAbove50 = marketContext?.marketAbove50 ?? null
  const sectorAbove50 = marketContext?.sectorBySector?.[sector]?.above50 ?? null
  const marketOk = marketAbove50 !== false
  const sectorOk = sectorAbove50 !== false
  if (marketAbove50 === false && sectorAbove50 === false) return 'UNFAVORABLE'
  if (marketOk && sectorOk && marketAbove50 != null && sectorAbove50 != null) return 'FAVORABLE'
  return 'MIXED'
}

function evaluateScoredFactors(r, marketContext, stage) {
  const factors = []

  factors.push(
    r.newHighCountIn3Months == null
      ? scored(1, `First-time 52W high (last ${SERIAL_HIGH_LOOKBACK_DAYS}d)`, 1, 'unknown', '0 prior=2, 1-2=1, 3+=0')
      : r.newHighCountIn3Months === 0
        ? scored(1, `First-time 52W high (last ${SERIAL_HIGH_LOOKBACK_DAYS}d)`, 2, 'first-time', '0 prior=2, 1-2=1, 3+=0')
        : r.newHighCountIn3Months <= 2
          ? scored(1, `First-time 52W high (last ${SERIAL_HIGH_LOOKBACK_DAYS}d)`, 1, `${r.newHighCountIn3Months} prior`, '0 prior=2, 1-2=1, 3+=0')
          : scored(1, `First-time 52W high (last ${SERIAL_HIGH_LOOKBACK_DAYS}d)`, 0, `${r.newHighCountIn3Months} prior — serial`, '0 prior=2, 1-2=1, 3+=0')
  )

  factors.push(
    r.volRatio50AtBreakout == null
      ? scored(2, 'Breakout-day volume vs 50d avg', 1, 'unknown', '>=1.5x=2, 1.0-1.5x=1, <1.0x=0')
      : r.volRatio50AtBreakout >= 1.5
        ? scored(2, 'Breakout-day volume vs 50d avg', 2, `${r.volRatio50AtBreakout.toFixed(2)}x`, '>=1.5x=2, 1.0-1.5x=1, <1.0x=0')
        : r.volRatio50AtBreakout >= 1.0
          ? scored(2, 'Breakout-day volume vs 50d avg', 1, `${r.volRatio50AtBreakout.toFixed(2)}x`, '>=1.5x=2, 1.0-1.5x=1, <1.0x=0')
          : scored(2, 'Breakout-day volume vs 50d avg', 0, `${r.volRatio50AtBreakout.toFixed(2)}x`, '>=1.5x=2, 1.0-1.5x=1, <1.0x=0')
  )

  factors.push(
    r.baseQuality == null
      ? scored(3, 'Base quality (6-8wk, <20% range)', 1, 'unknown', 'tight=2, moderate=1, poor=0')
      : r.baseQuality.tight
        ? scored(3, 'Base quality (6-8wk, <20% range)', 2, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}%`, 'tight=2, moderate=1, poor=0')
        : r.baseQuality.rangePct <= 30
          ? scored(3, 'Base quality (6-8wk, <20% range)', 1, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}%`, 'tight=2, moderate=1, poor=0')
          : scored(3, 'Base quality (6-8wk, <20% range)', 0, `${r.baseQuality.durationDays}d, ${r.baseQuality.rangePct.toFixed(1)}%`, 'tight=2, moderate=1, poor=0')
  )

  // isAllTimeHigh is always null — Alpaca's free-tier history (~13 months)
  // can never confirm ATH status either way. Never guessed: always the
  // conservative "not ATH" (1) score, never the unverified ATH bonus (2).
  factors.push(scored(4, 'ATH vs. just 52W high', 1, "can't determine (~13mo history)", 'ATH=2, not-ATH=1'))

  factors.push(
    r.breakoutGapPct == null
      ? scored(5, 'Gap on breakout day', 1, 'unknown', '<5%=2, 5-10%=1, >10%=0')
      : r.breakoutGapPct < 5
        ? scored(5, 'Gap on breakout day', 2, `${r.breakoutGapPct >= 0 ? '+' : ''}${r.breakoutGapPct.toFixed(1)}%`, '<5%=2, 5-10%=1, >10%=0')
        : r.breakoutGapPct <= 10
          ? scored(5, 'Gap on breakout day', 1, `+${r.breakoutGapPct.toFixed(1)}%`, '<5%=2, 5-10%=1, >10%=0')
          : scored(5, 'Gap on breakout day', 0, `+${r.breakoutGapPct.toFixed(1)}%`, '<5%=2, 5-10%=1, >10%=0')
  )

  factors.push(
    r.rsiValue == null
      ? scored(6, 'RSI zone', 1, 'unknown', '55-72=2, 72-80=1, >80 or <55=0')
      : r.rsiValue >= 55 && r.rsiValue <= 72
        ? scored(6, 'RSI zone', 2, r.rsiValue.toFixed(1), '55-72=2, 72-80=1, >80 or <55=0')
        : r.rsiValue > 72 && r.rsiValue <= 80
          ? scored(6, 'RSI zone', 1, r.rsiValue.toFixed(1), '55-72=2, 72-80=1, >80 or <55=0')
          : scored(6, 'RSI zone', 0, r.rsiValue.toFixed(1), '55-72=2, 72-80=1, >80 or <55=0')
  )

  factors.push(
    r.extensionFrom50EmaPct == null
      ? scored(7, 'Extension from 50 EMA', 1, 'unknown', '<15%=2, 15-25%=1, >25%=0')
      : r.extensionFrom50EmaPct < 15
        ? scored(7, 'Extension from 50 EMA', 2, `+${r.extensionFrom50EmaPct.toFixed(1)}%`, '<15%=2, 15-25%=1, >25%=0')
        : r.extensionFrom50EmaPct <= 25
          ? scored(7, 'Extension from 50 EMA', 1, `+${r.extensionFrom50EmaPct.toFixed(1)}%`, '<15%=2, 15-25%=1, >25%=0')
          : scored(7, 'Extension from 50 EMA', 0, `+${r.extensionFrom50EmaPct.toFixed(1)}%`, '<15%=2, 15-25%=1, >25%=0')
  )

  factors.push(
    r.adxValue == null
      ? scored(8, 'ADX', 1, 'unknown', '>=25=2, 20-25=1, <20=0')
      : r.adxValue >= 25
        ? scored(8, 'ADX', 2, r.adxValue.toFixed(1), '>=25=2, 20-25=1, <20=0')
        : r.adxValue >= 20
          ? scored(8, 'ADX', 1, r.adxValue.toFixed(1), '>=25=2, 20-25=1, <20=0')
          : scored(8, 'ADX', 0, r.adxValue.toFixed(1), '>=25=2, 20-25=1, <20=0')
  )

  factors.push(
    r.rsRank == null
      ? scored(9, 'RS Rank', 1, 'unknown', '>=85=2, 70-85=1, <70=0')
      : r.rsRank >= 85
        ? scored(9, 'RS Rank', 2, r.rsRank, '>=85=2, 70-85=1, <70=0')
        : r.rsRank >= 70
          ? scored(9, 'RS Rank', 1, r.rsRank, '>=85=2, 70-85=1, <70=0')
          : scored(9, 'RS Rank', 0, r.rsRank, '>=85=2, 70-85=1, <70=0')
  )

  factors.push(
    r.earningsDaysAway != null && r.earningsDaysAway <= EARNINGS_AVOID_TRADING_DAYS
      ? scored(10, `Earnings clear (> ${EARNINGS_AVOID_TRADING_DAYS}d)`, 0, `${r.earningsDaysAway}d away`, 'clear/unknown=2, within window=0')
      : scored(10, `Earnings clear (> ${EARNINGS_AVOID_TRADING_DAYS}d)`, 2, r.earningsDaysAway != null ? `${r.earningsDaysAway}d away` : 'unknown', 'clear/unknown=2, within window=0')
  )

  const regimeFit = classifyRegimeFit(r.sector, marketContext)
  factors.push(
    scored(11, 'Regime (market + sector vs 50MA)', regimeFit === 'FAVORABLE' ? 2 : regimeFit === 'MIXED' ? 1 : 0, regimeFit, 'FAVORABLE=2, MIXED=1, UNFAVORABLE=0')
  )

  factors.push(
    scored(12, 'Market stage fit', STAGE_SCORE[stage], stage, 'MARKUP/ACCUMULATION=2, UNCLEAR=1, DISTRIBUTION/DECLINE=0')
  )

  return factors
}

// ── STAGE 3: grade from score ────────────────────────────────────────────
function gradeForScore(score) {
  if (score >= 19) return 'A'
  if (score >= 13) return 'B'
  if (score >= 7) return 'C'
  return 'D'
}

// ── internal: signal type (was weekHighScreener.js's classifySignalType) ──
// Not a verdict — a timing classification Stage 4 consumes. Kept internal
// (not independently exported/callable) per the "no other function computes
// its own opinion" rule; the underlying logic is unchanged from before.
const BREAKOUT_PCT_FROM_HIGH_MIN = -1
const RETEST_PCT_FROM_HIGH_MIN = -10
const RETEST_PCT_FROM_HIGH_MAX = -1
const RETEST_MIN_DAYS = 3
const RETEST_MAX_DAYS = 7
const RETEST_VOLUME_MAX_RATIO = 0.85
const WATCH_PCT_FROM_HIGH_MIN = -5
const WATCH_RS_RANK_MIN = 70
const APPROACHING_PCT_FROM_HIGH_MIN = -8
const APPROACHING_RS_RANK_MIN = 65
const RS_RANK_VOLUME_BOOST_MIN = 85
const BOOSTED_VOLUME_RATIO_MIN = 1.3

// ADX can stand in for the Alligator not yet being EATING_UP, but only to
// promote an already-excellent (grade A) setup, never to rescue a weaker
// one — same GUARD 1 (never override a confirmed downtrend) / GUARD 2 (only
// ever promotes grade A, was A/A+ before the grade scale lost its A+ tier)
// as the pre-consolidation version.
function evaluateTrendConfirmation(phase, adxValue, grade) {
  if (phase === 'EATING_UP') return { confirmed: true, by: 'ALLIGATOR' }
  if (
    THRESHOLDS.adxConfirmsTrend &&
    phase !== 'EATING_DOWN' &&
    grade === 'A' &&
    adxValue != null && adxValue > THRESHOLDS.adxStrongTrendConfirm
  ) {
    return { confirmed: true, by: 'ADX_OVERRIDE' }
  }
  return { confirmed: false, by: null }
}

function computeSignalType(r, grade) {
  const { pctFromHigh, volRatio20, volRatioMaxN, rsRank, peakAge, pullbackVolRatio, todayUp, volRising, alligatorPhase: phase, adxValue, newHigh } = r

  const volForBreakout = volRatioMaxN ?? volRatio20
  const volumeOk = volForBreakout != null && (
    volForBreakout >= THRESHOLDS.volumeStrongFloor ||
    (rsRank != null && rsRank > RS_RANK_VOLUME_BOOST_MIN && volForBreakout >= BOOSTED_VOLUME_RATIO_MIN)
  )
  if ((newHigh || pctFromHigh >= BREAKOUT_PCT_FROM_HIGH_MIN) && volumeOk) {
    return { signalType: 'BUY_BREAKOUT', trendConfirmedBy: null }
  }

  const isRetestPullback = peakAge >= RETEST_MIN_DAYS && peakAge <= RETEST_MAX_DAYS
  const trend = evaluateTrendConfirmation(phase, adxValue, grade)
  if (
    pctFromHigh >= RETEST_PCT_FROM_HIGH_MIN && pctFromHigh <= RETEST_PCT_FROM_HIGH_MAX &&
    isRetestPullback &&
    pullbackVolRatio != null && pullbackVolRatio < RETEST_VOLUME_MAX_RATIO &&
    todayUp && volRising &&
    trend.confirmed
  ) {
    return { signalType: 'BUY_RETEST', trendConfirmedBy: trend.by }
  }

  if (pctFromHigh >= WATCH_PCT_FROM_HIGH_MIN && rsRank != null && rsRank > WATCH_RS_RANK_MIN) {
    return { signalType: 'WATCH', trendConfirmedBy: null }
  }

  if (pctFromHigh >= APPROACHING_PCT_FROM_HIGH_MIN && rsRank != null && rsRank > APPROACHING_RS_RANK_MIN) {
    return { signalType: 'APPROACHING', trendConfirmedBy: null }
  }

  return { signalType: null, trendConfirmedBy: null }
}

// ── STAGE 4: verdict — pure function of (grade, signalType) only ────────
export function computeVerdict(grade, signalType) {
  if (grade === 'D') return 'AVOID'
  if (grade === 'C') return 'WATCH'
  // grade A or B
  if (signalType === 'BUY_BREAKOUT') return 'BUY_NOW'
  if (signalType === 'BUY_RETEST') return 'WATCH_RETEST'
  return 'WATCH' // WATCH/APPROACHING/no signal on an otherwise-good stock: wait for the trigger
}

// ── STAGE 5: entry/stop/size/riskDollars ─────────────────────────────────
// Stop = wider (further from entry = lower price) of 1.5x ATR and 5% fixed.
// Sized off grade alone: A/B = 1% risk, C = 0.5%, D = never sized. This is
// the ONE place stops/sizing get computed for "should I buy this" — the
// separate, more detailed "Build Trade Plans" positionPlan.js engine
// (tightest-of-4 stops, risk-environment scaling, trim plan) is a distinct,
// out-of-scope feature for managing a position once you've decided to take
// it, not a second opinion on whether to take it.
const RISK_PCT_BY_GRADE = { A: 0.01, B: 0.01, C: 0.005, D: 0 }

function computeSizing(r, grade, accountSize) {
  if (grade == null || grade === 'D' || r.price == null || r.atr14 == null || !accountSize) {
    return { entry: null, stop: null, size: null, riskDollars: null }
  }

  const atrStop = r.price - 1.5 * r.atr14
  const fixedStop = r.price * 0.95
  const stop = Math.min(atrStop, fixedStop) // wider = further from entry = lower price
  const riskPerShare = r.price - stop
  if (riskPerShare <= 0) return { entry: round(r.price), stop: round(stop), size: 0, riskDollars: 0 }

  const riskPct = RISK_PCT_BY_GRADE[grade]
  const shares = Math.floor((accountSize * riskPct) / riskPerShare)
  const riskDollars = shares > 0 ? round(shares * riskPerShare) : 0

  return { entry: round(r.price), stop: round(stop), size: Math.max(0, shares), riskDollars }
}

// ── the one function ──────────────────────────────────────────────────
// `marketContext`: { marketAbove50, sectorBySector, portfolioSize } — regime
// data (fetched once per scan, see fetchMarketContext) plus the account size
// to size against.
export function evaluateStock(r, marketContext = {}) {
  const reasons = evaluateHardDisqualifiers(r)
  const disqualified = reasons.some((c) => c.status === 'FAIL')

  if (disqualified) {
    return {
      verdict: 'AVOID', grade: null, score: null, signalType: null, stage: null,
      reasons, entry: null, stop: null, size: null, riskDollars: null, tradePlanEligible: false,
    }
  }

  const stage = classifyMarketStage(r)
  const scoredFactors = evaluateScoredFactors(r, marketContext, stage)
  reasons.push(...scoredFactors)
  const score = scoredFactors.reduce((sum, f) => sum + f.points, 0)
  const grade = gradeForScore(score)

  const { signalType } = computeSignalType(r, grade)
  const verdict = computeVerdict(grade, signalType)
  const sizing = computeSizing(r, grade, marketContext.portfolioSize)
  const tradePlanEligible = verdict === 'BUY_NOW' || verdict === 'WATCH_RETEST'

  return { verdict, grade, score, signalType, stage, reasons, ...sizing, tradePlanEligible }
}

// Fetches the regime half of marketContext once per scan (not per stock) —
// reuses the existing market/sector-above-50-day-MA checks (marketRegime.js/
// sectorRegime.js) rather than a new fetch. Caller merges in portfolioSize
// before passing the result to evaluateStock() as `marketContext`.
export async function fetchMarketRegime() {
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

// ── derived views over `reasons` — filters, not separately stored fields ──
export function deriveFlags(reasons) {
  const red = reasons.filter((x) => x.tier === 'MUST' && x.status === 'FAIL')
  const amber = reasons.filter((x) => x.tier === 'SCORED' && x.points <= 1)
  const green = reasons.filter((x) => (x.tier === 'MUST' && x.status === 'PASS') || (x.tier === 'SCORED' && x.points === 2))
  return { red, amber, green }
}

// Weakest/strongest reasons entries, for generating thesis text at render
// time — not stored, computed on demand from the one source array.
export function strongestReasons(reasons, n = 3) {
  return [...reasons].filter((x) => x.tier === 'SCORED').sort((a, b) => b.points - a.points).slice(0, n)
}
export function weakestReasons(reasons, n = 3) {
  return [...reasons].filter((x) => x.tier === 'SCORED').sort((a, b) => a.points - b.points).slice(0, n)
}

// One-line verdict summary — shared by the always-visible badge (VerdictPanel)
// and the full details panel (AnalysisPanel), so there's exactly one place
// that turns an evaluation into "here's the headline and why," not two
// components independently deciding how to phrase the same verdict.
export const VERDICT_LABELS = {
  BUY_NOW: { headline: 'Buy Now', tier: 'green' },
  WATCH_RETEST: { headline: 'Watch — Retest Setup', tier: 'yellow' },
  WATCH: { headline: 'Watch — Not Yet', tier: 'yellow' },
  AVOID: { headline: 'Avoid', tier: 'red' },
}

export function summarizeVerdict(evaluation) {
  const { headline, tier } = VERDICT_LABELS[evaluation.verdict] ?? VERDICT_LABELS.WATCH

  let reason
  if (evaluation.verdict === 'AVOID' && evaluation.grade == null) {
    const failed = evaluation.reasons.filter((r) => r.tier === 'MUST' && r.status === 'FAIL')
    reason = `Failed: ${failed.map((f) => f.label).join(', ')}.`
  } else if (evaluation.verdict === 'AVOID') {
    reason = `Grade D (${evaluation.score}/24) — skip despite passing hard filters.`
  } else if (evaluation.verdict === 'BUY_NOW') {
    const top = strongestReasons(evaluation.reasons, 2).map((r) => r.label).join(', ')
    reason = `Grade ${evaluation.grade} confirmed breakout — strongest: ${top}.`
  } else if (evaluation.verdict === 'WATCH_RETEST') {
    reason = `Grade ${evaluation.grade} pulling back to a retest level — not yet confirmed.`
  } else if (evaluation.grade === 'C') {
    reason = `Grade C (${evaluation.score}/24) — marginal, small size only if at all.`
  } else {
    reason = `Grade ${evaluation.grade} — no confirmed breakout or retest trigger yet.`
  }

  return { headline, tier, reason }
}
