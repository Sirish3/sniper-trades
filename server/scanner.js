// Signal classification engine — the 4 daily scan jobs. Reuses the pure
// calculation/classification logic from ../src/utils unchanged (indicators,
// williamsAlligator/alligatorPhase, marketRegime's scoreTrend/
// classifyRegime/classifyRiskEnvironment/returnOverLookback, entrySignal's
// classifyEntrySignal/detectBase, positionPlan's selectStop/sizePosition/
// buildTrimPlan, positions.evaluatePosition). Only the I/O boundary
// (marketDataNode.js) and the spec's exact signal-type/grade thresholds are
// new — everything else is the same trading logic already validated in the
// browser app.

import { ema, rsi, macd, adx, volumeRatio, atr as atrIndicator, williamsAlligator, alligatorPhase } from '../src/utils/indicators.js'
import { scoreTrend, returnOverLookback } from '../src/utils/marketRegime.js'
import { detectBase } from '../src/utils/entrySignal.js'
import { evaluatePosition } from '../src/utils/positions.js'
import { fetchBars, fetchAlpacaCloses, fetchEarningsCalendar, fetchIntradayVolume } from './marketDataNode.js'
import { ALL_ETFS, SECTOR_ETFS, getEtfConstituents, getAllEtfTickers, PERMANENT_WATCHLIST } from './etfUniverse.js'
import { VOL_RATIO_MIN, RS_RANK_MIN, CHASE_PCT_MAX, HOT_SECTOR_PCT, WARM_SECTOR_PCT } from './config.js'
import * as db from './db.js'

const HIGH_LOOKBACK = 252
const RETEST_MIN_DAYS = 3
const RETEST_MAX_DAYS = 7
const RETEST_PULLBACK_VOL_MAX = 0.85
const RETEST_MAX_PCT_FROM_HIGH = -1
const RETEST_MIN_PCT_FROM_HIGH = -10
const WATCH_PCT_FROM_HIGH = -5
const APPROACHING_PCT_FROM_HIGH = -8
const APPROACHING_RS_RANK_MIN = 65
const EARNINGS_BUFFER_BREAKOUT_DAYS = 7
const EARNINGS_BUFFER_GRADE_DAYS = 10

function daysSinceTouchedHigh(highs, high52w) {
  for (let i = highs.length - 1; i >= 0; i--) {
    if (highs[i] >= high52w * 0.99) return highs.length - 1 - i
  }
  return highs.length
}

async function daysToNextEarnings(symbol) {
  const entries = await fetchEarningsCalendar(symbol, 0, 30)
  if (!entries || entries.length === 0) return null
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const days = entries
    .map((e) => Math.round((new Date(`${e.date}T00:00:00Z`) - today) / 86400000))
    .filter((d) => d >= 0)
  return days.length ? Math.min(...days) : null
}

