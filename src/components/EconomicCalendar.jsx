import { useEffect, useState } from 'react'

// Calls the swing_scanner Flask API's /api/economic-calendar endpoint —
// same API_BASE pattern as SwingScanner.jsx (dev proxy locally, absolute
// VITE_SWING_SCANNER_API_URL in production).
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

const IMPACT_LEVELS = ['High', 'Medium', 'Low']
const IMPACT_COLORS = { High: 'var(--red)', Medium: '#eab308', Low: 'var(--text-muted)' }

function defaultRange() {
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const end = new Date(monday)
  end.setDate(monday.getDate() + 13)
  const fmt = (d) => d.toISOString().slice(0, 10)
  return { start: fmt(monday), end: fmt(end) }
}

export default function EconomicCalendar() {
  const [impactLevels, setImpactLevels] = useState(new Set(['High', 'Medium']))
  const [{ start, end }, setRange] = useState(defaultRange)
  const [events, setEvents] = useState(null)
  const [liveDataAvailable, setLiveDataAvailable] = useState(true)
  const [nextHighImpact, setNextHighImpact] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(forceRefresh = false) {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ impact: [...impactLevels].join(','), start, end })
      if (forceRefresh) params.set('refresh', '1')
      const res = await fetch(`${API_BASE}/api/economic-calendar?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load economic calendar')
      setEvents(data.events)
      setLiveDataAvailable(data.liveDataAvailable)
      setNextHighImpact(data.nextHighImpact)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleImpact(level) {
    setImpactLevels(prev => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Economic Calendar</div>
        <div className="bt-subtitle">
          Finviz&apos;s free calendar only covers the current trading week — dates further out come from a static
          schedule of confirmed BLS/Fed release dates instead.
        </div>
      </div>

      {!liveDataAvailable && events !== null && (
        <div className="bt-error">Live data unavailable, showing scheduled events only.</div>
      )}

      {nextHighImpact && (
        <div className="qqq-state-loading" style={{ fontSize: '0.9rem' }}>
          <strong style={{ color: 'var(--text)' }}>Next high-impact event:</strong> {nextHighImpact.event}{' '}
          {nextHighImpact.daysUntil === 0 ? 'today' : `in ${nextHighImpact.daysUntil} day${nextHighImpact.daysUntil === 1 ? '' : 's'}`}{' '}
          ({nextHighImpact.date})
        </div>
      )}

      <div className="bt-controls">
        <div className="bt-signal-builder">
          {IMPACT_LEVELS.map(level => (
            <label key={level} className="scanner-checkbox-label">
              <input type="checkbox" checked={impactLevels.has(level)} onChange={() => toggleImpact(level)} />
              {level}
            </label>
          ))}
        </div>

        <div className="scanner-filters" style={{ margin: 0 }}>
          <label className="scanner-input-label">
            From
            <input className="bt-input" type="date" value={start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} />
          </label>
          <label className="scanner-input-label">
            To
            <input className="bt-input" type="date" value={end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} />
          </label>
        </div>

        <div className="bt-run-row">
          <button className="btn btn-primary bt-run-btn" onClick={() => load(false)} disabled={loading}>
            {loading ? 'Loading…' : 'Apply Filters'}
          </button>
          <button className="btn bt-run-btn" onClick={() => load(true)} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!events && !error && !loading && (
        <div className="qqq-state-loading">Loading economic calendar…</div>
      )}

      {events && (
        <div className="bt-result">
          <div className="bt-result-title">{events.length} event{events.length === 1 ? '' : 's'}</div>

          {events.length === 0 ? (
            <div className="qqq-state-loading">No events match the current filters.</div>
          ) : (
            <div className="scanner-table-wrap">
              <table className="scanner-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time (ET)</th>
                    <th>Event</th>
                    <th>Impact</th>
                    <th>Actual</th>
                    <th>Forecast</th>
                    <th>Previous</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={`${e.date}-${e.event}-${i}`}>
                      <td>{e.date}</td>
                      <td>{e.time || '—'}</td>
                      <td>{e.event}</td>
                      <td style={{ color: IMPACT_COLORS[e.impact], fontWeight: 600 }}>{e.impact}</td>
                      <td>{e.actual || '—'}</td>
                      <td>{e.forecast || '—'}</td>
                      <td>{e.previous || '—'}</td>
                      <td>{e.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
