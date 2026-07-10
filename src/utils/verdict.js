// The single user-facing verdict — consolidates the competing layers
// (grade, signalType, decision.action, the old standalone `call`) into ONE
// colored call per stock, with everything else demoted to supporting
// evidence.
//
// FIX 2 (AVOID/WATCH split): a single failed MUST in decision.action used to
// push strong setups (failing only on timing/confirmation) into the same
// AVOID bucket as genuinely weak stocks. AVOID_SELL is now decided here,
// independently of decision.action, from the structural-weakness fields
// directly (RS rank, AVWAP, sector, Alligator, RSI, grade, imminent known
// earnings) — see structuralWeakness() below. Everything else (volume not
// yet confirmed, overbought, extended, APPROACHING, grade B, Alligator not
// yet confirmed, unverified earnings, or a trade plan that failed on
// stop/sizing mechanics) falls through to WATCH. decision.action is still
// read for the BUY_NOW gate (it already encodes grade + signalType +
// indicator-FAIL checks; re-deriving that here would just be a second,
// competing implementation of the same eligibility rule) and for SELL vs.
// AVOID headline wording. grade, signalType, and decision.action themselves
// are never recomputed — gradeWeekHighSetup(), classifySignalType(), and
// makeDecision() stay the only source of truth for those three fields.
//
// FIX 3 / earningsProvider.js integration: earnings is now tagged
// CONFIRMED, ESTIMATED, or UNKNOWN (see earningsProvider.js). Only a
// CONFIRMED date inside the real buffer is a hard AVOID_SELL trigger.
// UNKNOWN (no data at all) and ESTIMATED (self-estimated, or
// calendar-returned but not Finnhub-confirmed — both carry ~±2-week error)
// can only cap a stock at WATCH with a verify-earnings flag, never force
// AVOID_SELL — a guess or a missing fetch isn't evidence of real risk.
//
// 3 states, not 4: WAIT and WATCH (decision.action) both collapse into the
// WATCH verdict. A clean NOT_READY split ("quality present, timing off" vs
// "not worth attention") isn't derivable from the existing fields without
// inventing a new heuristic — which would mean re-grading, not consolidating.
// Simpler ships better here.

import { analyzeStock } from './stockAnalysis'
import { THRESHOLDS } from './screenerThresholds'

export const DISCLAIMER = 'Educational only, not financial advice.'

const VERDICT_TIER = { BUY_NOW: 'green', WATCH: 'yellow', AVOID_SELL: 'red' }

const SIGNAL_PLAIN_LABEL = {
  BUY_BREAKOUT: 'Breakout confirmed',
  BUY_RETEST: 'Retest holding',
  WATCH: 'Near pivot, strong RS',
  APPROACHING: 'Approaching pivot',
}

// Small labeled chips for the subordinate evidence strip — a curated subset
// of analyzeStock()'s full indicator set, reusing its already-computed
// PASS/WARN/FAIL/DATA_MISSING status rather than re-deriving anything.
function buildEvidence(r, analysis) {
  const ind = analysis.indicators
  const earningsUnknown = r.earningsDaysAway == null
  const earningsSource = r.earningsSource ?? 'UNKNOWN'

  const volumeValue = ind.volume?.today != null
    ? `today ${ind.volume.today}x · best ${THRESHOLDS.volumeBreakoutWindowDays}d ${ind.volume.maxN ?? ind.volume.today}x${ind.volume.maxNDaysAgo ? ` (${ind.volume.maxNDaysAgo}d ago)` : ''}`
    : null

  // Always show which source the earnings date came from — a guess must
  // never display as if it were a fact (see earningsProvider.js).
  const earningsValue = earningsUnknown
    ? 'Unavailable — verify before buying'
    : `${r.earningsDaysAway}d away${earningsSource === 'ESTIMATED' ? ` (~${r.earningsDate ?? '?'}, estimated)` : ` (${r.earningsDate ?? '?'}, confirmed)`}`
  const earningsStatus = earningsUnknown
    ? 'WARN'
    : earningsSource === 'CONFIRMED' && r.earningsDaysAway <= THRESHOLDS.earningsBufferDays
      ? 'FAIL'
      : earningsSource === 'ESTIMATED' && r.earningsDaysAway <= THRESHOLDS.earningsBufferDays + THRESHOLDS.earningsEstimatedPadDays
        ? 'WARN'
        : 'PASS'

  return {
    grade: r.grade ?? '?',
    signal: SIGNAL_PLAIN_LABEL[r.signalType] ?? 'No clear signal yet',
    earningsUnknown,
    earningsSource,
    indicators: [
      { label: 'Volume', value: volumeValue, status: ind.volume?.status },
      { label: 'RSI', value: ind.rsi?.value, status: ind.rsi?.status },
      { label: 'ADX', value: ind.adx?.value, status: ind.adx?.status },
      { label: 'EMA Stack', value: ind.emaStack ? (ind.emaStack.aligned ? 'Aligned' : 'Not aligned') : null, status: ind.emaStack?.status },
      { label: 'RS Rank', value: ind.rsRank?.value, status: ind.rsRank?.status },
      { label: 'Earnings', value: earningsValue, status: earningsStatus },
    ],
  }
}

