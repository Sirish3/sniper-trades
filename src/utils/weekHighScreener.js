// 52-week-high screener — finds stocks breaking out to (or setting up near)
// a new 52-week high, classifies the setup into the same signal taxonomy as
// a discretionary swing trader would (breakout / retest / watch /
// approaching), grades it A+ through C, and — for actionable signals — builds
// a full stop/size/trim trade plan and a deterministic thesis. Everything is
// computed from real Alpaca/Finnhub data already flowing through this app
// (indicators.js, positionPlan.js, sectorRegime.js); no LLM involved.

import { ema, rsi, adx, volumeRatio, maxVolumeRatioOverWindow, pctChange, macd, atr, williamsAlligator, alligatorPhase } from './indicators'
import { scanUniverse } from './screener'
import { classifySectorHeat } from './sectorRegime'
import { getEarningsMap } from './earningsProvider'
import { selectStop, sizePosition, buildTrimPlan, TIME_STOP_DAYS } from './positionPlan'
import { avwapFromAnchorIndex } from './avwap'
import { THRESHOLDS } from './screenerThresholds'

const HIGH_LOOKBACK = 252 // ~52 weeks of trading days
const RET_1M_LOOKBACK = 21
const RET_3M_LOOKBACK = 63

// True if today's high reaches/exceeds the highest high of the prior year
// (i.e. excluding today) — the standard "new 52-week high" definition,
// rather than just "today is part of the highest-high window".
function isNewHigh(highs) {
  if (highs.length < 2) return false
  const lookback = highs.slice(-(HIGH_LOOKBACK + 1), -1)
  if (lookback.length === 0) return false
  const priorHigh = Math.max(...lookback)
  return highs[highs.length - 1] >= priorHigh
}

// Trading days since the most recent high within `lookback` bars (0 = today
// is the peak) — used to judge how many days into a pullback a stock is.
function daysSincePeakHigh(highs, lookback = HIGH_LOOKBACK) {
  const recent = highs.slice(-lookback)
  let peakIdx = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] >= recent[peakIdx]) peakIdx = i
  }
  return recent.length - 1 - peakIdx
}

