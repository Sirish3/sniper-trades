// Live S&P 500 / Nasdaq-100 constituent refresh — session-only, since a
// browser app can't rewrite src/data/sp500.js / nasdaq100.js on disk. This
// mirrors assetUniverse.js's "Total Stock Market" pattern: fetch live, hand
// the result to the caller, who swaps it into local/component state.
//
// Source: Wikipedia's MediaWiki API (via the /wikipedia proxy in
// vite.config.js), not a paid data vendor. Both Finnhub's
// (finnhub.io/pricing-etf-indices) and FMP's index-constituents endpoints
// require a paid plan — confirmed by calling them directly with this
// project's existing free-tier keys, both returned "Restricted Endpoint" /
// "You don't have access to this resource." Wikipedia's constituents tables
// are public and unauthenticated.

const WIKIPEDIA_API = '/wikipedia/w/api.php'
const SP500_MIN_ROWS = 400 // sanity floor — if parsing breaks, fail loudly instead of returning a half-empty list
const NASDAQ100_MIN_ROWS = 90

async function fetchWikipediaPageHtml(page) {
  const params = new URLSearchParams({ action: 'parse', page, prop: 'text', format: 'json', origin: '*' })
  const response = await fetch(`${WIKIPEDIA_API}?${params}`)
  if (!response.ok) throw new Error(`Wikipedia request failed (${response.status}) for "${page}"`)

  const data = await response.json()
  if (data.error) throw new Error(`Wikipedia API error for "${page}": ${data.error.info ?? data.error.code}`)
  const html = data?.parse?.text?.['*']
  if (!html) throw new Error(`Wikipedia returned no content for "${page}"`)
  return html
}

// Both the S&P 500 and Nasdaq-100 pages use a <table id="constituents"> for
// their current-membership list. The first row inside <tbody> is the header
// (<th> cells) — filter to rows that actually have a <td>.
function parseConstituentsRows(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.getElementById('constituents')
  if (!table) throw new Error('Could not find the #constituents table — the page structure may have changed')
  return [...table.querySelectorAll('tbody > tr')].filter((row) => row.querySelector('td'))
}

function cellText(row, index) {
  const cell = row.children[index]
  return cell ? cell.textContent.trim() : ''
}

// { symbol, name, sector } per row, sector = the literal GICS Sector column.
export async function fetchSp500FromWikipedia() {
  const html = await fetchWikipediaPageHtml('List of S&P 500 companies')
  const rows = parseConstituentsRows(html)
  const companies = rows
    .map((row) => ({ symbol: cellText(row, 0), name: cellText(row, 1), sector: cellText(row, 2) }))
    .filter((c) => c.symbol)

  if (companies.length < SP500_MIN_ROWS) {
    throw new Error(`Only parsed ${companies.length} S&P 500 rows (expected ${SP500_MIN_ROWS}+) — page structure may have changed`)
  }
  return companies
}

// The Nasdaq-100 page's table gives Ticker/Company/ICB Industry — ICB is a
// different taxonomy than the GICS sectors used throughout this app
// (sp500.js, the existing nasdaq100.js, sectorRegime.js's SECTOR_ETF map), so
// using its "Industry" column directly would silently mix two incompatible
// classification systems in the sector filter. Instead, backfill sector from
// `sectorBySymbol` (built from the existing static SP500/NASDAQ100 GICS
// data) for tickers we already know, and tag anything new (e.g. a fresh
// reconstitution addition) 'Unclassified' rather than guess — same fallback
// assetUniverse.js already uses for newly-discovered equities.
export async function fetchNasdaq100FromWikipedia(sectorBySymbol = new Map()) {
  const html = await fetchWikipediaPageHtml('Nasdaq-100')
  const rows = parseConstituentsRows(html)
  const companies = rows
    .map((row) => {
      const symbol = cellText(row, 0)
      return { symbol, name: cellText(row, 1), sector: sectorBySymbol.get(symbol) ?? 'Unclassified' }
    })
    .filter((c) => c.symbol)

  if (companies.length < NASDAQ100_MIN_ROWS) {
    throw new Error(`Only parsed ${companies.length} Nasdaq-100 rows (expected ${NASDAQ100_MIN_ROWS}+) — page structure may have changed`)
  }
  return companies
}

// Symbols present in `next` but not `previous` / vice versa — lets the UI
// show e.g. "+1 new: CRWV" after a refresh instead of just a row count.
export function diffConstituents(previous, next) {
  const prevSymbols = new Set(previous.map((c) => c.symbol))
  const nextSymbols = new Set(next.map((c) => c.symbol))
  return {
    added: next.filter((c) => !prevSymbols.has(c.symbol)).map((c) => c.symbol),
    removed: previous.filter((c) => !nextSymbols.has(c.symbol)).map((c) => c.symbol),
  }
}