// Computes every indicator the spec's classify_stock_signal/grade rubric
// needs for one ticker. Returns null if there isn't enough history.
export async function buildTickerData(symbol, etfSource = null) {
  const bars = await fetchBars(symbol)
  if (bars.length < 60) return null

  const closes = bars.map((b) => b.c)
  const highs = bars.map((b) => b.h)
  const lows = bars.map((b) => b.l)
  const volumes = bars.map((b) => b.v)
  const price = closes[closes.length - 1]

  const ema10 = ema(closes, 10)
  const ema21 = ema(closes, 21)
  const ema50 = ema(closes, 50)
  const rsiValue = rsi(closes, 14)
  const macdData = macd(closes)
  const adxValue = highs.length >= 29 ? adx(highs, lows, closes, 14) : null
  const volRatio = volumeRatio(volumes, 20)
  const atr14 = atrIndicator(bars, 14)
  const alligator = williamsAlligator(closes)
  const phase = alligatorPhase(alligator.jaw, alligator.teeth, alligator.lips)

  const high52w = Math.max(...highs.slice(-HIGH_LOOKBACK))
  const pctFromHigh = ((price - high52w) / high52w) * 100
  const ret1m = returnOverLookback(closes, 21)
  const ret3m = returnOverLookback(closes, 63)
  const daysSinceHigh = daysSinceTouchedHigh(highs, high52w)

  const today = bars[bars.length - 1]
  const yesterday = bars[bars.length - 2]
  const todayGreen = today.c > today.o
  const volumeRisingVsYesterday = yesterday ? today.v > yesterday.v : false

  const pullbackBars = bars.slice(-(daysSinceHigh + 1), -1)
  const avgVolume20 = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : null
  const pullbackVolRatio = avgVolume20 && pullbackBars.length
    ? pullbackBars.reduce((s, b) => s + b.v, 0) / pullbackBars.length / avgVolume20
    : null

  const base = detectBase(bars)
  const daysToEarnings = await daysToNextEarnings(symbol)
  const intraday = await fetchIntradayVolume(symbol)
  const projectedVolRatio = projectIntradayVolumeRatio(intraday, avgVolume20)

  return {
    symbol, etfSource, bars, price, high52w, pctFromHigh, daysSinceHigh,
    ema10, ema21, ema50, rsiValue, macdData, adxValue, volRatio, atr14,
    alligatorPhase: phase, ret1m, ret3m, daysToEarnings,
    todayGreen, volumeRisingVsYesterday, pullbackVolRatio,
    pivot: base.hasBase ? base.pivot : high52w,
    projectedVolRatio,
  }
}

// Projects full-day volume from the partial day so the 11am intraday scan
// doesn't unfairly reject a real breakout just because the day isn't over —
// projected = volume_so_far * (6.5 trading hours / hours elapsed since open).
function projectIntradayVolumeRatio(intraday, avgVolume20) {
  if (!intraday || !avgVolume20) return null
  const minutesElapsed = intraday.nowMinutes - 570 // since 9:30am ET
  if (minutesElapsed <= 0) return null
  const hoursElapsed = minutesElapsed / 60
  const projectedVolume = intraday.volumeSoFar * (6.5 / hoursElapsed)
  return projectedVolume / avgVolume20
}

// BUY_BREAKOUT / BUY_RETEST / WATCH / APPROACHING / null, checked in that
// priority order (mirrors the spec verbatim). `useProjectedVolume` is true
// for the 11am intraday job, false for the 3:50pm close-confirmation job.
export function classifyStockSignal(data, etfStatus, useProjectedVolume = false) {
  const { pctFromHigh, daysSinceHigh, rsRank, daysToEarnings, todayGreen, volumeRisingVsYesterday, pullbackVolRatio, alligatorPhase: phase, pivot, price } = data
  const volRatio = useProjectedVolume && data.projectedVolRatio != null ? data.projectedVolRatio : data.volRatio
  const sectorHot = etfStatus === 'HOT'
  const chasePctMax = sectorHot ? CHASE_PCT_MAX * 1.4 : CHASE_PCT_MAX // wider tolerance for hot sectors

  const noEarningsSoonBreakout = daysToEarnings == null || daysToEarnings > EARNINGS_BUFFER_BREAKOUT_DAYS
  const nearHigh = pctFromHigh >= -1
  const volConfirmed = volRatio != null && (volRatio >= VOL_RATIO_MIN || (rsRank > 85 && volRatio >= 1.3))
  const withinChaseDistance = Math.abs(pctFromHigh) <= chasePctMax || (price >= pivot && (price - pivot) / pivot * 100 <= chasePctMax)

  if (nearHigh && volConfirmed && withinChaseDistance && noEarningsSoonBreakout) {
    return 'BUY_BREAKOUT'
  }

  const retestPullback = pctFromHigh >= RETEST_MIN_PCT_FROM_HIGH && pctFromHigh <= RETEST_MAX_PCT_FROM_HIGH
  const retestDuration = daysSinceHigh >= RETEST_MIN_DAYS && daysSinceHigh <= RETEST_MAX_DAYS
  const retestVolumeDried = pullbackVolRatio != null && pullbackVolRatio < RETEST_PULLBACK_VOL_MAX
  if (retestPullback && retestDuration && retestVolumeDried && todayGreen && volumeRisingVsYesterday && phase === 'EATING_UP') {
    return 'BUY_RETEST'
  }

  if (pctFromHigh >= WATCH_PCT_FROM_HIGH && rsRank > RS_RANK_MIN) return 'WATCH'
  if (pctFromHigh >= APPROACHING_PCT_FROM_HIGH && rsRank > APPROACHING_RS_RANK_MIN) return 'APPROACHING'

  return null
}

