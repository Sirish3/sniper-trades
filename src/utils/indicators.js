export function sma(values, period) {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

export function emaSeries(values, period) {
  const result = new Array(values.length).fill(null)
  if (values.length < period) return result
  const k = 2 / (period + 1)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  result[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    result[i] = prev
  }
  return result
}

export function ema(values, period) {
  const series = emaSeries(values, period)
  return series[series.length - 1]
}

// True if the `period`-EMA is higher now than it was `lookback` bars ago, or
// null if there isn't enough history to compare.
export function emaSlopeUp(values, period, lookback = 5) {
  const series = emaSeries(values, period)
  const n = series.length
  const priorIndex = n - 1 - lookback
  if (priorIndex < 0 || series[n - 1] == null || series[priorIndex] == null) return null
  return series[n - 1] > series[priorIndex]
}

// Resamples daily bars (each `{ t, c }`, chronological) into one close per
// ISO week (Monday-keyed), taking the last close seen in each week.
export function weeklyCloses(bars) {
  const weeks = new Map()
  for (const bar of bars) {
    const d = new Date(bar.t)
    const day = d.getUTCDay() || 7 // Monday=1 .. Sunday=7
    const monday = new Date(d)
    monday.setUTCDate(d.getUTCDate() - (day - 1))
    weeks.set(monday.toISOString().slice(0, 10), bar.c)
  }
  return [...weeks.values()]
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null
  const changes = []
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1])

  let avgGain = 0
  let avgLoss = 0
  for (let i = 0; i < period; i++) {
    const c = changes[i]
    if (c > 0) avgGain += c
    else avgLoss -= c
  }
  avgGain /= period
  avgLoss /= period

  for (let i = period; i < changes.length; i++) {
    const c = changes[i]
    const gain = c > 0 ? c : 0
    const loss = c < 0 ? -c : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// Latest volume as a multiple of its trailing average (e.g. 1.5 = 1.5x the
// `period`-day average volume). Returns 0 if the average is 0.
export function volumeRatio(volumes, period = 20) {
  if (volumes.length < period) return null
  const avg = volumes.slice(-period).reduce((a, b) => a + b, 0) / period
  if (avg === 0) return 0
  return volumes[volumes.length - 1] / avg
}

// Highest single-day volumeRatio() over the most recent `lookbackDays` bars
// (0 = today), with which day it occurred. Lets a breakout's volume
// confirmation survive a quiet "digestion" day without losing it to a
// random high-volume day from weeks ago — the window is intentionally tight.
export function maxVolumeRatioOverWindow(volumes, period = 20, lookbackDays = 5) {
  let best = null
  for (let i = 0; i < lookbackDays; i++) {
    const idx = volumes.length - 1 - i
    if (idx < 0) break
    const ratio = volumeRatio(volumes.slice(0, idx + 1), period)
    if (ratio == null) continue
    if (best == null || ratio > best.ratio) best = { ratio, daysAgo: i }
  }
  return best
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null

  const fastEma = emaSeries(closes, fast)
  const slowEma = emaSeries(closes, slow)
  const macdLine = closes
    .map((_, i) => (fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null))
    .filter((v) => v != null)

  const signalSeries = emaSeries(macdLine, signalPeriod)

  const n = macdLine.length
  const value = macdLine[n - 1]
  const signal = signalSeries[n - 1]
  const prevValue = macdLine[n - 2]
  const prevSignal = signalSeries[n - 2]
  const prevValue2 = macdLine[n - 3]
  const prevSignal2 = signalSeries[n - 3]

  return {
    value,
    signal,
    histogram: value - signal,
    prevValue,
    prevSignal,
    histPrev: prevValue - prevSignal,
    histPrev2: prevValue2 - prevSignal2,
  }
}

// Histogram-as-%-of-price thresholds and their entry-zone scores.
const MACD_PCT_ZONES = [
  [0.05, 'FRESH CROSS — very early entry', 85],
  [0.15, 'SWEET SPOT ✅ — best entry zone', 100],
  [0.25, 'VALID — slightly extended', 75],
  [0.4, 'LATE — most move done', 30],
]

export const MACD_VALID_ENTRY_SCORE_MIN = 75

// Scores how good an entry the current MACD histogram represents, as a
// percentage of price, with a momentum adjustment based on the last 3
// histogram bars. Mirrors sp500_scanner/analysis/macd_pct.py — this catches
// a fresh MACD cross and the 1-2 days following it, instead of requiring the
// literal crossing bar.
export function macdPct(macdData, price) {
  const { value: macdNow, signal: signalNow, histogram: histNow, histPrev, histPrev2 } = macdData

  const histPct = (histNow / price) * 100
  const histGrowing = histNow > histPrev
  const histShrinking = histNow < histPrev

  let growingBars = 0
  if (histNow > histPrev) growingBars += 1
  if (histPrev > histPrev2) growingBars += 1

  let zone
  let score
  if (histPct <= 0) {
    zone = 'BEARISH — MACD below signal'
    score = 0
  } else {
    const matched = MACD_PCT_ZONES.find(([threshold]) => histPct <= threshold)
    if (matched) {
      ;[, zone, score] = matched
    } else {
      zone = 'TOO EXTENDED — avoid new entry'
      score = 0
    }
  }

  let momentumLabel
  if (histGrowing && growingBars >= 2) {
    score += 10
    momentumLabel = 'ACCELERATING ✅'
  } else if (histGrowing) {
    score += 5
    momentumLabel = 'GROWING'
  } else {
    score -= 20
    momentumLabel = 'FADING ⚠️'
  }

  score = Math.max(0, Math.min(100, score))

  const gapPct = signalNow === 0 ? 0 : ((macdNow - signalNow) / Math.abs(signalNow)) * 100
  const validEntry = score >= MACD_VALID_ENTRY_SCORE_MIN && histPct > 0

  return { histPct, gapPct, histGrowing, histShrinking, growingBars, zone, score, momentumLabel, validEntry }
}

export function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  const mean = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
  const sd = Math.sqrt(variance)
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd }
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null
  const trueRanges = []
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]
    const prev = bars[i - 1]
    trueRanges.push(
      Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c))
    )
  }
  let value = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trueRanges.length; i++) {
    value = (value * (period - 1) + trueRanges[i]) / period
  }
  return value
}

