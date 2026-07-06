import { useState } from 'react'

// Calls the swing_scanner Flask API's /api/earnings endpoint — same
// API_BASE pattern as SwingScanner.jsx.
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

const EARNINGS_RISK_TRADING_DAYS = 10
const TRACKING_LIST_STORAGE_KEY = 'sniper-trades-earnings-tracking-list'

export default function EarningsCalendar({ scanTickers = [] }) {
  const [trackingText, setTrackingText] = useState(() => localStorage.getItem(TRACKING_LIST_STORAGE_KEY) || '')
  const [showTrackingOnly, setShowTrackingOnly] = useState(false)
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const trackingTickers = trackingText
    .split(/[\n,]/)
    .map(t => t.trim().toUpperCase())
    .filter(Boolean)

  function handleTrackingChange(value) {
    setTrackingText(value)
    localStorage.setItem(TRACKING_LIST_STORAGE_KEY, value)
  }

  async function loadEarnings() {
    const tickers = showTrackingOnly ? trackingTickers : scanTickers
    if (tickers.length === 0) {
      setError(showTrackingOnly ? 'No tickers in your tracking list yet — add some below.' : 'No scan results yet — run a scan in the Scanner tab first.')
      setResults(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/earnings?tickers=${encodeURIComponent(tickers.join(','))}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load earnings data')
      setResults(data.results)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const displayTickerCount = showTrackingOnly ? trackingTickers.length : scanTickers.length

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Earnings</div>
        <div className="bt-subtitle">
          Flags any ticker reporting within the next {EARNINGS_RISK_TRADING_DAYS} trading days — a stop-loss
          can&apos;t protect against a gap through it on an earnings surprise.
        </div>
      </div>

      <div className="bt-controls">
        <label className="scanner-input-label">
          Tracking list (tickers you currently hold, comma or newline separated — saved in this browser only)
          <textarea
            className="bt-input"
            style={{ maxWidth: 'none', minHeight: '80px', fontFamily: 'var(--font-mono)' }}
            value={trackingText}
            onChange={e => handleTrackingChange(e.target.value)}
            placeholder="AAPL, MSFT, TSLA"
          />
        </label>

        <div className="bt-signal-builder">
          <label className="scanner-checkbox-label">
            <input type="checkbox" checked={showTrackingOnly} onChange={e => setShowTrackingOnly(e.target.checked)} />
            Show only tickers I currently hold / am tracking
          </label>
        </div>

        <div className="bt-run-row">
          <button className="btn btn-primary bt-run-btn" onClick={loadEarnings} disabled={loading}>
            {loading ? 'Loading…' : `Check Earnings (${displayTickerCount} ticker${displayTickerCount === 1 ? '' : 's'})`}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!results && !error && !loading && (
        <div className="qqq-state-loading">
          {showTrackingOnly
            ? 'Add tickers above, then click Check Earnings.'
            : 'Click Check Earnings to pull data for the current scan results.'}
        </div>
      )}

      {results && (
        <div className="bt-result">
          <div className="bt-result-title">{results.length} ticker{results.length === 1 ? '' : 's'}</div>

          <div className="scanner-table-wrap">
            <table className="scanner-table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Next Earnings Date</th>
                  <th>Days Until</th>
                  <th>Before/After Market</th>
                  <th>Est. EPS</th>
                  <th>Prior Qtr EPS</th>
                </tr>
              </thead>
              <tbody>
                {results
                  .slice()
                  .sort((a, b) => (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity))
                  .map(r => (
                    <tr key={r.ticker} className={r.earningsRisk ? 'text-danger' : ''}>
                      <td className="scanner-ticker-cell">{r.ticker}</td>
                      <td>{r.error ? `Error: ${r.error}` : (r.nextEarningsDate || 'Unknown')}</td>
                      <td>{r.daysUntil ?? '—'}</td>
                      <td>{r.beforeAfterMarket || 'Unknown'}</td>
                      <td>{r.estEps || '—'}</td>
                      <td>{r.priorQtrEps || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