// A_PLUS / A / B / C — same structure as agenticScreener.js's gradeSetup
// (C disqualifiers first, then an A+ checklist, then a relaxed A
// checklist), but with this spec's exact thresholds (EMA 10>21>50, ADX>28,
// Alligator EATING_UP, sector-HOT, no earnings within 10 days).
export function gradeSignal(data, etfStatus) {
  const { volRatio, rsRank, rsiValue, ema10, ema21, ema50, adxValue, alligatorPhase: phase, daysToEarnings, pctFromHigh } = data
  const emaBullStack = ema10 > ema21 && ema21 > ema50
  const earningsOk10d = daysToEarnings == null || daysToEarnings > EARNINGS_BUFFER_GRADE_DAYS

  if (!earningsOk10d) return { grade: 'C', reasons: [`Earnings in ${daysToEarnings} days (< 10)`] }
  if (rsiValue != null && (rsiValue < 45 || rsiValue > 78)) return { grade: 'C', reasons: [`RSI ${rsiValue.toFixed(0)} out of range`] }

  const checks = [
    { ok: volRatio != null && volRatio >= 2.5, miss: `Volume ${volRatio?.toFixed(2) ?? '?'}x (need >= 2.5x)` },
    { ok: rsRank != null && rsRank > 85, miss: `RS rank ${rsRank ?? '?'} (need > 85)` },
    { ok: rsiValue != null && rsiValue >= 55 && rsiValue <= 72, miss: `RSI ${rsiValue?.toFixed(0) ?? '?'} (need 55-72)` },
    { ok: emaBullStack, miss: '10>21>50 EMA stack not intact' },
    { ok: adxValue != null && adxValue > 28, miss: `ADX ${adxValue?.toFixed(0) ?? '?'} (need > 28)` },
    { ok: phase === 'EATING_UP', miss: `Alligator ${phase} (need EATING_UP)` },
    { ok: etfStatus === 'HOT', miss: `Sector ${etfStatus} (need HOT)` },
    { ok: pctFromHigh >= -5, miss: `${pctFromHigh.toFixed(1)}% from pivot (need >= -5%)` },
  ]
  const misses = checks.filter((c) => !c.ok).map((c) => c.miss)
  if (misses.length === 0) return { grade: 'A_PLUS', reasons: [] }

  const coreOk = volRatio != null && volRatio >= 1.5
    && rsiValue != null && rsiValue >= 50 && rsiValue <= 75
    && adxValue != null && adxValue > 20
    && emaBullStack
    && etfStatus !== 'COLD'
  if (misses.length <= 3 && coreOk) return { grade: 'A', reasons: misses }

  return { grade: 'B', reasons: misses.slice(0, 4) }
}

// ── Job 1 (8:00am) — sector gate + watchlist refresh ──
export async function sectorGateScan() {
  const tickers = getAllEtfTickers()
  const statuses = []

  for (const ticker of tickers) {
    try {
      const closes = await fetchAlpacaCloses(ticker)
      const price = closes[closes.length - 1]
      const high52w = Math.max(...closes.slice(-HIGH_LOOKBACK))
      const pctFromHigh = ((price - high52w) / high52w) * 100
      const status = pctFromHigh >= HOT_SECTOR_PCT ? 'HOT' : pctFromHigh >= WARM_SECTOR_PCT ? 'WARM' : 'COLD'
      const ret1m = returnOverLookback(closes, 21)
      const ret3m = returnOverLookback(closes, 63)
      const meta = ALL_ETFS[ticker]

      db.recordEtfStatus({
        etfTicker: ticker, etfName: meta?.name ?? ticker, category: meta?.category ?? null,
        curPrice: price, high52w, pctFromHigh, status, ret1m, ret3m,
      })
      statuses.push({ ticker, name: meta?.name, category: meta?.category, status, pctFromHigh, price })
    } catch {
      // one ETF failing to fetch shouldn't abort the whole gate scan
    }
  }

  for (const symbol of PERMANENT_WATCHLIST) {
    db.upsertWatchlistTicker({ ticker: symbol, sectorEtf: null, permanent: true })
  }
  for (const s of statuses.filter((s) => s.status === 'HOT')) {
    for (const company of getEtfConstituents(s.ticker)) {
      db.upsertWatchlistTicker({ ticker: company.symbol, sectorEtf: s.ticker, permanent: false })
    }
  }

  return statuses
}

