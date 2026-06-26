// "Show Analysis" panel — renders the output of stockAnalysis.js's
// analyzeStock()/analyzeOpenPosition(). Pure presentation: every field it
// shows was already computed synchronously before this component mounts, so
// there's no loading state of its own (the caller's cache/fetch — really
// just a synchronous call — happens before `data` is passed in).
//
// `isExistingPosition` reorders the layout per an open position's needs:
// IfAlreadyLong moves above the grade/indicators, and several sections that
// only make sense for a fresh-entry decision (gradeBreakdown, indicators,
// scenarios, thesis) are simply absent from `data` for that case — render
// defensively, skip what's not there.

import { STATUS_ICON, STATUS_CLS } from '../utils/indicatorStatus'

const ACTION_BANNER_CLS = {
  BUY: 'decision-banner-buy',
  ADD: 'decision-banner-buy',
  WAIT: 'decision-banner-wait',
  TRIM: 'decision-banner-wait',
  WATCH: 'decision-banner-watch',
  AVOID: 'decision-banner-avoid',
  SELL: 'decision-banner-avoid',
}

const GRADE_CLS = { 'A+': 'aplus', A: 'a', B: 'b', C: 'c' }
const PROBABILITY_CLS = { HIGH: 'text-green', MEDIUM: 'text-amber', LOW: 'text-muted' }

const VERDICT_BANNER_CLS = { green: 'decision-banner-buy', yellow: 'decision-banner-watch', red: 'decision-banner-avoid' }

// `verdict` (verdict.js's getVerdict() output) is only available for a
// fresh-scan WeekHighScreener result — OpenPositions has no equivalent, so
// this falls back to the raw decision tree there. Where a verdict exists,
// it must win: decision.action alone can read BUY on a stock the verdict
// holds at WATCH (earnings unverified, Alligator not yet confirmed — see
// verdict.js) and showing "BUY" here while the card's VerdictPanel and the
// Quick Lists chip both say Watch is the exact two-layers-disagree problem
// the verdict consolidation exists to prevent.
function DecisionBanner({ decision, verdict }) {
  if (verdict) {
    const cls = VERDICT_BANNER_CLS[verdict.tier] ?? 'decision-banner-watch'
    return (
      <div className={`decision-banner ${cls}`}>
        <div className="decision-banner-top">
          <span className="decision-action">{verdict.headline}</span>
        </div>
        <p className="decision-summary">{verdict.reason}</p>
      </div>
    )
  }

  const cls = ACTION_BANNER_CLS[decision.action] ?? 'decision-banner-watch'
  return (
    <div className={`decision-banner ${cls}`}>
      <div className="decision-banner-top">
        <span className="decision-action">{decision.action}</span>
        <span className="decision-meta">
          {decision.confidence} confidence · {decision.urgency.replace('_', ' ')}
        </span>
      </div>
      <p className="decision-summary">{decision.summary}</p>
    </div>
  )
}

