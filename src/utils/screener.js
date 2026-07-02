import { authHeaders } from './alpacaApi'

const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2/stocks'

// Alpaca's free/paper data plan allows ~200 requests/min, but bursts of
// concurrent requests can still trigger 429s. Use a modest batch size/delay
// and retry on 429 so a brief rate-limit hit doesn't drop a ticker.
const BATCH_SIZE = 10
const BATCH_DELAY_MS = 5000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

const MIN_BARS = 60

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

async function fetchBars(symbol) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 370)

  const params = new URLSearchParams({
    timeframe: '1Day',
    start: dateStr(start),
    end: dateStr(end),
    limit: '300',
    feed: 'iex',
    adjustment: 'split',
  })

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })

    if (response.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      continue
    }

    if (!response.ok) throw new Error(`${response.status}`)

    const data = await response.json()
    const bars = data.bars || []
    if (bars.length < MIN_BARS) throw new Error('insufficient history')
    return {
      closes: bars.map((b) => b.c),
      volumes: bars.map((b) => b.v),
      highs: bars.map((b) => b.h),
      lows: bars.map((b) => b.l),
      opens: bars.map((b) => b.o),
    }
  }

  throw new Error('429')
}

// Scans the given constituents in rate-limited batches, calling
// evaluate(company, closes, volumes, highs, lows, opens) for each and
// collecting non-null results. Symbols that fail to fetch, have insufficient
// history, or whose evaluator returns null are collected in `skipped`. Calls
// onProgress(done, total) after each ticker so the UI can show scan progress.
export async function scanUniverse(onProgress, universe, evaluate) {
  const results = []
  const skipped = []
  let done = 0

  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(
      batch.map(async (company) => {
        try {
          const { closes, volumes, highs, lows, opens } = await fetchBars(company.symbol)
          const result = evaluate(company, closes, volumes, highs, lows, opens)
          if (!result) {
            skipped.push(company.symbol)
            return null
          }
          return result
        } catch {
          skipped.push(company.symbol)
          return null
        } finally {
          done++
          onProgress?.(done, universe.length)
        }
      })
    )

    results.push(...batchResults.filter(Boolean))

    if (i + BATCH_SIZE < universe.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }
  }

  return { results, skipped }
}

// Rough lower-bound estimate (in minutes) for how long scanUniverse will take
// over `count` tickers, based on the batch size/delay above. Actual time is
// somewhat higher due to per-request fetch latency.
export function estimateScanMinutes(count) {
  const batches = Math.ceil(count / BATCH_SIZE)
  return Math.round((batches * BATCH_DELAY_MS) / 1000 / 60)
}