// Evaluates one company's 52-week-high setup. Returns null if there isn't
// enough history for the EMA stack (mirrors the other screeners' minimum).
// Pure technical metrics only — RS rank, sector heat, signal type, grade,
// and trade plan are attached afterward by classifyWeekHighResults /
// buildWeekHighTradePlans, since those need the whole scanned universe (RS
// rank) or extra API calls (sector heat, earnings) the per-ticker evaluator
// shouldn't make on every single scanned symbol.
export function evaluateWeekHigh(company, closes, volumes, highs, lows, opens) {
  const price = closes[closes.length - 1]
  const ema10 = ema(closes, 10)
  const ema20 = ema(closes, 20)
  const ema21 = ema(closes, 21)
  const ema50 = ema(closes, 50)
  if (ema10 == null || ema20 == null || ema50 == null) return null

  const highSeries = highs && highs.length > 0 ? highs : closes
  const lowSeries = lows && lows.length > 0 ? lows : closes
  const high52w = Math.max(...highSeries.slice(-HIGH_LOOKBACK))
  const low52w = Math.min(...lowSeries.slice(-HIGH_LOOKBACK))
  const pctFromHigh = ((price - high52w) / high52w) * 100
  const pctFromLow = ((price - low52w) / low52w) * 100

  const newHigh = isNewHigh(highSeries)
  const volRatio20 = volumeRatio(volumes, 20)
  const volRatio50 = volumes.length >= 50 ? volumeRatio(volumes, 50) : null
  // FIX 1: volume confirmation reads the best day in a tight recent window,
  // not just today's bar — a stock that broke out on big volume and is now
  // resting on a quiet digestion day shouldn't read as "volume FAIL".
  const volRatioMaxWindow = maxVolumeRatioOverWindow(volumes, 20, THRESHOLDS.volumeBreakoutWindowDays)
  const volRatioMaxN = volRatioMaxWindow?.ratio ?? null
  const volRatioMaxNDaysAgo = volRatioMaxWindow?.daysAgo ?? null
  const rsiValue = rsi(closes, 14)
  const adxValue = highs && lows && highs.length >= 29 && lows.length >= 29 ? adx(highs, lows, closes, 14) : null
  const pct10Day = pctChange(closes, 10)
  const emaFullStack = ema10 > ema20 && ema20 > ema50

  const barsHL = highSeries.map((h, i) => ({ h, l: lowSeries[i], c: closes[i] }))
  const atr14 = atr(barsHL, 14)
  const low10Day = lowSeries.length >= 10 ? Math.min(...lowSeries.slice(-10)) : null

  // FIX (BUG): MACD has two genuinely different aspects — histogram
  // DIRECTION (rising/falling, momentum) vs line-vs-signal POSTURE
  // (bullish/bearish, trend). These used to collide under ambiguous
  // names/labels, producing cards that showed "MACD RISING" and "MACD
  // BEARISH" simultaneously with no way to tell they were two different
  // readings. macdHistDirection is the entry-relevant signal for this
  // momentum/breakout system and is what gates decisions (see
  // stockAnalysis.js's makeDecision/gradeBreakdown); macdPosture is lagging
  // context only, displayed but never itself a disqualifier.
  const macdData = macd(closes)
  const macdPosture = macdData == null
    ? null
    : macdData.value > macdData.signal && macdData.histogram > 0 ? 'BULLISH' : 'BEARISH'
  const macdHistogram = macdData?.histogram ?? null
  const macdHistDirection = macdData == null
    ? null
    : macdData.histogram > macdData.histPrev ? 'RISING' : macdData.histogram < macdData.histPrev ? 'FALLING' : 'FLAT'

  const alligator = williamsAlligator(closes)
  const phase = alligatorPhase(alligator.jaw, alligator.teeth, alligator.lips)

  const ret1m = pctChange(closes, RET_1M_LOOKBACK)
  const ret3m = pctChange(closes, RET_3M_LOOKBACK)

  const peakAge = daysSincePeakHigh(highSeries)
  const avwapFromHigh = avwapFromAnchorIndex(highSeries, lowSeries, closes, volumes, closes.length - 1 - peakAge)
  const volRising = volumes.length >= 2 ? volumes[volumes.length - 1] > volumes[volumes.length - 2] : null
  // "Green candle" needs an open price; fall back to close > prior close if
  // opens weren't fetched (older callers of scanUniverse).
  const todayUp = opens && opens.length > 0
    ? price > opens[opens.length - 1]
    : closes.length >= 2 ? price > closes[closes.length - 2] : null

  const avgVol20 = volumes.length >= 20 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null
  const pullbackWindow = peakAge > 0 && peakAge <= 10 ? volumes.slice(-(peakAge + 1)) : []
  const pullbackVolRatio = pullbackWindow.length > 0 && avgVol20
    ? (pullbackWindow.reduce((a, b) => a + b, 0) / pullbackWindow.length) / avgVol20
    : null

  const volForConfirm = volRatioMaxN ?? volRatio20
  const volumeConfirmed = volForConfirm != null && volForConfirm >= THRESHOLDS.volumeStrongFloor
  const strength = newHigh && volumeConfirmed && emaFullStack
    ? 'STRONG'
    : newHigh || (pctFromHigh >= -5 && emaFullStack)
      ? 'WATCH'
      : null

  return {
    symbol: company.symbol,
    name: company.name,
    sector: company.sector,
    price,
    high52w,
    low52w,
    pctFromHigh,
    pctFromLow,
    newHigh,
    volRatio20,
    volRatio50,
    volRatioMaxN,
    volRatioMaxNDaysAgo,
    volumeConfirmed,
    rsiValue,
    adxValue,
    pct10Day,
    ema10,
    ema20,
    ema21,
    ema50,
    emaFullStack,
    macdPosture,
    macdHistogram,
    macdHistDirection,
    alligatorPhase: phase,
    atr14,
    low10Day,
    ret1m,
    ret3m,
    peakAge,
    avwapFromHigh,
    volRising,
    todayUp,
    pullbackVolRatio,
    strength, // legacy STRONG/WATCH tag, kept for back-compat with old filters
    // Populated by classifyWeekHighResults / buildWeekHighTradePlans:
    rsRank: null,
    sectorStatus: null,
    signalType: null,
    grade: null,
    gradeReasons: null,
    earningsDaysAway: null,
    earningsDate: null,
    earningsSource: null,
    tradePlan: null,
    thesis: null,
  }
}