function rsRanks(returnsByTicker) {
  const entries = Object.entries(returnsByTicker)
  const sorted = [...entries].sort((a, b) => (b[1] ?? -999) - (a[1] ?? -999))
  const n = sorted.length
  const ranks = {}
  sorted.forEach(([ticker], i) => { ranks[ticker] = n > 1 ? Math.round(((n - 1 - i) / (n - 1)) * 100) : 50 })
  return ranks
}

async function scanSymbols(symbols, etfStatusByTicker, useProjectedVolume) {
  const dataByTicker = {}
  for (const symbol of symbols) {
    try {
      const data = await buildTickerData(symbol, etfStatusByTicker.sourceMap?.[symbol])
      if (data) dataByTicker[symbol] = data
    } catch {
      // skip tickers that fail to fetch
    }
  }

  const ranks = rsRanks(Object.fromEntries(Object.entries(dataByTicker).map(([t, d]) => [t, d.ret3m])))
  for (const [ticker, data] of Object.entries(dataByTicker)) data.rsRank = ranks[ticker]

  const results = []
  for (const [ticker, data] of Object.entries(dataByTicker)) {
    const etfStatus = etfStatusByTicker[ticker] ?? etfStatusByTicker.default ?? 'WARM'
    const signalType = classifyStockSignal(data, etfStatus, useProjectedVolume)
    if (!signalType) continue
    const { grade } = gradeSignal(data, etfStatus)
    results.push({ ticker, etfSource: data.etfSource, data, signalType, signalGrade: grade })
  }
  return results
}

function buildScanUniverse() {
  const watchlist = db.getWatchlist()
  const bySymbol = new Map()
  for (const row of watchlist) bySymbol.set(row.ticker, row.sector_etf)
  for (const symbol of PERMANENT_WATCHLIST) if (!bySymbol.has(symbol)) bySymbol.set(symbol, null)
  return bySymbol
}

function etfStatusMap() {
  const statuses = db.getLatestEtfStatuses()
  const map = { default: 'WARM' }
  for (const s of statuses) map[s.etf_ticker] = s.status
  return map
}

function persistResults(results, scanRunId) {
  for (const r of results) {
    db.insertScanResult({
      ticker: r.ticker, etfSource: r.etfSource ?? null, curPrice: r.data.price, high52w: r.data.high52w,
      pctFromHigh: r.data.pctFromHigh, volRatio: r.data.volRatio, rsRank: r.data.rsRank,
      ret1m: r.data.ret1m, ret3m: r.data.ret3m, atr14: r.data.atr14, ema10: r.data.ema10,
      ema21: r.data.ema21, ema50: r.data.ema50, rsi14: r.data.rsiValue,
      macdHist: r.data.macdData?.histogram ?? null, adx14: r.data.adxValue,
      alligatorPhase: r.data.alligatorPhase, signalType: r.signalType, signalGrade: r.signalGrade,
    }, scanRunId)
  }
}