// FIX 2 — AVOID_SELL is reserved for genuine structural weakness (trend
// direction, relative strength, sector backdrop) or a hard date-driven risk
// event (earnings known and imminent), never for a strong setup that's
// merely failing one timing/confirmation gate. Checked in priority order;
// the first match names the dominant reason. Anything else (volume,
// extension, stop/sizing mechanics, grade B, unverified earnings) falls
// through to WATCH instead — see reasonForWatch.
function structuralWeakness(r) {
  if (r.grade === 'C') return 'grade-c'
  // Only a CONFIRMED earnings date is a hard structural trigger — ESTIMATED
  // and UNKNOWN route through reasonForWatch's earnings caveat instead (see
  // earningsBlocksBuy in getVerdict), never straight to AVOID_SELL.
  if (r.earningsSource === 'CONFIRMED' && r.earningsDaysAway != null && r.earningsDaysAway <= THRESHOLDS.earningsBufferDays) return 'earnings-soon'
  if (r.rsRank != null && r.rsRank < THRESHOLDS.rsRankWeakMax) return 'rs-weak'
  if (r.avwapFromHigh != null && r.avwapFromHigh.signal === 'BEARISH') return 'avwap-bearish'
  if (r.sectorStatus === 'COLD' && (r.rsRank == null || r.rsRank < THRESHOLDS.sectorColdRsOverride)) return 'sector-cold'
  if (r.alligatorPhase === 'EATING_DOWN') return 'alligator-down'
  if (r.rsiValue != null && r.rsiValue < THRESHOLDS.rsiWeakMax) return 'rsi-weak'
  return null
}

const WEAKNESS_REASON = {
  'grade-c': () => "This setup didn't earn a high enough grade — skip it.",
  'earnings-soon': (r) => `Earnings confirmed in ${r.earningsDaysAway} days — too risky to enter now.`,
  'rs-weak': (r) => `RS rank ${r.rsRank} is too weak — this stock is lagging the market.`,
  'avwap-bearish': () => 'Buyers since the 52-week high are underwater — the breakout lacks real support.',
  'sector-cold': () => "Sector is cold and this stock isn't strong enough to fight it.",
  'alligator-down': () => 'Trend is breaking down — stay out.',
  'rsi-weak': () => 'No momentum left — this is not a long setup right now.',
}

function reasonForAvoidSell(r, weaknessKey) {
  return WEAKNESS_REASON[weaknessKey](r)
}

