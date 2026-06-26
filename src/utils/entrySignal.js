// Deterministic Stage 4 entry-type classifier — replaces the old approach of
// handing Claude the last 10 daily candles and asking it to eyeball a
// breakout vs. pullback vs. base setup. Everything here (volume ratios,
// candle body/wick math, time-of-day windows, base contraction) is plain
// arithmetic on OHLCV, so there's no need for an LLM in the loop.
//
// Mirrors the trading rules verbatim:
//   TYPE 1 — Breakout: limit at pivot + $0.10, needs 1.5x daily-avg volume in
//            the first 90 minutes confirmed by 11am ET, no entries after 2pm
//            ET or on Monday's open, cancel if >5% above pivot.
//   TYPE 2 — Pullback to 10/21 EMA (preferred): limit at the EMA price, low
//            volume + small-bodied candles during the pullback, a trigger
//            candle (hammer / bullish engulfing / break of prior-day high),
//            entry windows 10:30-11:30am or 2-3:30pm ET, abandon after 7 days
//            with no trigger.
//   TYPE 3 — Base breakout (VCP/flat/cup): $0.05 above the base pivot on a
//            closing basis, needs 2x 50-day-avg volume confirmed by 3pm ET,
//            flags a retest 3-5 days later on low volume as an add-on.
//
// Plus global timing rules applied to all three types: never in the first 30
// minutes, never Friday after 2pm ET, never the day before a major macro
// event, Tue-Thu preferred, and abandon (don't chase) if price has already
// run more than 3% past the computed entry price.

import { ema, sma, volumeRatio } from './indicators'
import { getEasternTime, MARKET_OPEN_MIN } from './marketTime'
import { isDayBeforeMajorEvent } from './economicCalendar'

const PULLBACK_EMA_TOLERANCE_PCT = 1.5 // price must be within this % of the EMA to count as "at" it
const PULLBACK_MAX_BODY_PCT = 1.5
const PULLBACK_ABANDON_DAYS = 7
const PULLBACK_WINDOWS = [[630, 690], [840, 930]] // 10:30-11:30am, 2:00-3:30pm ET
const BREAKOUT_WINDOWS = [[570, 840]] // 9:30am-2:00pm ET
const BREAKOUT_CUTOFF_MIN = 840 // 2:00pm
const BREAKOUT_FIRST_90_END_MIN = 660 // 9:30 + 90min = 11:00am
const BREAKOUT_CONFIRM_BY_MIN = 660 // 11:00am
const BREAKOUT_MAX_EXTENSION_PCT = 5
const BASE_BREAKOUT_VOLUME_MULT = 2
const BASE_BREAKOUT_CONFIRM_BY_MIN = 900 // 3:00pm
const BASE_LOOKBACK_DAYS = 50
const BASE_MIN_LENGTH_DAYS = 15
const RETEST_LOOKBACK_DAYS = 5

const FIRST_HALF_HOUR_END_MIN = MARKET_OPEN_MIN + 30 // 10:00am
const FRIDAY_AFTERNOON_CUTOFF_MIN = 840 // 2:00pm
const MISSED_ENTRY_MAX_PCT = 3
const PREFERRED_DAYS = [2, 3, 4] // Tue, Wed, Thu
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function inAnyWindow(minutes, windows) {
  return windows.some(([start, end]) => minutes >= start && minutes <= end)
}

function bodyPct(bar) {
  return bar.c ? (Math.abs(bar.c - bar.o) / bar.c) * 100 : 0
}

function rangePct(bar) {
  return bar.c ? ((bar.h - bar.l) / bar.c) * 100 : 0
}

function isBullish(bar) {
  return bar.c > bar.o
}

// Small real body in the upper part of the range, a lower wick at least 2x
// the body, and a negligible upper wick.
function isHammer(bar) {
  const body = Math.abs(bar.c - bar.o)
  const range = bar.h - bar.l
  if (range <= 0) return false
  const lowerWick = Math.min(bar.o, bar.c) - bar.l
  const upperWick = bar.h - Math.max(bar.o, bar.c)
  return lowerWick >= 2 * body && upperWick <= body * 0.5 && body / range <= 0.35
}

