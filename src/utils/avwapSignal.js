// AVWAP Strategy Intelligence — turns the multi-anchor AVWAP numbers from
// avwap.js (plus sweepDetector.js's read of the same bars) into one
// actionable signal with a confidence score, a plain-English reason, and
// specific entry/stop/target levels. Pure function of data already
// computed — no new fetch, no new API cost. Logic mirrors a standard
// 52-week-high breakout playbook: every AVWAP anchor still below price
// means every wave of buyers since that point is profitable (no forced
// selling pressure); a sweep below an anchor that reclaims same-session
// clears out the weak hands without breaking the thesis — historically the
// highest-probability re-entry. A breach that doesn't reclaim within a few
// sessions is no longer a sweep, it's a breakdown.
//
// volumeProfile.js's analysis (optional `vp`) layers on top as context
// rather than its own scenarios: a smarter HVN-based stop in place of an
// arbitrary percentage, a confidence nudge when an AVWAP anchor lines up
// with a high-volume node, and a note when an open low-volume gap sits
// between price and the 52-week high.

export const SIGNAL = {
  SWEEP_RECLAIM: 'SWEEP_RECLAIM',
  STRONG_BUY: 'STRONG_BUY',
  BUY_ZONE: 'BUY_ZONE',
  HOLD: 'HOLD',
  CAUTION: 'CAUTION',
  SWEEP_IN_PROGRESS: 'SWEEP_IN_PROGRESS',
  EXIT: 'EXIT',
  NO_SIGNAL: 'NO_SIGNAL',
}

export const SIGNAL_CONFIG = {
  SWEEP_RECLAIM: { color: '#22c55e', bg: 'rgba(6, 182, 212, 0.10)', icon: '⚡✓', label: 'SWEEP + RECLAIM' },
  STRONG_BUY: { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.08)', icon: '⬆⬆', label: 'STRONG BUY' },
  BUY_ZONE: { color: '#22c55e', bg: 'transparent', icon: '⬆', label: 'BUY ZONE' },
  HOLD: { color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.08)', icon: '━', label: 'HOLD' },
  CAUTION: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', icon: '⚠', label: 'CAUTION' },
  SWEEP_IN_PROGRESS: { color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.08)', icon: '⚡', label: 'SWEEP IN PROGRESS' },
  EXIT: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', icon: '⬇', label: 'EXIT' },
  NO_SIGNAL: { color: '#6b6b80', bg: 'transparent', icon: '—', label: 'NO SIGNAL' },
}

const BULLISH_SIGNALS = ['SWEEP_RECLAIM', 'STRONG_BUY', 'BUY_ZONE', 'HOLD']
const SLOPE_ARROW = { rising: '↗', flat: '→', falling: '↘' }

function byKey(anchors) {
  return Object.fromEntries(anchors.map((a) => [a.key, a]))
}

// How many trailing sessions have closed below the 52W-high AVWAP, read
// straight from the chart series (no bars re-walk needed).
function consecutiveDaysBelow(analysis, anchorKey) {
  let count = 0
  for (let i = analysis.chartData.length - 1; i >= 0; i--) {
    const row = analysis.chartData[i]
    const av = row[anchorKey]
    if (av == null) break
    if (row.close < av) count++
    else break
  }
  return count
}

function blank(signal, confidence, reason, action, stackStatus, levels) {
  return {
    signal, confidence, reason, action,
    entryLow: null, entryHigh: null, entryPrice: null, stopPrice: null,
    target1: null, riskRewardRatio: null, sweepGrade: null,
    stackStatus, levels,
  }
}

