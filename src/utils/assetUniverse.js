import { authHeaders } from './alpacaApi'
import { ETFS_AND_METALS } from '../data/etfsAndMetals'

const ASSETS_URL = '/alpaca/v2/assets'

// Live "Total Stock Market" universe: every active, tradable, fractionable
// NASDAQ/NYSE equity (~5000 tickers — Alpaca's fractionable flag is a decent
// proxy for "real, liquid, investable company"), plus a curated set of major
// ETFs/metals funds that mostly trade on NYSE Arca and so aren't covered by
// the exchange filter. Returns null on any error so the UI can disable the
// checkbox rather than scanning an empty/partial list.
export async function getTotalStockMarketUniverse() {
  try {
    const params = new URLSearchParams({ status: 'active', asset_class: 'us_equity' })
    const response = await fetch(`${ASSETS_URL}?${params}`, { headers: authHeaders() })
    if (!response.ok) return null
    const assets = await response.json()

    const equities = assets
      .filter((a) => (a.exchange === 'NASDAQ' || a.exchange === 'NYSE') && a.tradable && a.fractionable)
      .map((a) => ({ symbol: a.symbol, name: a.name, sector: 'Unclassified' }))

    const seen = new Set(equities.map((c) => c.symbol))
    for (const etf of ETFS_AND_METALS) {
      if (!seen.has(etf.symbol)) equities.push(etf)
    }

    return equities
  } catch {
    return null
  }
}