// Today's bullish body fully contains yesterday's bearish body.
function isBullishEngulfing(prev, bar) {
  return isBullish(bar) && prev.c < prev.o && bar.o <= prev.c && bar.c >= prev.o
}

function brokePriorHigh(prev, bar) {
  return bar.c > prev.h
}

// Looks for today's bar acting as a Type-2 trigger candle: a volume spike
// (>=1.2x the trailing 30-day average, excluding today) on a bullish close
// that's either a hammer, a bullish engulfing bar, or a close above the
// prior day's high.
function detectTriggerCandle(bars) {
  const n = bars.length
  if (n < 2) return { isTrigger: false, unknown: true }

  const bar = bars[n - 1]
  const prev = bars[n - 2]
  const trailing = bars.slice(Math.max(0, n - 31), n - 1)
  if (trailing.length < 10) return { isTrigger: false, unknown: true }

  const avgVol = trailing.reduce((sum, b) => sum + b.v, 0) / trailing.length
  const volRatio = avgVol > 0 ? bar.v / avgVol : 0
  const volumeSpike = volRatio >= 1.2
  const bullish = isBullish(bar)
  const hammer = isHammer(bar)
  const engulfing = isBullishEngulfing(prev, bar)
  const brokeHigh = brokePriorHigh(prev, bar)

  return {
    isTrigger: bullish && volumeSpike && (hammer || engulfing || brokeHigh),
    bullish,
    volumeSpike,
    volRatio,
    hammer,
    engulfing,
    brokeHigh,
  }
}

// Number of consecutive bars (ending at the most recent) since price last
// closed at a new `lookback`-day high — used to gauge how many days into a
// pullback the stock is, for the Type-2 7-day abandon rule.
function daysSincePeak(bars, lookback = 20) {
  const recent = bars.slice(-lookback)
  let peakIdx = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].c >= recent[peakIdx].c) peakIdx = i
  }
  return recent.length - 1 - peakIdx
}

// Approximates a VCP/flat-base/cup: splits the lookback window into thirds
// and checks that both the daily range and volume have contracted from the
// first third to the last. The pivot is the window's high, `baseLow` its low
// (used by the Option C stop-loss method — below the base/pivot low).
export function detectBase(bars, lookback = BASE_LOOKBACK_DAYS) {
  const recent = bars.slice(-lookback)
  if (recent.length < BASE_MIN_LENGTH_DAYS) return { hasBase: false }

  const pivot = Math.max(...recent.map((b) => b.h))
  const baseLow = Math.min(...recent.map((b) => b.l))
  const third = Math.floor(recent.length / 3)
  const avg = (arr) => (arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : 0)

  const ranges = recent.map(rangePct)
  const r1 = avg(ranges.slice(0, third))
  const r2 = avg(ranges.slice(third, third * 2))
  const r3 = avg(ranges.slice(third * 2))
  const contracting = r3 < r1 && r2 <= r1 * 1.1 && r3 <= r2 * 1.05

  const vols = recent.map((b) => b.v)
  const v1 = avg(vols.slice(0, third))
  const v3 = avg(vols.slice(third * 2))
  const volumeDryingUp = v3 < v1

  return {
    hasBase: contracting && volumeDryingUp,
    pivot,
    baseLow,
    baseLengthDays: recent.length,
    contracting,
    volumeDryingUp,
  }
}

// Sums intraday volume-by-minute entries up to (and including) `cutoffMin`.
function intradayVolumeUpTo(intraday, cutoffMin) {
  if (!intraday) return null
  return intraday.volumeByMinute.filter((b) => b.etMinutes <= cutoffMin).reduce((sum, b) => sum + b.v, 0)
}

function dayLabel(dayOfWeek) {
  return DAY_NAMES[dayOfWeek] ?? '?'
}

