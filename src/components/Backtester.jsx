import { useState, useEffect } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceArea,
} from 'recharts'
import { fetchDailyBars } from '../utils/marketData'
import { runQQQCycleBacktest, getSignalPeriods } from '../utils/backtester'
import { emaSeries } from '../utils/indicators'

const EMA_OPTIONS = [
  { label: 'Price',    period: null },
  { label: 'EMA 3',   period: 3    },
  { label: 'EMA 5',   period: 5    },
  { label: 'EMA 8',   period: 8    },
  { label: 'EMA 10',  period: 10   },
  { label: 'EMA 20',  period: 20   },
  { label: 'EMA 50',  period: 50   },
  { label: 'EMA 100', period: 100  },
  { label: 'EMA 150', period: 150  },
  { label: 'EMA 200', period: 200  },
]

// fetchDays includes ~300 calendar day warmup buffer for slow EMAs (e.g. EMA 200).
// displayBars is the exact trading-day window shown in the chart and metrics.
const PERIODS = [
  { label: '1 Year',  fetchDays: 665,  displayBars: 252  },
  { label: '2 Years', fetchDays: 1030, displayBars: 504  },
  { label: '3 Years', fetchDays: 1395, displayBars: 756  },
  { label: '5 Years', fetchDays: 2125, displayBars: 1260 },
]