// Layers Volume Profile context onto a finished scenario result: prefers a
// stop just below the nearest high-volume node over the scenario's
// arbitrary percentage-based one, nudges confidence up when an AVWAP
// anchor lines up with an HVN (double confirmation), and notes any
// low-volume "open air" between price and the 52-week high.
function applyVolumeProfileContext(result, vp, currentPrice) {
  if (!vp) return result

  let { stopPrice, confidence, reason, action } = result

  if (stopPrice != null && vp.hvns?.length) {
    const support = vp.hvns.filter((h) => h.price < currentPrice && h.price > stopPrice * 0.95)
    if (support.length > 0) {
      const best = support.reduce((a, b) => (b.price > a.price ? b : a))
      if (best.price * 0.995 !== stopPrice) {
        stopPrice = best.price * 0.995
        action = `${action} Stop adjusted to just below the nearest high-volume node ($${best.price.toFixed(2)}) — real volume support, not an arbitrary percentage.`
      }
    }
  }

  const confluence = vp.confluences?.[0] ?? null
  if (confluence) {
    confidence = Math.min(confidence + 4, 100)
    reason = `${reason} AVWAP from the ${confluence.anchorLabel.replace('From ', '').toLowerCase()} lines up with a high-volume node near $${confluence.hvnPrice.toFixed(2)} — double confirmation that level matters.`
  }

  const bullish = BULLISH_SIGNALS.includes(result.signal)
  if (bullish && vp.pocTrend === 'rising') {
    reason = `${reason} The volume-weighted point of control has been migrating higher over the past month — consensus is shifting bullish ahead of the move.`
  }

  if (bullish && vp.accelerationZones?.length > 0) {
    const zone = vp.accelerationZones[0]
    action = `${action} There's a low-volume gap near $${zone.price.toFixed(2)} between here and the 52-week high — expect price to accelerate through that zone once it triggers, since there's little volume there to absorb the move.`
  }

  return { ...result, stopPrice, confidence, reason, action, vpConfluence: confluence }
}

