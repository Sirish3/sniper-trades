// One-off script: dumps the React app's ticker universes to JSON so the
// execution scheduler has a single source of truth instead of
// hand-duplicating 500+ tickers. Run with `node backend/data/export_universe.mjs`
// whenever the React app's data files change (e.g. after a Refresh in the
// UI gets manually folded back into the static files).
import { SP500 } from '../../src/data/sp500.js'
import { NASDAQ100 } from '../../src/data/nasdaq100.js'
import { ETFS_AND_METALS } from '../../src/data/etfsAndMetals.js'
import { writeFileSync, mkdirSync } from 'fs'

const targets = [
  new URL('./', import.meta.url),
]

for (const dir of targets) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(new URL('sp500.json', dir), JSON.stringify(SP500, null, 2))
  writeFileSync(new URL('nasdaq100.json', dir), JSON.stringify(NASDAQ100, null, 2))
  writeFileSync(new URL('etfs.json', dir), JSON.stringify(ETFS_AND_METALS, null, 2))
}

console.log(`Exported ${SP500.length} S&P 500, ${NASDAQ100.length} Nasdaq-100, ${ETFS_AND_METALS.length} ETF tickers to ${targets.length} locations.`)
