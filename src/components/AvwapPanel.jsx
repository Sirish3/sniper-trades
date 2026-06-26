// Anchored VWAP strategy panel — shown alongside AnalysisPanel when a 52W
// High result's "Show Analysis" is expanded. Fetches full OHLCV bars once
// per symbol (reusing marketData.js's fetchBars, already used everywhere
// else in this app for the same Alpaca data), computes every anchor's
// AVWAP client-side, then runs avwapSignal.js's signal engine on top to
// turn the raw numbers into one actionable call. A custom anchor date
// recalculates everything from the same cached bars — no extra fetch.
import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { fetchBars } from '../utils/marketData'
import { buildAvwapAnalysis } from '../utils/avwap'
import { evaluateAvwapSignal, SIGNAL_CONFIG, slopeArrow } from '../utils/avwapSignal'
import { detectSweep } from '../utils/sweepDetector'
import { buildVolumeProfileAnalysis } from '../utils/volumeProfile'
import { LoaderIcon } from './Icons'

const ANCHOR_LINE_COLORS = {
  from_52w_high: '#00c896',
  from_recent_low: '#f59e0b',
  from_year_start: '#8b5cf6',
  from_custom: '#3b82f6',
}

const STACK_LABEL = {
  BULLISH_STACK: 'BULLISH STACK',
  MIXED: 'MIXED',
  BEARISH_STACK: 'BEARISH STACK',
}
const STACK_CLASS = {
  BULLISH_STACK: 'signal-badge-bullish',
  MIXED: 'signal-badge-watch',
  BEARISH_STACK: 'signal-badge-bearish',
}

function fmt(n) {
  return n.toFixed(2)
}

function SignalCard({ result }) {
  const cfg = SIGNAL_CONFIG[result.signal]
  const risk = result.entryPrice != null && result.stopPrice != null ? result.entryPrice - result.stopPrice : null

  const pulsing = result.signal === 'SWEEP_IN_PROGRESS' ? ' avwap-signal-card-pulsing' : ''

  return (
    <div className={`avwap-signal-card${pulsing}`} style={{ borderColor: cfg.color, background: cfg.bg }}>
      <div className="avwap-signal-card-top">
        <span className="avwap-signal-label" style={{ color: cfg.color }}>{cfg.icon} {cfg.label}</span>
        <div className="avwap-confidence">
          <span className="result-stat-label">Confidence</span>
          <div className="avwap-confidence-bar">
            <div className="avwap-confidence-fill" style={{ width: `${result.confidence}%`, background: cfg.color }} />
          </div>
          <span className="mono">{result.confidence}%</span>
        </div>
      </div>

      <p className="avwap-signal-reason">{result.reason}</p>

      <div className="avwap-signal-action">
        <span className="thesis-label">Action</span>
        <p className="thesis-text">{result.action}</p>
      </div>

      {(result.entryLow != null || result.stopPrice != null) && (
        <div className="result-stats">
          {result.entryLow != null && (
            <div className="result-stat">
              <span className="result-stat-label">Entry Zone</span>
              <span className="result-stat-value mono">${fmt(result.entryLow)} - ${fmt(result.entryHigh)}</span>
            </div>
          )}
          {result.stopPrice != null && (
            <div className="result-stat">
              <span className="result-stat-label">Stop Zone</span>
              <span className="result-stat-value mono text-danger">${fmt(result.stopPrice)}</span>
            </div>
          )}
          {result.target1 != null && (
            <div className="result-stat">
              <span className="result-stat-label">Target 1</span>
              <span className="result-stat-value mono text-green">${fmt(result.target1)}</span>
            </div>
          )}
          {risk != null && (
            <div className="result-stat">
              <span className="result-stat-label">Risk</span>
              <span className="result-stat-value mono">${fmt(risk)}/share</span>
            </div>
          )}
          {result.riskRewardRatio != null && (
            <div className="result-stat">
              <span className="result-stat-label">R:R</span>
              <span className="result-stat-value mono">{result.riskRewardRatio.toFixed(1)}:1</span>
            </div>
          )}
          {result.sweepGrade != null && (
            <div className="result-stat">
              <span className="result-stat-label">Sweep Grade</span>
              <span className="result-stat-value mono">{result.sweepGrade}</span>
            </div>
          )}
        </div>
      )}

      <p className="avwap-disclaimer">
        Signal is based on AVWAP positioning, not financial advice. Always manage risk with proper position sizing and stop losses.
      </p>
    </div>
  )
}