// Timing rules that apply identically to all three entry types: no entries
// in the first 30 minutes, no Friday-afternoon entries, and no entries the
// day before a major macro release. Returns hard `blocks` (invalidate the
// signal) and soft `notes` (informational, e.g. day-of-week preference).
function globalTimingGates(et, now) {
  const blocks = []
  const notes = []

  if (et.isWeekday && et.totalMinutes >= MARKET_OPEN_MIN && et.totalMinutes < FIRST_HALF_HOUR_END_MIN) {
    blocks.push('Within the first 30 minutes of the open (9:30-10:00am ET) — wait for the open to settle')
  }
  if (et.dayOfWeek === 5 && et.totalMinutes > FRIDAY_AFTERNOON_CUTOFF_MIN) {
    blocks.push('Friday after 2:00pm ET — no new entries into the close')
  }
  if (isDayBeforeMajorEvent(now)) {
    blocks.push('Tomorrow is a major market event (FOMC/CPI/PPI/NFP/PCE/ISM) — no new entries today')
  }
  if (et.isWeekday && !PREFERRED_DAYS.includes(et.dayOfWeek)) {
    notes.push(`${dayLabel(et.dayOfWeek)} entry — Tuesday-Thursday is preferred`)
  }

  return { blocks, notes }
}

// "If you miss the entry by >3%, wait — another pullback will come." Applies
// to all three types against their own computed entry price.
function missedEntryGate(price, entryPrice) {
  if (entryPrice == null) return { missed: false, pct: null }
  const pct = ((price - entryPrice) / entryPrice) * 100
  return { missed: pct > MISSED_ENTRY_MAX_PCT, pct }
}

