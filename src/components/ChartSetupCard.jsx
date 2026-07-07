import { useEffect, useState } from 'react'
import CandlestickChart from './CandlestickChart'
import { getSetupCandles } from '../utils/chartSetupsApi'

function formatUpdated(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatSupport(setup) {
  if (setup.supportLow == null) return '—'
  return setup.supportHigh != null
    ? `$${setup.supportLow.toFixed(2)} – $${setup.supportHigh.toFixed(2)}`
    : `$${setup.supportLow.toFixed(2)}`
}

export default function ChartSetupCard({ setup }) {
  const [candles, setCandles] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setCandles(null)
    setError(null)
    getSetupCandles(setup.id)
      .then((data) => { if (!cancelled) setCandles(data.candles) })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [setup.id])

  const lastClose = candles?.length ? candles[candles.length - 1].close : null

  return (
    <div className="cp-card">
      <div className="cp-card-header">
        <div>
          <span className="cp-card-ticker">{setup.ticker}</span>
          {lastClose != null && <span className="cp-card-price">${lastClose.toFixed(2)}</span>}
        </div>
        <span className="cp-pattern-tag">{setup.patternType}</span>
      </div>

      <div className="cp-card-updated">Updated {formatUpdated(setup.updatedAt)}</div>

      {error && <div className="bt-error">{error}</div>}
      {!candles && !error && <div className="qqq-state-loading">Loading chart…</div>}
      {candles && <CandlestickChart candles={candles} annotations={setup.chartAnnotations} height={260} />}

      <div className="cp-levels">
        <div className="cp-level cp-level-support">
          <span className="cp-level-label">Support</span>
          <span className="cp-level-value">{formatSupport(setup)}</span>
        </div>
        <div className="cp-level cp-level-resistance">
          <span className="cp-level-label">Resistance</span>
          <span className="cp-level-value">{setup.resistance != null ? `$${setup.resistance.toFixed(2)}` : '—'}</span>
        </div>
      </div>

      {setup.description && <p className="cp-card-description">{setup.description}</p>}
    </div>
  )
}
