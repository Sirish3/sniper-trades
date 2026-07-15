import { useEffect, useState } from 'react'

// Same API base convention as SwingScanner.jsx / EconomicCalendar.jsx —
// dev-only Vite proxy, direct URL in production (see vite.config.js).
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

function fmtPct(value) {
  return value == null ? '—' : `${value.toFixed(2)}%`
}

function fmtNum(value, decimals = 2) {
  return value == null ? '—' : Number(value).toFixed(decimals)
}

function downloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const STAT_COLUMNS = [
  { key: 'totalReturnPct', label: 'Total Return', fmt: fmtPct },
  { key: 'cagrPct', label: 'CAGR', fmt: fmtPct },
  { key: 'winRatePct', label: 'Win Rate', fmt: fmtPct },
  { key: 'avgRMultiple', label: 'Avg R', fmt: (v) => (v == null ? '—' : `${fmtNum(v, 2)}R`) },
  { key: 'profitFactor', label: 'Profit Factor', fmt: (v) => (v === 'inf' ? '∞' : fmtNum(v, 2)) },
  { key: 'maxDrawdownPct', label: 'Max Drawdown', fmt: fmtPct },
  { key: 'numTrades', label: 'Trades', fmt: (v) => v ?? 0 },
  { key: 'avgHoldingDays', label: 'Avg Hold (days)', fmt: (v) => fmtNum(v, 1) },
  { key: 'setupsFound', label: 'Setups Found', fmt: (v) => v ?? 0 },
  { key: 'entriesTriggered', label: 'Entries Triggered', fmt: (v) => v ?? 0 },
  { key: 'entriesSkippedEarnings', label: 'Skipped (Earnings)', fmt: (v) => v ?? 0 },
]

