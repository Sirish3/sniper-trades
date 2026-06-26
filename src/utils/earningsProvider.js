// Earnings-date lookup — calls a local Python microservice
// (earnings_service/earnings_service.py) that wraps yfinance, since
// yfinance is Python-only and this app is JS/React. This module is the
// ONLY thing that knows that detail: it exposes the same
// getEarningsMap(tickers) -> { symbol -> { date, daysAway, source } }
// interface regardless of what's behind it. weekHighScreener.js,
// stockAnalysis.js, and verdict.js never know or care that yfinance is the
// source — swap this module (or just the URL it calls) for a different
// provider later and nothing downstream changes.
//
// No per-ticker HTTP calls happen here — ONE request covers the whole
// scan; the service handles its own Yahoo politeness/concurrency/caching
// server-side (see earnings_service.py's config block), since that's a
// concern of whatever sits behind this interface, not of this client.
//
// Source tags (same three tiers used everywhere else in this app):
//   CONFIRMED — the service found a real, future earnings date.
//   ESTIMATED — no upcoming date, but the service projected one from
//               earnings history (same-fiscal-quarter-last-year preferred,
//               else +~91d — computed server-side).
//   UNKNOWN   — no usable date at all, or the fetch failed.

const EARNINGS_SERVICE_URL = '/earnings-api/earnings'

function daysUntil(dateStringValue) {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const d = new Date(`${dateStringValue}T00:00:00Z`)
  return Math.round((d - today) / 86_400_000)
}

function unknownFor(tickers) {
  const result = {}
  for (const symbol of tickers) result[symbol] = { date: null, daysAway: null, source: 'UNKNOWN' }
  return result
}

// Batched earnings lookup for a whole scan. Never throws: if the service is
// unreachable, missing, or returns something unexpected, every ticker
// degrades to UNKNOWN (logged loudly) rather than failing the scan — this
// is the same GLW-type fix as before (unknown must never bury a strong
// stock), just at the transport layer this time.
export async function getEarningsMap(tickers) {
  if (tickers.length === 0) return {}

  let data
  try {
    const response = await fetch(`${EARNINGS_SERVICE_URL}?symbols=${tickers.join(',')}`)
    if (!response.ok) throw new Error(`earnings service returned HTTP ${response.status}`)
    data = await response.json()
  } catch (err) {
    console.error(`[earningsProvider] earnings service unreachable — every ticker falls back to UNKNOWN: ${err.message}`)
    return unknownFor(tickers)
  }

  const result = {}
  const counts = { CONFIRMED: 0, ESTIMATED: 0, UNKNOWN: 0 }
  for (const symbol of tickers) {
    const entry = data[symbol]
    const tagged = !entry || entry.source === 'UNKNOWN' || entry.date == null
      ? { date: null, daysAway: null, source: 'UNKNOWN' }
      : { date: entry.date, daysAway: daysUntil(entry.date), source: entry.source }
    result[symbol] = tagged
    counts[tagged.source]++
  }

  console.info(`[earningsProvider] earnings: ${counts.CONFIRMED} confirmed / ${counts.ESTIMATED} estimated / ${counts.UNKNOWN} unknown (of ${tickers.length})`)
  return result
}
