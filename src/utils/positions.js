// Open-position tracking: a small localStorage-backed list (ticker, entry,
// shares, trim/stop state) plus a deterministic daily evaluator that
// recommends Hold/Trim/Exit/Add actions from the "FULL EXIT" and "TRIM /
// SCALE-OUT" rules. No LLM involved — Claude only narrates the result.
//
// Storage never auto-mutates from a recommendation; the UI has explicit
// "mark trim done" / "apply new stop" / "close" actions so real trade
// confirmations stay in the user's control.

import { sma, atr, ema, rsi, volumeRatio, pctChange } from './indicators'
import { ATR_STOP_MULT, TIME_STOP_DAYS, PARABOLIC_RSI, PARABOLIC_PCT_20D, selectStop, buildTrimPlan } from './positionPlan'
import { fetchBars, fetchEarningsCalendar } from './marketData'
import { detectBase } from './entrySignal'

const STORAGE_KEY = 'sniper-trades-open-positions'
const HEAVY_VOLUME_RATIO = 1.5
const GAP_DOWN_PCT = -4
const RETEST_BAND_PCT = 2

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export function loadPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function savePositions(positions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(positions))
}

// `plan` is a trim plan from positionPlan.js's buildTrimPlan; `stop` from
// selectStop. Stores everything needed to evaluate and manage the position
// going forward without re-deriving it from the original setup.
export function createPosition({ symbol, name, sector, grade, entryPrice, entryDate, breakoutLevel, shares, stop, plan }) {
  return {
    id: `${symbol}-${Date.now()}`,
    symbol,
    name,
    sector,
    grade,
    entryPrice,
    entryDate,
    breakoutLevel: breakoutLevel ?? entryPrice,
    shares,
    stopMethod: stop.method,
    currentStop: stop.stopPrice,
    trim1Price: plan.trim1.price,
    trim1Shares: plan.trim1.shares,
    trim1Done: false,
    trim2Price: plan.trim2.price,
    trim2Shares: plan.trim2.shares,
    trim2Done: false,
    trim3Shares: plan.trim3.shares,
    addedBack: false,
  }
}

// Best-effort sync to the Python scheduler's own Position table, deployed
// separately at https://sniper-trades.onrender.com (backend/app.py's
// /api/positions/manual), so the existing 2PM trim-check and 3:50PM
// stop/time-stop jobs pick this position up and email trim/stop
// suggestions on their normal schedule — this app's own localStorage
// tracking only evaluates while this page is open. Failure here (backend
// unreachable, etc.) never blocks the local add — it only means scheduled
// email alerts won't fire for this position.
async function syncManualPositionToBackend({ symbol, entryPrice, shares, entryDate, grade, sector }) {
  try {
    const res = await fetch('https://sniper-trades.onrender.com/api/positions/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: symbol, entry_price: entryPrice, shares, entry_date: entryDate, grade, sector_etf: sector }),
    })
    return res.ok
  } catch {
    return false
  }
}

// Fetches the symbol's bars, derives a stop and trim plan, and builds a
// position record — the shared logic behind the "add position" form on
// the Open Positions tab. Throws if there's insufficient history or no
// viable stop, same as the inline version this replaced.
export async function addPositionFromEntry({ symbol, entryPrice, shares, entryDate, grade, sector }) {
  const bars = await fetchBars(symbol)
  if (bars.length < 30) throw new Error('Insufficient price history for this symbol')

  const closes = bars.map((b) => b.c)
  const lows = bars.map((b) => b.l)
  const low10Day = Math.min(...lows.slice(-10))
  const ema21 = ema(closes, 21)
  const baseLow = detectBase(bars).baseLow ?? null
  const atr14 = atr(bars, 14)

  const stop = selectStop({ price: entryPrice, low10Day, ema21, baseLow, atr14 })
  if (!stop.viable) throw new Error(stop.reason)

  const plan = buildTrimPlan({ price: entryPrice, stopPrice: stop.stopPrice, shares, atr14 })
  const position = createPosition({
    symbol, name: symbol, sector: sector || 'Unknown', grade,
    entryPrice, entryDate, breakoutLevel: entryPrice, shares, stop, plan,
  })

  position.backendTracked = await syncManualPositionToBackend({ symbol, entryPrice, shares, entryDate, grade, sector })
  return position
}

export function upsertPosition(positions, position) {
  const idx = positions.findIndex((p) => p.id === position.id)
  if (idx === -1) return [...positions, position]
  const next = [...positions]
  next[idx] = position
  return next
}

export function removePosition(positions, id) {
  return positions.filter((p) => p.id !== id)
}

function tradingDaysSince(bars, entryDate) {
  return bars.filter((b) => (b.t || '').slice(0, 10) > entryDate).length
}