// Nearest swing high above price (resistance) and swing low below price
// (support) within the lookback window, falling back to the window's
// overall high/low if price is already outside that range.
export function findSupportResistance(bars, lookback = 60) {
  const recent = bars.slice(-lookback)
  const price = recent[recent.length - 1].c
  const highs = recent.map((b) => b.h)
  const lows = recent.map((b) => b.l)

  const above = highs.filter((h) => h > price)
  const below = lows.filter((l) => l < price)

  const resistance = above.length ? Math.min(...above) : Math.max(...highs)
  const support = below.length ? Math.max(...below) : Math.min(...lows)

  return { support, resistance }
}

export function pctChange(values, period) {
  if (values.length < period + 1) return null
  const start = values[values.length - 1 - period]
  const end = values[values.length - 1]
  return ((end - start) / start) * 100
}

// Wilder's running average: first value is a simple sum over `period`, each
// later value decays the prior sum by 1/period before adding the new term.
function wilderSum(values, period) {
  const result = new Array(values.length).fill(null)
  if (values.length < period) return result
  let sum = values.slice(0, period).reduce((a, b) => a + b, 0)
  result[period - 1] = sum
  for (let i = period; i < values.length; i++) {
    sum = sum - sum / period + values[i]
    result[i] = sum
  }
  return result
}

// Average Directional Index (14-period default) from daily highs/lows/closes,
// using Wilder's smoothing. Returns null if there isn't enough history
// (needs roughly 2*period+1 bars).
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length
  if (n < period * 2 + 1) return null

  const plusDM = []
  const minusDM = []
  const tr = []

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1]
    const downMove = lows[i - 1] - lows[i]
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }

  const trSmoothed = wilderSum(tr, period)
  const plusDMSmoothed = wilderSum(plusDM, period)
  const minusDMSmoothed = wilderSum(minusDM, period)

  const dx = []
  for (let i = period - 1; i < tr.length; i++) {
    if (!trSmoothed[i]) continue
    const plusDI = (plusDMSmoothed[i] / trSmoothed[i]) * 100
    const minusDI = (minusDMSmoothed[i] / trSmoothed[i]) * 100
    const diSum = plusDI + minusDI
    dx.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100)
  }

  if (dx.length < period) return null

  let adxValue = dx.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dx.length; i++) {
    adxValue = (adxValue * (period - 1) + dx[i]) / period
  }

  return adxValue
}

// One Alligator line: an SMA(period) plotted `shift` bars into the future.
// Equivalently, "today's" value of the line is the SMA computed using data
// that ended `shift` bars ago — result[i] = SMA(period) of values[0..i-shift].
function smaShiftedSeries(values, period, shift) {
  const result = new Array(values.length).fill(null)
  for (let i = period - 1 + shift; i < values.length; i++) {
    result[i] = sma(values.slice(0, i - shift + 1), period)
  }
  return result
}

// Bill Williams' Alligator: jaw (13-SMA, +8), teeth (8-SMA, +5), lips
// (5-SMA, +3). Returns the three full series so callers can inspect recent
// history (e.g. to judge whether the lines are diverging).
export function williamsAlligator(closes) {
  return {
    jaw: smaShiftedSeries(closes, 13, 8),
    teeth: smaShiftedSeries(closes, 8, 5),
    lips: smaShiftedSeries(closes, 5, 3),
  }
}

const ALLIGATOR_SLEEPING_SPREAD_PCT = 0.015 // lines within 1.5% of each other = intertwined ("mouth closed")

// Classifies the Alligator's current phase from its three line series.
// 'SLEEPING' — lines intertwined (no clear trend). 'WAKING' — lines
// separating but not yet in clean bullish/bearish order. 'EATING_UP' /
// 'EATING_DOWN' — lips > teeth > jaw (or reverse) and the spread between
// them is still widening, i.e. the trend has room to keep running. This is
// an approximation of Bill Williams' visual heuristic, not his original
// rulebook — treat it as directional confirmation, not a standalone signal.
export function alligatorPhase(jawSeries, teethSeries, lipsSeries) {
  const n = jawSeries.length
  const jaw = jawSeries[n - 1]
  const teeth = teethSeries[n - 1]
  const lips = lipsSeries[n - 1]
  if (jaw == null || teeth == null || lips == null) return 'SLEEPING'

  const spreadPct = (vals) => (Math.max(...vals) - Math.min(...vals)) / vals[0]
  const spread = spreadPct([jaw, teeth, lips])

  const priorIdx = n - 6
  const priorJaw = jawSeries[priorIdx]
  const priorTeeth = teethSeries[priorIdx]
  const priorLips = lipsSeries[priorIdx]
  const priorSpread = priorJaw != null && priorTeeth != null && priorLips != null
    ? spreadPct([priorJaw, priorTeeth, priorLips])
    : spread

  if (spread < ALLIGATOR_SLEEPING_SPREAD_PCT) return 'SLEEPING'

  const bullishOrder = lips > teeth && teeth > jaw
  const bearishOrder = lips < teeth && teeth < jaw

  if (bullishOrder && spread >= priorSpread) return 'EATING_UP'
  if (bearishOrder && spread >= priorSpread) return 'EATING_DOWN'
  return 'WAKING'
}
