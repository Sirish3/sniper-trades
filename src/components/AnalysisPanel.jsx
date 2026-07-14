// "Show Details" panel — renders evaluateStock.js's ONE evaluation object.
// Pure presentation: every field it shows was already computed synchronously
// before this component mounts (evaluateStock() runs once per result during
// the scan/earnings-check step, not per-render), so there's no loading
// state of its own.
//
// Previously this rendered stockAnalysis.js's analyzeStock() output — a
// separately-computed grade breakdown, indicator checklist, flags, dual
// breakout/retest scenario cards (each with its own positionPlan.js sizing
// call), and a hand-computed thesis. All of that was a second, sometimes-
// disagreeing opinion sitting next to VerdictPanel/EntryFilter's opinions —
// exactly the "which number do I trust" problem this consolidation exists
// to fix. What replaced each piece:
//   - grade breakdown + indicator checklist -> ONE `reasons` array (MUST +
//     SCORED tiers), reused directly instead of two separately-shaped
//     objects.
//   - flags (red/amber/green) -> deriveFlags(reasons), a filter over that
//     same array, not a separately computed object.
//   - dual scenario cards -> ONE scenario (evaluation.entry/stop/size/
//     riskDollars), matching whichever signalType actually applies — two
//     independently-sized "opinions" on the same trade was part of the
//     original clutter.
//   - hand-computed thesis -> generated at render time from stage + the
//     weakest/strongest reasons entries (generateThesisText below), not a
//     6th separately-computed field.

import { STATUS_ICON, STATUS_CLS } from '../utils/indicatorStatus'
import { deriveFlags, strongestReasons, weakestReasons, summarizeVerdict } from '../utils/evaluateStock'

const VERDICT_BANNER_CLS = { green: 'decision-banner-buy', yellow: 'decision-banner-watch', red: 'decision-banner-avoid' }

const STAGE_TEXT = {
  MARKUP: 'an established, still-widening uptrend',
  ACCUMULATION: 'a fresh breakout out of a real base — early in the move',
  DISTRIBUTION: 'a stretched move with fading trend strength — a distribution warning',
  DECLINE: 'a downtrend',
  UNCLEAR: 'a stage that is not clearly one thing or another',
}

// MUST status (PASS/FAIL) or SCORED points (0/1/2) -> the shared PASS/WARN/
// FAIL icon vocabulary.
function reasonStatus(reason) {
  if (reason.tier === 'MUST') return reason.status
  return reason.points === 2 ? 'PASS' : reason.points === 1 ? 'WARN' : 'FAIL'
}

function reasonValueText(reason) {
  if (reason.tier === 'MUST') return reason.value
  return `${reason.value} (${reason.points}/${reason.maxPoints})`
}

function generateThesisText(evaluation) {
  if (evaluation.grade == null) {
    const failed = evaluation.reasons.filter((r) => r.tier === 'MUST' && r.status === 'FAIL')
    return `Disqualified before scoring: ${failed.map((f) => `${f.label} (${f.value}, need ${f.threshold})`).join('; ')}.`
  }
  const strengths = strongestReasons(evaluation.reasons, 2).map((r) => r.label)
  const weaknesses = weakestReasons(evaluation.reasons, 2).map((r) => r.label)
  const stageTxt = STAGE_TEXT[evaluation.stage] ?? 'an uncertain stage'
  return `Grade ${evaluation.grade} (${evaluation.score}/24) setup in ${stageTxt}. `
    + `Strongest: ${strengths.join(', ')}. Weakest: ${weaknesses.join(', ')}.`
}

function DecisionBanner({ evaluation }) {
  const { headline, tier, reason } = summarizeVerdict(evaluation)
  return (
    <div className={`decision-banner ${VERDICT_BANNER_CLS[tier]}`}>
      <div className="decision-banner-top">
        <span className="decision-action">{headline}</span>
      </div>
      <p className="decision-summary">{reason}</p>
    </div>
  )
}

