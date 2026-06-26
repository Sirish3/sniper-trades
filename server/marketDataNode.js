// Server-side market data fetchers — same data shapes as
// ../src/utils/marketData.js / alpacaApi.js / finnhubApi.js / marketRegime.js
// (fetchBars returns the same bar objects, fetchIntradayVolume the same
// { nowMinutes, volumeByMinute, volumeSoFar } shape, etc.) so the pure
// classification logic in src/utils (indicators, entrySignal, positionPlan,
// agenticScreener's gradeSetup) can be imported and used completely
// unchanged from src/utils.
//
// The only real difference from the browser versions: no CORS workaround is
// needed here (CORS only applies to browser fetches), so these hit Alpaca/
// Finnhub/Yahoo directly instead of going through Vite's dev proxy.

import { getEnv } from './env.js'
import { getEasternTime, isRegularSession, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } from '../src/utils/marketTime.js'

const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2/stocks'
const FINNHUB_URL = 'https://finnhub.io/api/v1'
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'

function alpacaHeaders() {
  const keyId = getEnv('ALPACA_KEY_ID')
  const secretKey = getEnv('ALPACA_SECRET_KEY')
  if (!keyId || !secretKey) throw new Error('Alpaca API credentials are not configured (VITE_ALPACA_KEY_ID/VITE_ALPACA_SECRET_KEY).')
  return { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey }
}

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

// Up to 1000 daily bars (~400 calendar days) of full OHLCV, with timestamps.
export async function fetchBars(symbol) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 400)

  const params = new URLSearchParams({
    timeframe: '1Day', start: dateStr(start), end: dateStr(end), limit: '1000', feed: 'iex', adjustment: 'split',
  })

  const response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: alpacaHeaders() })
  if (!response.ok) throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)

  const data = await response.json()
  const bars = data.bars || []
  if (bars.length === 0) throw new Error(`No market data returned for ${symbol}.`)
  return bars
}

// Plain close-price series (mirrors marketRegime.js's fetchAlpacaCloses) —
// used for SPY/QQQ/sector-ETF trend scoring.
export async function fetchAlpacaCloses(symbol) {
  const bars = await fetchBars(symbol)
  return bars.map((b) => b.c)
}

export async function fetchYahooCloses(symbol) {
  const response = await fetch(`${YAHOO_CHART_URL}/${symbol}?range=1y&interval=1d`)
  if (!response.ok) throw new Error(`Yahoo chart request failed (${response.status}) for ${symbol}`)
  const data = await response.json()
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
  if (!Array.isArray(closes)) throw new Error(`No chart data returned for ${symbol}`)
  const clean = closes.filter((c) => c != null)
  if (clean.length === 0) throw new Error(`No usable close prices for ${symbol}`)
  return clean
}

// Today's regular-session 5-minute bars so far, ET-tagged — same shape as
// the browser's fetchIntradayVolume, for entrySignal.js's volume-by-time
// checks (first-90-minutes, 3pm pace, etc.).
export async function fetchIntradayVolume(symbol) {
  const et = getEasternTime()
  if (!isRegularSession(et)) return null

  const now = new Date()
  const startOfDayUtc = new Date(now)
  startOfDayUtc.setUTCHours(0, 0, 0, 0)

  const params = new URLSearchParams({
    timeframe: '5Min', start: startOfDayUtc.toISOString(), end: now.toISOString(), limit: '150', feed: 'iex', adjustment: 'split',
  })

  let response
  try {
    response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: alpacaHeaders() })
  } catch {
    return null
  }
  if (!response.ok) return null

  const data = await response.json()
  const bars = data.bars || []
  const sessionBars = bars
    .map((b) => ({ v: b.v, etMinutes: getEasternTime(new Date(b.t)).totalMinutes }))
    .filter((b) => b.etMinutes >= MARKET_OPEN_MIN && b.etMinutes <= MARKET_CLOSE_MIN)

  if (sessionBars.length === 0) return null
  return { nowMinutes: et.totalMinutes, volumeByMinute: sessionBars, volumeSoFar: sessionBars.reduce((sum, b) => sum + b.v, 0) }
}

function finnhubKey() {
  return getEnv('FINNHUB_API_KEY')
}

async function fetchFinnhub(path) {
  const key = finnhubKey()
  if (!key) return null
  try {
    const response = await fetch(`${FINNHUB_URL}${path}&token=${key}`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

// Earnings calendar entries within [today - daysBack, today + daysForward].
export async function fetchEarningsCalendar(symbol, daysBack = 0, daysForward = 14) {
  const from = new Date()
  from.setDate(from.getDate() - daysBack)
  const to = new Date()
  to.setDate(to.getDate() + daysForward)

  const data = await fetchFinnhub(`/calendar/earnings?symbol=${symbol}&from=${dateStr(from)}&to=${dateStr(to)}`)
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : data ? [] : null
}

// PEG, market cap (USD), and 10-day average volume (shares) — same shape as
// finnhubApi.js's getFundamentals.
export async function getFundamentals(symbol) {
  const empty = { peg: null, marketCap: null, avgVolume10D: null }
  const data = await fetchFinnhub(`/stock/metric?symbol=${symbol}&metric=all`)
  if (!data) return empty

  const m = data?.metric || {}
  const peg = typeof m.pegTTM === 'number' && Number.isFinite(m.pegTTM) ? m.pegTTM : null
  const marketCap = typeof m.marketCapitalization === 'number' ? m.marketCapitalization * 1e6 : null
  const avgVolume10D = typeof m['10DayAverageTradingVolume'] === 'number' ? m['10DayAverageTradingVolume'] * 1e6 : null
  return { peg, marketCap, avgVolume10D }
}
