import { SP500 } from '../data/sp500'
import { NASDAQ100 } from '../data/nasdaq100'
import { ETFS_AND_METALS } from '../data/etfsAndMetals'

function getSectorBaseUniverse(sp500, nasdaq100) {
  const seen = new Set(sp500.map((c) => c.symbol))
  const combined = [...sp500]
  for (const c of nasdaq100) {
    if (!seen.has(c.symbol)) {
      seen.add(c.symbol)
      combined.push(c)
    }
  }
  return combined
}

function slugify(sector) {
  return sector.toLowerCase().replace(/\s+/g, '-')
}

// `overrides.sp500` / `overrides.nasdaq100` let a caller swap in a
// live-refreshed constituent list (see indexConstituents.js) for that
// session without touching the static data files — everything else (sector
// grouping, the ETFs/Total-Market groups) derives from whichever lists are
// passed in, defaulting to the static SP500/NASDAQ100 imports.
export function getUniverseGroups(totalMarketCompanies = [], overrides = {}) {
  const sp500 = overrides.sp500 ?? SP500
  const nasdaq100 = overrides.nasdaq100 ?? NASDAQ100
  const etfsAndMetals = overrides.etfsAndMetals ?? ETFS_AND_METALS
  const sectorBase = getSectorBaseUniverse(sp500, nasdaq100)
  const sectors = [...new Set(sectorBase.map((c) => c.sector))].sort()

  return [
    { id: 'sp500', label: 'S&P 500', companies: sp500 },
    { id: 'nasdaq100', label: 'Nasdaq 100', companies: nasdaq100 },
    { id: 'etfs', label: 'ETFs & Metals', companies: etfsAndMetals },
    { id: 'total-market', label: 'Total Stock Market', companies: totalMarketCompanies },
    ...sectors.map((sector) => ({
      id: `sector-${slugify(sector)}`,
      label: sector,
      companies: sectorBase.filter((c) => c.sector === sector),
    })),
  ]
}
