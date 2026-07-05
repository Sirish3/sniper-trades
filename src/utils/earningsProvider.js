// Earnings-date lookup — calls Finnhub directly (no Python microservice;
// this used to wrap earnings_service/, a yfinance/Yahoo-backed Flask app,
// which has been retired in favor of Finnhub, already used elsewhere in
// this app — see finnhubApi.js). Exposes the same
// getEarningsMap(tickers) -> { symbol -> { date, daysAway, source } }
// interface regardless of what's behind it, per this module's original
// design intent: weekHighScreener.js, stockAnalysis.js, and verdict.js
// never know or care that Finnhub is the source.
//
// Source tags (same three tiers used everywhere else in this app):
//   CONFIRMED — Finnhub's earnings calendar has a real, scheduled date
//               within CONFIRMED_WINDOW_FORWARD_DAYS.
//   ESTIMATED — no scheduled date in that window, but earnings history
//               exists to project one from (same-fiscal-quarter-last-year
//               preferred, else +~91d) — see selfEstimateNextEarnings.
//   UNKNOWN   — no usable date at all, or the fetch failed.
//
// ASSUMPTION FLAGGED — /calendar/earnings truncates at ~1500 entries with
// NO indication it happened, and (confirmed live) doesn't even keep the
// nearest-term dates when it does: a single 2026-07-02..2026-11-02 request
// came back capped at exactly 1500 rows covering only 2026-10-21..11-02 —
// every near-term (most decision-relevant) date silently missing. A 21-day
// window measured 761 rows; 30 days already hit the cap. So the confirmed
// window is fetched in CONFIRMED_CHUNK_DAYS-sized pieces and merged instead
// of one wide request, keeping each request far under the cap regardless
// of how dense a given earnings season is.
//
// ASSUMPTION FLAGGED: Finnhub's /stock/earnings history endpoint reports
// fiscal QUARTER-END dates ("period"), not the actual report/announcement
// date — unlike yfinance's get_earnings_dates(), whose index was the real
// report date. Report dates are typically ~3-5 weeks after quarter-end, so
// REPORT_LAG_DAYS_APPROX is added to each historical quarter-end before
// running the same next-report estimation logic the old service used.
// This makes ESTIMATED dates a bit coarser than before; CONFIRMED dates
// are unaffected (those come straight from Finnhub's own calendar, not
// this approximation).

import { fetchFinnhub } from './finnhubApi'

const CONFIRMED_WINDOW_BACK_DAYS = 3
const CONFIRMED_WINDOW_FORWARD_DAYS = 120  // wide enough to span a full quarterly cycle
const CONFIRMED_CHUNK_DAYS = 14            // per-request slice size — see ASSUMPTION FLAGGED above re: the ~1500-entry truncation cap
const REPORT_LAG_DAYS_APPROX = 32          // typical quarter-end -> report-date gap (see module docstring)
const FALLBACK_CADENCE_DAYS = 91           // ~1 quarter, the naive "next earnings" guess when no better anchor exists
const SAME_QUARTER_TOLERANCE_DAYS = 45     // how close a history date must be to "exactly a year before the naive guess" to be preferred
const ESTIMATE_FETCH_CONCURRENCY = 8       // matches the old service's ThreadPoolExecutor(max_workers=8)

function todayUtc() {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10)
}

function daysUntil(dateStringValue) {
  const today = todayUtc()
  const d = new Date(`${dateStringValue}T00:00:00Z`)
  return Math.round((d - today) / 86_400_000)
}

function addDaysKeepingWeekday(d, days) {
  // Shifts `d` forward by `days`, then nudges 0-6 days further forward to
  // land back on the same weekday — earnings calls tend to recur on the
  // same weekday each quarter, and 365 days is 52 weeks + 1 day.
  const shifted = new Date(d)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  const drift = (((d.getUTCDay() - shifted.getUTCDay()) % 7) + 7) % 7
  shifted.setUTCDate(shifted.getUTCDate() + drift)
  return shifted
}

// Estimates the next report date from approximate report-date history (see
// module docstring re: the quarter-end -> report-date lag). The naive guess
// is the most recent approximate report date + ~91 days; refined by looking
// for a historical date close to exactly 365 days before THAT guess (the
// same calendar quarter, one year earlier) and projecting it forward +365d
// (weekday-adjusted) instead, since a company's actual report date drifts
// less year-over-year within the same quarter than a flat +91d cadence
// assumes. Falls back to the naive +91d guess when no such anchor exists.
function selfEstimateNextEarnings(historyDates) {
  const sorted = [...historyDates].sort((a, b) => a - b)
  const mostRecent = sorted[sorted.length - 1]
  const nextApprox = new Date(mostRecent)
  nextApprox.setUTCDate(nextApprox.getUTCDate() + FALLBACK_CADENCE_DAYS)
  const targetLastYear = new Date(nextApprox)
  targetLastYear.setUTCDate(targetLastYear.getUTCDate() - 365)

  let best = null
  let bestDiff = null
  for (const d of sorted) {
    const diff = Math.abs((d - targetLastYear) / 86_400_000)
    if (bestDiff === null || diff < bestDiff) {
      best = d
      bestDiff = diff
    }
  }

  if (best !== null && bestDiff <= SAME_QUARTER_TOLERANCE_DAYS) {
    return addDaysKeepingWeekday(best, 365)
  }
  return nextApprox
}

