import { emaSeries } from './indicators'

function rollingSma(closes, period) {
  const result = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]
    result[i] = sum / period
  }
  return result
}

export function computeIndicators(closes) {
  return {
    price: closes,
    ema10: emaSeries(closes, 10),
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    ema200: emaSeries(closes, 200),
    sma50: rollingSma(closes, 50),
    sma200: rollingSma(closes, 200),
  }
}

function evalCondition(indicators, i, { left, operator, right }) {
  const l = indicators[left]?.[i]
  const r = indicators[right]?.[i]
  if (l == null || r == null) return false
  if (operator === '>') return l > r
  if (operator === '<') return l < r
  if (operator === '>=') return l >= r
  return l <= r
}

export function runBacktest(bars, conditions) {
  const closes = bars.map(b => b.c)
  const indicators = computeIndicators(closes)
  const CAPITAL = 10000

  let cash = CAPITAL
  let shares = 0
  let inMarket = false
  let trades = 0
  let daysInMarket = 0
  const bhShares = CAPITAL / closes[0]

  const series = []

  for (let i = 0; i < bars.length; i++) {
    const price = closes[i]
    const signal = conditions.length > 0 && conditions.every(c => evalCondition(indicators, i, c))

    if (signal && !inMarket) {
      shares = cash / price
      cash = 0
      inMarket = true
      trades++
    } else if (!signal && inMarket) {
      cash = shares * price
      shares = 0
      inMarket = false
    }

    if (inMarket) daysInMarket++

    series.push({
      date: bars[i].t.slice(0, 10),
      strategy: +(inMarket ? shares * price : cash).toFixed(2),
      buyHold: +(bhShares * price).toFixed(2),
      signal,
    })
  }

  const finalStrat = series[series.length - 1].strategy
  const finalBh = series[series.length - 1].buyHold
  const years = bars.length / 252

  let peak = CAPITAL
  let maxDd = 0
  for (const d of series) {
    if (d.strategy > peak) peak = d.strategy
    const dd = (peak - d.strategy) / peak
    if (dd > maxDd) maxDd = dd
  }

  return {
    series,
    metrics: {
      stratReturn: ((finalStrat / CAPITAL) - 1) * 100,
      bhReturn: ((finalBh / CAPITAL) - 1) * 100,
      stratCagr: years > 0 ? (Math.pow(finalStrat / CAPITAL, 1 / years) - 1) * 100 : 0,
      bhCagr: years > 0 ? (Math.pow(finalBh / CAPITAL, 1 / years) - 1) * 100 : 0,
      maxDrawdown: maxDd * 100,
      trades,
      timeInMarket: (daysInMarket / bars.length) * 100,
    },
  }
}

export function getInMarketPeriods(series) {
  const periods = []
  let start = null
  for (let i = 0; i < series.length; i++) {
    if (series[i].signal && start === null) start = series[i].date
    if (!series[i].signal && start !== null) {
      periods.push({ x1: start, x2: series[i - 1].date })
      start = null
    }
  }
  if (start !== null) periods.push({ x1: start, x2: series[series.length - 1].date })
  return periods
}

