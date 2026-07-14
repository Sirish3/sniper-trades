import { summarizeVerdict } from '../utils/evaluateStock'

// Renders evaluateStock.js's evaluation.verdict: ONE colored badge + reason
// on top, everything else (grade, stage, factors) demoted to a small gray
// evidence strip underneath — "this is why," not a second competing call.
// summarizeVerdict() is the same headline/reason logic AnalysisPanel's
// "Show Details" uses, so the badge and the full breakdown never disagree
// on what to say about the same evaluation.
//
// Named VerdictPanel, not VerdictBadge, on purpose: AnalysisResult.jsx (the
// separate Claude-powered "Analysis" tab) already has its own local
// VerdictBadge component and `.verdict-badge` CSS class for its own
// GO/EXIT/HOLD verdict — a different, unrelated verdict system. Reusing the
// name here would recreate exactly the kind of confusion this refactor is
// fixing.
const DISCLAIMER = 'Educational only, not financial advice.'

function evidenceChips(evaluation) {
  const chips = [
    { label: 'Grade', value: evaluation.grade ?? '?' },
    { label: 'Stage', value: evaluation.stage ?? '?' },
  ]
  if (evaluation.score != null) chips.push({ label: 'Score', value: `${evaluation.score}/24` })
  return chips
}

function VerdictPanel({ evaluation, newHigh }) {
  if (!evaluation) return null
  const { headline, tier, reason } = summarizeVerdict(evaluation)

  return (
    <div className="verdict-panel">
      <div className="verdict-panel-top">
        <span className={`verdict-panel-badge verdict-panel-badge-${tier}`}>{headline}</span>
        <p className="verdict-panel-reason">{reason}</p>
      </div>
      <div className="verdict-panel-evidence">
        {newHigh && <span className="evidence-chip">New 52W High</span>}
        {evidenceChips(evaluation).map((c) => (
          <span className="evidence-chip" key={c.label}>{c.label}: {c.value}</span>
        ))}
      </div>
      <p className="text-muted verdict-panel-disclaimer">{DISCLAIMER}</p>
    </div>
  )
}

export default VerdictPanel
