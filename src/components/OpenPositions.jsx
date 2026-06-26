import { useEffect, useState } from 'react'
import { loadPositions, savePositions, upsertPosition, removePosition, evaluateOpenPositions, addPositionFromEntry } from '../utils/positions'
import { fetchAlpacaCloses, fetchYahooCloses, scoreTrend } from '../utils/marketRegime'
import { analyzeOpenPosition } from '../utils/stockAnalysis'
import { logPositionAlerts } from '../utils/alerts'
import { LoaderIcon } from './Icons'
import AnalysisPanel from './AnalysisPanel'

const GRADES = ['A+', 'A', 'B', 'C']
const ACTION_CLS = {
  HOLD: 'pos-action-hold',
  'TRIM 1': 'pos-action-trim',
  'TRIM 2': 'pos-action-trim',
  'TRIM (PARABOLIC)': 'pos-action-trim',
  EXIT: 'pos-action-exit',
  'ADD ON RETEST': 'pos-action-add',
}

const EMPTY_FORM = { symbol: '', entryPrice: '', shares: '', entryDate: new Date().toISOString().slice(0, 10), grade: 'A', sector: '' }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function OpenPositions() {
  const [positions, setPositions] = useState(() => loadPositions())
  const [evaluations, setEvaluations] = useState(new Map())
  const [loadingEval, setLoadingEval] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)
  const [analysisId, setAnalysisId] = useState(null)

  const refreshEvaluations = async (list = positions) => {
    if (list.length === 0) {
      setEvaluations(new Map())
      return
    }
    setLoadingEval(true)
    try {
      const [spyResult, vixResult] = await Promise.allSettled([fetchAlpacaCloses('SPY'), fetchYahooCloses('%5EVIX')])
      const marketContext = {
        spyAbove200: spyResult.status === 'fulfilled' ? scoreTrend(spyResult.value).above200 : null,
        vixCurrent: vixResult.status === 'fulfilled' ? vixResult.value[vixResult.value.length - 1] : null,
      }
      const results = await evaluateOpenPositions(list, marketContext)
      setEvaluations(new Map(results.map((r) => [r.position.id, r])))
      logPositionAlerts(results)
    } finally {
      setLoadingEval(false)
    }
  }

  useEffect(() => {
    refreshEvaluations(positions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persist = (next) => {
    setPositions(next)
    savePositions(next)
  }

  const handleAdd = async (e) => {
    e.preventDefault()
    setError(null)

    const symbol = form.symbol.trim().toUpperCase()
    const entryPrice = Number(form.entryPrice)
    const shares = Number(form.shares)
    if (!symbol || !entryPrice || !shares) {
      setError('Symbol, entry price, and shares are required.')
      return
    }

    setAdding(true)
    try {
      const position = await addPositionFromEntry({
        symbol, entryPrice, shares, entryDate: form.entryDate, grade: form.grade, sector: form.sector.trim(),
      })

      const next = upsertPosition(positions, position)
      persist(next)
      setForm(EMPTY_FORM)
      await refreshEvaluations(next)
    } catch (err) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  const handleClose = (id) => {
    const next = removePosition(positions, id)
    persist(next)
  }

  const markTrim1Done = (position) => {
    const next = upsertPosition(positions, { ...position, trim1Done: true, currentStop: position.entryPrice })
    persist(next)
    refreshEvaluations(next)
  }

  const markTrim2Done = (position) => {
    const next = upsertPosition(positions, { ...position, trim2Done: true, currentStop: position.trim1Price })
    persist(next)
    refreshEvaluations(next)
  }

  const applyTrailingStop = (position, activeStop) => {
    if (activeStop == null) return
    const next = upsertPosition(positions, { ...position, currentStop: Math.max(position.currentStop, activeStop) })
    persist(next)
    refreshEvaluations(next)
  }

  const markAddDone = (position) => {
    const next = upsertPosition(positions, {
      ...position, addedBack: true, trim3Shares: position.trim3Shares + position.trim1Shares,
    })
    persist(next)
    refreshEvaluations(next)
  }

  return (
    <div className="open-positions">
      <div className="open-positions-header">
        <h3 className="result-card-title">Open Positions</h3>
        {loadingEval && <LoaderIcon className="spin-icon" />}
      </div>

      <form className="open-positions-form" onSubmit={handleAdd}>
        <input
          className="settings-input" placeholder="Symbol" value={form.symbol}
          onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))} disabled={adding}
        />
        <input
          className="settings-input" placeholder="Entry price" type="number" step="0.01" value={form.entryPrice}
          onChange={(e) => setForm((f) => ({ ...f, entryPrice: e.target.value }))} disabled={adding}
        />
        <input
          className="settings-input" placeholder="Shares" type="number" value={form.shares}
          onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))} disabled={adding}
        />
        <input
          className="settings-input" type="date" max={todayStr()} value={form.entryDate}
          onChange={(e) => setForm((f) => ({ ...f, entryDate: e.target.value }))} disabled={adding}
        />
        <select
          className="settings-input" value={form.grade}
          onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} disabled={adding}
        >
          {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input
          className="settings-input" placeholder="Sector (optional)" value={form.sector}
          onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))} disabled={adding}
        />
        <button type="submit" className="btn btn-primary" disabled={adding}>
          {adding ? 'Adding…' : 'Add Position'}
        </button>
      </form>
      {error && <div className="analysis-error">{error}</div>}

      {positions.length === 0 ? (
        <p className="section-empty">No open positions tracked yet.</p>
      ) : (
        <div className="signal-list">
          {positions.map((position) => {
            const result = evaluations.get(position.id)
            const evaluation = result?.evaluation
            const actionCls = evaluation ? ACTION_CLS[evaluation.action] ?? '' : ''

            return (
              <div className="signal-card" key={position.id}>
                <div className="signal-card-header">
                  <div className="result-title">
                    <span className="result-ticker mono">{position.symbol}</span>
                    <span className="result-company">Entry ${position.entryPrice.toFixed(2)} · {position.entryDate} · {position.shares} sh · Grade {position.grade}</span>
                  </div>
                  <div className="badge-row">
                    {position.backendTracked != null && (
                      <span
                        className={`result-sector-tag ${position.backendTracked ? 'text-green' : 'text-muted'}`}
                        title={position.backendTracked
                          ? 'Synced to the backend scheduler — trim/stop alerts will email you on the 2PM/3:50PM schedule'
                          : 'Backend sync failed (scheduler not running?) — only evaluated locally while this page is open'}
                      >
                        {position.backendTracked ? '✉ Scheduled alerts on' : '✉ Scheduled alerts off'}
                      </span>
                    )}
                    {evaluation && <span className={`signal-badge ${actionCls}`}>{evaluation.action}</span>}
                    {evaluation && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setAnalysisId((prev) => (prev === position.id ? null : position.id))}
                      >
                        {analysisId === position.id ? 'Hide Analysis ▴' : 'Show Analysis ▾'}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={() => handleClose(position.id)}>Close</button>
                  </div>
                </div>

                {result?.error && <p className="section-empty">Couldn&apos;t price this position today: {result.error}</p>}

                {analysisId === position.id && evaluation && (
                  <AnalysisPanel
                    data={analyzeOpenPosition(position, evaluation)}
                    onClose={() => setAnalysisId(null)}
                    isExistingPosition
                  />
                )}

                {evaluation && (
                  <>
                    <div className="result-stats">
                      <div className="result-stat">
                        <span className="result-stat-label">Current</span>
                        <span className="result-stat-value mono">${evaluation.currentPrice.toFixed(2)}</span>
                      </div>
                      <div className="result-stat">
                        <span className="result-stat-label">P&amp;L</span>
                        <span className={`result-stat-value mono ${evaluation.plPct >= 0 ? 'text-green' : 'text-danger'}`}>
                          {evaluation.plPct >= 0 ? '+' : ''}{evaluation.plPct.toFixed(2)}%
                        </span>
                      </div>
                      <div className="result-stat">
                        <span className="result-stat-label">Days held</span>
                        <span className="result-stat-value mono">{evaluation.daysHeld}</span>
                      </div>
                      <div className="result-stat">
                        <span className="result-stat-label">Today&apos;s stop</span>
                        <span className="result-stat-value mono">${evaluation.activeStop.toFixed(2)}</span>
                      </div>
                      <div className="result-stat">
                        <span className="result-stat-label">Next: {evaluation.nextTrim.label}</span>
                        <span className="result-stat-value mono">
                          {evaluation.nextTrim.price != null ? `$${evaluation.nextTrim.price.toFixed(2)}` : 'trailing'}
                        </span>
                      </div>
                    </div>

                    {evaluation.exitSignals.length > 0 && (
                      <p className="analysis-error">{evaluation.exitSignals.join(' · ')}</p>
                    )}
                    {evaluation.partialExitSignal && <p className="section-empty">{evaluation.partialExitSignal}</p>}

                    <div className="badge-row">
                      {!position.trim1Done && evaluation.action === 'TRIM 1' && (
                        <button type="button" className="btn" onClick={() => markTrim1Done(position)}>Mark Trim 1 Done</button>
                      )}
                      {position.trim1Done && !position.trim2Done && evaluation.action === 'TRIM 2' && (
                        <button type="button" className="btn" onClick={() => markTrim2Done(position)}>Mark Trim 2 Done</button>
                      )}
                      {evaluation.stage === 'POST_TRIM2' && evaluation.atrTrailStopToday > position.currentStop && (
                        <button type="button" className="btn" onClick={() => applyTrailingStop(position, evaluation.atrTrailStopToday)}>
                          Apply New Trailing Stop (${evaluation.atrTrailStopToday.toFixed(2)})
                        </button>
                      )}
                      {evaluation.retestAddEligible && (
                        <button type="button" className="btn" onClick={() => markAddDone(position)}>Mark Retest Add Done</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default OpenPositions
