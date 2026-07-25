// Backs the "Filter" tab: fetches recent daily bars for a chosen exchange
// list (via screener.js's scanUniverse — same rate-limited Alpaca batching
// WeekHighScreener.jsx uses) and computes price + the 10/20/50-day EMA
// stack + price-vs-200-day-SMA per ticker. No grading, no signals — every
// checkbox in the Filter tab is a plain client-side filter over these raw
// numbers, not a second evaluation pipeline.
//
// Fundamentals (EPS/revenue growth, ROE, debt/equity, market cap, free
// cash flow) are a deliberately separate, explicit step — see
// checkFundamentals() below — triggered after narrowing down via the free
// technical filters above, not fetched for the whole scanned universe.
// Finnhub's basic-financials endpoint has no bulk form (one call per
// symbol, free tier ~60 req/min), so cost should scale with "stocks I'm
// actually considering," same reasoning weekHighScreener.js's
// checkEarningsForResults already documents for its own separate,
// user-triggered Finnhub step.
import { ema, sma } from './indicators'
import { scanUniverse } from './screener'
import { fetchFinnhub } from './finnhubApi'

// SEC's own rule-of-thumb cutoff for what counts as a "penny stock".
export const PENNY_STOCK_MAX_PRICE = 5

export const EPS_GROWTH_MIN_PCT = 25
export const REVENUE_GROWTH_MIN_PCT = 20
export const ROE_MIN_PCT = 20
export const DEBT_EQUITY_MAX = 0.5
export const MARKET_CAP_MIN = 2_000_000_000

const FUNDAMENTALS_FETCH_CONCURRENCY = 8 // matches earningsProvider.js's Finnhub free-tier budget

function evaluateFilterCandidate(company, closes) {
  const ema10 = ema(closes, 10)
  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  if (ema10 == null || ema20 == null || ema50 == null) return null

  const price = closes[closes.length - 1]
  const sma200 = sma(closes, 200) // null for names with <200 trading days of history

  return {
    symbol: company.symbol,
    name: company.name,
    sector: company.sector,
    price,
    ema10,
    ema20,
    ema50,
    emaStackedUp: ema10 > ema20 && ema20 > ema50,
    sma200,
    aboveSma200: sma200 != null ? price > sma200 : null,
    // Populated by checkFundamentals() — stay null until that explicit step runs.
    fundamentalsChecked: false,
    marketCap: null,
    epsGrowth: null,
    revenueGrowth: null,
    roe: null,
    debtToEquity: null,
    fcfPositive: null,
    fcfGrowing: null,
  }
}

export async function scanFilterCandidates(onProgress, universe) {
  return scanUniverse(onProgress, universe, evaluateFilterCandidate)
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// One symbol's fundamentals from Finnhub's basic-financials endpoint
// (/stock/metric?metric=all). Field names below are confirmed against a
// live response, not guessed — Finnhub's own docs page doesn't list them.
// epsGrowth*/revenueGrowth*/roe* come back already as percentages (e.g.
// 29.01 means 29.01%, not 0.2901); debt/equity is a plain ratio. TTM
// figures are preferred (freshest); the 5-year figure is the fallback for
// thinly-covered names rather than reporting unknown outright.
//
// There's no single "free cash flow is positive and growing" field, so
// both are derived from the trailing-twelve-month FCF/share quarterly
// series (series.quarterly.fcfPerShareTTM, newest-first): positive means
// the latest TTM figure is > 0; growing compares it to the same TTM
// figure 4 quarters ago (true YoY, not seasonal noise within one year).
async function fetchOneFundamentalScreen(symbol) {
  const empty = {
    marketCap: null, epsGrowth: null, revenueGrowth: null, roe: null,
    debtToEquity: null, fcfPositive: null, fcfGrowing: null,
  }
  const data = await fetchFinnhub(`/stock/metric?symbol=${symbol}&metric=all`)
  if (!data) return empty

  const m = data.metric || {}
  const marketCap = numOrNull(m.marketCapitalization) != null ? m.marketCapitalization * 1e6 : null
  const epsGrowth = numOrNull(m.epsGrowthTTMYoy) ?? numOrNull(m.epsGrowth5Y)
  const revenueGrowth = numOrNull(m.revenueGrowthTTMYoy) ?? numOrNull(m.revenueGrowth5Y)
  const roe = numOrNull(m.roeTTM) ?? numOrNull(m.roeRfy)
  const debtToEquity = numOrNull(m['totalDebt/totalEquityQuarterly']) ?? numOrNull(m['totalDebt/totalEquityAnnual'])

  const fcfSeries = data.series?.quarterly?.fcfPerShareTTM
  let fcfPositive = null
  let fcfGrowing = null
  if (Array.isArray(fcfSeries) && fcfSeries.length > 0) {
    const latest = numOrNull(fcfSeries[0]?.v)
    fcfPositive = latest != null ? latest > 0 : null
    if (fcfSeries.length > 4) {
      const yearAgo = numOrNull(fcfSeries[4]?.v)
      fcfGrowing = latest != null && yearAgo != null ? latest > yearAgo : null
    }
  }

  return { marketCap, epsGrowth, revenueGrowth, roe, debtToEquity, fcfPositive, fcfGrowing }
}

// Fetches fundamentals for `results` in rate-limited batches (mirrors
// earningsProvider.js's getEarningsMap concurrency), mutating each result
// object in place and setting fundamentalsChecked. Call this with
// whatever subset the user has already narrowed down to via the technical
// filters — not the whole scanned universe (see file header).
export async function checkFundamentals(results, onProgress) {
  let done = 0
  for (let i = 0; i < results.length; i += FUNDAMENTALS_FETCH_CONCURRENCY) {
    const batch = results.slice(i, i + FUNDAMENTALS_FETCH_CONCURRENCY)
    const fetched = await Promise.all(batch.map((r) => fetchOneFundamentalScreen(r.symbol)))
    batch.forEach((r, idx) => {
      Object.assign(r, fetched[idx])
      r.fundamentalsChecked = true
    })
    done += batch.length
    onProgress?.(done, results.length)
  }
}

// Rough lower-bound estimate (minutes) for checkFundamentals — Finnhub's
// free tier allows ~60 requests/min and basic financials has no bulk form,
// so this is strictly one request per symbol.
export function estimateFundamentalsMinutes(count) {
  return Math.round(count / 60)
}
