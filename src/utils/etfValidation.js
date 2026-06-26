// Validates the curated ETFS_AND_METALS watchlist against Alpaca's asset
// registry. There's no published index behind that list (it's hand-picked,
// not index membership), so "refresh" can't mean re-deriving constituents —
// it means confirming every ticker is still a real, tradable Alpaca asset,
// the same check assetUniverse.js already relies on for the live "Total
// Stock Market" group. Never drops a symbol; just annotates it so the UI can
// flag stale entries (e.g. a fund that's since been delisted or restricted).

import { authHeaders } from './alpacaApi'

const ASSETS_URL = '/alpaca/v2/assets'

export async function validateEtfTickers(tickers) {
  return Promise.all(
    tickers.map(async (symbol) => {
      try {
        const response = await fetch(`${ASSETS_URL}/${symbol}`, { headers: authHeaders() })
        if (response.status === 404) return { symbol, status: 'missing', tradable: false }
        if (!response.ok) return { symbol, status: 'error', tradable: null }
        const asset = await response.json()
        return { symbol, status: asset.tradable ? 'active' : 'inactive', tradable: !!asset.tradable, name: asset.name }
      } catch {
        return { symbol, status: 'error', tradable: null }
      }
    })
  )
}
