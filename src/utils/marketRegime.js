// Market regime detection — mirrors sp500_scanner/analysis/market_regime.py.
//
// Fetches SPY, QQQ, IWM, and ^VIX and scores the market 0-100 across SPY
// trend, VIX fear, small-cap breadth (IWM), and Nasdaq health (QQQ).

import { authHeaders } from './alpacaApi'
import { sma, ema } from './indicators'
import { isMajorEventThisWeek } from './economicCalendar'

const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2/stocks'
export const ABORT_THRESHOLD = 40
export const RUN_SCAN_THRESHOLD_DEFAULT = 55

const VIX_SCORE_DEFAULT = 12
const BREADTH_SCORE_DEFAULT = 10
const QQQ_SCORE_DEFAULT = 7

export class RegimeDataError extends Error {}

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

export async function fetchAlpacaCloses(symbol) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 400)

  const params = new URLSearchParams({
    timeframe: '1Day',
    start: dateStr(start),
    end: dateStr(end),
    limit: '1000',
    feed: 'iex',
    adjustment: 'split',
  })

  const response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
  if (!response.ok) {
    throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)
  }

  const data = await response.json()
  const bars = data.bars || []
  if (bars.length === 0) {
    throw new Error(`No market data returned for ${symbol}`)
  }
  return bars.map((b) => b.c)
}

// Rolling mean at `period`, falling back to the full-series mean if the
// series is shorter than `period` (mirrors _safe_sma's NaN fallback).
function safeSma(closes, period) {
  const value = sma(closes, period)
  if (value != null) return value
  return closes.reduce((a, b) => a + b, 0) / closes.length
}

// Generic 0-40 trend score (above 200MA +15, above 50MA +10, golden cross
// +10, above 20EMA +5), reused for SPY (market regime) and individual sector
// ETFs (sector regime).
export function scoreTrend(closes) {
  const price = closes[closes.length - 1]
  const sma50 = safeSma(closes, 50)
  const sma200 = safeSma(closes, 200)
  const ema20 = ema(closes, 20)
  const ema21 = ema(closes, 21) // display-only (e.g. "SPY vs 21 EMA") — scoring still uses the 20 EMA above

  const above200 = price > sma200
  const above50 = price > sma50
  const goldenCross = sma50 > sma200
  const aboveEma20 = price > ema20
  const above21 = ema21 != null && price > ema21

  let score = 0
  if (above200) score += 15
  if (above50) score += 10
  if (goldenCross) score += 10
  if (aboveEma20) score += 5

  let trendLabel
  if (score >= 35) trendLabel = 'STRONG BULL'
  else if (score >= 25) trendLabel = 'BULL'
  else if (score >= 15) trendLabel = 'NEUTRAL'
  else if (score >= 5) trendLabel = 'BEAR'
  else trendLabel = 'STRONG BEAR'

  return { price, sma50, sma200, ema20, ema21, above200, above50, above21, aboveEma20, goldenCross, trendScore: score, trendLabel }
}

// Percent return from `lookback` bars ago to the latest bar, clamped so it
// never looks further back than the series allows.
export function returnOverLookback(closes, lookback) {
  const n = closes.length
  const effectiveLookback = Math.min(lookback, n - 1)
  if (effectiveLookback <= 0) return 0
  const price = closes[n - 1]
  const past = closes[n - 1 - effectiveLookback]
  return (price / past - 1) * 100
}

function scoreSpyTrend(closes) {
  const t = scoreTrend(closes)
  return {
    spyPrice: t.price,
    spySma50: t.sma50,
    spySma200: t.sma200,
    spyEma20: t.ema20,
    spyEma21: t.ema21,
    spyAbove200: t.above200,
    spyAbove50: t.above50,
    spyAboveEma20: t.aboveEma20,
    spyAbove21: t.above21,
    goldenCross: t.goldenCross,
    spyTrendScore: t.trendScore,
    spyTrendLabel: t.trendLabel,
  }
}

function scoreVix(closes) {
  const vixCurrent = closes[closes.length - 1]
  const vixSma20 = safeSma(closes, 20)

  let vixScore
  let vixLabel
  if (vixCurrent > 40) {
    vixScore = -10
    vixLabel = 'CRISIS — exit everything'
  } else if (vixCurrent > 30) {
    vixScore = 0
    vixLabel = 'PANIC — avoid new longs'
  } else if (vixCurrent > 25) {
    vixScore = 5
    vixLabel = 'FEARFUL — reduce exposure'
  } else if (vixCurrent > 20) {
    vixScore = 12
    vixLabel = 'CAUTIOUS — proceed carefully'
  } else if (vixCurrent > 15) {
    vixScore = 20
    vixLabel = 'CALM — healthy market'
  } else {
    vixScore = 25
    vixLabel = 'COMPLACENT — ideal bull conditions'
  }

  const vixTrend = vixCurrent > vixSma20 ? 'RISING' : 'FALLING'

  return { vixCurrent, vixSma20, vixTrend, vixScore, vixLabel }
}

function scoreBreadth(closes) {
  const price = closes[closes.length - 1]
  const iwmSma50 = safeSma(closes, 50)
  const iwmSma200 = safeSma(closes, 200)

  const iwmAbove200 = price > iwmSma200
  const iwmAbove50 = price > iwmSma50
  const iwmReturn1m = returnOverLookback(closes, 21)

  let score = 0
  if (iwmAbove200) score += 10
  if (iwmAbove50) score += 5
  if (iwmReturn1m > 0) score += 5

  let breadthLabel
  if (score >= 15) breadthLabel = 'BROAD PARTICIPATION — best bull signal'
  else if (score >= 8) breadthLabel = 'NARROW — large caps only leading'
  else breadthLabel = 'WEAK BREADTH — distribution likely'

  return {
    iwmPrice: price,
    iwmSma50,
    iwmSma200,
    iwmAbove200,
    iwmAbove50,
    iwmReturn1m,
    breadthScore: score,
    breadthLabel,
  }
}