export async function scanWeekHighs(onProgress, universe) {
  return scanUniverse(onProgress, universe, evaluateWeekHigh)
}

// Assigns a percentile RS rank (0-100) based on 3-month return vs all other
// scanned stocks — recent enough to matter for a breakout screen, smooth
// enough to not be whipsawed by a single day. Mutates results in place.
export function computeWeekHighRsRanks(results) {
  if (results.length < 2) {
    results.forEach((r) => { r.rsRank = null })
    return
  }
  const sorted = [...results].sort((a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999))
  const n = sorted.length
  sorted.forEach((r, i) => { r.rsRank = Math.round(((n - 1 - i) / (n - 1)) * 100) })
}

const BREAKOUT_PCT_FROM_HIGH_MIN = -1 // "at or within 1% above" the 52w high
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

// RULE CHANGE (THRESHOLDS.adxConfirmsTrend, default OFF — see
// screenerThresholds.js): ADX and the Williams Alligator are both
// trend-confirmation tools. Normally the retest branch below requires
// EATING_UP outright. When the flag is on, an exceptionally strong ADX
// reading is treated as an equally valid trend confirmation even while the
// Alligator is still only WAKING/SLEEPING — but two guards keep this from
// over-reaching: GUARD 1, EATING_DOWN is a real, confirmed downtrend and is
// never overridden regardless of ADX or the flag; GUARD 2, the override
// only ever PROMOTES an already-excellent (grade A/A+) setup — it must
// never rescue a B/C card that just happens to have a freak-high ADX.
// Returns which path (if either) confirmed the trend, so callers can tag
// the result for visibility into how often the override actually fires.
function evaluateTrendConfirmation(phase, adxValue, grade) {
  if (phase === 'EATING_UP') return { confirmed: true, by: 'ALLIGATOR' }
  if (
    THRESHOLDS.adxConfirmsTrend &&
    phase !== 'EATING_DOWN' && // GUARD 1 — never override a confirmed downtrend
    (grade === 'A' || grade === 'A+') && // GUARD 2 — only promote, never rescue
    adxValue != null && adxValue > THRESHOLDS.adxStrongTrendConfirm
  ) {
    return { confirmed: true, by: 'ADX_OVERRIDE' }
  }
  return { confirmed: false, by: null }
}

