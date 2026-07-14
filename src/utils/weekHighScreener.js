// 52-week-high screener — finds stocks breaking out to (or setting up near)
// a new 52-week high and computes their raw technical metrics. Grading,
// signal timing, and the buy/watch/avoid verdict are NOT computed here —
// see evaluateStock.js, the single pipeline everything downstream reads
// (classifyWeekHighResults/checkEarningsForResults just run it and mirror
// grade/signalType onto flat r fields for back-compat). This file also
// keeps the separate, more detailed "Build Trade Plans" stop/size/trim
// engine (positionPlan.js) and its own deterministic thesis text — a
// distinct feature for managing a position once you've decided to take it,
// not a second opinion on whether to take it. Everything is computed from
// real Alpaca/Finnhub data already flowing through this app; no LLM
// involved.

import { ema, rsi, adx, volumeRatio, maxVolumeRatioOverWindow, pctChange, macd, atr, williamsAlligator, alligatorPhase } from './indicators'
import { scanUniverse } from './screener'
import { getEarningsMap } from './earningsProvider'
import { selectStop, sizePosition, buildTrimPlan, TIME_STOP_DAYS } from './positionPlan'
import { avwapFromAnchorIndex } from './avwap'
import { THRESHOLDS } from './screenerThresholds'
import { evaluateStock } from './evaluateStock'

const HIGH_LOOKBACK = 252 // ~52 weeks of trading days
const RET_1M_LOOKBACK = 21
const RET_3M_LOOKBACK = 63
const SERIAL_HIGH_LOOKBACK_DAYS = RET_3M_LOOKBACK // "last 3 months" per the entry-filter spec
const BASE_LOOKBACK_MIN_DAYS = 30 // ~6 weeks
const BASE_LOOKBACK_MAX_DAYS = 40 // ~8 weeks
const DOLLAR_VOLUME_WINDOW = 20

// How many OTHER days in the trailing `SERIAL_HIGH_LOOKBACK_DAYS` window
// (excluding today) were ALSO a new 52-week high — 0 means today's high
// isn't a repeated/serial new-high maker, higher counts mean it's one of
// several recent highs. Returns null if there's not enough history to check
// the full window. Each candidate day's "prior high" uses whatever trailing
// history is actually available up to HIGH_LOOKBACK bars (same graceful-
// degradation approach as isNewHigh/daysSincePeakHigh above) rather than
// hard-requiring a full 252+63 bars, which this app's ~370-calendar-day
// Alpaca fetch (screener.js) never has — this trades a small amount of edge
// accuracy on the earliest days of the window for actually being computable
// at all, rather than being permanently null for every single stock.
function countNewHighsIn3Months(highSeries) {
  const n = highSeries.length
  if (n < SERIAL_HIGH_LOOKBACK_DAYS + 2) return null
  let count = 0
  for (let i = n - 1 - SERIAL_HIGH_LOOKBACK_DAYS; i < n - 1; i++) {
    if (i <= 0) continue
    const priorHigh = Math.max(...highSeries.slice(Math.max(0, i - HIGH_LOOKBACK), i))
    if (highSeries[i] >= priorHigh) count++ // a prior day in the window already made a new high
  }
  return count
}

// Numeric approximation of "base quality" over the ~6-8 week window
// immediately before the breakout day: how wide was the high-low range, and
// how many days does that span. This is NOT a substitute for actually
// looking at the chart — a tight numeric range can still hide a base that a
// discretionary trader would reject (broken prior trend, no higher lows,
// etc.) — so callers should always treat this as an estimate requiring
// visual verification, never a hard pass on its own. Returns null if there
// isn't enough pre-breakout history to measure.
function estimateBaseQuality(highSeries, lowSeries, peakAge) {
  const breakoutIdx = highSeries.length - 1 - peakAge
  const windowEnd = breakoutIdx
  const windowStart = Math.max(0, windowEnd - BASE_LOOKBACK_MAX_DAYS)
  const durationDays = windowEnd - windowStart
  if (durationDays < BASE_LOOKBACK_MIN_DAYS) return null
  const windowHighs = highSeries.slice(windowStart, windowEnd)
  const windowLows = lowSeries.slice(windowStart, windowEnd)
  const baseHigh = Math.max(...windowHighs)
  const baseLow = Math.min(...windowLows)
  if (baseLow <= 0) return null
  const rangePct = ((baseHigh - baseLow) / baseLow) * 100
  return { durationDays, rangePct, tight: rangePct <= 20 }
}

