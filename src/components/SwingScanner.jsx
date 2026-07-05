import { useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import MetricCard from './MetricCard'

// Calls the swing_scanner Flask API. In dev, the relative path is proxied
// by Vite's '/swing-scanner-api' rule (see vite.config.js) to a locally-
// running `python api.py`. In production, Vite's dev proxy doesn't exist —
// VITE_SWING_SCANNER_API_URL (baked in at build time, see render.yaml)
// points directly at the deployed service instead, and the service's own
// CORS headers (api.py) allow the cross-origin call.
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

function fmtMoney(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

function fmtPct(value) {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

// Pure client-side port of levels.py::position_size — trivial arithmetic,
// no reason to round-trip to the API for it.
function computePositionSize(accountSize, riskPct, entry, stop) {
  const riskPerShare = entry - stop
  if (riskPerShare <= 0 || accountSize <= 0) {
    return { dollarRisk: 0, shares: 0, positionValue: 0, pctOfAccount: 0 }
  }
  const dollarRisk = accountSize * (riskPct / 100)
  const shares = Math.floor(dollarRisk / riskPerShare)
  const positionValue = shares * entry
  const pctOfAccount = (positionValue / accountSize) * 100
  return { dollarRisk, shares, positionValue, pctOfAccount }
}

function SetupBadge({ setup }) {
  const isVcp = setup === 'VCP confirmed'
  return <span className={isVcp ? 'bt-bull-tag' : 'bt-neutral-tag'}>{setup}</span>
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bt-tooltip">
      <div className="bt-tooltip-date">{label}</div>
      {payload.map(p => (
        <div className="bt-tooltip-row" key={p.dataKey}>
          <span className="bt-tooltip-dot" style={{ background: p.color }} />
          {p.name}: {p.value != null ? `$${p.value.toFixed(2)}` : '—'}
        </div>
      ))}
    </div>
  )
}

export default function SwingScanner() {
  const [useTestSubset, setUseTestSubset] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState(null)
  const [scanMeta, setScanMeta] = useState(null)

  const [minRs, setMinRs] = useState(70)
  const [vcpOnly, setVcpOnly] = useState(false)

  const [selectedTicker, setSelectedTicker] = useState(null)
  const [chartData, setChartData] = useState(null)
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState(null)

  const [accountSize, setAccountSize] = useState(25000)
  const [riskPct, setRiskPct] = useState(1)
  const [entryPrice, setEntryPrice] = useState(100)
  const [stopPrice, setStopPrice] = useState(92)

  const sizing = computePositionSize(accountSize, riskPct, entryPrice, stopPrice)

  async function runScan() {
    setScanning(true)
    setError(null)
    setResults(null)
    setSelectedTicker(null)
    setChartData(null)
    try {
      const res = await fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useTestSubset }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Scan failed')
      setResults(data.results)
      setScanMeta({ scannedCount: data.scannedCount, passedCount: data.passedCount, trailRule: data.trailRule })
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  async function selectTicker(row) {
    setSelectedTicker(row)
    setChartLoading(true)
    setChartError(null)
    setChartData(null)
    try {
      const res = await fetch(`${API_BASE}/api/chart/${row.ticker}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load chart')
      setChartData(data.series)
    } catch (err) {
      setChartError(err.message)
    } finally {
      setChartLoading(false)
    }
  }

  const filtered = (results || [])
    .filter(r => r.rsScore == null || r.rsScore >= minRs)
    .filter(r => !vcpOnly || r.setup === 'VCP confirmed')

  return (
    <div className="backtester">

      {/* ── Position sizing ── */}
      <div className="bt-header-block">
        <div className="bt-title">Position Sizing</div>
        <div className="bt-subtitle">Risk-based share count for a given account size, entry, and stop.</div>
      </div>

      <div className="bt-controls">
        <div className="scanner-sizing-grid">
          <label className="scanner-input-label">
            Account size ($)
            <input className="bt-input" type="number" value={accountSize} onChange={e => setAccountSize(+e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Risk % per trade
            <input className="bt-input" type="number" step="0.1" value={riskPct} onChange={e => setRiskPct(+e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Entry price ($)
            <input className="bt-input" type="number" step="0.5" value={entryPrice} onChange={e => setEntryPrice(+e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Stop price ($)
            <input className="bt-input" type="number" step="0.5" value={stopPrice} onChange={e => setStopPrice(+e.target.value)} />
          </label>
        </div>

        <div className="bt-metrics">
          <MetricCard label="Dollar Risk" value={fmtMoney(sizing.dollarRisk)} />
          <MetricCard label="Shares" value={sizing.shares.toLocaleString()} />
          <MetricCard label="Position Value" value={fmtMoney(sizing.positionValue)} />
          <MetricCard label="% of Account" value={fmtPct(sizing.pctOfAccount)} />
        </div>
      </div>

      {/* ── Scan ── */}
      <div className="bt-section-divider"><span>Scan</span></div>

      <div className="bt-header-block">
        <div className="bt-title">Swing Trading Scanner</div>
        <div className="bt-subtitle">
          Trend Template (Stage 2) + simplified VCP detection, powered by Alpaca daily bars.
        </div>
      </div>

      <div className="bt-controls">
        <div className="bt-signal-builder">
          <label className="scanner-checkbox-label">
            <input type="checkbox" checked={useTestSubset} onChange={e => setUseTestSubset(e.target.checked)} />
            Use 20-ticker test subset
          </label>
        </div>
        <div className="bt-run-row">
          <button className="btn btn-primary bt-run-btn" onClick={runScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Run Scan'}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!results && !error && !scanning && (
        <div className="qqq-state-loading">Click Run Scan to screen the universe for Trend Template + VCP setups.</div>
      )}

      {results && (
        <div className="bt-result">
          <div className="bt-result-title">
            Results ({scanMeta.passedCount} / {scanMeta.scannedCount} passed Trend Template)
          </div>

          {results.length === 0 ? (
            <div className="bt-error">No tickers passed the Trend Template filter in this scan.</div>
          ) : (
            <>
              <div className="scanner-filters">
                <label className="scanner-input-label">
                  Minimum RS score: {minRs}
                  <input
                    type="range" min="0" max="100" value={minRs}
                    onChange={e => setMinRs(+e.target.value)}
                    className="scanner-range"
                  />
                </label>
                <label className="scanner-checkbox-label">
                  <input type="checkbox" checked={vcpOnly} onChange={e => setVcpOnly(e.target.checked)} />
                  Show only confirmed VCP setups
                </label>
              </div>

              <div className="scanner-table-wrap">
                <table className="scanner-table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Setup</th>
                      <th>Current Price</th>
                      <th>Pivot / Entry</th>
                      <th>Initial Stop</th>
                      <th>Risk/Share $</th>
                      <th>Risk/Share %</th>
                      <th>Target +20%</th>
                      <th>RS Score</th>
                      <th>% Off 52w High</th>
                      <th>Vol vs 50d Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(row => (
                      <tr
                        key={row.ticker}
                        className={`scanner-row${selectedTicker?.ticker === row.ticker ? ' scanner-row-selected' : ''}`}
                        onClick={() => selectTicker(row)}
                      >
                        <td className="scanner-ticker-cell">{row.ticker}</td>
                        <td><SetupBadge setup={row.setup} /></td>
                        <td>{fmtMoney(row.currentPrice)}</td>
                        <td>{fmtMoney(row.pivotEntry)}</td>
                        <td>{fmtMoney(row.initialStop)}</td>
                        <td>{fmtMoney(row.riskPerShareDollar)}</td>
                        <td>{fmtPct(row.riskPerSharePct)}</td>
                        <td>{fmtMoney(row.target20)}</td>
                        <td>{row.rsScore?.toFixed(0) ?? '—'}</td>
                        <td>{fmtPct(row.pctOffHigh)}</td>
                        <td>{row.volVsAvg != null ? `${row.volVsAvg.toFixed(2)}x` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="qqq-state-loading" style={{ marginTop: '0.75rem' }}>
                Trail rule once in a position: {scanMeta.trailRule}
              </div>

              {!selectedTicker && (
                <div className="qqq-state-loading" style={{ marginTop: '0.5rem' }}>
                  Click a row above to see its chart with SMA overlays and entry/stop lines.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Chart ── */}
      {selectedTicker && (
        <div className="bt-result">
          <div className="bt-result-title">{selectedTicker.ticker} chart</div>

          {chartLoading && <div className="qqq-state-loading">Loading chart…</div>}
          {chartError && <div className="bt-error">{chartError}</div>}

          {chartData && (
            <div className="bt-chart">
              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    tickFormatter={d => {
                      const [y, m] = d.split('-')
                      return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`
                    }}
                    interval={Math.max(1, Math.floor(chartData.length / 8))}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    tickFormatter={v => `$${v}`}
                    domain={['auto', 'auto']}
                    width={54}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '0.8rem', color: 'var(--text-muted)' }} />
                  {selectedTicker.pivotEntry != null && (
                    <ReferenceLine y={selectedTicker.pivotEntry} stroke="var(--green)" strokeDasharray="4 4"
                      label={{ value: `Entry ${selectedTicker.pivotEntry.toFixed(2)}`, fill: 'var(--green)', fontSize: 11, position: 'insideTopLeft' }} />
                  )}
                  {selectedTicker.initialStop != null && (
                    <ReferenceLine y={selectedTicker.initialStop} stroke="var(--red)" strokeDasharray="4 4"
                      label={{ value: `Stop ${selectedTicker.initialStop.toFixed(2)}`, fill: 'var(--red)', fontSize: 11, position: 'insideBottomLeft' }} />
                  )}
                  <Line type="monotone" dataKey="close" stroke="#8b5cf6" dot={false} strokeWidth={2} name="Close" />
                  <Line type="monotone" dataKey="sma50" stroke="#22c55e" dot={false} strokeWidth={1.3} name="SMA50" />
                  <Line type="monotone" dataKey="sma150" stroke="#eab308" dot={false} strokeWidth={1.3} name="SMA150" />
                  <Line type="monotone" dataKey="sma200" stroke="#ef4444" dot={false} strokeWidth={1.3} name="SMA200" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
