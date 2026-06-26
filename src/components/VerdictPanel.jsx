import { DISCLAIMER } from '../utils/verdict'

// Renders verdict.js's getVerdict() output: ONE colored badge + reason on
// top, everything else (grade, signal, indicators) demoted to a small gray
// evidence strip underneath — "this is why," not a second competing call.
//
// Named VerdictPanel, not VerdictBadge, on purpose: AnalysisResult.jsx (the
// separate Claude-powered "Analysis" tab) already has its own local
// VerdictBadge component and `.verdict-badge` CSS class for its own
// GO/EXIT/HOLD verdict — a different, unrelated verdict system. Reusing the
// name here would recreate exactly the kind of confusion this refactor is
// fixing.
function VerdictPanel({ verdict, newHigh }) {
  if (!verdict) return null
  const { tier, headline, reason, evidence } = verdict

  return (
    <div className="verdict-panel">
      <div className="verdict-panel-top">
        <span className={`verdict-panel-badge verdict-panel-badge-${tier}`}>{headline}</span>
        <p className="verdict-panel-reason">{reason}</p>
      </div>
      <div className="verdict-panel-evidence">
        {newHigh && <span className="evidence-chip">New 52W High</span>}
        <span className="evidence-chip">Grade {evidence.grade}</span>
        <span className="evidence-chip">{evidence.signal}</span>
        {evidence.indicators.map((ind) => (
          <span className="evidence-chip" key={ind.label}>{ind.label}: {ind.value ?? '—'}</span>
        ))}
      </div>
      <p className="text-muted verdict-panel-disclaimer">{DISCLAIMER}</p>
    </div>
  )
}

export default VerdictPanel