// Classifies a setup into the signal taxonomy: BUY_BREAKOUT (at/near a new
// high on strong volume), BUY_RETEST (pulled back 1-10% on light volume,
// today reversing up, trend confirmed — see evaluateTrendConfirmation
// above), WATCH (close to the high, strong RS, not yet breaking out),
// APPROACHING (further out but still worth monitoring), or null (no
// actionable signal). Checked in priority order — a stock meeting
// BUY_BREAKOUT's bar is reported as that even if it would also technically
// satisfy WATCH. Reads r.grade (must already be set — classifyWeekHighResults
// computes grade before signal type for exactly this reason) for GUARD 2
// above, and mutates r.trendConfirmedBy ('ALLIGATOR' | 'ADX_OVERRIDE' | null)
// as a side effect, same "attach extra computed context to r" pattern this
// file already uses for earnings — see classifyWeekHighResults.
export function classifySignalType(r) {
  const { pctFromHigh, volRatio20, volRatioMaxN, rsRank, peakAge, pullbackVolRatio, todayUp, volRising, alligatorPhase: phase, adxValue, grade, newHigh } = r
  r.trendConfirmedBy = null

  // FIX 1: the breakout volume gate reads the best day in the recent
  // window, not just today's bar — see maxVolumeRatioOverWindow.
  const volForBreakout = volRatioMaxN ?? volRatio20
  const volumeOk = volForBreakout != null && (
    volForBreakout >= THRESHOLDS.volumeStrongFloor ||
    (rsRank != null && rsRank > RS_RANK_VOLUME_BOOST_MIN && volForBreakout >= BOOSTED_VOLUME_RATIO_MIN)
  )
  if ((newHigh || pctFromHigh >= BREAKOUT_PCT_FROM_HIGH_MIN) && volumeOk) {
    return 'BUY_BREAKOUT'
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
    r.trendConfirmedBy = trend.by
    return 'BUY_RETEST'
  }

  if (pctFromHigh >= WATCH_PCT_FROM_HIGH_MIN && rsRank != null && rsRank > WATCH_RS_RANK_MIN) {
    return 'WATCH'
  }

  if (pctFromHigh >= APPROACHING_PCT_FROM_HIGH_MIN && rsRank != null && rsRank > APPROACHING_RS_RANK_MIN) {
    return 'APPROACHING'
  }

  return null
}

const GRADE_C_RSI_MIN = 45
const GRADE_C_RSI_MAX = 78
const GRADE_C_MAX_PCT_FROM_HIGH = -10
const EARNINGS_AVOID_DAYS = 10