function scoreQqq(closes) {
  const price = closes[closes.length - 1]
  const qqqSma50 = safeSma(closes, 50)
  const qqqSma200 = safeSma(closes, 200)

  const qqqAbove200 = price > qqqSma200
  const qqqAbove50 = price > qqqSma50
  const qqqReturn5d = returnOverLookback(closes, 5)

  let score = 0
  if (qqqAbove200) score += 8
  if (qqqAbove50) score += 4
  if (qqqReturn5d > 0) score += 3

  return {
    qqqPrice: price,
    qqqSma50,
    qqqSma200,
    qqqAbove200,
    qqqAbove50,
    qqqReturn5d,
    qqqScore: score,
  }
}

export function classifyRegime(score) {
  if (score >= 85) return ['STRONG BULL', '✅✅']
  if (score >= 70) return ['BULL', '✅']
  if (score >= 55) return ['WEAK BULL', '⚠️']
  if (score >= 40) return ['NEUTRAL', '⚠️']
  if (score >= 25) return ['BEAR', '❌']
  return ['STRONG BEAR', '❌❌']
}

// Collapses the 0-100 regime score into the three position-sizing buckets
// the trading rules key off of: Risk On (full 1.5% risk), Risk Neutral
// (half size, 0.75%), Risk Off (cash, 0%). A major macro release this week
// downgrades an otherwise-Risk-On score to Risk Neutral.
export function classifyRiskEnvironment(regimeScore, date = new Date()) {
  if (regimeScore < ABORT_THRESHOLD) return 'off'
  if (regimeScore < 70) return 'neutral'
  if (isMajorEventThisWeek(date)) return 'neutral'
  return 'on'
}

// Fetch SPY/QQQ/IWM/^VIX and compute the 0-100 market regime score.
//
// `threshold` is the minimum regimeScore required to run the scan / show
// signals (default 55). The hard abort boundary (score < ABORT_THRESHOLD)
// is fixed regardless of `threshold`.
//
// Throws RegimeDataError if SPY data can't be fetched — the dashboard
// can't render without it.
export async function checkMarketRegime(threshold = RUN_SCAN_THRESHOLD_DEFAULT) {
  const warnings = []

  const [spyResult, iwmResult, qqqResult] = await Promise.allSettled([
    fetchAlpacaCloses('SPY'),
    fetchAlpacaCloses('IWM'),
    fetchAlpacaCloses('QQQ'),
  ])

  if (spyResult.status === 'rejected') {
    throw new RegimeDataError('Failed to fetch SPY data — cannot check market regime')
  }
  const spyCloses = spyResult.value
  if (spyCloses.length < 200) {
    warnings.push(`SPY history is only ${spyCloses.length} bars (<200) — using available bars for long-term averages`)
  }
  const spy = scoreSpyTrend(spyCloses)

  const vix = {
    vixCurrent: 0,
    vixSma20: 0,
    vixTrend: 'UNKNOWN',
    vixScore: VIX_SCORE_DEFAULT,
    vixLabel: 'UNKNOWN — VIX data unavailable',
  }

  let breadth
  if (iwmResult.status === 'rejected') {
    warnings.push('IWM fetch failed — using default breadth score (10/20)')
    breadth = {
      iwmPrice: 0,
      iwmSma50: 0,
      iwmSma200: 0,
      iwmAbove200: false,
      iwmAbove50: false,
      iwmReturn1m: 0,
      breadthScore: BREADTH_SCORE_DEFAULT,
      breadthLabel: 'UNKNOWN — IWM data unavailable',
    }
  } else {
    const iwmCloses = iwmResult.value
    if (iwmCloses.length < 200) {
      warnings.push(`IWM history is only ${iwmCloses.length} bars (<200) — using available bars for long-term averages`)
    }
    breadth = scoreBreadth(iwmCloses)
  }

  let qqq
  if (qqqResult.status === 'rejected') {
    warnings.push('QQQ fetch failed — using default Nasdaq score (7/15)')
    qqq = {
      qqqPrice: 0,
      qqqSma50: 0,
      qqqSma200: 0,
      qqqAbove200: false,
      qqqAbove50: false,
      qqqReturn5d: 0,
      qqqScore: QQQ_SCORE_DEFAULT,
    }
  } else {
    const qqqCloses = qqqResult.value
    if (qqqCloses.length < 200) {
      warnings.push(`QQQ history is only ${qqqCloses.length} bars (<200) — using available bars for long-term averages`)
    }
    qqq = scoreQqq(qqqCloses)
  }

  let regimeScore = spy.spyTrendScore + vix.vixScore + breadth.breadthScore + qqq.qqqScore
  regimeScore = Math.max(0, Math.min(100, regimeScore))
  const [regimeLabel, regimeEmoji] = classifyRegime(regimeScore)

  const runScan = regimeScore >= threshold
  const showSignals = runScan
  const positionWarning = regimeScore >= threshold && regimeScore < 70
  const vixElevated = vix.vixCurrent > 30

  return {
    regimeScore,
    regimeLabel,
    regimeEmoji,
    runScan,
    showSignals,
    positionWarning,
    vixElevated,
    warnings,
    ...spy,
    ...vix,
    ...breadth,
    ...qqq,
  }
}