function GradeCard({ grade }) {
  if (!grade) return null
  const gradeCls = grade.finalGrade ? GRADE_CLS[grade.finalGrade] : null

  return (
    <div className="analysis-section">
      <div className="grade-card-header">
        <span className={`grade-card-letter grade-badge-${gradeCls}`}>{grade.finalGrade ?? '?'}</span>
        <div className="text-muted">Criteria breakdown below — this grade is final, not a score to climb.</div>
      </div>
      <div className="criteria-list">
        {grade.criteria.map((c) => (
          <div className="criteria-row" key={c.name}>
            <span className={`criteria-icon ${STATUS_CLS[c.result]}`}>{STATUS_ICON[c.result]}</span>
            <span className="criteria-name">
              {c.name} {c.weight === 'MUST' && <span className="must-badge">MUST</span>}
            </span>
            <span className="criteria-value mono">{c.value}</span>
            <span className="text-muted criteria-threshold">{c.threshold}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function IndicatorChecklist({ indicators }) {
  if (!indicators) return null
  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Indicators</h4>
      <div className="indicator-table">
        {Object.entries(indicators).map(([key, ind]) => (
          <div className="indicator-row" key={key}>
            <span className="indicator-name">{key}</span>
            <span className={`indicator-value mono ${STATUS_CLS[ind.status]}`}>
              {ind.value ?? ind.phase ?? (ind.daysAway != null ? `${ind.daysAway}d` : '—')}
            </span>
            <span className={STATUS_CLS[ind.status]}>{STATUS_ICON[ind.status]}</span>
            <span className="text-muted indicator-label">{ind.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FlagsList({ flags }) {
  if (!flags) return null
  const sections = [
    ['redFlags', 'red', 'Red flags'],
    ['amberFlags', 'amber', 'Amber flags'],
    ['greenFlags', 'green', 'Green flags'],
  ]
  const anyFlags = sections.some(([key]) => flags[key]?.length > 0)
  if (!anyFlags) return null

  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Flags</h4>
      {sections.map(([key, tone, label]) => {
        const items = flags[key]
        if (!items || items.length === 0) return null
        return (
          <div className="flag-group" key={key}>
            <span className={`flag-group-label text-${tone === 'amber' ? 'amber' : tone === 'red' ? 'danger' : 'green'}`}>{label}</span>
            {items.map((text, i) => (
              <div className={`flag-item flag-item-${tone}`} key={i}>
                <span className={`flag-dot flag-dot-${tone}`} />
                {text}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function ScenarioCards({ scenarios }) {
  if (!scenarios) return null
  if (scenarios.length === 0) return <p className="section-empty">No entry scenarios — this isn&apos;t a long setup right now.</p>

  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Scenarios</h4>
      {scenarios.map((s) => (
        <div className="scenario-card" key={s.name}>
          <div className="scenario-card-header">
            <span className="scenario-name">{s.name}</span>
            {s.probability && <span className={`scenario-probability ${PROBABILITY_CLS[s.probability]}`}>{s.probability}</span>}
          </div>
          <p className="scenario-condition">{s.condition}</p>
          {s.viable ? (
            <div className="result-stats">
              <div className="result-stat">
                <span className="result-stat-label">Entry</span>
                <span className="result-stat-value mono">${s.entry.toFixed(2)}</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Stop ({s.stopMethod})</span>
                <span className="result-stat-value mono text-danger">${s.stop.toFixed(2)} (-{s.stopPct.toFixed(1)}%)</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Trim 1 (+{s.trim1R}R)</span>
                <span className="result-stat-value mono text-green">${s.trim1.toFixed(2)}</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Trim 2 (+{s.trim2R}R)</span>
                <span className="result-stat-value mono text-green">${s.trim2.toFixed(2)}</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Shares</span>
                <span className="result-stat-value mono">{s.shares}</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Position $</span>
                <span className="result-stat-value mono">${s.position.toLocaleString()}</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Risk $</span>
                <span className="result-stat-value mono">${s.risk.toLocaleString()} ({s.riskPct.toFixed(2)}%)</span>
              </div>
              <div className="result-stat">
                <span className="result-stat-label">Time stop</span>
                <span className="result-stat-value mono">{s.timeStopDays}d</span>
              </div>
            </div>
          ) : (
            <p className="analysis-error">Not viable: {s.reason}</p>
          )}
        </div>
      ))}
    </div>
  )
}

function ThesisBox({ thesis }) {
  if (!thesis) return null
  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Thesis</h4>
      <div className="thesis-row">
        <span className="thesis-label">Chart pattern</span>
        <p className="thesis-text">{thesis.chartPattern}</p>
      </div>
      <div className="thesis-row">
        <span className="thesis-label">Why now</span>
        <p className="thesis-text">{thesis.whyNow}</p>
      </div>
      <div className="thesis-row">
        <span className="thesis-label">Main risk</span>
        <p className="thesis-text thesis-risk">{thesis.risk}</p>
      </div>
    </div>
  )
}

function IfAlreadyLong({ data }) {
  if (!data) return null
  return (
    <div className="analysis-section if-already-long">
      <h4 className="analysis-section-title">If you&apos;re already long...</h4>
      <p className="if-long-action">{data.action}</p>
      <span className="if-long-trigger">{data.trimTrigger}</span>
      <p className="if-long-stop mono">{data.stopAction}</p>
    </div>
  )
}

function AnalysisPanel({ data, onClose, isExistingPosition = false, verdict = null }) {
  if (!data) {
    return (
      <div className="analysis-panel">
        <p className="analysis-error">Analysis unavailable.</p>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    )
  }

  const { decision, gradeBreakdown, indicators, flags, scenarios, thesis, ifAlreadyLong } = data

  const leftColumn = (
    <div className="analysis-col">
      <GradeCard grade={gradeBreakdown} />
      <IndicatorChecklist indicators={indicators} />
      <FlagsList flags={flags} />
    </div>
  )
  const rightColumn = (
    <div className="analysis-col">
      <ScenarioCards scenarios={scenarios} />
      <ThesisBox thesis={thesis} />
      {!isExistingPosition && <IfAlreadyLong data={ifAlreadyLong} />}
    </div>
  )

  return (
    <div className="analysis-panel">
      <div className="analysis-panel-header">
        <span className="result-ticker mono">{data.ticker}</span>
        <span className="result-company">{data.company}</span>
        <button type="button" className="btn analysis-close-btn" onClick={onClose}>Close</button>
      </div>

      <DecisionBanner decision={decision} verdict={verdict} />

      {isExistingPosition && <IfAlreadyLong data={ifAlreadyLong} />}

      <div className="analysis-grid">
        {leftColumn}
        {rightColumn}
      </div>
    </div>
  )
}

export default AnalysisPanel
