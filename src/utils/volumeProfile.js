// Volume Profile — a price-binned histogram of volume traded at each price
// level, computed from the same daily OHLCV bars already fetched for
// AVWAP (zero new API cost). Daily bars don't carry tick distribution, so
// each bar's volume is spread evenly across every price level its
// high-low range touched — the standard approximation when only OHLCV is
// available. From the histogram: POC (point of control, the most-traded
// price), the value area (the band around POC holding 70% of volume), and
// HVN/LVN (local volume peaks/troughs) — levels the market has already
// agreed matter, independent of AVWAP.

const VALUE_AREA_PCT = 0.70

// A "nice" tick size (1/2/5/10 x a power of ten) that yields roughly
// `targetLevels` bins regardless of the stock's price — so a $5 stock and
// a $1,344 stock (e.g. GWW) both get a readable ~50-100 level profile
// instead of a hardcoded price bracket.
function niceTickSize(range, targetLevels = 75) {
  if (range <= 0) return 0.01
  const rawStep = range / targetLevels
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  let nice
  if (normalized < 1.5) nice = 1
  else if (normalized < 3.5) nice = 2
  else if (normalized < 7.5) nice = 5
  else nice = 10
  return nice * magnitude
}

export function computeVolumeProfile(bars, { targetLevels = 75 } = {}) {
  if (!bars || bars.length === 0) return null

  const lo = Math.min(...bars.map((b) => b.l))
  const hi = Math.max(...bars.map((b) => b.h))
  const range = hi - lo
  if (range <= 0) return null

  const tickSize = niceTickSize(range, targetLevels)
  const numBins = Math.max(1, Math.ceil(range / tickSize) + 1)
  const bins = Array.from({ length: numBins }, (_, i) => ({ price: lo + i * tickSize, volume: 0 }))

  for (const bar of bars) {
    const startBin = Math.max(0, Math.floor((bar.l - lo) / tickSize))
    const endBin = Math.min(numBins - 1, Math.floor((bar.h - lo) / tickSize))
    const span = endBin - startBin + 1
    const volPerBin = bar.v / span
    for (let i = startBin; i <= endBin; i++) bins[i].volume += volPerBin
  }

  const totalVolume = bins.reduce((sum, b) => sum + b.volume, 0)
  const pocIdx = bins.reduce((bestIdx, b, i) => (b.volume > bins[bestIdx].volume ? i : bestIdx), 0)

  // Value area: expand outward from POC, always taking whichever neighbor
  // (above or below) carries more volume, until 70% of total is captured.
  let loIdx = pocIdx
  let hiIdx = pocIdx
  let captured = bins[pocIdx].volume
  const targetVolume = totalVolume * VALUE_AREA_PCT
  while (captured < targetVolume && (loIdx > 0 || hiIdx < bins.length - 1)) {
    const belowVol = loIdx > 0 ? bins[loIdx - 1].volume : -1
    const aboveVol = hiIdx < bins.length - 1 ? bins[hiIdx + 1].volume : -1
    if (aboveVol >= belowVol) { hiIdx++; captured += bins[hiIdx].volume }
    else { loIdx--; captured += bins[loIdx].volume }
  }

  return {
    tickSize,
    bins,
    totalVolume,
    poc: bins[pocIdx].price,
    vah: bins[hiIdx].price,
    val: bins[loIdx].price,
  }
}

// Local volume peaks (HVN — high-volume nodes, real support/resistance the
// market has already agreed on) and troughs (LVN — low-volume nodes, "open
// air" the market raced through) — only the statistically significant ones.
export function findHvnsLvns(bins, { maxResults = 5 } = {}) {
  if (!bins || bins.length < 3) return { hvns: [], lvns: [] }

  const mean = bins.reduce((sum, b) => sum + b.volume, 0) / bins.length
  const variance = bins.reduce((sum, b) => sum + (b.volume - mean) ** 2, 0) / bins.length
  const std = Math.sqrt(variance)

  const hvns = []
  const lvns = []
  for (let i = 1; i < bins.length - 1; i++) {
    const b = bins[i]
    const isPeak = b.volume > bins[i - 1].volume && b.volume > bins[i + 1].volume
    const isTrough = b.volume < bins[i - 1].volume && b.volume < bins[i + 1].volume
    if (isPeak && b.volume > mean + 0.5 * std) hvns.push(b)
    if (isTrough && b.volume < Math.max(mean - 0.5 * std, 0)) lvns.push(b)
  }

  hvns.sort((a, b) => b.volume - a.volume)
  lvns.sort((a, b) => a.volume - b.volume)
  return { hvns: hvns.slice(0, maxResults), lvns: lvns.slice(0, maxResults) }
}

// Builds all three profile timeframes plus the cross-cutting reads the
// signal engine and panel use: developing POC trend (is volume consensus
// migrating toward the 52W high — a leading sign of building conviction),
// AVWAP-anchor/HVN confluence (double confirmation a level matters), and
// LVN "acceleration zones" sitting between price and the 52W high (little
// volume to absorb a breakout move through that band).
export function buildVolumeProfileAnalysis(analysis) {
  const { bars, anchors, currentPrice, high52w } = analysis
  const highAnchor = anchors.find((a) => a.key === 'from_52w_high')
  const sinceHighBars = highAnchor
    ? bars.filter((_, i) => highAnchor.series[i]?.avwap != null)
    : bars

  const recent30 = bars.slice(-30)
  const prior30 = bars.slice(-60, -30)

  const timeframes = {
    from_52w_high: computeVolumeProfile(sinceHighBars),
    full_year: computeVolumeProfile(bars),
    recent_30d: computeVolumeProfile(recent30),
  }

  let pocTrend = 'flat'
  if (prior30.length >= 10) {
    const priorProfile = computeVolumeProfile(prior30)
    if (priorProfile && timeframes.recent_30d) {
      const pctChange = ((timeframes.recent_30d.poc - priorProfile.poc) / priorProfile.poc) * 100
      if (pctChange > 0.5) pocTrend = 'rising'
      else if (pctChange < -0.5) pocTrend = 'falling'
    }
  }

  const primary = timeframes.from_52w_high ?? timeframes.full_year
  const { hvns, lvns } = primary ? findHvnsLvns(primary.bins) : { hvns: [], lvns: [] }

  const confluences = []
  for (const anchor of anchors) {
    for (const hvn of hvns) {
      const pct = Math.abs((anchor.value - hvn.price) / hvn.price) * 100
      if (pct < 1) confluences.push({ anchorKey: anchor.key, anchorLabel: anchor.label, hvnPrice: hvn.price, pct })
    }
  }

  const accelerationZones = lvns
    .filter((l) => l.price > currentPrice && l.price <= high52w)
    .sort((a, b) => a.price - b.price)

  return { timeframes, pocTrend, hvns, lvns, confluences, accelerationZones }
}