function ReasonList({ title, reasons }) {
  if (reasons.length === 0) return null
  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">{title}</h4>
      <div className="criteria-list">
        {reasons.map((r) => {
          const status = reasonStatus(r)
          return (
            <div className="criteria-row" key={`${r.tier}-${r.n ?? r.label}`}>
              <span className={`criteria-icon ${STATUS_CLS[status]}`}>{STATUS_ICON[status]}</span>
              <span className="criteria-name">{r.label}</span>
              <span className="criteria-value mono">{reasonValueText(r)}</span>
              <span className="text-muted criteria-threshold">{r.threshold}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FlagsList({ reasons }) {
  const { red, amber, green } = deriveFlags(reasons)
  const sections = [
    ['red', red, 'Red flags'],
    ['amber', amber, 'Amber flags'],
    ['green', green, 'Green flags'],
  ]
  if (red.length === 0 && amber.length === 0 && green.length === 0) return null

  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Flags</h4>
      {sections.map(([tone, items, label]) => {
        if (items.length === 0) return null
        return (
          <div className="flag-group" key={tone}>
            <span className={`flag-group-label text-${tone === 'amber' ? 'amber' : tone === 'red' ? 'danger' : 'green'}`}>{label}</span>
            {items.map((r) => (
              <div className={`flag-item flag-item-${tone}`} key={`${r.tier}-${r.n ?? r.label}`}>
                <span className={`flag-dot flag-dot-${tone}`} />
                {r.label}: {reasonValueText(r)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function SizingCard({ evaluation }) {
  if (evaluation.entry == null) {
    return (
      <div className="analysis-section">
        <h4 className="analysis-section-title">Entry / Stop / Size</h4>
        <p className="section-empty">
          {evaluation.grade === 'D' ? 'Grade D — not sized.' : 'Not sized — this setup is disqualified.'}
        </p>
      </div>
    )
  }
  const riskPerShare = evaluation.entry - evaluation.stop
  const riskPct = evaluation.entry ? (riskPerShare / evaluation.entry) * 100 : null
  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Entry / Stop / Size</h4>
      <div className="result-stats">
        <div className="result-stat">
          <span className="result-stat-label">Entry</span>
          <span className="result-stat-value mono">${evaluation.entry.toFixed(2)}</span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">Stop (max of 5% / 1.5x ATR)</span>
          <span className="result-stat-value mono text-danger">
            ${evaluation.stop.toFixed(2)} {riskPct != null && <span className="text-muted">(-{riskPct.toFixed(1)}%)</span>}
          </span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">Size</span>
          <span className="result-stat-value mono">{evaluation.size} sh</span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">Risk $</span>
          <span className="result-stat-value mono">${evaluation.riskDollars?.toLocaleString()}</span>
        </div>
      </div>
      {!evaluation.tradePlanEligible && (
        <p className="section-empty" style={{ marginTop: '0.5rem' }}>
          Sized for reference — verdict is {evaluation.verdict}, not an actionable trigger right now.
        </p>
      )}
    </div>
  )
}

function ThesisBox({ evaluation }) {
  return (
    <div className="analysis-section">
      <h4 className="analysis-section-title">Thesis</h4>
      <p className="thesis-text">{generateThesisText(evaluation)}</p>
    </div>
  )
}

function AnalysisPanel({ evaluation, ticker, company, onClose }) {
  if (!evaluation) {
    return (
      <div className="analysis-panel">
        <p className="analysis-error">Analysis unavailable.</p>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    )
  }

  const musts = evaluation.reasons.filter((r) => r.tier === 'MUST')
  const scoredList = evaluation.reasons.filter((r) => r.tier === 'SCORED')

  return (
    <div className="analysis-panel">
      <div className="analysis-panel-header">
        <span className="result-ticker mono">{ticker}</span>
        <span className="result-company">{company}</span>
        <button type="button" className="btn analysis-close-btn" onClick={onClose}>Close</button>
      </div>

      <DecisionBanner evaluation={evaluation} />

      <div className="analysis-grid">
        <div className="analysis-col">
          <ReasonList title="Hard Filters (MUST)" reasons={musts} />
          <ReasonList title="Scored Factors" reasons={scoredList} />
          <FlagsList reasons={evaluation.reasons} />
        </div>
        <div className="analysis-col">
          <SizingCard evaluation={evaluation} />
          <ThesisBox evaluation={evaluation} />
        </div>
      </div>
    </div>
  )
}

export default AnalysisPanel
