const FINNHUB_URL = '/finnhub/api/v1'

// Finnhub's free tier allows 60 requests/min. A burst of concurrent requests
// (e.g. scanning many tickers) can still trigger 429s well under that budget,
// so retry with backoff instead of silently treating a rate limit as "no data".
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500

function finnhubKey() {
  return import.meta.env.VITE_FINNHUB_API_KEY || null
}

// Fetches a Finnhub endpoint, retrying on 429 with increasing backoff. Returns
// null on a missing key, an exhausted retry budget, a non-429 error response,
// or a network failure — callers treat null as "data unavailable".
export async function fetchFinnhub(path) {
  const key = finnhubKey()
  if (!key) return null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${FINNHUB_URL}${path}&token=${key}`)

      if (response.status === 429 && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  return null
}

// Liquidity/valuation fundamentals from Finnhub's basic-financials endpoint:
// PEG (TTM), market cap (USD, converted from Finnhub's millions), and average
// daily share volume (10-day, converted from Finnhub's millions of shares).
// Each field is null if missing/unavailable; the whole call degrades to all-null
// on any error (including an exhausted 429 retry) rather than throwing.
export async function getFundamentals(symbol) {
  const empty = { peg: null, marketCap: null, avgVolume10D: null }
  const data = await fetchFinnhub(`/stock/metric?symbol=${symbol}&metric=all`)
  if (!data) return empty

  const m = data?.metric || {}
  const peg = typeof m.pegTTM === 'number' && Number.isFinite(m.pegTTM) ? m.pegTTM : null
  const marketCap =
    typeof m.marketCapitalization === 'number' && Number.isFinite(m.marketCapitalization)
      ? m.marketCapitalization * 1e6
      : null
  const avgVolume10D =
    typeof m['10DayAverageTradingVolume'] === 'number' && Number.isFinite(m['10DayAverageTradingVolume'])
      ? m['10DayAverageTradingVolume'] * 1e6
      : null

  return { peg, marketCap, avgVolume10D }
}