// `bars` is daily OHLCV for `position.symbol` (chronological, today last).
// `marketContext` is { spyAbove200, vixCurrent, earningsWithin48h }. Returns
// a full read of where the position stands today and what to do about it —
// every field computed from real data; nothing here writes back to storage.
export function evaluatePosition(position, bars, marketContext = {}) {
  const closes = bars.map((b) => b.c)
  const lows = bars.map((b) => b.l)
  const volumes = bars.map((b) => b.v)
  const price = closes[closes.length - 1]
  const today = bars[bars.length - 1]
  const yesterday = bars[bars.length - 2]

  const atr14 = atr(bars, 14)
  const sma50 = sma(closes, 50)
  const avgVolume20 = sma(volumes, 20)
  const volRatio = volumeRatio(volumes, 20)
  const rsiValue = rsi(closes, 14)
  const pct20Day = pctChange(closes, 20)
  const daysHeld = tradingDaysSince(bars, position.entryDate)
  const plPct = ((price - position.entryPrice) / position.entryPrice) * 100

  const stage = position.trim2Done ? 'POST_TRIM2' : position.trim1Done ? 'POST_TRIM1' : 'PRE_TRIM1'
  const atrTrailStopToday = atr14 != null ? round(price - ATR_STOP_MULT * atr14) : null

  // The stop only ratchets up — never recommend a level below what's stored.
  let activeStop = position.currentStop
  if (stage === 'POST_TRIM2' && atrTrailStopToday != null) {
    activeStop = Math.max(activeStop, atrTrailStopToday)
  }

  const exitSignals = []
  if (price <= activeStop) {
    exitSignals.push(
      stage === 'POST_TRIM2'
        ? `Daily close $${price.toFixed(2)} below ATR trailing stop $${activeStop.toFixed(2)}`
        : `Daily close $${price.toFixed(2)} below stop $${activeStop.toFixed(2)}`
    )
  }
  if (sma50 != null && price < sma50 && volRatio != null && volRatio >= HEAVY_VOLUME_RATIO) {
    exitSignals.push(`Closed below 50-day MA $${sma50.toFixed(2)} on ${volRatio.toFixed(2)}x volume`)
  }
  if (today && yesterday && yesterday.c > 0) {
    const gapPct = ((today.o - yesterday.c) / yesterday.c) * 100
    if (gapPct <= GAP_DOWN_PCT) {
      exitSignals.push(`Gapped down ${gapPct.toFixed(1)}% — verify if earnings/news related`)
    }
  }
  if (marketContext.spyAbove200 === false) {
    exitSignals.push('SPY closed below its 200-day MA')
  }
  if (marketContext.vixCurrent != null && marketContext.vixCurrent > 30) {
    exitSignals.push(`VIX at ${marketContext.vixCurrent.toFixed(1)} (> 30) — cut all positions 50% at market`)
  }
  if (closes.length >= 4) {
    const [c3, c2, c1] = closes.slice(-3)
    const threeDown = c3 > c2 && c2 > c1
    const low10 = Math.min(...lows.slice(-11, -1))
    if (threeDown && price < low10) {
      exitSignals.push(`3 consecutive down closes and below the 10-day low $${low10.toFixed(2)}`)
    }
  }
  if (daysHeld >= TIME_STOP_DAYS && !position.trim1Done) {
    exitSignals.push(`Time stop: ${daysHeld} trading days with no progress to Trim 1`)
  }
  if (marketContext.earningsWithin48h) {
    exitSignals.push('Earnings within 48 hours')
  }

  const parabolic = rsiValue != null && pct20Day != null && rsiValue > PARABOLIC_RSI && pct20Day > PARABOLIC_PCT_20D
  const partialExitSignal = parabolic
    ? `Parabolic: RSI ${rsiValue.toFixed(0)}, up ${pct20Day.toFixed(0)}% in 20 days — sell 25% more immediately`
    : null

  const retestAddEligible = position.grade === 'A+'
    && position.trim1Done && !position.trim2Done && !position.addedBack
    && Math.abs((price - position.breakoutLevel) / position.breakoutLevel) * 100 <= RETEST_BAND_PCT
    && avgVolume20 != null && (volumes[volumes.length - 1] ?? 0) < avgVolume20

  let action = 'HOLD'
  if (exitSignals.length > 0) action = 'EXIT'
  else if (!position.trim1Done && price >= position.trim1Price) action = 'TRIM 1'
  else if (position.trim1Done && !position.trim2Done && price >= position.trim2Price) action = 'TRIM 2'
  else if (retestAddEligible) action = 'ADD ON RETEST'
  else if (partialExitSignal) action = 'TRIM (PARABOLIC)'

  const nextTrim = !position.trim1Done
    ? { label: 'Trim 1', price: position.trim1Price, shares: position.trim1Shares }
    : !position.trim2Done
      ? { label: 'Trim 2', price: position.trim2Price, shares: position.trim2Shares }
      : { label: 'Trim 3 (trail)', price: atrTrailStopToday, shares: position.trim3Shares }

  return {
    symbol: position.symbol,
    currentPrice: round(price),
    plPct: round(plPct),
    daysHeld,
    stage,
    atr14: round(atr14),
    activeStop: round(activeStop),
    atrTrailStopToday,
    nextTrim,
    exitSignals,
    forceExit: exitSignals.length > 0,
    partialExitSignal,
    retestAddEligible,
    action,
  }
}

// Fetches bars + a 48-hour earnings check for every open position and
// evaluates each one. `marketContext` should already carry `spyAbove200`
// and `vixCurrent` (from getMarketCondition) — those are shared across all
// positions, not refetched per symbol. Positions whose data can't be
// fetched are returned with `{ error }` instead of an evaluation.
export async function evaluateOpenPositions(positions, marketContext = {}) {
  const results = []

  for (const position of positions) {
    try {
      const [bars, earnings] = await Promise.all([
        fetchBars(position.symbol),
        fetchEarningsCalendar(position.symbol, 0, 2),
      ])
      const earningsWithin48h = Array.isArray(earnings) && earnings.length > 0
      results.push({
        position,
        evaluation: evaluatePosition(position, bars, { ...marketContext, earningsWithin48h }),
      })
    } catch (err) {
      results.push({ position, error: err.message })
    }
  }

  return results
}