// Grades a 52-week-high setup A+, A, B, or C.
// C disqualifiers are checked first (any one -> C regardless of other criteria).
// A+ requires all 9 criteria (volume, RS rank, RSI, EMA stack, ADX, Alligator,
// sector heat, earnings distance, proximity to pivot). A allows a few misses
// if the core trend/volume/RSI criteria still hold. Everything else is B
// (tradeable at the 50% size positionPlan.js's B_GRADE_SCALE already applies).
export function gradeWeekHighSetup(r) {
  const { volRatio20, volRatioMaxN, rsiValue, adxValue, rsRank, emaFullStack, pctFromHigh, alligatorPhase: phase, sectorStatus, earningsDaysAway, earningsSource, avwapFromHigh } = r
  const avwapBullish = avwapFromHigh == null || avwapFromHigh.signal === 'BULLISH'
  // FIX 1: the MUST volume floor reads the best day in the recent window
  // (volRatioMaxN), not just today's single bar — see maxVolumeRatioOverWindow.
  const volForMust = volRatioMaxN ?? volRatio20
  // An ESTIMATED earnings date carries ~±2-week real error, so it can never
  // produce a confident pass this close to the avoid window — widen the bar
  // it has to clear. A CONFIRMED date (or no date at all, i.e. UNKNOWN) uses
  // the real threshold unchanged.
  const earningsAvoidDays = EARNINGS_AVOID_DAYS + (earningsSource === 'ESTIMATED' ? THRESHOLDS.earningsEstimatedPadDays : 0)

  const cReasons = []
  if (volForMust != null && volForMust < THRESHOLDS.volumeMustFloor) {
    cReasons.push(`Vol ${volForMust.toFixed(2)}x < ${THRESHOLDS.volumeMustFloor}x (best of last ${THRESHOLDS.volumeBreakoutWindowDays}d)`)
  }
  if (rsiValue != null && (rsiValue < GRADE_C_RSI_MIN || rsiValue > GRADE_C_RSI_MAX)) {
    cReasons.push(`RSI ${rsiValue.toFixed(0)} out of 45-78 range`)
  }
  if (pctFromHigh != null && pctFromHigh < GRADE_C_MAX_PCT_FROM_HIGH) {
    cReasons.push(`${pctFromHigh.toFixed(1)}% from high — too extended from pivot`)
  }
  if (cReasons.length > 0) return { grade: 'C', reasons: cReasons }

  const checks = [
    { ok: pctFromHigh != null && pctFromHigh >= -5, miss: `${pctFromHigh?.toFixed(1) ?? '?'}% from pivot (need >= -5%)` },
    // FIX 1 (applied here too — was still reading today's single-day
    // volRatio20 while every other gate in this file already used
    // volForMust): a stock that broke out yesterday on 3x volume and is
    // quietly digesting today at 1.1x was incorrectly losing this A+
    // criterion even though the breakout volume already confirmed.
    { ok: volForMust != null && volForMust >= 2.5, miss: `Vol ${volForMust?.toFixed(2) ?? '?'}x (need >= 2.5x, best of last ${THRESHOLDS.volumeBreakoutWindowDays}d)` },
    { ok: rsRank != null && rsRank > 85, miss: `RS rank ${rsRank ?? '?'} (need > 85)` },
    { ok: rsiValue != null && rsiValue >= 55 && rsiValue <= 72, miss: `RSI ${rsiValue?.toFixed(0) ?? '?'} (need 55-72)` },
    { ok: !!emaFullStack, miss: 'EMA stack not bullish (need 10>20>50)' },
    { ok: adxValue != null && adxValue > 28, miss: `ADX ${adxValue?.toFixed(0) ?? '?'} (need > 28)` },
    { ok: phase === 'EATING_UP', miss: `Alligator ${phase} (need EATING_UP)` },
    { ok: sectorStatus === 'HOT', miss: `Sector ${sectorStatus ?? 'unknown'} (need HOT)` },
    { ok: earningsDaysAway == null || earningsDaysAway > earningsAvoidDays, miss: `Earnings in ${earningsDaysAway} days${earningsSource === 'ESTIMATED' ? ' (estimated)' : ''} (need > ${earningsAvoidDays})` },
    { ok: avwapBullish, miss: `AVWAP from 52W high bearish (${avwapFromHigh?.vsPricePct.toFixed(1)}%) — buyers since the high are underwater` },
  ]
  const misses = checks.filter((c) => !c.ok).map((c) => c.miss)
  if (misses.length === 0) return { grade: 'A+', reasons: [] }

  const coreOk = !!emaFullStack
    && (volForMust == null || volForMust >= THRESHOLDS.volumeStrongFloor)
    && (rsiValue == null || (rsiValue >= 50 && rsiValue <= 75))
    && (pctFromHigh == null || pctFromHigh >= -7)
    && (adxValue == null || adxValue > 20)
    && sectorStatus !== 'COLD'
    && avwapBullish
  if (misses.length <= 3 && coreOk) return { grade: 'A', reasons: misses }

  return { grade: 'B', reasons: misses.slice(0, 4) }
}