function fmt(val) {
  return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function sign(val) {
  return val >= 0 ? `+${val.toFixed(1)}%` : `${val.toFixed(1)}%`
}

function MetricCard({ label, value, up, down }) {
  const cls = up ? ' bt-metric--up' : down ? ' bt-metric--down' : ''
  return (
    <div className={`bt-metric${cls}`}>
      <div className="bt-metric-value">{value}</div>
      <div className="bt-metric-label">{label}</div>
    </div>
  )
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const strat = payload.find(p => p.dataKey === 'strategy')
  const qqq   = payload.find(p => p.dataKey === 'qqqBH')
  return (
    <div className="bt-tooltip">
      <div className="bt-tooltip-date">{label}</div>
      {strat && <div className="bt-tooltip-row"><span className="bt-tooltip-dot" style={{ background: '#8b5cf6' }} />Strategy: {fmt(strat.value)}</div>}
      {qqq   && <div className="bt-tooltip-row"><span className="bt-tooltip-dot" style={{ background: '#64748b' }} />QQQ B&H: {fmt(qqq.value)}</div>}
    </div>
  )
}

export default function Backtester() {
  const [fastIdx, setFastIdx]     = useState(4)  // EMA 10
  const [slowIdx, setSlowIdx]     = useState(5)  // EMA 20
  const [period, setPeriod]       = useState(PERIODS[3])
  const [result, setResult]       = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [qqState, setQqState]           = useState(null)
  const [stateLoading, setStateLoading] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [emailStatus, setEmailStatus]   = useState(null)  // 'sent' | 'error'

  async function fetchCurrentState() {
    setStateLoading(true)
    try {
      const bars   = await fetchDailyBars('QQQ', 60)
      const closes = bars.map(b => b.c)
      const ema10  = emaSeries(closes, 10)
      const price  = closes[closes.length - 1]
      const e10    = ema10[ema10.length - 1]
      const now = new Date()
      const formattedDate = now.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago',
      }).replace(',', '')
      const formattedTime = now.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'America/Chicago', timeZoneName: 'short',
      })
      setQqState({
        signal: price > e10 ? 'TQQQ' : 'SQQQ',
        price,
        ema10: e10,
        timestamp: `${formattedDate} ${formattedTime}`,
      })
    } catch {
      setQqState(null)
    } finally {
      setStateLoading(false)
    }
  }

  useEffect(() => { fetchCurrentState() }, [])

  async function sendSignalEmail() {
    setEmailSending(true)
    setEmailStatus(null)
    try {
      const res = await fetch('https://sniper-trades.onrender.com/api/qqq-signal/send', { method: 'POST' })
      const data = await res.json()
      setEmailStatus(data.ok ? 'sent' : 'error')
    } catch {
      setEmailStatus('error')
    } finally {
      setEmailSending(false)
    }
  }

  async function handleRun() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const [qqqBars, tqqqBars, sqqqBars] = await Promise.all([
        fetchDailyBars('QQQ',  period.fetchDays),
        fetchDailyBars('TQQQ', period.fetchDays),
        fetchDailyBars('SQQQ', period.fetchDays),
      ])
      const fast = EMA_OPTIONS[fastIdx]
      const slow = EMA_OPTIONS[slowIdx]
      const { series, metrics } = runQQQCycleBacktest(qqqBars, tqqqBars, sqqqBars, fast.period, slow.period, period.displayBars)
      setResult({ series, metrics, fastLabel: fast.label, slowLabel: slow.label, period: period.label })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const bullPeriods = result ? getSignalPeriods(result.series, 'bull') : []
  const bearPeriods = result ? getSignalPeriods(result.series, 'bear') : []
  const xInterval   = result ? Math.max(1, Math.floor(result.series.length / 8)) : 1
  const stratBetter = result && result.metrics.stratReturn >= result.metrics.qqqReturn

  const bull = qqState?.signal === 'TQQQ'

  return (
    <div className="backtester">

      {/* ── Current State ── */}
      <div className={`qqq-state-card${qqState ? (bull ? ' qqq-state-bull' : ' qqq-state-bear') : ''}`}>
        {stateLoading && <span className="qqq-state-loading">Fetching QQQ state…</span>}
        {!stateLoading && qqState && (
          <>
            <div className="qqq-state-badge">{qqState.signal}</div>
            <div className="qqq-state-details">
              <div className="qqq-state-label">
                {bull ? 'BULLISH — Price above EMA 10' : 'BEARISH — Price below EMA 10'}
              </div>
              <div className="qqq-state-prices">
                QQQ ${qqState.price.toFixed(2)}&nbsp;&nbsp;·&nbsp;&nbsp;EMA 10: ${qqState.ema10.toFixed(2)}
              </div>
              <div className="qqq-state-date">As of {qqState.timestamp}</div>
            </div>
          </>
        )}
        {!stateLoading && !qqState && (
          <span className="qqq-state-loading">Could not load QQQ state</span>
        )}
        <div className="qqq-state-actions">
          <button className="qqq-state-refresh" onClick={fetchCurrentState} disabled={stateLoading} title="Refresh">⟳</button>
          <button
            className={`qqq-email-btn${emailStatus === 'sent' ? ' qqq-email-sent' : emailStatus === 'error' ? ' qqq-email-error' : ''}`}
            onClick={sendSignalEmail}
            disabled={emailSending}
          >
            {emailSending ? 'Sending…' : emailStatus === 'sent' ? '✓ Sent' : emailStatus === 'error' ? '✗ Failed' : '✉ Send Email'}
          </button>
        </div>
      </div>

      {/* ── Backtest ── */}
      <div className="bt-section-divider"><span>Backtest</span></div>

      <div className="bt-header-block">
        <div className="bt-title">QQQ EMA Cycle Strategy</div>
        <div className="bt-subtitle">Rotates between TQQQ (3× bull) and SQQQ (3× bear) based on QQQ EMA signals</div>
      </div>

      <div className="bt-controls">
        <div className="bt-signal-builder">
          <span className="bt-signal-label">Bull when</span>
          <select
            className="bt-ema-select"
            value={fastIdx}
            onChange={e => setFastIdx(+e.target.value)}
          >
            {EMA_OPTIONS.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
          </select>
          <span className="bt-signal-op">&gt;</span>
          <select
            className="bt-ema-select"
            value={slowIdx}
            onChange={e => setSlowIdx(+e.target.value)}
          >
            {EMA_OPTIONS.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
          </select>
          <span className="bt-signal-result">
            <span className="bt-bull-tag">→ Buy TQQQ</span>
            <span className="bt-signal-sep">  else  </span>
            <span className="bt-bear-tag">→ Buy SQQQ</span>
          </span>
        </div>

        <div className="bt-run-row">
          <select
            className="bt-select"
            value={period.label}
            onChange={e => setPeriod(PERIODS.find(p => p.label === e.target.value))}
          >
            {PERIODS.map(p => <option key={p.label}>{p.label}</option>)}
          </select>
          <button
            className="btn btn-primary bt-run-btn"
            onClick={handleRun}
            disabled={loading}
          >
            {loading ? 'Fetching…' : 'Run'}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {result && (
        <div className="bt-result">
          <div className="bt-result-title">
            {result.fastLabel} &gt; {result.slowLabel} → TQQQ &nbsp;|&nbsp; else → SQQQ &nbsp;·&nbsp; {result.period} · $10,000 start
          </div>

          <div className="bt-metrics">
            <MetricCard
              label="Strategy Return"
              value={sign(result.metrics.stratReturn)}
              up={result.metrics.stratReturn > 0 && stratBetter}
              down={result.metrics.stratReturn <= 0}
            />
            <MetricCard
              label="QQQ Buy & Hold"
              value={sign(result.metrics.qqqReturn)}
              up={result.metrics.qqqReturn > 0 && !stratBetter}
              down={result.metrics.qqqReturn <= 0}
            />
            <MetricCard label="Strategy CAGR"    value={`${result.metrics.stratCagr.toFixed(1)}%/yr`} />
            <MetricCard label="QQQ CAGR"         value={`${result.metrics.qqqCagr.toFixed(1)}%/yr`}  />
            <MetricCard
              label="Max Drawdown"
              value={`-${result.metrics.maxDrawdown.toFixed(1)}%`}
              down={result.metrics.maxDrawdown > 30}
            />
            <MetricCard label="Trades"           value={result.metrics.trades} />
            <MetricCard label="Bullish (TQQQ)"   value={`${result.metrics.daysBull.toFixed(0)}%`} />
            <MetricCard label="Bearish (SQQQ)"   value={`${result.metrics.daysBear.toFixed(0)}%`} />
          </div>

          <div className="bt-chart">
            <ResponsiveContainer width="100%" height={400}>
              <ComposedChart data={result.series} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickFormatter={d => {
                    const [y, m] = d.split('-')
                    return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`
                  }}
                  interval={xInterval}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickFormatter={v => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                  domain={['auto', 'auto']}
                  width={54}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  formatter={v => v === 'strategy' ? 'Strategy (TQQQ/SQQQ)' : 'QQQ Buy & Hold'}
                  wrapperStyle={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}
                />
                {bullPeriods.map(p => (
                  <ReferenceArea key={`bull-${p.x1}`} x1={p.x1} x2={p.x2} fill="rgba(0,200,150,0.07)" />
                ))}
                {bearPeriods.map(p => (
                  <ReferenceArea key={`bear-${p.x1}`} x1={p.x1} x2={p.x2} fill="rgba(255,76,76,0.06)" />
                ))}
                <Line type="monotone" dataKey="strategy" stroke="#8b5cf6" dot={false} strokeWidth={2} name="strategy" />
                <Line type="monotone" dataKey="qqqBH"    stroke="#64748b" dot={false} strokeWidth={2} name="qqqBH"    />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="bt-chart-legend-note">
              <span className="bt-legend-bull">■ Bull (TQQQ)</span>
              <span className="bt-legend-bear">■ Bear (SQQQ)</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