// Gap % and volume-vs-50-day-average SPECIFICALLY on the day price crossed
// the 52-week high (not today's bar, unless today IS that day — peakAge=0)
// — distinct from volRatioMaxN/volRatio50, which read the best/current day
// in a trailing window rather than anchoring to the actual breakout day.
function computeBreakoutDayMetrics(closes, opens, volumes, peakAge) {
  const idx = closes.length - 1 - peakAge
  if (idx <= 0) return { gapPct: null, volRatio50AtBreakout: null }
  const prevClose = closes[idx - 1]
  const gapPct = opens && opens[idx] != null && prevClose > 0
    ? ((opens[idx] - prevClose) / prevClose) * 100
    : null
  const volRatio50AtBreakout = idx + 1 >= 50 ? volumeRatio(volumes.slice(0, idx + 1), 50) : null
  return { gapPct, volRatio50AtBreakout }
}

function avgDollarVolume(closes, volumes, period = DOLLAR_VOLUME_WINDOW) {
  if (closes.length < period || volumes.length < period) return null
  const c = closes.slice(-period)
  const v = volumes.slice(-period)
  let sum = 0
  for (let i = 0; i < period; i++) sum += c[i] * v[i]
  return sum / period
}

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

  // evaluateStock()-specific metrics — not used by the legacy `strength`
  // tag above, kept only for back-compat with old filters.
  const newHighCountIn3Months = countNewHighsIn3Months(highSeries)
  const baseQuality = estimateBaseQuality(highSeries, lowSeries, peakAge)
  const { gapPct: breakoutGapPct, volRatio50AtBreakout } = computeBreakoutDayMetrics(closes, opens, volumes, peakAge)
  const extensionFrom50EmaPct = ema50 != null ? ((price - ema50) / ema50) * 100 : null
  const avgDollarVolume20 = avgDollarVolume(closes, volumes)
  // Confirmed unavailable from this app's data: Alpaca's free-tier fetch
  // (screener.js) only pulls ~370 calendar days of history, nowhere near
  // enough to know whether a 52-week high is also an ALL-TIME high — always
  // UNKNOWN, never guessed. See evaluateStock.js's own note on how this is
  // handled (never a hard fail, always surfaced for manual verification).
  const isAllTimeHigh = null

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
    newHighCountIn3Months,
    baseQuality,
    breakoutGapPct,
    volRatio50AtBreakout,
    extensionFrom50EmaPct,
    avgDollarVolume20,
    isAllTimeHigh,
    // Populated by classifyWeekHighResults / buildWeekHighTradePlans:
    rsRank: null,
    signalType: null,
    grade: null,
    earningsDaysAway: null,
    earningsDate: null,
    earningsSource: null,
    tradePlan: null,
    thesis: null,
    // Populated by classifyWeekHighResults / checkEarningsForResults — the
    // ONE evaluation object (see evaluateStock.js). grade/signalType above
    // are kept as flat fields too (mirrored from evaluation.grade/
    // .signalType) purely for back-compat with existing sort/filter code
    // and positionPlan.js's B-grade size scale on the separate "Build Trade
    // Plans" path — evaluation is the single source of truth they're copied
    // from, never computed independently.
    evaluation: null,
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

// Runs evaluateStock() for one result and mirrors grade/signalType onto flat
// r.grade/r.signalType fields — kept for back-compat with existing sort/
// filter code and positionPlan.js's B-grade size scale on the separate
// "Build Trade Plans" path. r.evaluation is the single source of truth
// they're copied from, never computed independently of it.
function applyEvaluation(r, marketContext) {
  const evaluation = evaluateStock(r, marketContext)
  r.evaluation = evaluation
  r.grade = evaluation.grade
  r.signalType = evaluation.signalType
}

// Attaches RS rank and runs evaluateStock() (grade/stage/verdict/sizing) for
// every scanned result. Deliberately does NOT fetch earnings here — that
// used to run against the entire scanned universe on every scan (thousands
// of Finnhub calls for a Total Market scan, well past the free tier's
// budget — see the earningsProvider fetch-failure tracking). Earnings is a
// separate, explicit step (see checkEarningsForResults) the user triggers
// after filtering down to the list they actually care about, so the
// Finnhub cost scales with "stocks I'm considering," not "stocks that
// happened to be in the scanned universe." Every result gets
// earningsSource: 'UNKNOWN' until that step runs — evaluateStock()'s Stage 0
// earnings check and factor 10 both already treat that as "don't know,
// don't hard-block, tell the user to verify."
// `marketContext` is `{ marketAbove50, sectorBySector, portfolioSize }` —
// see evaluateStock.js's fetchMarketRegime() for the first two.
export async function classifyWeekHighResults(results, marketContext) {
  computeWeekHighRsRanks(results)

  for (const r of results) {
    r.earningsDate = null
    r.earningsDaysAway = null
    r.earningsSource = 'UNKNOWN'
    applyEvaluation(r, marketContext)
  }

  return { results }
}

