import { useEffect, useState } from 'react'
import ChartSetupCard from './ChartSetupCard'
import { getPatternCounts, getSetups } from '../utils/chartSetupsApi'

export default function ChartPatterns() {
  const [counts, setCounts] = useState(null)
  const [setups, setSetups] = useState(null)
  const [selectedPattern, setSelectedPattern] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getPatternCounts().then(setCounts).catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getSetups(selectedPattern)
      .then((data) => { if (!cancelled) setSetups(data) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedPattern])

  const totalCount = counts?.reduce((sum, c) => sum + c.count, 0) ?? 0

  return (
    <div className="cp-page">
      <aside className="cp-sidebar">
        <div className="cp-sidebar-title">Patterns</div>
        <button
          className={`cp-sidebar-item ${selectedPattern === null ? 'active' : ''}`}
          onClick={() => setSelectedPattern(null)}
        >
          <span>All Setups</span>
          <span className="cp-sidebar-count">{totalCount}</span>
        </button>
        {counts?.map((c) => (
          <button
            key={c.patternType}
            className={`cp-sidebar-item ${selectedPattern === c.patternType ? 'active' : ''}`}
            onClick={() => setSelectedPattern(c.patternType)}
          >
            <span>{c.patternType}</span>
            <span className="cp-sidebar-count">{c.count}</span>
          </button>
        ))}
      </aside>

      <div className="cp-main">
        {error && <div className="bt-error">{error}</div>}
        {loading && <div className="qqq-state-loading">Loading setups…</div>}

        {!loading && setups && setups.length === 0 && (
          <div className="qqq-state-loading">No published setups{selectedPattern ? ` for "${selectedPattern}"` : ''} yet.</div>
        )}

        {setups && setups.length > 0 && (
          <div className="cp-grid">
            {setups.map((setup) => (
              <ChartSetupCard key={setup.id} setup={setup} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
