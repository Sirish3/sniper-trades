import { useEffect, useState } from 'react'

// Calls the stock_screener Flask API. In dev, the relative path is
// proxied by Vite's '/stock-screener-api' rule (see vite.config.js) to a
// locally-running `python api.py`. In production, Vite's dev proxy
// doesn't exist — VITE_STOCK_SCREENER_API_URL (baked in at build time,
// see render.yaml) points directly at the deployed service instead, and
// the service's own CORS headers (api.py) allow the cross-origin call.
const API_BASE = import.meta.env.VITE_STOCK_SCREENER_API_URL || '/stock-screener-api'

const UNIVERSES = [
  { key: 'sp500', label: 'S&P 500' },
  { key: 'nasdaq100', label: 'Nasdaq 100' },
  { key: 'custom', label: 'Custom List' },
]

const COLUMNS = [
  { key: 'symbol', label: 'Ticker' },
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'marketCap', label: 'Market Cap' },
  { key: 'peRatio', label: 'P/E' },
  { key: 'price', label: 'Price' },
  { key: 'changePct', label: 'Change' },
  { key: 'volume', label: 'Volume' },
]

function formatMarketCap(value) {
  if (value == null) return '—'
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${value.toLocaleString()}`
}

function formatVolume(value) {
  if (value == null) return '—'
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toLocaleString()
}

function formatPrice(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

function formatPct(value) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

export default function StockScreener() {
  const [universe, setUniverse] = useState('sp500')
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState(null)

  const [customTickers, setCustomTickers] = useState([])
  const [newTicker, setNewTicker] = useState('')
  const [customBusy, setCustomBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [sectorFilter, setSectorFilter] = useState('all')
  const [sortKey, setSortKey] = useState('marketCap')
  const [sortDir, setSortDir] = useState('desc')

  async function loadCustomList() {
    try {
      const res = await fetch(`${API_BASE}/api/universe/custom`)
      const data = await res.json()
      setCustomTickers(data.tickers || [])
    } catch {
      setCustomTickers([])
    }
  }

  useEffect(() => { loadCustomList() }, [])

  async function runScreen() {
    setLoading(true)
    setError(null)
    setRows(null)
    try {
      const res = await fetch(`${API_BASE}/api/screen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universe }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Screen failed')
      setRows(data.rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function refreshUniverse() {
    setRefreshing(true)
    setRefreshStatus(null)
    try {
      const res = await fetch(`${API_BASE}/api/universe/${universe}/refresh`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Refresh failed')
      setRefreshStatus(`Updated ${data.count} tickers from ${data.source}.`)
    } catch (err) {
      setRefreshStatus(`Refresh failed: ${err.message}`)
    } finally {
      setRefreshing(false)
    }
  }

  async function addCustomTicker() {
    const symbol = newTicker.trim().toUpperCase()
    if (!symbol) return
    setCustomBusy(true)
    try {
      const res = await fetch(`${API_BASE}/api/universe/custom/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const data = await res.json()
      setCustomTickers(data.tickers || [])
      setNewTicker('')
    } finally {
      setCustomBusy(false)
    }
  }

  async function removeCustomTicker(symbol) {
    setCustomBusy(true)
    try {
      const res = await fetch(`${API_BASE}/api/universe/custom/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const data = await res.json()
      setCustomTickers(data.tickers || [])
    } finally {
      setCustomBusy(false)
    }
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sectors = Array.from(new Set((rows || []).map(r => r.sector).filter(Boolean))).sort()

  const filtered = (rows || [])
    .filter(r => sectorFilter === 'all' || r.sector === sectorFilter)
    .filter(r => {
      if (!search.trim()) return true
      const q = search.trim().toLowerCase()
      return r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sortDir === 'asc' ? cmp : -cmp
    })

  return (
    <div className="backtester">

      <div className="bt-header-block">
        <div className="bt-title">Stock Screener</div>
        <div className="bt-subtitle">
          S&amp;P 500, Nasdaq 100, or your own custom list — live price/volume from Alpaca, market cap/P/E from Yahoo.
        </div>
      </div>

      <div className="bt-controls">
        <div className="bt-signal-builder">
          {UNIVERSES.map(u => (
            <button
              key={u.key}
              className={`btn screener-universe-btn${universe === u.key ? ' screener-universe-btn-active' : ''}`}
              onClick={() => { setUniverse(u.key); setRows(null); setRefreshStatus(null) }}
            >
              {u.label}
            </button>
          ))}
          {universe !== 'custom' && (
            <button className="qqq-state-refresh" onClick={refreshUniverse} disabled={refreshing} title="Refresh ticker list">
              {refreshing ? 'Refreshing…' : '⟳ Refresh list'}
            </button>
          )}
        </div>

        {refreshStatus && <div className="qqq-state-loading">{refreshStatus}</div>}

        {universe === 'custom' && (
          <div className="scanner-sizing-grid" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="bt-signal-builder">
                <input
                  className="bt-input"
                  style={{ width: '160px' }}
                  placeholder="Ticker (e.g. AAPL)"
                  value={newTicker}
                  onChange={e => setNewTicker(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCustomTicker()}
                />
                <button className="btn btn-primary" onClick={addCustomTicker} disabled={customBusy || !newTicker.trim()}>
                  Add
                </button>
              </div>
              <div className="screener-custom-chips">
                {customTickers.length === 0 && <span className="qqq-state-loading">No tickers yet — add some above.</span>}
                {customTickers.map(t => (
                  <span key={t.symbol} className="screener-chip">
                    {t.symbol}
                    <button className="screener-chip-remove" onClick={() => removeCustomTicker(t.symbol)} disabled={customBusy} title={`Remove ${t.symbol}`}>×</button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="bt-run-row" style={{ marginTop: '1rem' }}>
          <button className="btn btn-primary bt-run-btn" onClick={runScreen} disabled={loading}>
            {loading ? 'Screening…' : 'Run Screen'}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!rows && !error && !loading && (
        <div className="qqq-state-loading">Click Run Screen to pull live data for the selected universe.</div>
      )}
      {loading && (
        <div className="qqq-state-loading">
          Screening {universe === 'sp500' ? '~500' : universe === 'nasdaq100' ? '~100' : customTickers.length} tickers —
          first run of the day can take a while (fundamentals get cached after that).
        </div>
      )}

      {rows && (
        <div className="bt-result">
          <div className="bt-result-title">{filtered.length} / {rows.length} tickers</div>

          <div className="scanner-filters">
            <label className="scanner-input-label" style={{ flex: 2 }}>
              Search ticker or company
              <input className="bt-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. AAPL or Apple" />
            </label>
            <label className="scanner-input-label">
              Sector
              <select className="bt-select" value={sectorFilter} onChange={e => setSectorFilter(e.target.value)}>
                <option value="all">All sectors</option>
                {sectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>

          <div className="scanner-table-wrap">
            <table className="scanner-table">
              <thead>
                <tr>
                  {COLUMNS.map(col => (
                    <th key={col.key} className="screener-sortable-th" onClick={() => toggleSort(col.key)}>
                      {col.label}{sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.symbol}>
                    <td className="scanner-ticker-cell">{r.symbol}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.sector || '—'}</td>
                    <td>{formatMarketCap(r.marketCap)}</td>
                    <td>{r.peRatio != null ? r.peRatio.toFixed(2) : '—'}</td>
                    <td>{formatPrice(r.price)}</td>
                    <td className={r.changePct == null ? '' : r.changePct >= 0 ? 'screener-positive' : 'screener-negative'}>
                      {formatPct(r.changePct)}
                    </td>
                    <td>{formatVolume(r.volume)}</td>
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