// `analysis` is buildAvwapAnalysis()'s return value. `avgVolume`/`volumeToday`
// nudge confidence only. `sweep` is sweepDetector.js's detectSweep() result
// (optional) — when present, sweep scenarios take priority over the plain
// AVWAP-stack scenarios, matching a standard sweep-and-reclaim playbook.
// `vp` is volumeProfile.js's buildVolumeProfileAnalysis() result (optional).
export function evaluateAvwapSignal(analysis, { avgVolume = null, volumeToday = null, sweep = null, vp = null } = {}) {
  const { currentPrice, high52w, anchors } = analysis
  const anchorsByKey = byKey(anchors)
  const high = anchorsByKey.from_52w_high
  const low = anchorsByKey.from_recent_low
  const yearStart = anchorsByKey.from_year_start

  const finish = (result) => applyVolumeProfileContext(result, vp, currentPrice)

  if (!high) {
    return finish(blank(
      SIGNAL.NO_SIGNAL, 30,
      'Not enough price history to anchor AVWAP from the 52-week high.',
      'Stay on sidelines. Add to watchlist and monitor.',
      'MIXED', anchors
    ))
  }

  const coreAnchors = [high, low, yearStart].filter(Boolean)
  const aboveCount = coreAnchors.filter((a) => currentPrice > a.value).length
  const total = coreAnchors.length
  const stackStatus = aboveCount === total && total >= 3 ? 'BULLISH_STACK' : aboveCount === 0 ? 'BEARISH_STACK' : 'MIXED'

  const pctFromHigh = ((currentPrice - high52w) / high52w) * 100
  const relVol = avgVolume ? (volumeToday ?? 0) / avgVolume : 1
  const levels = [...coreAnchors].sort((a, b) => a.value - b.value)
  const pctAbove = (level) => ((currentPrice - level.value) / level.value) * 100

  // PRIORITY 1: sweep below the 52W-high AVWAP that has since reclaimed —
  // the highest-probability entry in this playbook (stops triggered, then
  // real buyers stepped back in above the level).
  if (sweep?.status === 'reclaimed' && sweep.event && ['A', 'B'].includes(sweep.event.grade) && currentPrice > high.value) {
    const { sweepLow, depthPct, grade } = sweep.event
    const stopPrice = sweepLow * 0.995
    const target1 = high52w
    const risk = currentPrice - stopPrice
    const rr = risk > 0 ? (target1 - currentPrice) / risk : null
    return finish({
      signal: SIGNAL.SWEEP_RECLAIM,
      confidence: Math.min(82 + Math.round(relVol * 3) + (grade === 'A' ? 5 : 0), 98),
      reason: `Price swept ${depthPct.toFixed(1)}% below AVWAP from the 52-week high, triggering stop losses, then reclaimed above it — a grade ${grade} sweep. Weak hands are cleared out; institutions absorbed the liquidated shares. This is the highest-probability entry for a 52-week-high breakout.`,
      action: `Enter at $${currentPrice.toFixed(2)} (above the reclaimed AVWAP). Stop below $${stopPrice.toFixed(2)} (below the sweep low). Target 1: $${target1.toFixed(2)} (52-week-high retest). Target 2: trail above AVWAP from the sweep date.`,
      entryLow: high.value, entryHigh: high.value * 1.01, entryPrice: currentPrice, stopPrice,
      target1, riskRewardRatio: rr, sweepGrade: grade,
      stackStatus, levels,
    })
  }

  // PRIORITY 2: sweep currently underway, not yet reclaimed — wait, don't
  // catch the falling knife.
  if (sweep?.status === 'sweeping' && pctAbove(high) > -3.0) {
    return finish(blank(
      SIGNAL.SWEEP_IN_PROGRESS, 40,
      `Price is ${Math.abs(pctAbove(high)).toFixed(1)}% below AVWAP from the 52-week high. Stops are being triggered — this could be a liquidity sweep. Do not buy yet. Wait for price to reclaim above $${high.value.toFixed(2)}; if it reclaims on strong volume, that's the entry.`,
      `WAIT. Set an alert for price crossing back above $${high.value.toFixed(2)}. Don't try to catch the falling knife. If price drops beyond 3% below AVWAP, it's a breakdown, not a sweep — walk away.`,
      stackStatus, levels
    ))
  }

  // PRIORITY 3: pulling back to a rising AVWAP from the recent low, inside
  // an otherwise fully-bullish stack — the textbook re-entry.
  if (
    stackStatus === 'BULLISH_STACK' &&
    currentPrice > high.value &&
    low && pctAbove(low) > 0 && pctAbove(low) < 3 &&
    low.slope === 'rising'
  ) {
    const stopPrice = high.value * 0.99
    const target1 = high52w
    const risk = currentPrice - stopPrice
    const rr = risk > 0 ? (target1 - currentPrice) / risk : null
    return finish({
      signal: SIGNAL.STRONG_BUY,
      confidence: Math.min(85 + Math.round(relVol * 5), 100),
      reason: `Price is pulling back to a rising AVWAP from the recent low while every anchor is stacked bullishly. Breakout buyers from the 52-week high are still profitable (price ${Math.abs(pctAbove(high)).toFixed(1)}% above their average cost) — this is the textbook re-entry zone for a 52-week-high breakout.`,
      action: `Enter near $${low.value.toFixed(2)} (AVWAP from recent low). Stop below $${stopPrice.toFixed(2)} (below AVWAP from the 52W high — if this breaks, the breakout thesis is dead). Target 1: $${target1.toFixed(2)} (52-week-high retest).`,
      entryLow: low.value * 0.995, entryHigh: low.value * 1.005, entryPrice: low.value, stopPrice,
      target1, riskRewardRatio: rr, sweepGrade: null,
      stackStatus, levels,
    })
  }

  // PRIORITY 4: testing the 52W-high AVWAP as support, not yet broken.
  if (currentPrice > high.value && pctAbove(high) < 2 && aboveCount >= total - 1) {
    const stopPrice = high.value * 0.985
    return finish({
      signal: SIGNAL.BUY_ZONE,
      confidence: 65 + Math.round(relVol * 3),
      reason: `Price is testing AVWAP from the 52-week high ($${high.value.toFixed(2)}) as support. If this level holds, breakout buyers are defending their positions — watch for a bounce on rising volume to confirm.`,
      action: `Potential entry if price bounces off $${high.value.toFixed(2)} with volume. Wait for a green candle close above this level before entering. Stop below $${stopPrice.toFixed(2)}.`,
      entryLow: high.value, entryHigh: high.value * 1.01, entryPrice: high.value, stopPrice,
      target1: high52w, riskRewardRatio: null, sweepGrade: null,
      stackStatus, levels,
    })
  }

  // PRIORITY 5: above every anchor, trend intact — manage, don't chase.
  if (stackStatus === 'BULLISH_STACK' && pctFromHigh >= -3) {
    const trail = levels[levels.length - 1]
    const stopPrice = trail.value * 0.99
    return finish({
      ...blank(
        SIGNAL.HOLD,
        Math.min(70 + aboveCount * 5, 100),
        'Every AVWAP level is stacked bullishly below price — every wave of buyers since the breakout is in profit, so there\'s no forced selling pressure. The trend is intact.',
        `Hold position. Trail stop to $${stopPrice.toFixed(2)} (just below AVWAP from ${trail.label.replace('From ', '')}, the nearest support). Only add if price pulls back to an AVWAP and bounces.`,
        stackStatus, levels
      ),
      stopPrice,
    })
  }

  // PRIORITY 6: lost the recent-low anchor but the 52W-high anchor still
  // holds — thesis bruised, not dead.
  if (stackStatus === 'MIXED' && low && currentPrice < low.value && currentPrice > high.value) {
    const stopPrice = high.value * 0.99
    return finish({
      ...blank(
        SIGNAL.CAUTION, 50,
        `Price broke below AVWAP from the recent low ($${low.value.toFixed(2)}) — recent dip buyers are now underwater and may sell. Still above AVWAP from the 52-week high, so the breakout thesis isn't dead yet, but the AVWAPs are converging toward price, meaning buyers are getting squeezed.`,
        `Tighten stop to $${stopPrice.toFixed(2)} (below the 52W AVWAP). Do not add to the position. If price reclaims $${low.value.toFixed(2)}, the thesis recovers; if price breaks $${high.value.toFixed(2)}, exit immediately.`,
        stackStatus, levels
      ),
      stopPrice,
    })
  }

  // PRIORITY 7: below the 52W-high AVWAP — graduated severity. A single
  // shallow-breach day could just be a sweep forming; only a deeper or
  // multi-day breach calls it a failed breakout. This avoids exiting on a
  // one-day shake-out that reclaims the next session.
  if (currentPrice < high.value) {
    const daysBelow = consecutiveDaysBelow(analysis, 'from_52w_high')
    const depth = Math.abs(pctAbove(high))

    if (daysBelow >= 2 || depth > 1.5) {
      return finish(blank(
        SIGNAL.EXIT, 82,
        `Price is ${depth.toFixed(1)}% below AVWAP from the 52-week high for ${daysBelow} day(s) — breakout buyers are underwater and will be selling to cut losses. The breakout has failed; supply will overwhelm demand here.${stackStatus === 'BEARISH_STACK' ? ' Multiple AVWAP levels are broken.' : ''}`,
        `Exit any existing position. Do not buy. Re-evaluate only if price reclaims $${high.value.toFixed(2)} on strong volume (a sweep-and-reclaim setup).`,
        stackStatus, levels
      ))
    }
    return finish(blank(
      SIGNAL.CAUTION, 50,
      `Price is ${depth.toFixed(1)}% below AVWAP from the 52-week high — a single-day breach. Could be the start of a liquidity sweep rather than a real breakdown.`,
      `Don't panic-sell. Give it 1-2 sessions. If price reclaims $${high.value.toFixed(2)}, that's a sweep-and-reclaim entry. If it stays below or breaks further, exit.`,
      stackStatus, levels
    ))
  }

  return finish(blank(
    SIGNAL.NO_SIGNAL, 30,
    'AVWAP positioning is ambiguous right now — no clean confluence either way.',
    'Stay on sidelines. Add to watchlist and monitor.',
    stackStatus, levels
  ))
}

export function slopeArrow(slope) {
  return SLOPE_ARROW[slope] ?? '→'
}