// A handful of batched calls (CONFIRMED_CHUNK_DAYS-wide slices) covering
// every symbol reporting in the window — Finnhub's /calendar/earnings
// returns the whole market's scheduled earnings when called without a
// `symbol` param, so this never needs a per-ticker request for the common
// case (a scheduled date within the window). Sliced rather than one wide
// request specifically to stay under the ~1500-entry truncation cap — see
// the ASSUMPTION FLAGGED note in the module docstring.
async function fetchConfirmedCalendar() {
  const windowStart = todayUtc()
  windowStart.setUTCDate(windowStart.getUTCDate() - CONFIRMED_WINDOW_BACK_DAYS)
  const windowEnd = todayUtc()
  windowEnd.setUTCDate(windowEnd.getUTCDate() + CONFIRMED_WINDOW_FORWARD_DAYS)

  const map = {}
  let chunkStart = windowStart
  while (chunkStart < windowEnd) {
    const chunkEnd = new Date(chunkStart)
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CONFIRMED_CHUNK_DAYS)
    const cappedEnd = chunkEnd < windowEnd ? chunkEnd : windowEnd

    const data = await fetchFinnhub(`/calendar/earnings?from=${fmtDate(chunkStart)}&to=${fmtDate(cappedEnd)}`)
    for (const entry of data?.earningsCalendar || []) {
      if (!entry.symbol || !entry.date) continue
      if (!map[entry.symbol] || entry.date < map[entry.symbol]) map[entry.symbol] = entry.date
    }

    chunkStart = cappedEnd
  }
  return map
}

// Per-symbol fallback for anything without a near-term confirmed date —
// historical quarter-end dates, shifted by the approximate report lag.
async function fetchApproxHistoricalReportDates(symbol) {
  const data = await fetchFinnhub(`/stock/earnings?symbol=${symbol}`)
  if (!Array.isArray(data)) return []
  return data
    .map((e) => e.period)
    .filter(Boolean)
    .map((period) => {
      const d = new Date(`${period}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + REPORT_LAG_DAYS_APPROX)
      return d
    })
}

async function estimateOne(symbol) {
  try {
    const historyDates = await fetchApproxHistoricalReportDates(symbol)
    if (historyDates.length === 0) return { date: null, daysAway: null, source: 'UNKNOWN' }
    const estimate = fmtDate(selfEstimateNextEarnings(historyDates))
    return { date: estimate, daysAway: daysUntil(estimate), source: 'ESTIMATED' }
  } catch {
    return { date: null, daysAway: null, source: 'UNKNOWN' }
  }
}

// Batched earnings lookup for a whole scan. Never throws: if Finnhub is
// unreachable or returns something unexpected, every ticker degrades to
// UNKNOWN (logged loudly) rather than failing the scan — unknown must
// never bury a strong stock.
export async function getEarningsMap(tickers) {
  if (tickers.length === 0) return {}

  let confirmedMap = {}
  try {
    confirmedMap = await fetchConfirmedCalendar()
  } catch (err) {
    console.error(`[earningsProvider] confirmed calendar fetch failed, falling back to per-symbol estimation for everyone: ${err.message}`)
  }

  const result = {}
  const needsEstimate = []
  const today = todayUtc()

  for (const symbol of tickers) {
    const confirmedDate = confirmedMap[symbol]
    if (confirmedDate && new Date(`${confirmedDate}T00:00:00Z`) >= today) {
      result[symbol] = { date: confirmedDate, daysAway: daysUntil(confirmedDate), source: 'CONFIRMED' }
    } else {
      needsEstimate.push(symbol)
    }
  }

  // Limited-concurrency fallback (not Promise.all-everything) — Finnhub's
  // free tier is 60 req/min, and this is the one path that's still
  // per-symbol; fetchFinnhub already retries on 429, but batching avoids
  // triggering a rate-limit storm in the first place.
  for (let i = 0; i < needsEstimate.length; i += ESTIMATE_FETCH_CONCURRENCY) {
    const batch = needsEstimate.slice(i, i + ESTIMATE_FETCH_CONCURRENCY)
    const estimates = await Promise.all(batch.map(estimateOne))
    batch.forEach((symbol, idx) => { result[symbol] = estimates[idx] })
  }

  const counts = { CONFIRMED: 0, ESTIMATED: 0, UNKNOWN: 0 }
  for (const symbol of tickers) counts[result[symbol].source]++
  console.info(`[earningsProvider] earnings: ${counts.CONFIRMED} confirmed / ${counts.ESTIMATED} estimated / ${counts.UNKNOWN} unknown (of ${tickers.length})`)
  return result
}
