// Sector regime detection — per-GICS-sector trend score plus 1-month
// relative strength vs SPY, using SPDR sector ETFs (one per sector used in
// src/data/sp500.js).

import { fetchAlpacaCloses, scoreTrend, classifyRegime, returnOverLookback, ABORT_THRESHOLD } from './marketRegime'
import { fetchBars } from './marketData'

export const SECTOR_ETF = {
  'Communication Services': 'XLC',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  Energy: 'XLE',
  Financials: 'XLF',
  'Health Care': 'XLV',
  Industrials: 'XLI',
  'Information Technology': 'XLK',
  Materials: 'XLB',
  'Real Estate': 'XLRE',
  Utilities: 'XLU',
}

const RETURN_LOOKBACK = 21 // ~1 trading month

function scoreSector(sector, etf, closes, spyReturn1m) {
  const trend = scoreTrend(closes)
  // Scale the 0-40 trend score to 0-100 so it can share classifyRegime's bands.
  const regimeScore = Math.max(0, Math.min(100, trend.trendScore * 2.5))
  const [regimeLabel, regimeEmoji] = classifyRegime(regimeScore)
  const return1m = returnOverLookback(closes, RETURN_LOOKBACK)
  const relStrength1m = return1m - spyReturn1m

  return {
    sector,
    etf,
    price: trend.price,
    sma50: trend.sma50,
    sma200: trend.sma200,
    ema20: trend.ema20,
    above200: trend.above200,
    above50: trend.above50,
    aboveEma20: trend.aboveEma20,
    goldenCross: trend.goldenCross,
    trendScore: trend.trendScore,
    regimeScore,
    regimeLabel,
    regimeEmoji,
    return1m,
    relStrength1m,
    leading: relStrength1m > 0,
    blocked: regimeScore < ABORT_THRESHOLD,
  }
}

// Fetch SPY plus all 11 SPDR sector ETFs and score each sector's trend
// (0-100, scaled from the same 0-40 SPY-trend formula) and its 1-month
// relative strength vs SPY. Individual ETF failures are skipped with a
// warning rather than failing the whole call — this is a supplementary
// dashboard, not a hard scan blocker on its own.
export async function checkSectorRegimes() {
  const entries = Object.entries(SECTOR_ETF)
  const symbols = ['SPY', ...entries.map(([, etf]) => etf)]

  const results = await Promise.allSettled(symbols.map((symbol) => fetchAlpacaCloses(symbol)))
  const [spyResult, ...etfResults] = results

  const warnings = []

  let spyReturn1m = 0
  if (spyResult.status === 'rejected') {
    warnings.push('SPY fetch failed — sector relative strength unavailable (using 0% baseline)')
  } else {
    spyReturn1m = returnOverLookback(spyResult.value, RETURN_LOOKBACK)
  }

  const list = []
  const bySector = {}

  entries.forEach(([sector, etf], i) => {
    const result = etfResults[i]
    if (result.status === 'rejected') {
      warnings.push(`${etf} (${sector}) fetch failed — sector regime unavailable`)
      const entry = { sector, etf, error: result.reason?.message || 'fetch failed' }
      bySector[sector] = entry
      list.push(entry)
      return
    }
    const entry = scoreSector(sector, etf, result.value, spyReturn1m)
    bySector[sector] = entry
    list.push(entry)
  })

  list.sort((a, b) => (b.regimeScore ?? -1) - (a.regimeScore ?? -1))

  return { list, bySector, warnings, spyReturn1m }
}

const SECTOR_HIGH_LOOKBACK = 252
export const SECTOR_HOT_PCT = -3
export const SECTOR_WARM_PCT = -8

function classifyHeat(pctFromHigh) {
  if (pctFromHigh >= SECTOR_HOT_PCT) return 'HOT'
  if (pctFromHigh >= SECTOR_WARM_PCT) return 'WARM'
  return 'COLD'
}

// Classifies each SPDR sector ETF as HOT/WARM/COLD purely by its own distance
// from its 52-week high (HOT within 3%, WARM within 8%, else COLD) — this is
// the literal "sector gate" used to grade individual 52-week-high setups in
// weekHighScreener.js, distinct from checkSectorRegimes' trend-score-based
// regime above (which answers a different question: "is this sector's trend
// healthy?" rather than "is this sector itself near its own highs?").
export async function classifySectorHeat() {
  const entries = Object.entries(SECTOR_ETF)
  const results = await Promise.allSettled(entries.map(([, etf]) => fetchBars(etf)))

  const bySector = {}
  const list = []
  const warnings = []

  entries.forEach(([sector, etf], i) => {
    const result = results[i]
    if (result.status === 'rejected') {
      warnings.push(`${etf} (${sector}) fetch failed — sector heat unavailable`)
      bySector[sector] = { sector, etf, status: null }
      return
    }
    const bars = result.value
    const price = bars[bars.length - 1].c
    const window = bars.slice(-SECTOR_HIGH_LOOKBACK)
    const high52w = Math.max(...window.map((b) => b.h))
    const pctFromHigh = ((price - high52w) / high52w) * 100
    const entry = { sector, etf, price, high52w, pctFromHigh, status: classifyHeat(pctFromHigh) }
    bySector[sector] = entry
    list.push(entry)
  })

  list.sort((a, b) => b.pctFromHigh - a.pctFromHigh)
  return { list, bySector, warnings }
}
