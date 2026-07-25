import { authHeaders } from './alpacaApi'
import { fetchFinnhub } from './finnhubApi'
import { getEasternTime, isRegularSession, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } from './marketTime'

const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2/stocks'

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

// Up to 1000 daily bars (~400 calendar days) of full OHLCV, with timestamps —
// enough for 52-week high/low, ADX, and weekly resampling.
export async function fetchBars(symbol) {
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

  let response
  try {
    response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
  } catch {
    throw new Error('Network error — could not reach Alpaca market data.')
  }

  if (!response.ok) {
    throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)
  }

  const data = await response.json()
  const bars = data.bars || []
  if (bars.length === 0) {
    throw new Error(`No market data returned for ${symbol}. Check the ticker symbol.`)
  }
  return bars
}

// Full daily OHLCV history going back `lookbackDays`, paginating past
// Alpaca's 1000-bars-per-request cap when the range needs it (e.g. 5y is
// ~1260 trading days). Separate from fetchBars() above, which is hardcoded
// to ~400 days and used by callers that only need ~1 year of context —
// this is for the backtester, which needs multi-year history.
export async function fetchDailyBars(symbol, lookbackDays) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - lookbackDays)

  const bars = []
  let pageToken = null
  do {
    const params = new URLSearchParams({
      timeframe: '1Day',
      start: dateStr(start),
      end: dateStr(end),
      limit: '1000',
      feed: 'iex',
      adjustment: 'split',
    })
    if (pageToken) params.set('page_token', pageToken)

    let response
    try {
      response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
    } catch {
      throw new Error('Network error — could not reach Alpaca market data.')
    }
    if (!response.ok) {
      throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)
    }

    const data = await response.json()
    bars.push(...(data.bars || []))
    pageToken = data.next_page_token || null
  } while (pageToken)

  if (bars.length === 0) {
    throw new Error(`No market data returned for ${symbol}. Check the ticker symbol.`)
  }
  return bars
}

// Today's regular-session 5-minute bars so far, each tagged with its ET
// minute-of-day — lets the entry-rule engine sum volume over specific
// intraday windows (e.g. "first 90 minutes", "by 11am") without re-deriving
// timezone math itself. Returns null outside market hours, on a non-trading
// day, or if the request fails — callers treat that as "intraday data
// unavailable" rather than inventing a volume figure.
export async function fetchIntradayVolume(symbol) {
  const et = getEasternTime()
  if (!isRegularSession(et)) return null

  const now = new Date()
  const startOfDayUtc = new Date(now)
  startOfDayUtc.setUTCHours(0, 0, 0, 0) // always before 9:30am ET regardless of DST

  const params = new URLSearchParams({
    timeframe: '5Min',
    start: startOfDayUtc.toISOString(),
    end: now.toISOString(),
    limit: '150',
    feed: 'iex',
    adjustment: 'split',
  })

  let response
  try {
    response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
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

  return {
    nowMinutes: et.totalMinutes,
    volumeByMinute: sessionBars,
    volumeSoFar: sessionBars.reduce((sum, b) => sum + b.v, 0),
  }
}

// Earnings calendar entries for `symbol` within [today - daysBack, today + daysForward].
// Returns null if the Finnhub key is missing or the request fails after retries
// (degrades to "unavailable" rather than throwing).
export async function fetchEarningsCalendar(symbol, daysBack = 0, daysForward = 14) {
  const from = new Date()
  from.setDate(from.getDate() - daysBack)
  const to = new Date()
  to.setDate(to.getDate() + daysForward)

  const data = await fetchFinnhub(`/calendar/earnings?symbol=${symbol}&from=${dateStr(from)}&to=${dateStr(to)}`)
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : data ? [] : null
}