// Attaches RS rank, sector-ETF heat (HOT/WARM/COLD), earnings date/source,
// signal classification, and grade to every scanned result. One extra fetch
// for sector heat (11 SPDR ETFs) and ONE batched Finnhub calendar call for
// earnings (see earningsProvider.js) — no per-ticker API calls for either.
// Mutates `results` in place and also returns them alongside the sector
// heat map.
export async function classifyWeekHighResults(results) {
  computeWeekHighRsRanks(results)

  let sectorHeat = null
  try {
    sectorHeat = await classifySectorHeat()
  } catch {
    sectorHeat = null
  }

  let earningsMap = {}
  try {
    earningsMap = await getEarningsMap(results.map((r) => r.symbol))
  } catch {
    earningsMap = {}
  }

  for (const r of results) {
    const earnings = earningsMap[r.symbol] ?? { date: null, daysAway: null, source: 'UNKNOWN' }
    r.earningsDate = earnings.date
    r.earningsDaysAway = earnings.daysAway
    r.earningsSource = earnings.source
    r.sectorStatus = sectorHeat?.bySector?.[r.sector]?.status ?? null
    // Grade must be set before classifySignalType runs — its ADX-override
    // trend-confirmation path (GUARD 2) reads r.grade to ensure the override
    // only ever promotes an already-excellent setup. gradeWeekHighSetup has
    // no dependency on signalType, so this ordering is safe.
    const { grade, reasons } = gradeWeekHighSetup(r)
    r.grade = grade
    r.gradeReasons = reasons
    r.signalType = classifySignalType(r)
  }

  return { results, sectorHeat }
}

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// Adds `days` *trading* days (skipping Sat/Sun) to `start` — used for the
// trade plan's "exit if no progress by [date]" time stop.
function addTradingDays(start, days) {
  const d = new Date(start)
  let added = 0
  while (added < days) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) added++
  }
  return d
}

