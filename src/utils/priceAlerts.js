// Forward-looking price-trigger watch list — set via the "Set Alert" buttons
// on a built trade plan's Entry/Stop/Trim1/Trim2 rows. Distinct from
// alerts.js's log, which records alerts that have already fired (buy
// signals, position trim/exit escalations) — these are levels the user is
// still waiting on. localStorage only for now; a future step syncs this
// list to a hosted DB instead.

const STORAGE_KEY = 'sniper-trades-price-alerts'

export function loadPriceAlerts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function savePriceAlerts(alerts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))
}

// One alert per symbol+label+price combo — re-clicking "Set Alert" after a
// re-scan where the level hasn't moved doesn't pile up duplicates.
export function addPriceAlert(alerts, { symbol, name, price, label }) {
  const exists = alerts.some((a) => a.symbol === symbol && a.label === label && a.price === price)
  if (exists) return alerts

  const alert = {
    id: `${symbol}-${label}-${Date.now()}`,
    symbol,
    name: name ?? symbol,
    price,
    label,
    createdAt: new Date().toISOString(),
  }
  return [alert, ...alerts]
}

export function removePriceAlert(alerts, id) {
  return alerts.filter((a) => a.id !== id)
}