// `bars` is chronological daily OHLCV (today/most-recent last). `intraday` is
// the result of fetchIntradayVolume(symbol) or null if unavailable. `now`
// defaults to the real current time; pass an override only for testing.
export function classifyEntrySignal(bars, intraday, now = new Date()) {
  if (bars.length < BASE_MIN_LENGTH_DAYS) {
    return { type: 'NONE', valid: false, reasons: ['Insufficient history for entry classification'], unknowns: [] }
  }

  const closes = bars.map((b) => b.c)
  const price = closes[closes.length - 1]
  const ema10 = ema(closes, 10)
  const ema21 = ema(closes, 21)
  const avgVolume20 = sma(bars.map((b) => b.v), 20)
  const volRatio50 = volumeRatio(bars.map((b) => b.v), 50)

  const et = getEasternTime(now)
  const trigger = detectTriggerCandle(bars)
  const base = detectBase(bars)
  const peakAge = daysSincePeak(bars)
  const globalGates = globalTimingGates(et, now)

  const unknowns = []
  if (intraday == null) unknowns.push('Intraday volume unavailable (outside market hours, or fetch failed) — verify volume confirmation manually')

  // ── Type 2: pullback to 10/21 EMA (preferred) ──
  const distTo10 = ema10 != null ? Math.abs((price - ema10) / ema10) * 100 : null
  const distTo21 = ema21 != null ? Math.abs((price - ema21) / ema21) * 100 : null
  const nearEma10 = distTo10 != null && distTo10 <= PULLBACK_EMA_TOLERANCE_PCT
  const nearEma21 = distTo21 != null && distTo21 <= PULLBACK_EMA_TOLERANCE_PCT

  if ((nearEma10 || nearEma21) && peakAge >= 1) {
    const useEma10 = nearEma10 && (!nearEma21 || (distTo10 ?? Infinity) <= (distTo21 ?? Infinity))
    const emaPrice = useEma10 ? ema10 : ema21
    const emaLabel = useEma10 ? '10 EMA' : '21 EMA'

    const pullbackBars = bars.slice(-Math.min(peakAge + 1, bars.length))
    const pullbackVolRatio = avgVolume20 > 0
      ? pullbackBars.reduce((sum, b) => sum + b.v, 0) / pullbackBars.length / avgVolume20
      : null
    const lowVolume = pullbackVolRatio != null && pullbackVolRatio < 1.0
    const smallBodied = pullbackBars.every((b) => bodyPct(b) < PULLBACK_MAX_BODY_PCT)
    const inWindow = inAnyWindow(et.totalMinutes, PULLBACK_WINDOWS)
    const abandoned = peakAge > PULLBACK_ABANDON_DAYS && !trigger.isTrigger

    const missed = missedEntryGate(price, emaPrice)

    const r2 = [...globalGates.blocks]
    if (!lowVolume) r2.push(pullbackVolRatio != null ? `Pullback volume ${pullbackVolRatio.toFixed(2)}x 20d avg (need < 1.0x)` : 'Pullback volume unavailable')
    if (!smallBodied) r2.push(`Pullback candle bodies exceed ${PULLBACK_MAX_BODY_PCT}% range`)
    if (!trigger.isTrigger) r2.push(trigger.unknown ? 'Trigger candle unavailable' : 'No trigger candle yet (volume spike + bullish hammer/engulfing/break-of-high)')
    if (!inWindow && !et.isWeekday) r2.push('Market closed — not a valid entry window')
    else if (!inWindow) r2.push(`Outside entry window (need 10:30-11:30am or 2:00-3:30pm ET, now ${et.hour}:${String(et.minute).padStart(2, '0')} ET)`)
    if (abandoned) r2.push(`No trigger by day ${peakAge} of pullback (abandon after day ${PULLBACK_ABANDON_DAYS})`)
    if (missed.missed) r2.push(`Missed entry by ${missed.pct.toFixed(1)}% above $${emaPrice.toFixed(2)} — wait for another pullback, don't chase`)

    return {
      type: 'PULLBACK',
      valid: !abandoned && lowVolume && smallBodied && trigger.isTrigger && inWindow && globalGates.blocks.length === 0 && !missed.missed,
      entryPrice: emaPrice,
      entryLabel: `Limit at ${emaLabel} ($${emaPrice.toFixed(2)})`,
      pullbackDays: peakAge,
      pullbackVolRatio,
      triggerCandle: trigger,
      reasons: r2,
      unknowns,
      notes: globalGates.notes,
    }
  }

  // ── Type 3: base breakout (VCP / flat base / cup) ──
  if (base.hasBase && price >= base.pivot * 0.97) {
    const entryPrice = base.pivot + 0.05
    const closedAboveTrigger = price > entryPrice
    const volumeConfirmed = volRatio50 != null && volRatio50 >= BASE_BREAKOUT_VOLUME_MULT

    const requiredByCutoff = avgVolume20 != null
      ? avgVolume20 * BASE_BREAKOUT_VOLUME_MULT * ((BASE_BREAKOUT_CONFIRM_BY_MIN - 570) / (960 - 570))
      : null
    const volumeSoFar = intradayVolumeUpTo(intraday, BASE_BREAKOUT_CONFIRM_BY_MIN)
    const paceConfirmed = et.totalMinutes < BASE_BREAKOUT_CONFIRM_BY_MIN
      ? null // too early in the day to judge pace
      : volumeSoFar != null && requiredByCutoff != null ? volumeSoFar >= requiredByCutoff : null

    const missed = missedEntryGate(price, entryPrice)

    const r3 = [...globalGates.blocks]
    if (!closedAboveTrigger) r3.push(`Price $${price.toFixed(2)} hasn't closed above $${entryPrice.toFixed(2)} (pivot $${base.pivot.toFixed(2)} + $0.05)`)
    if (!volumeConfirmed) r3.push(volRatio50 != null ? `Volume ${volRatio50.toFixed(2)}x 50d avg (need >= ${BASE_BREAKOUT_VOLUME_MULT}x)` : 'Volume vs 50d avg unavailable')
    if (paceConfirmed === false) r3.push('Volume pace not on track for 2x avg by 3pm ET — do not enter')
    if (paceConfirmed === null && et.totalMinutes >= BASE_BREAKOUT_CONFIRM_BY_MIN) unknowns.push('Could not verify 3pm ET volume pace — verify manually')
    if (missed.missed) r3.push(`Missed entry by ${missed.pct.toFixed(1)}% above $${entryPrice.toFixed(2)} — wait for another pullback, don't chase`)

    // Retest add-on: a breakout in the last few days followed by a pullback
    // toward the pivot on lighter volume — informational, not a new entry.
    const recentBars = bars.slice(-RETEST_LOOKBACK_DAYS - 1)
    const breakoutBar = recentBars.find((b) => b.c > base.pivot + 0.05)
    const retestWatch = !!breakoutBar
      && price <= base.pivot * 1.02 && price >= base.pivot * 0.98
      && avgVolume20 != null && bars[bars.length - 1].v < avgVolume20

    return {
      type: 'BASE_BREAKOUT',
      valid: closedAboveTrigger && volumeConfirmed && paceConfirmed !== false && globalGates.blocks.length === 0 && !missed.missed,
      entryPrice,
      entryLabel: `$0.05 above base pivot $${base.pivot.toFixed(2)} on a closing basis`,
      baseLengthDays: base.baseLengthDays,
      retestWatch,
      reasons: r3,
      unknowns,
      notes: globalGates.notes,
    }
  }

  // ── Type 1: breakout ──
  const shortLookback = bars.slice(-20, -1)
  const pivot = shortLookback.length ? Math.max(...shortLookback.map((b) => b.h)) : null

  if (pivot != null && price >= pivot * 0.95) {
    const entryPrice = pivot + 0.1
    const extensionPct = ((price - pivot) / pivot) * 100
    const tooExtended = extensionPct > BREAKOUT_MAX_EXTENSION_PCT

    const requiredFirst90 = avgVolume20 != null ? avgVolume20 * 1.5 * (90 / 390) : null
    const volumeFirst90 = intraday
      ? intraday.volumeByMinute.filter((b) => b.etMinutes <= BREAKOUT_FIRST_90_END_MIN).reduce((sum, b) => sum + b.v, 0)
      : null
    const volumeConfirmedBy11 = et.totalMinutes < BREAKOUT_CONFIRM_BY_MIN
      ? null
      : volumeFirst90 != null && requiredFirst90 != null ? volumeFirst90 >= requiredFirst90 : null

    const isMondayOpen = et.dayOfWeek === 1 && et.totalMinutes <= 600 // Monday, before 10am
    const afterCutoff = et.totalMinutes > BREAKOUT_CUTOFF_MIN
    const inWindow = inAnyWindow(et.totalMinutes, BREAKOUT_WINDOWS) && !isMondayOpen
    const missed = missedEntryGate(price, entryPrice)

    const r1 = [...globalGates.blocks]
    if (tooExtended) r1.push(`${extensionPct.toFixed(1)}% above pivot $${pivot.toFixed(2)} (cancel if > ${BREAKOUT_MAX_EXTENSION_PCT}%)`)
    if (isMondayOpen) r1.push("Monday open — gaps fade too often, skip")
    if (afterCutoff) r1.push('After 2:00pm ET — wait for next morning open')
    if (volumeConfirmedBy11 === false) r1.push('Volume not at 1.5x daily avg in the first 90 minutes — not confirmed by 11am ET')
    if (volumeConfirmedBy11 === null && et.totalMinutes >= BREAKOUT_CONFIRM_BY_MIN) unknowns.push('Could not verify 11am ET volume confirmation — verify manually')
    if (!et.isWeekday) r1.push('Market closed today')
    if (missed.missed) r1.push(`Missed entry by ${missed.pct.toFixed(1)}% above $${entryPrice.toFixed(2)} — wait for another pullback, don't chase`)

    return {
      type: 'BREAKOUT',
      valid: !tooExtended && !isMondayOpen && !afterCutoff && volumeConfirmedBy11 !== false && et.isWeekday && inWindow
        && globalGates.blocks.length === 0 && !missed.missed,
      entryPrice,
      entryLabel: `Limit at pivot $${pivot.toFixed(2)} + $0.10 = $${entryPrice.toFixed(2)}`,
      extensionPct,
      reasons: r1,
      unknowns,
      notes: globalGates.notes,
    }
  }

  return {
    type: 'NONE',
    valid: false,
    reasons: ['No breakout, pullback, or base setup detected today'],
    unknowns,
    notes: globalGates.notes,
    debug: { dayLabel: dayLabel(et.dayOfWeek) },
  }
}