// ── Job 2 (11:00am) — intraday breakout scan ──
export async function breakoutScan() {
  const watchlistBySymbol = buildScanUniverse()
  const sectorEtfBySymbol = {}
  for (const [symbol, sectorEtf] of watchlistBySymbol) sectorEtfBySymbol[symbol] = sectorEtf

  const etfStatuses = etfStatusMap()
  const statusBySymbol = { default: etfStatuses.default }
  for (const [symbol, sectorEtf] of watchlistBySymbol) {
    statusBySymbol[symbol] = sectorEtf ? (etfStatuses[sectorEtf] ?? etfStatuses.default) : etfStatuses.default
  }
  statusBySymbol.sourceMap = sectorEtfBySymbol

  const results = await scanSymbols([...watchlistBySymbol.keys()], statusBySymbol, true)
  const breakouts = results.filter((r) => r.signalType === 'BUY_BREAKOUT')

  const scanRunId = `breakout-${Date.now()}`
  persistResults(breakouts, scanRunId)
  return breakouts
}

// ── Job 3 (2:00pm) — retest + approaching scan (also covers WARM sectors) ──
export async function retestApproachingScan() {
  const watchlistBySymbol = buildScanUniverse()
  const etfStatuses = etfStatusMap()

  for (const [etfTicker, status] of Object.entries(etfStatuses)) {
    if (status !== 'WARM') continue
    for (const company of getEtfConstituents(etfTicker)) {
      if (!watchlistBySymbol.has(company.symbol)) watchlistBySymbol.set(company.symbol, etfTicker)
    }
  }

  const statusBySymbol = { default: etfStatuses.default, sourceMap: {} }
  for (const [symbol, sectorEtf] of watchlistBySymbol) {
    statusBySymbol.sourceMap[symbol] = sectorEtf
    statusBySymbol[symbol] = sectorEtf ? (etfStatuses[sectorEtf] ?? etfStatuses.default) : etfStatuses.default
  }

  const results = await scanSymbols([...watchlistBySymbol.keys()], statusBySymbol, false)
  const retests = results.filter((r) => r.signalType === 'BUY_RETEST')
  const watchAndApproaching = results.filter((r) => r.signalType === 'WATCH' || r.signalType === 'APPROACHING')

  const scanRunId = `retest-${Date.now()}`
  persistResults([...retests, ...watchAndApproaching], scanRunId)
  return { retests, watchAndApproaching }
}

// ── Job 4 (3:50pm) — close confirmation + position management ──
export async function closeConfirmationScan(marketContext) {
  const watchlistBySymbol = buildScanUniverse()
  const etfStatuses = etfStatusMap()
  const statusBySymbol = { default: etfStatuses.default, sourceMap: {} }
  for (const [symbol, sectorEtf] of watchlistBySymbol) {
    statusBySymbol.sourceMap[symbol] = sectorEtf
    statusBySymbol[symbol] = sectorEtf ? (etfStatuses[sectorEtf] ?? etfStatuses.default) : etfStatuses.default
  }

  const results = await scanSymbols([...watchlistBySymbol.keys()], statusBySymbol, false)
  const breakouts = results.filter((r) => r.signalType === 'BUY_BREAKOUT')
  const scanRunId = `close-${Date.now()}`
  persistResults(results, scanRunId)

  const openPositions = db.getOpenPositions()
  const positionUpdates = []
  for (const position of openPositions) {
    try {
      const bars = await fetchBars(position.ticker)
      const evaluation = evaluatePosition(
        {
          symbol: position.ticker, entryPrice: position.avg_cost, entryDate: position.entry_date,
          breakoutLevel: position.avg_cost, grade: 'A', trim1Price: position.trim1_price,
          trim1Shares: 0, trim1Done: !!position.trim1_executed, trim2Price: position.trim2_price,
          trim2Shares: 0, trim2Done: !!position.trim2_executed, currentStop: position.current_stop,
        },
        bars,
        marketContext
      )
      if (evaluation.activeStop !== position.current_stop) db.updatePositionStop(position.id, evaluation.activeStop)
      if (evaluation.forceExit) db.closePosition(position.id)
      positionUpdates.push({ position, evaluation })
    } catch {
      positionUpdates.push({ position, error: 'Could not price this position today' })
    }
  }

  return { breakouts, positionUpdates }
}
