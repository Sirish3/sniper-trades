const ALERTS_STORAGE_KEY = 'swing-trade-alerts'
const MAX_ALERTS = 200

function loadAlerts() {
  try {
    const raw = localStorage.getItem(ALERTS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveAlerts(alerts) {
  localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(alerts))
}

// Appends one alert per symbol per calendar day, so re-scanning later the
// same day doesn't spam duplicate entries for a ticker that's still a BUY.
// `buys` is the [{ r, a }] pairs produced by analyzeStock() — the full `r`
// snapshot is kept so "Show Analysis" can rebuild the exact panel later via
// analyzeStock(snapshot, ...), frozen at the moment the alert fired.
export function logBuyAlerts(buys) {
  const existing = loadAlerts()
  const today = new Date().toISOString().slice(0, 10)
  const seenToday = new Set(existing.filter((a) => a.loggedAt.slice(0, 10) === today).map((a) => a.symbol))

  const fresh = buys
    .filter(({ r }) => !seenToday.has(r.symbol))
    .map(({ r, a }) => ({
      id: `${r.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'buy',
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      signalType: r.signalType,
      grade: r.grade,
      price: r.price,
      summary: a.decision.summary,
      confidence: a.decision.confidence,
      urgency: a.decision.urgency,
      loggedAt: new Date().toISOString(),
      snapshot: r,
    }))

  if (fresh.length === 0) return []
  saveAlerts([...fresh, ...existing].slice(0, MAX_ALERTS))
  return fresh
}

function positionAlertSummary(evaluation) {
  switch (evaluation.action) {
    case 'EXIT':
      return evaluation.exitSignals?.[0] ?? 'Exit signal triggered'
    case 'TRIM 1':
      return `Trim 1 target reached at $${evaluation.currentPrice?.toFixed(2)}`
    case 'TRIM 2':
      return `Trim 2 target reached at $${evaluation.currentPrice?.toFixed(2)}`
    case 'TRIM (PARABOLIC)':
      return evaluation.partialExitSignal ?? 'Parabolic move — trim more'
    case 'ADD ON RETEST':
      return 'Pulled back to the breakout level on light volume — eligible to add'
    default:
      return `Action: ${evaluation.action}`
  }
}

// Logs one alert per held position whenever evaluatePosition()'s action
// differs from the last action logged for that position id. HOLD never
// alerts. Fires on every distinct escalation (TRIM 1 -> TRIM 2 -> EXIT), not
// just once per day, since a held position's risk can change intraday.
export function logPositionAlerts(evaluatedResults) {
  const existing = loadAlerts()
  const lastActionByPosition = new Map()
  for (const a of existing) {
    if (a.kind === 'position' && !lastActionByPosition.has(a.positionId)) {
      lastActionByPosition.set(a.positionId, a.action)
    }
  }

  const fresh = []
  for (const { position, evaluation } of evaluatedResults) {
    if (!evaluation || evaluation.action === 'HOLD') continue
    if (lastActionByPosition.get(position.id) === evaluation.action) continue
    fresh.push({
      id: `${position.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'position',
      positionId: position.id,
      symbol: position.symbol,
      name: position.name,
      sector: position.sector,
      grade: position.grade,
      price: evaluation.currentPrice,
      action: evaluation.action,
      summary: positionAlertSummary(evaluation),
      loggedAt: new Date().toISOString(),
      snapshot: { position, evaluation },
    })
  }

  if (fresh.length === 0) return []
  saveAlerts([...fresh, ...existing].slice(0, MAX_ALERTS))
  return fresh
}
