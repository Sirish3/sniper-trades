// Backs the "Filter" tab: fetches recent daily bars for a chosen exchange
// list (via screener.js's scanUniverse — same rate-limited Alpaca batching
// WeekHighScreener.jsx uses) and computes just price + the 10/20/50-day EMA
// stack per ticker. No grading, no signals — the Filter tab's checkboxes
// (penny-stock price floor, EMA stack) are plain client-side filters over
// these raw numbers, not a second evaluation pipeline.
import { ema } from './indicators'
import { scanUniverse } from './screener'

// SEC's own rule-of-thumb cutoff for what counts as a "penny stock".
export const PENNY_STOCK_MAX_PRICE = 5

function evaluateFilterCandidate(company, closes) {
  const ema10 = ema(closes, 10)
  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  if (ema10 == null || ema20 == null || ema50 == null) return null

  return {
    symbol: company.symbol,
    name: company.name,
    sector: company.sector,
    price: closes[closes.length - 1],
    ema10,
    ema20,
    ema50,
    emaStackedUp: ema10 > ema20 && ema20 > ema50,
  }
}

export async function scanFilterCandidates(onProgress, universe) {
  return scanUniverse(onProgress, universe, evaluateFilterCandidate)
}