// Explicit, user-triggered earnings check — call this with whatever subset
// of results the user has already filtered down to (not necessarily the
// whole scan), typically right before deciding what to trade. Re-runs
// evaluateStock() afterward for each result, since earnings feeds both
// Stage 0 (a newly-discovered CONFIRMED date inside 3 trading days now
// hard-disqualifies) and Stage 2 factor 10. Mutates `results` in place;
// returns { fetchFailedCount } — see earningsProvider.js's getEarningsMap
// for what that counts.
export async function checkEarningsForResults(results, marketContext) {
  if (results.length === 0) return { fetchFailedCount: 0 }

  const { map: earningsMap, fetchFailedCount } = await getEarningsMap(results.map((r) => r.symbol))

  for (const r of results) {
    const earnings = earningsMap[r.symbol] ?? { date: null, daysAway: null, source: 'UNKNOWN' }
    r.earningsDate = earnings.date
    r.earningsDaysAway = earnings.daysAway
    r.earningsSource = earnings.source
    applyEvaluation(r, marketContext)
  }

  return { fetchFailedCount }
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

const THESIS_BREAKOUT_PCT_FROM_HIGH_MIN = -1 // "at or within 1% above" the 52w high
const THESIS_EARNINGS_AVOID_DAYS = 10

// Deterministic 3-sentence thesis built only from already-computed real
// numbers (no LLM, no invented figures): what the chart shows, why now, and
// what could go wrong. Independent of evaluateStock.js's own Stage 0/2
// earnings checks (different thresholds, different purpose) — this is
// display text for the separate "Build Trade Plans" feature, not a second
// eligibility opinion.
export function generateThesis(r) {
  const volTxt = r.volRatio20 != null ? `${r.volRatio20.toFixed(1)}x average volume` : 'unconfirmed volume'
  const sentence1 = r.newHigh || r.pctFromHigh >= THESIS_BREAKOUT_PCT_FROM_HIGH_MIN
    ? `${r.symbol} is breaking out to a new 52-week high near $${r.price.toFixed(2)} on ${volTxt}, with its EMA stack ${r.emaFullStack ? '10>20>50 aligned' : 'not yet fully aligned'} and the Alligator in its ${r.alligatorPhase} phase.`
    : `${r.symbol} is ${Math.abs(r.pctFromHigh).toFixed(1)}% below its 52-week high of $${r.high52w.toFixed(2)}, with RSI at ${r.rsiValue?.toFixed(0) ?? '?'} and ADX at ${r.adxValue?.toFixed(0) ?? '?'} (${r.adxValue != null && r.adxValue > 25 ? 'trending' : 'still developing'}).`

  const earningsTxt = r.earningsDaysAway != null
    ? `, with earnings ${r.earningsDaysAway} days out${r.earningsSource === 'ESTIMATED' ? ' (estimated)' : ''} — ${r.earningsDaysAway <= THESIS_EARNINGS_AVOID_DAYS ? 'verify before entry' : 'no near-term gap risk'}`
    : r.earningsSource === 'UNKNOWN' ? ', earnings date unavailable — verify before entry' : ''
  const sentence2 = `It ranks ${r.rsRank ?? '?'} on relative strength versus the scanned universe (${pctLabel(r.ret1m)} over 1 month, ${pctLabel(r.ret3m)} over 3 months)${earningsTxt}.`

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
// result is grade C/D or has earnings within the avoid window. Earnings and
// grade are already known by this point (classifyWeekHighResults populates
// both, batched, before this ever runs) — no per-ticker fetch or re-grade
// needed here anymore. Grade scale is A/B/C/D (evaluateStock.js) — D means
// "skip despite passing hard filters," refused here same as C.
async function attachTradePlan(r, portfolioOptions) {
  if (r.grade === 'C' || r.grade === 'D') {
    r.tradePlan = { viable: false, reason: `Grade ${r.grade} — do not trade` }
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