function pctLabel(value) {
  if (value == null) return '?'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

// Deterministic 3-sentence thesis built only from already-computed real
// numbers (no LLM, no invented figures): what the chart shows, why now, and
// what could go wrong.
export function generateThesis(r) {
  const volTxt = r.volRatio20 != null ? `${r.volRatio20.toFixed(1)}x average volume` : 'unconfirmed volume'
  const sentence1 = r.newHigh || r.pctFromHigh >= BREAKOUT_PCT_FROM_HIGH_MIN
    ? `${r.symbol} is breaking out to a new 52-week high near $${r.price.toFixed(2)} on ${volTxt}, with its EMA stack ${r.emaFullStack ? '10>20>50 aligned' : 'not yet fully aligned'} and the Alligator in its ${r.alligatorPhase} phase.`
    : `${r.symbol} is ${Math.abs(r.pctFromHigh).toFixed(1)}% below its 52-week high of $${r.high52w.toFixed(2)}, with RSI at ${r.rsiValue?.toFixed(0) ?? '?'} and ADX at ${r.adxValue?.toFixed(0) ?? '?'} (${r.adxValue != null && r.adxValue > 25 ? 'trending' : 'still developing'}).`

  const sectorTxt = r.sectorStatus ? `its sector ETF reading ${r.sectorStatus}` : 'sector heat unavailable'
  const earningsTxt = r.earningsDaysAway != null
    ? `, with earnings ${r.earningsDaysAway} days out${r.earningsSource === 'ESTIMATED' ? ' (estimated)' : ''} — ${r.earningsDaysAway <= EARNINGS_AVOID_DAYS ? 'verify before entry' : 'no near-term gap risk'}`
    : r.earningsSource === 'UNKNOWN' ? ', earnings date unavailable — verify before entry' : ''
  const sentence2 = `It ranks ${r.rsRank ?? '?'} on relative strength versus the scanned universe (${pctLabel(r.ret1m)} over 1 month, ${pctLabel(r.ret3m)} over 3 months), with ${sectorTxt}${earningsTxt}.`

  const sentence3 = r.tradePlan?.viable
    ? `Risk is defined by a ${r.tradePlan.stopMethod} stop at $${r.tradePlan.stopPrice.toFixed(2)} (${r.tradePlan.riskPct.toFixed(1)}% below entry) — a daily close back below that level invalidates the setup, with a time stop by ${r.tradePlan.timeStopDate} if it hasn't progressed.`
    : r.tradePlan?.reason
      ? `No trade plan was built: ${r.tradePlan.reason}.`
      : `Grade ${r.grade ?? '?'} — treat as informational only until volume and trend confirm further.`

  return `${sentence1} ${sentence2} ${sentence3}`
}

export const MAX_TRADE_PLAN_CANDIDATES = 15
const TRADE_PLAN_BATCH_SIZE = 5
const TRADE_PLAN_BATCH_DELAY_MS = 1500

// Builds the full stop/size/trim plan via positionPlan.js (the same engine
// the Agentic Screener uses) plus a deterministic thesis — unless the
// result is grade C or has earnings within the avoid window. Earnings and
// grade are already known by this point (classifyWeekHighResults populates
// both, batched, before this ever runs) — no per-ticker fetch or re-grade
// needed here anymore.
async function attachTradePlan(r, portfolioOptions) {
  if (r.grade === 'C') {
    r.tradePlan = { viable: false, reason: 'Grade C — do not trade' }
    r.thesis = generateThesis(r)
    return r
  }
  // An ESTIMATED earnings date carries ~±2-week error, so the no-new-entries
  // window widens for it — never let a guess clear a stock for a sized,
  // stopped position. CONFIRMED uses the real 7-day buffer unchanged.
  const earningsBlockDays = 7 + (r.earningsSource === 'ESTIMATED' ? THRESHOLDS.earningsEstimatedPadDays : 0)
  if (r.earningsDaysAway != null && r.earningsDaysAway <= earningsBlockDays) {
    const tag = r.earningsSource === 'ESTIMATED' ? ' (estimated — verify)' : ''
    r.tradePlan = { viable: false, reason: `Earnings in ${r.earningsDaysAway} days${tag} — skip new entries` }
    r.thesis = generateThesis(r)
    return r
  }

  const { portfolioSize, riskEnvironment, openPositions } = portfolioOptions
  const stop = selectStop({ price: r.price, low10Day: r.low10Day, ema21: r.ema21, baseLow: null, atr14: r.atr14 })
  if (!stop.viable) {
    r.tradePlan = stop
    r.thesis = generateThesis(r)
    return r
  }

  const sizing = sizePosition({
    portfolioSize, price: r.price, stopPrice: stop.stopPrice, grade: r.grade, riskEnvironment, openPositions, sector: r.sector,
  })
  if (!sizing.viable) {
    r.tradePlan = sizing
    r.thesis = generateThesis(r)
    return r
  }

  const trimPlan = buildTrimPlan({ price: r.price, stopPrice: stop.stopPrice, shares: sizing.shares, atr14: r.atr14 })
  const timeStopDate = addTradingDays(new Date(), TIME_STOP_DAYS).toISOString().slice(0, 10)

  r.tradePlan = {
    viable: true,
    entryPrice: round(r.price),
    stopPrice: stop.stopPrice,
    stopMethod: stop.method,
    ...sizing,
    ...trimPlan,
    timeStopDate,
  }
  r.thesis = generateThesis(r)
  return r
}

// Builds trade plans (and a thesis) for up to MAX_TRADE_PLAN_CANDIDATES of
// `results`, rate-limited in small batches (mirrors swingPlan.js's
// buildSwingCandidates). `portfolioOptions` is `{ portfolioSize,
// riskEnvironment, openPositions }`. Mutates each result in place.
export async function buildWeekHighTradePlans(results, portfolioOptions, onProgress) {
  const subset = results.slice(0, MAX_TRADE_PLAN_CANDIDATES)
  let done = 0

  for (let i = 0; i < subset.length; i += TRADE_PLAN_BATCH_SIZE) {
    const batch = subset.slice(i, i + TRADE_PLAN_BATCH_SIZE)
    await Promise.all(batch.map((r) => attachTradePlan(r, portfolioOptions)))
    done += batch.length
    onProgress?.(done, subset.length)

    if (i + TRADE_PLAN_BATCH_SIZE < subset.length) {
      await new Promise((resolve) => setTimeout(resolve, TRADE_PLAN_BATCH_DELAY_MS))
    }
  }

  return { truncated: results.length > MAX_TRADE_PLAN_CANDIDATES, totalAvailable: results.length, builtCount: subset.length }
}