// FIX 2 — the ONE dominant reason a WATCH-verdict stock isn't BUY_NOW yet.
// Priority mirrors makeDecision()'s own WAIT/WATCH branches (stockAnalysis.js)
// plus two additions this fix introduces: an earnings-unverified soft caution
// (UNKNOWN, or ESTIMATED inside the widened danger window — see
// earningsBlocksBuy in getVerdict) and an Alligator-not-yet-EATING_UP
// confirmation gate — makeDecision doesn't check Alligator phase for its BUY
// condition, so without this a strong setup could read BUY_NOW before the
// trend is actually confirmed.
function reasonForWatch(r, analysis, { earningsBlocksBuy, alligatorNotConfirmed }) {
  const ind = analysis.indicators
  if (earningsBlocksBuy) {
    if (r.earningsSource === 'ESTIMATED') return `Looks ready, but earnings is only an estimate (~${r.earningsDate ?? '?'}) inside the danger window — verify before buying.`
    return 'Looks ready, but the earnings date is unavailable — verify before buying.'
  }
  if (alligatorNotConfirmed) return "Strong setup, but the trend isn't fully confirmed yet — wait for it to turn up."
  if (ind.rsi.status === 'FAIL' && r.rsiValue > 72) return "Good setup, but it's overbought right now — wait for it to cool off."
  if (ind.volume.status === 'FAIL') return 'Good setup, but volume on the move is too light — wait for it.'
  if (r.pctFromHigh != null && r.pctFromHigh > 7) return "It's already run past the high — wait for a pullback."
  if (r.signalType === 'APPROACHING') return "Strong stock, hasn't reached the pivot yet."
  if (r.signalType === 'WATCH') return 'Close to the pivot with strong relative strength — not breaking out yet.'
  if (r.grade === 'B') return "Solid setup, just hasn't earned a high enough grade yet."
  if (r.tradePlan != null && r.tradePlan.viable === false) return `Good setup, but ${r.tradePlan.reason.toLowerCase()} — wait and reassess.`
  if (r.ret1m != null && r.ret1m > 35) return "It's run up too far, too fast — let it cool off before chasing."
  return "Good setup, but at least one confirmation hasn't triggered yet."
}

// `analysis` is analyzeStock(r, portfolioOptions)'s output. Pure function,
// no side effects.
export function getVerdict(r, analysis) {
  const action = analysis.decision.action
  const weaknessKey = structuralWeakness(r)
  // BUY_NOW requires a verified-clear earnings date: UNKNOWN (no data at
  // all) or ESTIMATED still inside the widened danger window can't clear it
  // — only a CONFIRMED date, or an ESTIMATED one comfortably outside the
  // widened window (a "soft clear"), can.
  const earningsDangerDays = THRESHOLDS.earningsBufferDays + THRESHOLDS.earningsEstimatedPadDays
  const earningsBlocksBuy = r.earningsSource === 'UNKNOWN' || r.earningsSource == null
    || (r.earningsSource === 'ESTIMATED' && (r.earningsDaysAway == null || r.earningsDaysAway <= earningsDangerDays))
  const alligatorNotConfirmed = r.alligatorPhase !== 'EATING_UP'

  let verdict
  if (weaknessKey) {
    verdict = 'AVOID_SELL'
  } else if (action === 'BUY' && !earningsBlocksBuy && !alligatorNotConfirmed) {
    verdict = 'BUY_NOW'
  } else {
    verdict = 'WATCH'
  }

  // Always "Avoid," never "Sell" — this screener evaluates candidates you
  // might buy, not positions you're already holding (Open Positions
  // tracking was removed), so "Sell" would be a confusing label to show
  // next to a stock you've never bought. A real held-position "Sell" only
  // makes sense once position-aware tracking exists again.
  const headline = verdict === 'BUY_NOW'
    ? 'Buy Now'
    : verdict === 'WATCH'
      ? 'Watch — not yet'
      : 'Avoid'

  const reason = verdict === 'BUY_NOW'
    ? 'Top-grade setup breaking out on strong, confirmed volume.'
    : verdict === 'WATCH'
      ? reasonForWatch(r, analysis, { earningsBlocksBuy, alligatorNotConfirmed: action === 'BUY' && alligatorNotConfirmed })
      : reasonForAvoidSell(r, weaknessKey)

  return {
    verdict,
    tier: VERDICT_TIER[verdict],
    headline,
    reason,
    evidence: buildEvidence(r, analysis),
  }
}

// Buckets every result into exactly one of buyNow/watch/avoidSell by running
// analyzeStock() + getVerdict() once per result — the Quick Lists dashboard's
// data source. Every visible result lands in exactly one chip, no silent
// drops (see verdict.test.js's bucketing regression guard).
export function bucketResultsByVerdict(results, portfolioOptions) {
  const buckets = { buyNow: [], watch: [], avoidSell: [] }

  for (const r of results) {
    const a = analyzeStock(r, portfolioOptions)
    const verdict = getVerdict(r, a)
    const key = verdict.verdict === 'BUY_NOW' ? 'buyNow' : verdict.verdict === 'WATCH' ? 'watch' : 'avoidSell'
    buckets[key].push({ r, a, verdict })
  }

  return buckets
}