export default function StrategyLab() {
  const [availableStrategies, setAvailableStrategies] = useState([])
  const [selectedStrategies, setSelectedStrategies] = useState([])
  const [tickers, setTickers] = useState('META, MSFT, AAPL')
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 5)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))

  const [accountEquity, setAccountEquity] = useState(100000)
  const [riskPct, setRiskPct] = useState(1.0)
  const [maxConcurrentPositions, setMaxConcurrentPositions] = useState(4)
  const [fillTiming, setFillTiming] = useState('close')
  const [slippagePct, setSlippagePct] = useState(0.05)
  const [commissionPerSide, setCommissionPerSide] = useState(0)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/strategy-lab/strategies`)
      .then((res) => res.json())
      .then((data) => {
        setAvailableStrategies(data.strategies || [])
        setSelectedStrategies((data.strategies || []).map((s) => s.id))
      })
      .catch(() => setError('Could not load strategy list from the API.'))
  }, [])

  function toggleStrategy(id) {
    setSelectedStrategies((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  async function runComparison() {
    const tickerList = tickers.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
    if (!tickerList.length || !selectedStrategies.length) {
      setError('Pick at least one ticker and one strategy.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`${API_BASE}/api/strategy-lab/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategies: selectedStrategies,
          tickers: tickerList,
          startDate,
          endDate,
          accountEquity: Number(accountEquity),
          riskPct: Number(riskPct),
          maxConcurrentPositions: Number(maxConcurrentPositions),
          fillTiming,
          slippagePct: Number(slippagePct),
          commissionPerSide: Number(commissionPerSide),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Backtest failed')
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  const rows = result
    ? [
        ...selectedStrategies
          .filter((sid) => result.perStrategy[sid])
          .map((sid) => ({ id: sid, label: availableStrategies.find((s) => s.id === sid)?.label || sid, stats: result.perStrategy[sid] })),
        ...(selectedStrategies.length > 1 ? [{ id: 'combined', label: 'Combined', stats: result.combined }] : []),
      ]
    : []

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Strategy Lab</div>
        <div className="bt-subtitle">
          Compare Pullback-to-MA, Base Breakout, and Post-Earnings Gap-and-Hold side by side on real Alpaca daily bars.
        </div>
      </div>

      <div className="bt-controls">
        <div className="bt-signal-builder">
          {availableStrategies.map((s) => (
            <label key={s.id} className="scanner-checkbox-label">
              <input
                type="checkbox"
                checked={selectedStrategies.includes(s.id)}
                onChange={() => toggleStrategy(s.id)}
              />
              {s.label}
            </label>
          ))}
        </div>

        <div className="scanner-sizing-grid">
          <label className="scanner-input-label">
            Tickers (comma-separated)
            <input className="bt-input" value={tickers} onChange={(e) => setTickers(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Start date
            <input className="bt-input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            End date
            <input className="bt-input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>

        <div className="scanner-sizing-grid">
          <label className="scanner-input-label">
            Account equity ($)
            <input className="bt-input" type="number" value={accountEquity} onChange={(e) => setAccountEquity(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Risk % per trade
            <input className="bt-input" type="number" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Max concurrent positions
            <input className="bt-input" type="number" value={maxConcurrentPositions} onChange={(e) => setMaxConcurrentPositions(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Fill timing
            <select className="bt-input" value={fillTiming} onChange={(e) => setFillTiming(e.target.value)}>
              <option value="close">Same-day close</option>
              <option value="next_open">Next-day open</option>
            </select>
          </label>
          <label className="scanner-input-label">
            Slippage (%)
            <input className="bt-input" type="number" step="0.01" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />
          </label>
          <label className="scanner-input-label">
            Commission per side ($)
            <input className="bt-input" type="number" step="0.01" value={commissionPerSide} onChange={(e) => setCommissionPerSide(e.target.value)} />
          </label>
        </div>

        <div className="bt-run-row">
          <button className="btn btn-primary bt-run-btn" onClick={runComparison} disabled={running}>
            {running ? 'Running backtest…' : 'Run Comparison'}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!result && !error && !running && (
        <div className="qqq-state-loading">Pick strategies + tickers and run a comparison backtest.</div>
      )}

      {result && (
        <div className="bt-result">
          <div className="bt-result-title">Comparison ({tickers})</div>
          <div className="scanner-table-wrap">
            <table className="scanner-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  {STAT_COLUMNS.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === 'combined' ? 'scanner-row-selected' : ''}>
                    <td className="scanner-ticker-cell">{row.label}</td>
                    {STAT_COLUMNS.map((c) => (
                      <td key={c.key}>{c.fmt(row.stats[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bt-result-title" style={{ marginTop: '1.5rem' }}>
            Trade Log ({result.trades.length} trades)
            <button
              className="btn"
              style={{ marginLeft: '1rem' }}
              onClick={() => downloadCsv(result.tradeLogCsv, 'strategy-lab-trades.csv')}
              disabled={!result.trades.length}
            >
              Download CSV
            </button>
          </div>

          {result.trades.length > 0 && (
            <div className="scanner-table-wrap" style={{ maxHeight: '420px', overflowY: 'auto' }}>
              <table className="scanner-table">
                <thead>
                  <tr>
                    <th>Ticker</th><th>Strategy</th><th>Setup Date</th><th>Entry Date</th><th>Entry $</th>
                    <th>Stop $</th><th>Exit Date</th><th>Exit $</th><th>Reason</th><th>Shares</th>
                    <th>R Multiple</th><th>Hold Days</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i}>
                      <td className="scanner-ticker-cell">{t.ticker}</td>
                      <td>{t.strategy}</td>
                      <td>{t.setupDate}</td>
                      <td>{t.entryDate}</td>
                      <td>{fmtNum(t.entryPrice)}</td>
                      <td>{fmtNum(t.stopPrice)}</td>
                      <td>{t.exitDate}</td>
                      <td>{fmtNum(t.exitPrice)}</td>
                      <td>{t.exitReason}</td>
                      <td>{fmtNum(t.shares, 2)}</td>
                      <td className={t.rMultiple >= 0 ? 'text-green' : 'text-danger'}>{fmtNum(t.rMultiple, 2)}R</td>
                      <td>{t.holdingDays}</td>
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