function StackVisualization({ analysis, result, sweep, vp }) {
  const primaryProfile = vp?.timeframes?.from_52w_high
  const rows = [
    { kind: 'reference', label: '52W High', value: analysis.high52w },
    { kind: 'price', label: 'Current Price', value: analysis.currentPrice },
    ...result.levels.map((a) => ({
      kind: 'avwap', label: a.label.replace('From ', ''), value: a.value,
      slope: a.slope, vsPricePct: a.vsPricePct, signal: a.signal,
    })),
    ...(sweep?.event?.sweepLow != null
      ? [{ kind: 'sweep', label: `Sweep Low (${sweep.event.sweepDate})`, value: sweep.event.sweepLow }]
      : []),
    ...(primaryProfile ? [{ kind: 'poc', label: 'Volume POC', value: primaryProfile.poc }] : []),
  ].sort((a, b) => b.value - a.value)

  return (
    <div className="avwap-stack">
      <div className="badge-row">
        <span className={`signal-badge ${STACK_CLASS[result.stackStatus]}`}>{STACK_LABEL[result.stackStatus]}</span>
      </div>
      {rows.map((row, i) => (
        <div className={`avwap-stack-row avwap-stack-row-${row.kind}${row.kind === 'avwap' ? ` avwap-stack-row-${row.signal.toLowerCase()}` : ''}`} key={i}>
          <span className="avwap-stack-row-value mono">${fmt(row.value)}</span>
          <span className="avwap-stack-row-label">
            {row.kind === 'price' ? '◆ Current Price' : row.label}
            {row.kind === 'avwap' && <span className="avwap-stack-row-slope"> {slopeArrow(row.slope)} {row.slope}</span>}
          </span>
          {row.kind === 'avwap' && (
            <span className={`avwap-stack-row-pct mono ${row.signal === 'BULLISH' ? 'text-green' : 'text-danger'}`}>
              {row.vsPricePct >= 0 ? '+' : ''}{row.vsPricePct.toFixed(1)}%
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

const VP_TIMEFRAME_LABELS = {
  from_52w_high: 'From 52W High',
  full_year: 'Full Year',
  recent_30d: 'Recent 30d',
}

function VolumeProfilePanel({ vp }) {
  const [timeframe, setTimeframe] = useState('from_52w_high')
  const profile = vp.timeframes[timeframe]

  return (
    <div className="result-card">
      <div className="vp-header">
        <h4 className="analysis-section-title">Volume Profile</h4>
        {vp.pocTrend !== 'flat' && (
          <span className={`signal-badge ${vp.pocTrend === 'rising' ? 'signal-badge-bullish' : 'signal-badge-bearish'}`}>
            POC {vp.pocTrend}
          </span>
        )}
      </div>

      <div className="badge-row vp-timeframe-row">
        {Object.entries(VP_TIMEFRAME_LABELS).map(([key, label]) => (
          <button
            key={key} type="button"
            className={`btn vp-timeframe-btn${timeframe === key ? ' vp-timeframe-btn-active' : ''}`}
            onClick={() => setTimeframe(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {!profile ? (
        <p className="section-empty">Not enough bars in this timeframe yet.</p>
      ) : (
        <>
          <div className="result-stats">
            <div className="result-stat">
              <span className="result-stat-label">POC</span>
              <span className="result-stat-value mono vp-poc-text">${fmt(profile.poc)}</span>
            </div>
            <div className="result-stat">
              <span className="result-stat-label">Value Area High</span>
              <span className="result-stat-value mono">${fmt(profile.vah)}</span>
            </div>
            <div className="result-stat">
              <span className="result-stat-label">Value Area Low</span>
              <span className="result-stat-value mono">${fmt(profile.val)}</span>
            </div>
          </div>

          <VolumeProfileHistogram profile={profile} hvns={vp.hvns} lvns={vp.lvns} />

          {(vp.hvns.length > 0 || vp.accelerationZones.length > 0) && (
            <div className="vp-levels">
              {vp.hvns.length > 0 && (
                <div className="vp-levels-group">
                  <span className="result-stat-label">High-volume nodes (real support/resistance)</span>
                  <div className="badge-row">
                    {vp.hvns.map((h) => (
                      <span className="signal-badge vp-hvn-badge" key={h.price}>${fmt(h.price)}</span>
                    ))}
                  </div>
                </div>
              )}
              {vp.accelerationZones.length > 0 && (
                <div className="vp-levels-group">
                  <span className="result-stat-label">Low-volume gaps above price (acceleration zones)</span>
                  <div className="badge-row">
                    {vp.accelerationZones.map((l) => (
                      <span className="signal-badge vp-lvn-badge" key={l.price}>${fmt(l.price)}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function VolumeProfileHistogram({ profile, hvns, lvns }) {
  const maxVol = Math.max(...profile.bins.map((b) => b.volume))
  const hvnPrices = new Set(hvns.map((h) => h.price))
  const lvnPrices = new Set(lvns.map((l) => l.price))
  const rows = [...profile.bins].sort((a, b) => b.price - a.price)

  return (
    <div className="vp-histogram">
      {rows.map((bin) => {
        const isPoc = bin.price === profile.poc
        const inValueArea = bin.price <= profile.vah && bin.price >= profile.val
        const isHvn = hvnPrices.has(bin.price)
        const isLvn = lvnPrices.has(bin.price)
        const widthPct = maxVol > 0 ? (bin.volume / maxVol) * 100 : 0
        const cls = isPoc ? 'vp-bar-poc' : isHvn ? 'vp-bar-hvn' : isLvn ? 'vp-bar-lvn' : inValueArea ? 'vp-bar-va' : 'vp-bar-normal'
        return (
          <div className="vp-row" key={bin.price}>
            <span className="vp-row-price mono">${bin.price.toFixed(2)}</span>
            <div className="vp-row-track">
              <div className={`vp-row-bar ${cls}`} style={{ width: `${widthPct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AvwapPanel({ symbol }) {
  const [bars, setBars] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [customAnchor, setCustomAnchor] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setBars(null)
    setCustomAnchor('')
    fetchBars(symbol)
      .then((b) => { if (!cancelled) setBars(b) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [symbol])

  const analysis = useMemo(
    () => (bars ? buildAvwapAnalysis(bars, customAnchor || null) : null),
    [bars, customAnchor]
  )

  const sweep = useMemo(() => {
    if (!analysis) return null
    const highAnchor = analysis.anchors.find((a) => a.key === 'from_52w_high')
    if (!highAnchor) return null
    return detectSweep(analysis.bars, highAnchor.series)
  }, [analysis])

  const vp = useMemo(() => {
    if (!analysis) return null
    return buildVolumeProfileAnalysis(analysis)
  }, [analysis])

  const signalResult = useMemo(() => {
    if (!analysis || !bars) return null
    const volumeToday = bars[bars.length - 1]?.v ?? null
    const avgVolume = bars.length >= 20
      ? bars.slice(-20).reduce((sum, b) => sum + b.v, 0) / 20
      : null
    return evaluateAvwapSignal(analysis, { avgVolume, volumeToday, sweep, vp })
  }, [analysis, bars, sweep, vp])

  if (loading) {
    return (
      <div className="result-card">
        <p className="section-empty"><LoaderIcon className="spin-icon" /> Loading AVWAP Strategy…</p>
      </div>
    )
  }
  if (error) {
    return <div className="result-card"><p className="analysis-error">{error}</p></div>
  }
  if (!analysis || !signalResult) return null

  const today = new Date().toISOString().slice(0, 10)

  return (
    <>
      <div className="result-card">
        <h4 className="analysis-section-title">AVWAP Strategy</h4>

        <SignalCard result={signalResult} />
        <StackVisualization analysis={analysis} result={signalResult} sweep={sweep} vp={vp} />

        <div className="screener-controls avwap-controls">
          <input
            className="settings-input" type="date" max={today}
            value={customAnchor} onChange={(e) => setCustomAnchor(e.target.value)}
            title="Pick a custom AVWAP anchor date"
          />
          {customAnchor && (
            <button type="button" className="btn btn-ghost" onClick={() => setCustomAnchor('')}>
              Clear custom anchor
            </button>
          )}
        </div>

        <div className="avwap-chart">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={analysis.chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
              <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} width={55} />
              <Tooltip />
              <Line type="monotone" dataKey="close" name="Price" stroke="#e2e8f0" dot={false} strokeWidth={1.5} />
              {analysis.anchors.map((a) => (
                <Line
                  key={a.key} type="monotone" dataKey={a.key} name={a.label}
                  stroke={ANCHOR_LINE_COLORS[a.key] ?? '#3b82f6'} dot={false} strokeWidth={1.5} connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {vp && <VolumeProfilePanel vp={vp} />}
    </>
  )
}

export default AvwapPanel
