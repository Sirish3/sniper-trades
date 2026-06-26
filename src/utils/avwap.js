// Anchored VWAP — the volume-weighted average price of every bar from a
// fixed anchor point forward, using each bar's typical price (H+L+C)/3.
// Comparing the live price to AVWAP from a meaningful anchor (the 52-week
// high day, a recent pullback low, year start) shows whether the average
// participant since that event is sitting on a gain or a loss — a read on
// whether a breakout has real support underneath it, not just a 52-week
// high crossing.
//
// Bars are Alpaca's raw bar shape ({ t, o, h, l, c, v }), already fetched
// elsewhere in this app (marketData.js's fetchBars) — no new data source.

const RECENT_LOW_WINDOW = 60 // ~3 months of trading days

function typicalPrice(bar) {
  return (bar.h + bar.l + bar.c) / 3
}

// Per-bar AVWAP from `anchorTime` (ms epoch) forward, for charting — null
// before the anchor is reached.
function computeAvwapSeries(sortedBars, anchorTime) {
  let cumTpVol = 0
  let cumVol = 0
  return sortedBars.map((bar) => {
    const date = bar.t.slice(0, 10)
    if (new Date(bar.t).getTime() < anchorTime) return { date, avwap: null }
    cumTpVol += typicalPrice(bar) * bar.v
    cumVol += bar.v
    return { date, avwap: cumVol > 0 ? cumTpVol / cumVol : null }
  })
}

const SLOPE_WINDOW = 5 // trading days
const SLOPE_THRESHOLD_PCT = 0.3

// Rising/flat/falling over the last SLOPE_WINDOW trading days — compares
// the AVWAP as of today against the AVWAP as of 5 sessions ago (both
// anchored at the same point). A rising AVWAP means new buyers are paying
// higher prices than the running average (bullish); falling means buyers
// are stepping away.
function slopeOf(series) {
  const valid = series.filter((p) => p.avwap != null)
  if (valid.length < SLOPE_WINDOW + 1) return 'flat'

  const now = valid[valid.length - 1].avwap
  const then = valid[valid.length - 1 - SLOPE_WINDOW].avwap
  if (!then) return 'flat'

  const changePct = ((now - then) / then) * 100
  if (changePct > SLOPE_THRESHOLD_PCT) return 'rising'
  if (changePct < -SLOPE_THRESHOLD_PCT) return 'falling'
  return 'flat'
}

function anchorDateOf(series) {
  return series.find((p) => p.avwap != null)?.date ?? null
}

function finalValueOf(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].avwap != null) return series[i].avwap
  }
  return null
}

// Single-point AVWAP for callers that already have parallel OHLCV arrays
// from a scan (no per-bar dates available, just oldest->newest arrays) —
// anchored `anchorIndex` bars from the end of the series, inclusive. Used
// for the quick "AVWAP (52W High)" stat shown for every scanned result,
// since the scan already fetches highs/lows/closes/volumes for free —
// computing this here costs zero extra API calls.
export function avwapFromAnchorIndex(highs, lows, closes, volumes, anchorIndex) {
  if (anchorIndex < 0 || anchorIndex >= closes.length) return null

  let cumTpVol = 0
  let cumVol = 0
  for (let i = anchorIndex; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3
    cumTpVol += tp * volumes[i]
    cumVol += volumes[i]
  }
  if (cumVol === 0) return null

  const value = cumTpVol / cumVol
  const price = closes[closes.length - 1]
  return {
    value,
    vsPricePct: ((price - value) / value) * 100,
    signal: price > value ? 'BULLISH' : 'BEARISH',
  }
}

// Builds every "interesting" AVWAP anchor for `bars`: the 52-week-high bar
// (auto-detected — the highest high in the series), the lowest low in the
// last ~3 months (the most recent pullback), and the first session of the
// current calendar year. `customAnchorDate` (YYYY-MM-DD) layers on a
// user-picked anchor with the same zero-extra-fetch math, since everything
// here just re-walks the already-fetched `bars`.
export function buildAvwapAnalysis(bars, customAnchorDate = null) {
  if (!bars || bars.length === 0) return null

  const sorted = [...bars].sort((a, b) => new Date(a.t) - new Date(b.t))
  const currentPrice = sorted[sorted.length - 1].c

  const highBar = sorted.reduce((best, b) => (b.h > best.h ? b : best))
  const recentWindow = sorted.slice(-RECENT_LOW_WINDOW)
  const lowBar = recentWindow.reduce((best, b) => (b.l < best.l ? b : best), recentWindow[0])
  const yearStartTime = new Date(`${new Date().getFullYear()}-01-01T00:00:00Z`).getTime()

  const anchorDefs = [
    { key: 'from_52w_high', label: 'From 52W High', time: new Date(highBar.t).getTime() },
    { key: 'from_recent_low', label: 'From Recent Pullback Low', time: new Date(lowBar.t).getTime() },
    { key: 'from_year_start', label: 'From Year Start', time: yearStartTime },
  ]
  if (customAnchorDate) {
    anchorDefs.push({ key: 'from_custom', label: 'Custom Anchor', time: new Date(`${customAnchorDate}T00:00:00Z`).getTime() })
  }

  const anchors = anchorDefs
    .map((def) => {
      const series = computeAvwapSeries(sorted, def.time)
      const value = finalValueOf(series)
      if (value == null) return null
      return {
        key: def.key,
        label: def.label,
        anchorDate: anchorDateOf(series),
        value,
        vsPricePct: ((currentPrice - value) / value) * 100,
        signal: currentPrice > value ? 'BULLISH' : 'BEARISH',
        slope: slopeOf(series),
        series,
      }
    })
    .filter(Boolean)

  // One row per date with every anchor's running AVWAP + the close, for a
  // single combined sparkline (Recharts wants one flat array of objects).
  const chartData = sorted.map((bar, i) => {
    const row = { date: bar.t.slice(0, 10), close: bar.c }
    for (const a of anchors) row[a.key] = a.series[i].avwap
    return row
  })

  return {
    currentPrice,
    high52w: highBar.h,
    high52wDate: highBar.t.slice(0, 10),
    anchors,
    chartData,
    bars: sorted,
  }
}