// QQQ EMA cycle strategy: rotates between TQQQ (bull) and SQQQ (bear)
// based on whether the fast indicator is above the slow indicator on QQQ's
// closing price. Execution is modeled at the close too (a market-on-close
// style fill), but lagged by one day — a signal computed FROM today's close
// can't also be used to earn today's own close-to-close return (that's
// circular: it assumes the fill happens before the price that produced the
// signal existed). Instead, the position for today's leg is whatever was
// already decided as of yesterday's close.
// fastPeriod / slowPeriod: null = raw price, number = EMA period.
// displayBars: trim the output to the last N bars and renormalize both series
// to $10K at that start point — ensures "1 Year" really shows 1 year of data.
export function runQQQCycleBacktest(qqqBars, tqqqBars, sqqqBars, fastPeriod, slowPeriod, displayBars = null) {
  const qqqCloses = qqqBars.map(b => b.c)
  const qqqDates  = qqqBars.map(b => b.t.slice(0, 10))

  const tqqqMap = new Map(tqqqBars.map(b => [b.t.slice(0, 10), b.c]))
  const sqqqMap = new Map(sqqqBars.map(b => [b.t.slice(0, 10), b.c]))

  const fastArr = fastPeriod === null ? qqqCloses : emaSeries(qqqCloses, fastPeriod)
  const slowArr = slowPeriod === null ? qqqCloses : emaSeries(qqqCloses, slowPeriod)

  // Only include QQQ bars where TQQQ + SQQQ data also exists
  const aligned = qqqBars
    .map((_, i) => i)
    .filter(i => tqqqMap.has(qqqDates[i]) && sqqqMap.has(qqqDates[i]))

  if (aligned.length === 0) throw new Error('No overlapping trading dates found for QQQ / TQQQ / SQQQ')

  const CAPITAL = 10000
  const qqqBhShares = CAPITAL / qqqCloses[aligned[0]]

  let stratValue = CAPITAL
  let currentSig = null

  const fullSeries = []

  for (let j = 0; j < aligned.length; j++) {
    const i    = aligned[j]
    const date = qqqDates[i]

    const fast = fastArr[i]
    const slow = slowArr[i]
    const sig  = (fast != null && slow != null) ? (fast > slow ? 'bull' : 'bear') : null

    // Apply the position decided as of yesterday's close (currentSig) to
    // today's return — using today's own signal here would be look-ahead
    // bias, since today's close is what determines today's signal.
    if (j > 0) {
      const prevDate = qqqDates[aligned[j - 1]]
      if (currentSig === 'bull') stratValue *= tqqqMap.get(date) / tqqqMap.get(prevDate)
      else if (currentSig === 'bear') stratValue *= sqqqMap.get(date) / sqqqMap.get(prevDate)
    }

    if (sig !== null) currentSig = sig

    fullSeries.push({
      date,
      strategy: +stratValue.toFixed(2),
      qqqBH: +(qqqBhShares * qqqCloses[i]).toFixed(2),
      signal: currentSig ?? 'neutral',
    })
  }

  // Trim to the requested display window and renormalize both series to $10K.
  // This makes "1 Year" show exactly 252 trading bars regardless of warmup fetch.
  let series = fullSeries
  if (displayBars !== null && fullSeries.length > displayBars) {
    const trimmed = fullSeries.slice(fullSeries.length - displayBars)
    const stratScale = CAPITAL / trimmed[0].strategy
    const qqqScale   = CAPITAL / trimmed[0].qqqBH
    series = trimmed.map(d => ({
      ...d,
      strategy: +(d.strategy * stratScale).toFixed(2),
      qqqBH:    +(d.qqqBH    * qqqScale  ).toFixed(2),
    }))
  }

  // Metrics from the display window
  const finalStrat = series[series.length - 1].strategy
  const finalQQQ   = series[series.length - 1].qqqBH

  // Use actual calendar span so CAGR == return for ~1-year windows
  const msPerYear = 1000 * 60 * 60 * 24 * 365.25
  const years = (new Date(series[series.length - 1].date) - new Date(series[0].date)) / msPerYear

  let peak = CAPITAL, maxDd = 0, trades = 0, daysBull = 0, daysBear = 0, prevSig = null
  for (const d of series) {
    if (d.strategy > peak) peak = d.strategy
    const dd = (peak - d.strategy) / peak
    if (dd > maxDd) maxDd = dd

    if (d.signal !== 'neutral' && d.signal !== prevSig && prevSig !== null) trades++
    prevSig = d.signal !== 'neutral' ? d.signal : prevSig
    if (d.signal === 'bull') daysBull++
    else if (d.signal === 'bear') daysBear++
  }

  return {
    series,
    metrics: {
      stratReturn: ((finalStrat / CAPITAL) - 1) * 100,
      qqqReturn:   ((finalQQQ   / CAPITAL) - 1) * 100,
      stratCagr: years > 0 ? (Math.pow(finalStrat / CAPITAL, 1 / years) - 1) * 100 : 0,
      qqqCagr:   years > 0 ? (Math.pow(finalQQQ   / CAPITAL, 1 / years) - 1) * 100 : 0,
      maxDrawdown: maxDd * 100,
      trades,
      daysBull: series.length > 0 ? (daysBull / series.length) * 100 : 0,
      daysBear: series.length > 0 ? (daysBear / series.length) * 100 : 0,
    },
  }
}

export function getSignalPeriods(series, targetSignal) {
  const periods = []
  let start = null
  for (let i = 0; i < series.length; i++) {
    if (series[i].signal === targetSignal && start === null) start = series[i].date
    if (series[i].signal !== targetSignal && start !== null) {
      periods.push({ x1: start, x2: series[i - 1].date })
      start = null
    }
  }
  if (start !== null) periods.push({ x1: start, x2: series[series.length - 1].date })
  return periods
}
