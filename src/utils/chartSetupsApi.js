// Calls the swing_scanner Flask API's /api/setups routes — same API_BASE
// pattern as SwingScanner.jsx/EconomicCalendar.jsx (dev proxy locally,
// absolute VITE_SWING_SCANNER_API_URL in production).
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

async function handle(res) {
  const data = res.status === 204 ? null : await res.json()
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

// Public gallery — published setups only.
export async function getSetups(pattern) {
  const params = pattern ? `?pattern=${encodeURIComponent(pattern)}` : ''
  const data = await handle(await fetch(`${API_BASE}/api/setups${params}`))
  return data.results
}

// Admin: every setup regardless of status (draft/published/archived).
export async function getAllSetupsForAdmin() {
  const data = await handle(await fetch(`${API_BASE}/api/setups?status=all`))
  return data.results
}

export async function getPatternCounts() {
  const data = await handle(await fetch(`${API_BASE}/api/setups/pattern-counts`))
  return data.results
}

export async function getSetup(id) {
  return handle(await fetch(`${API_BASE}/api/setups/${id}`))
}

export async function getSetupCandles(id, days = 180) {
  return handle(await fetch(`${API_BASE}/api/setups/${id}/candles?days=${days}`))
}

export async function createSetup(setup) {
  return handle(await fetch(`${API_BASE}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setup),
  }))
}

export async function updateSetup(id, setup) {
  return handle(await fetch(`${API_BASE}/api/setups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setup),
  }))
}

export async function deleteSetup(id) {
  return handle(await fetch(`${API_BASE}/api/setups/${id}`, { method: 'DELETE' }))
}

// Manual trigger for the same detection job scheduler.py runs at 4:30pm ET —
// runs synchronously and can take a while for a longer ticker list.
export async function runPatternScan(symbols) {
  return handle(await fetch(`${API_BASE}/api/pattern-scan/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols }),
  }))
}
