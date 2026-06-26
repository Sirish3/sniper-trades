// Deterministic "Show Analysis" engine — every field below is derived from
// data a WeekHighScreener scan result already has in memory (indicators.js,
// positionPlan.js, sectorRegime.js). No fetch, no Claude call: this is a
// pure function over an already-computed object, so it runs in <1ms and
// never goes stale relative to whatever's on screen.
//
// The canonical grade/signal/trade-plan stay single-sourced from
// weekHighScreener.js (r.grade, r.signalType, r.tradePlan) — this module
// only adds presentation/decision layers on top (criteria breakdown,
// per-indicator PASS/WARN/FAIL, flags, decision tree, scenarios, thesis,
// "if already long"), it never recomputes a different grade or signal than
// what's already shown on the result card.

import { selectStop, sizePosition, buildTrimPlan, TIME_STOP_DAYS, ATR_STOP_MULT } from './positionPlan'
import { DEFAULT_PORTFOLIO_SIZE } from './swingPlan'
import { THRESHOLDS } from './screenerThresholds'

const EARNINGS_BLOCK_DAYS = 7

// FIX 1: volume MUST/STRONG checks read the best day in the recent window
// (volRatioMaxN), not just today's single bar, plus a dual-readout label so
// the card shows both numbers — see weekHighScreener.js's
// maxVolumeRatioOverWindow.
function dualVolumeLabel(r) {
  if (r.volRatio20 == null) return 'unknown'
  const todayTxt = `today ${r.volRatio20.toFixed(2)}x`
  if (r.volRatioMaxN == null) return todayTxt
  const dayTxt = r.volRatioMaxNDaysAgo ? `${r.volRatioMaxNDaysAgo}d ago` : 'today'
  return `${todayTxt} · best ${THRESHOLDS.volumeBreakoutWindowDays}d ${r.volRatioMaxN.toFixed(2)}x (${dayTxt})`
}

function round(value, decimals = 2) {
  if (value == null || !Number.isFinite(value)) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function dataMissing(label = 'Data unavailable for this indicator') {
  return { status: 'DATA_MISSING', label }
}

// ── grade breakdown (MUST / STRONG / NICE criteria, explanatory only —
// finalGrade is always r.grade, never re-derived here) ──────────────────────
function gradeBreakdown(r) {
  // An ESTIMATED earnings date carries ~±2-week error, so this MUST widens
  // for it — an estimate can never produce a confident pass this close to
  // the buffer. UNKNOWN (no date at all) is never treated as a failure here.
  const earningsPad = r.earningsSource === 'ESTIMATED' ? THRESHOLDS.earningsEstimatedPadDays : 0
  const earningsBlockDays = EARNINGS_BLOCK_DAYS + earningsPad
  const earningsOk = r.earningsDaysAway == null || r.earningsDaysAway > earningsBlockDays
  const earningsValue = r.earningsDaysAway != null
    ? `${r.earningsDaysAway}d away${r.earningsSource === 'ESTIMATED' ? ' (estimated)' : ''}`
    : r.earningsSource === 'UNKNOWN' ? 'unavailable' : 'unknown'
  const sectorOk = r.sectorStatus !== 'COLD' || (r.rsRank != null && r.rsRank > 90)
  const volForCheck = r.volRatioMaxN ?? r.volRatio20
  const volLabel = dualVolumeLabel(r)

  const must = [
    { name: 'Earnings buffer', result: earningsOk ? 'PASS' : 'FAIL', value: earningsValue, threshold: `> ${earningsBlockDays} days`, weight: 'MUST', detail: earningsOk ? 'No near-term earnings gap risk' : 'Earnings too close — gap risk' },
    { name: 'Volume floor', result: volForCheck == null ? 'WARN' : volForCheck >= THRESHOLDS.volumeMustFloor ? 'PASS' : 'FAIL', value: volLabel, threshold: `>= ${THRESHOLDS.volumeMustFloor}x (best ${THRESHOLDS.volumeBreakoutWindowDays}d)`, weight: 'MUST', detail: 'Minimum participation for any setup' },
    { name: 'Proximity to pivot', result: r.pctFromHigh == null ? 'WARN' : r.pctFromHigh >= -10 ? 'PASS' : 'FAIL', value: r.pctFromHigh != null ? `${r.pctFromHigh.toFixed(1)}%` : 'unknown', threshold: '>= -10%', weight: 'MUST', detail: 'Too far from the 52-week high is a different trade' },
    { name: 'Sector not COLD', result: sectorOk ? 'PASS' : 'FAIL', value: r.sectorStatus ?? 'unknown', threshold: 'not COLD (or RS rank > 90)', weight: 'MUST', detail: sectorOk ? 'Sector backdrop acceptable' : 'Sector is COLD and stock isn\'t strong enough to ignore it' },
  ]

  const strong = [
    { name: 'Strong volume', result: volForCheck == null ? 'WARN' : volForCheck >= THRESHOLDS.volumeStrongFloor ? 'PASS' : 'FAIL', value: volLabel, threshold: `>= ${THRESHOLDS.volumeStrongFloor}x (best ${THRESHOLDS.volumeBreakoutWindowDays}d)`, weight: 'STRONG', detail: 'Institutional-size participation' },
    { name: 'RSI in zone', result: r.rsiValue == null ? 'WARN' : r.rsiValue >= 45 && r.rsiValue <= 72 ? 'PASS' : 'FAIL', value: r.rsiValue != null ? r.rsiValue.toFixed(1) : 'unknown', threshold: '45-72', weight: 'STRONG', detail: 'Healthy momentum, not overbought' },
    { name: 'EMA stack aligned', result: r.emaFullStack ? 'PASS' : 'FAIL', value: r.emaFullStack ? '10>20>50' : 'not aligned', threshold: '10>20>50', weight: 'STRONG', detail: 'Trend confirmed across short/medium term' },
    { name: 'ADX trending', result: r.adxValue == null ? 'WARN' : r.adxValue > 25 ? 'PASS' : 'FAIL', value: r.adxValue != null ? r.adxValue.toFixed(1) : 'unknown', threshold: '> 25', weight: 'STRONG', detail: 'Directional trend, not chop' },
    { name: 'RS rank strong', result: r.rsRank == null ? 'WARN' : r.rsRank >= 70 ? 'PASS' : 'FAIL', value: r.rsRank ?? 'unknown', threshold: '>= 70', weight: 'STRONG', detail: 'Outperforming most of the scanned universe' },
    { name: 'Near the high', result: r.pctFromHigh == null ? 'WARN' : r.pctFromHigh >= -5 ? 'PASS' : 'FAIL', value: r.pctFromHigh != null ? `${r.pctFromHigh.toFixed(1)}%` : 'unknown', threshold: '>= -5%', weight: 'STRONG', detail: 'Close enough to the pivot to act' },
    { name: 'Not extended', result: r.ret1m == null ? 'WARN' : r.ret1m < 25 ? 'PASS' : 'FAIL', value: r.ret1m != null ? `${r.ret1m.toFixed(1)}%` : 'unknown', threshold: '< 25% (1m)', weight: 'STRONG', detail: '1-month move hasn\'t run too far yet' },
    { name: 'AVWAP supportive', result: r.avwapFromHigh == null ? 'WARN' : r.avwapFromHigh.signal === 'BULLISH' ? 'PASS' : 'FAIL', value: r.avwapFromHigh != null ? `${r.avwapFromHigh.signal} ${r.avwapFromHigh.vsPricePct >= 0 ? '+' : ''}${r.avwapFromHigh.vsPricePct.toFixed(1)}%` : 'unknown', threshold: 'price > AVWAP from 52W high', weight: 'STRONG', detail: 'Buyers since the 52-week high are net profitable — real support under the move' },
  ]

  const nice = [
    { name: 'Alligator eating up', result: r.alligatorPhase === 'EATING_UP' ? 'PASS' : 'WARN', value: r.alligatorPhase, threshold: 'EATING_UP', weight: 'NICE', detail: 'Trend confirmed at all timeframes' },
    { name: 'MACD momentum', result: r.macdHistDirection === 'RISING' ? 'PASS' : 'WARN', value: r.macdHistDirection ?? 'unknown', threshold: 'RISING', weight: 'NICE', detail: 'Momentum accelerating' },
    { name: 'Sector HOT', result: r.sectorStatus === 'HOT' ? 'PASS' : 'WARN', value: r.sectorStatus ?? 'unknown', threshold: 'HOT', weight: 'NICE', detail: 'Sector tailwind' },
    { name: 'ADX strong', result: r.adxValue != null && r.adxValue > 30 ? 'PASS' : 'WARN', value: r.adxValue != null ? r.adxValue.toFixed(1) : 'unknown', threshold: '> 30', weight: 'NICE', detail: 'Trend strength well above borderline' },
    { name: 'RS rank elite', result: r.rsRank != null && r.rsRank >= 85 ? 'PASS' : 'WARN', value: r.rsRank ?? 'unknown', threshold: '>= 85', weight: 'NICE', detail: 'Top-tier relative strength' },
    { name: 'Earnings well clear', result: r.earningsDaysAway == null || r.earningsDaysAway > 14 ? 'PASS' : 'WARN', value: earningsValue, threshold: '> 14 days', weight: 'NICE', detail: 'Comfortable earnings buffer' },
  ]

  const anyMustFailing = must.some((c) => c.result === 'FAIL')
  // strongPassCount/strongTotal feed makeDecision()'s confidence calc below
  // — keep computing them even though the panel no longer displays a score.
  // The "X/10 points" score was removed from display (not computed here
  // either) because its thresholds were looser than gradeWeekHighSetup()'s
  // canonical grade, making a B-grade stock look "almost A" — see the
  // verdict-consolidation refactor. r.grade (passed through as finalGrade)
  // remains the only source of truth for grade.
  const strongPassCount = strong.filter((c) => c.result === 'PASS').length

  return {
    finalGrade: r.grade,
    anyMustFailing,
    strongPassCount,
    strongTotal: strong.length,
    criteria: [...must, ...strong, ...nice],
  }
}

// ── per-indicator PASS/WARN/FAIL + plain-English label ──────────────────────
function analyseIndicators(r) {
  const indicators = {}

  if (r.rsiValue == null) {
    indicators.rsi = dataMissing('RSI unavailable')
  } else {
    const rsi = r.rsiValue
    let status, label
    if (rsi > 78) { status = 'FAIL'; label = 'Extremely overbought — do not chase' }
    else if (rsi > 72) { status = 'WARN'; label = 'Overbought — risk of short-term pullback' }
    else if (rsi >= 65) { status = 'PASS'; label = 'Strong momentum — approaching overbought' }
    else if (rsi >= 45) { status = 'PASS'; label = 'Healthy momentum — room to run' }
    else if (rsi >= 38) { status = 'WARN'; label = 'Momentum fading — wait for recovery' }
    else { status = 'FAIL'; label = 'No momentum — possible downtrend' }
    indicators.rsi = { value: round(rsi, 1), status, label, rangeLow: 45, rangeHigh: 72 }
  }

  if (r.volRatio20 == null) {
    indicators.volume = dataMissing('Volume ratio unavailable')
  } else {
    // FIX 1: status reads the best day in the recent window, not just
    // today's bar — `today`/`maxN`/`maxNDaysAgo` carry both numbers for
    // display (the dual readout), `value` is the one actually evaluated.
    const v = r.volRatioMaxN ?? r.volRatio20
    let status, label
    if (v >= 2.0) { status = 'PASS'; label = 'Strong institutional buying confirmed' }
    else if (v >= 1.5) { status = 'PASS'; label = 'Above average — institutions participating' }
    else if (v >= 1.2) { status = 'WARN'; label = 'Marginal — watch for improvement' }
    else if (v >= 0.9) { status = 'FAIL'; label = 'Below average — breakout not confirmed' }
    else { status = 'FAIL'; label = 'Volume drying up — potential retest forming' }
    indicators.volume = {
      value: round(v, 2),
      today: round(r.volRatio20, 2),
      maxN: r.volRatioMaxN != null ? round(r.volRatioMaxN, 2) : null,
      maxNDaysAgo: r.volRatioMaxNDaysAgo ?? null,
      status, label, threshold: 1.5,
    }
  }

  // MACD has two genuinely different aspects, shown as two separate rows so
  // they never read as contradicting each other (the FIX 1 bug: a card
  // could show "MACD RISING" and "MACD BEARISH" under the same label with
  // no way to tell those were different readings). macdHistDirection
  // (momentum) is the entry-relevant signal that gates makeDecision/
  // gradeBreakdown above; macdPosture (trend) is lagging context only —
  // capped at WARN, never FAIL, so a bearish posture never reads as a
  // reason to avoid entry on its own.
  if (r.macdHistDirection == null) {
    indicators.macdMomentum = dataMissing('MACD unavailable')
  } else {
    const direction = r.macdHistDirection
    const status = direction === 'RISING' ? 'PASS' : 'WARN'
    const label = direction === 'RISING' ? 'Histogram rising — momentum accelerating'
      : direction === 'FALLING' ? 'Histogram falling — momentum fading'
        : 'Histogram flat — momentum stalling'
    indicators.macdMomentum = { value: direction, status, label }
  }

  if (r.macdPosture == null) {
    indicators.macdTrend = dataMissing('MACD unavailable')
  } else {
    const bullish = r.macdPosture === 'BULLISH'
    const status = bullish ? 'PASS' : 'WARN'
    const label = bullish ? 'Bullish — line above signal, trend context supportive' : 'Bearish — line below signal (lagging context only, does not block entry)'
    indicators.macdTrend = { value: r.macdPosture, status, label }
  }

  if (r.adxValue == null) {
    indicators.adx = dataMissing('ADX unavailable')
  } else {
    const adx = r.adxValue
    const status = adx >= 25 ? 'PASS' : adx >= 20 ? 'WARN' : 'FAIL'
    const label = adx > 40 ? 'Very strong trend' : adx > 25 ? 'Directional trend confirmed' : adx >= 20 ? 'Borderline — trend not yet confirmed' : 'No trend / choppy'
    indicators.adx = { value: round(adx, 1), status, label, threshold: 25 }
  }

  if (r.ema10 == null || r.ema21 == null || r.ema50 == null) {
    indicators.emaStack = dataMissing('EMA stack unavailable')
  } else {
    const aligned = r.ema10 > r.ema21 && r.ema21 > r.ema50
    const partial = r.ema10 > r.ema21 || r.ema21 > r.ema50
    const status = aligned ? 'PASS' : partial ? 'WARN' : 'FAIL'
    const label = aligned ? 'Full bull stack intact' : partial ? 'Partially aligned — not fully confirmed' : 'Not aligned — no clean trend'
    const pctAbove21 = r.ema21 ? round(((r.price - r.ema21) / r.ema21) * 100, 1) : null
    indicators.emaStack = { aligned, order: '10>21>50', status, label, pctAbove21 }
  }

  if (r.alligatorPhase == null) {
    indicators.alligator = dataMissing('Alligator phase unavailable')
  } else {
    const phase = r.alligatorPhase
    const map = {
      EATING_UP: ['PASS', 'Alligator eating — trend fully confirmed'],
      WAKING: ['WARN', 'Alligator waking — watch for confirmation'],
      SLEEPING: ['FAIL', 'Alligator sleeping — no trend, stay out'],
      EATING_DOWN: ['FAIL', 'Downtrend confirmed'],
    }
    const [status, label] = map[phase] ?? ['WARN', 'Unknown phase']
    indicators.alligator = { phase, status, label }
  }

  if (r.rsRank == null) {
    indicators.rsRank = dataMissing('RS rank unavailable')
  } else {
    const rank = r.rsRank
    const status = rank >= 70 ? 'PASS' : rank >= 50 ? 'WARN' : 'FAIL'
    const label = rank >= 99 ? 'Top of the entire market' : rank >= 95 ? 'Top 5%' : rank >= 90 ? 'Top 10%' : rank >= 70 ? 'Above average strength' : rank >= 50 ? 'Middle of the pack' : 'Weak relative strength'
    indicators.rsRank = { value: rank, status, label, threshold: 70 }
  }

  if (r.pctFromHigh == null) {
    indicators.pctFromHigh = dataMissing('52-week high distance unavailable')
  } else {
    const pct = r.pctFromHigh
    const status = pct >= -5 ? 'PASS' : pct >= -10 ? 'WARN' : 'FAIL'
    const label = pct > 0 ? 'New 52-week high — no overhead resistance' : pct >= -5 ? 'Right at the breakout door' : pct >= -10 ? 'Within striking distance' : 'Too far from the pivot'
    indicators.pctFromHigh = { value: round(pct, 2), status, label, threshold: -5.0 }
  }

  if (r.ret1m == null) {
    indicators.extension = dataMissing('Return data unavailable')
  } else {
    const ret1m = r.ret1m
    const status = ret1m < 15 ? 'PASS' : ret1m < 25 ? 'WARN' : 'FAIL'
    const extended = ret1m >= 25
    let label = status === 'PASS' ? '1-month move is reasonable' : status === 'WARN' ? '1-month move getting extended' : '1-month move is extended — chase risk'
    if (r.ret3m != null && r.ret3m > 100) label += `, 3-month move of ${r.ret3m.toFixed(0)}% is very large`
    indicators.extension = { ret1m: round(ret1m, 2), ret3m: round(r.ret3m, 2), extended, status, label }
  }

  if (r.earningsDaysAway == null) {
    const label = r.earningsSource === 'UNKNOWN' || r.earningsSource == null
      ? 'Earnings date unavailable — verify before entry'
      : 'Not checked yet — build a trade plan to fetch the earnings calendar'
    indicators.earnings = { status: 'DATA_MISSING', label, daysAway: null, source: r.earningsSource ?? 'UNKNOWN', date: null, threshold: 7 }
  } else {
    const days = r.earningsDaysAway
    // ESTIMATED dates carry ~±2-week error — widen the safe/getting-close
    // bands so an estimate can never read as a confident "Safe".
    const pad = r.earningsSource === 'ESTIMATED' ? THRESHOLDS.earningsEstimatedPadDays : 0
    const status = days > 14 + pad ? 'PASS' : days > 7 + pad ? 'WARN' : 'FAIL'
    const sourceTag = r.earningsSource === 'ESTIMATED' ? ' (estimated — verify)' : r.earningsSource === 'CONFIRMED' ? ' (confirmed)' : ''
    const label = status === 'PASS' ? `Safe — ${days} days to earnings${sourceTag}` : status === 'WARN' ? `Getting close — ${days} days to earnings${sourceTag}` : `Too close — ${days} days to earnings${sourceTag}, gap risk`
    indicators.earnings = { daysAway: days, status, label, source: r.earningsSource ?? 'UNKNOWN', date: r.earningsDate ?? null, threshold: 7 + pad }
  }

  if (r.avwapFromHigh == null) {
    indicators.avwap = dataMissing('AVWAP unavailable')
  } else {
    const { signal, vsPricePct } = r.avwapFromHigh
    const status = signal === 'BULLISH' ? 'PASS' : 'FAIL'
    const label = signal === 'BULLISH'
      ? 'Buyers since the 52W high are profitable — real support under the breakout'
      : 'Buyers since the 52W high are underwater — breakout lacks support, risk of fade'
    indicators.avwap = { value: `${signal} ${vsPricePct >= 0 ? '+' : ''}${vsPricePct.toFixed(1)}%`, status, label }
  }

  return indicators
}

// ── red/amber/green flag rollup from the indicators above ──────────────────
function extractFlags(r, indicators) {
  const red = []
  const amber = []
  const green = []

  if (indicators.volume.status === 'FAIL') {
    red.push(`Volume today ${indicators.volume.today ?? 'N/A'}x, best ${indicators.volume.maxN ?? indicators.volume.today ?? 'N/A'}x — below threshold for confirmed breakout`)
  }
  if (indicators.rsi.status === 'FAIL' && r.rsiValue > 72) red.push(`RSI ${r.rsiValue.toFixed(1)} extremely overbought — do not chase here`)
  if (indicators.alligator.status === 'FAIL' && r.alligatorPhase === 'EATING_DOWN') red.push('Alligator EATING_DOWN — downtrend confirmed, avoid longs')
  if (indicators.earnings.status === 'FAIL') {
    const tag = r.earningsSource === 'ESTIMATED' ? ' (estimated — verify)' : ''
    red.push(`Earnings in ${r.earningsDaysAway} days${tag} — gap risk too close to enter`)
  }

  if (r.ret3m != null && r.ret3m > 100) amber.push(`3-month return of ${r.ret3m.toFixed(0)}% is parabolic — check for exhaustion`)
  if (r.alligatorPhase === 'WAKING') amber.push('Alligator WAKING not EATING — trend not fully confirmed')
  if (indicators.adx.status === 'WARN') amber.push(`ADX ${r.adxValue?.toFixed(1) ?? '?'} borderline — trend not yet confirmed`)
  if (indicators.volume.status === 'WARN') amber.push(`Volume today ${indicators.volume.today ?? '?'}x, best ${indicators.volume.maxN ?? indicators.volume.today ?? '?'}x — marginal, watch for improvement`)
  if (r.sectorStatus === 'COLD') amber.push('Sector ETF is COLD — sector backdrop unsupportive')
  if (indicators.avwap?.status === 'FAIL') {
    amber.push(`AVWAP from 52W high is bearish (${r.avwapFromHigh.vsPricePct.toFixed(1)}%) — buyers since the high are underwater`)
  }

  if (r.rsRank != null && r.rsRank >= 90) green.push(`RS rank ${r.rsRank} — ${r.rsRank >= 99 ? 'strongest stock in market' : 'top tier relative strength'}`)
  if (indicators.rsi.status === 'PASS') green.push(`RSI ${r.rsiValue.toFixed(1)} — ${indicators.rsi.label.toLowerCase()}`)
  if (r.emaFullStack) green.push('EMA stack fully aligned bull stack')
  if (r.alligatorPhase === 'EATING_UP') green.push('Alligator eating up — trend confirmed at all timeframes')
  if (r.sectorStatus === 'HOT') green.push('Sector ETF is HOT — within 3% of its own 52-week high')
  if (indicators.avwap?.status === 'PASS') {
    green.push(`AVWAP from 52W high is bullish (+${r.avwapFromHigh.vsPricePct.toFixed(1)}%) — real support under the move`)
  }

  return { redFlags: red, amberFlags: amber, greenFlags: green }
}

// ── decision tree ───────────────────────────────────────────────────────────
function makeDecision(r, grade, indicators) {
  const action = (() => {
    if (r.signalType === 'SELL_STOP' || r.alligatorPhase === 'EATING_DOWN' || (r.rsiValue != null && r.rsiValue < 35)) return 'SELL'

    if (
      grade.finalGrade === 'C' ||
      // Only a CONFIRMED earnings date is a hard AVOID trigger — an
      // ESTIMATED date carries ~±2-week error and is handled as a softer
      // WAIT-style caution instead (via indicators.earnings.status above,
      // whose bands already widen for ESTIMATED — see analyseIndicators).
      (r.earningsSource === 'CONFIRMED' && r.earningsDaysAway != null && r.earningsDaysAway <= 6) ||
      (r.tradePlan != null && r.tradePlan.viable === false) ||
      (r.sectorStatus === 'COLD' && (r.rsRank == null || r.rsRank < 85)) ||
      (r.ret1m != null && r.ret1m > 35)
    ) return 'AVOID'

    if (
      (grade.finalGrade === 'A+' || grade.finalGrade === 'A') &&
      (r.signalType === 'BUY_BREAKOUT' || r.signalType === 'BUY_RETEST') &&
      indicators.volume.status !== 'FAIL' &&
      indicators.earnings.status !== 'FAIL' &&
      indicators.rsi.status !== 'FAIL' &&
      !grade.anyMustFailing
    ) return 'BUY'

    if (indicators.rsi.status === 'FAIL' && r.rsiValue > 72) return 'WAIT'
    if (indicators.volume.status === 'FAIL') return 'WAIT'
    if (r.pctFromHigh != null && r.pctFromHigh > 7) return 'WAIT'
    if (r.signalType === 'APPROACHING') return 'WAIT'
    if (r.signalType === 'WATCH') return 'WATCH'
    if (grade.finalGrade === 'B') return 'WAIT'

    return 'WAIT'
  })()

  // Visibility into the ADX-override RULE CHANGE (THRESHOLDS.adxConfirmsTrend,
  // weekHighScreener.js's evaluateTrendConfirmation) — when a BUY came from
  // that override rather than a normal Alligator EATING_UP confirmation,
  // say so explicitly so it's auditable during A/B testing, same purpose as
  // the r.trendConfirmedBy field itself.
  const buySummary = r.trendConfirmedBy === 'ADX_OVERRIDE'
    ? `Grade ${grade.finalGrade} ${r.signalType?.replace('_', ' ').toLowerCase() ?? 'setup'} — trend confirmed by strong ADX (${r.adxValue?.toFixed(1) ?? '?'}), Alligator still ${r.alligatorPhase?.toLowerCase() ?? 'unconfirmed'}.`
    : `Grade ${grade.finalGrade} ${r.signalType?.replace('_', ' ').toLowerCase() ?? 'setup'} with volume and momentum confirmed.`

  const summaryByAction = {
    BUY: buySummary,
    WAIT: 'Setup is close but at least one confirmation criterion hasn\'t triggered yet.',
    WATCH: 'Within range of the pivot with strong relative strength — not yet breaking out.',
    AVOID: 'One or more hard disqualifiers (grade, earnings, sector, or extension) rule this out right now.',
    SELL: 'Trend has turned down or momentum has broken — this is not a long setup.',
  }

  const reasons = []
  if (action === 'WAIT') {
    if (indicators.rsi.status === 'FAIL' && r.rsiValue > 72) reasons.push('Wait for RSI to cool to <72')
    if (indicators.volume.status === 'FAIL') reasons.push('Wait for volume confirmation >1.5x')
    if (r.signalType === 'APPROACHING') reasons.push('Not yet at the pivot')
    if (grade.finalGrade === 'B') reasons.push('Grade B — wait for stronger confirmation')
  }
  const summary = reasons.length > 0 ? reasons.join('; ') : summaryByAction[action]

  const confidence = grade.finalGrade === 'A+' && grade.strongPassCount === grade.strongTotal
    ? 'HIGH'
    : grade.finalGrade === 'A' && (grade.strongTotal - grade.strongPassCount) <= 2
      ? 'MEDIUM'
      : 'LOW'

  const urgency = action === 'BUY'
    ? (r.signalType === 'BUY_BREAKOUT' && indicators.volume.status === 'PASS' ? 'NOW' : 'TODAY')
    : action === 'WATCH'
      ? 'THIS_WEEK'
      : 'NO_RUSH'

  return { action, confidence, summary, urgency }
}

// ── scenarios (entry/stop/trim/sizing via positionPlan.js) ──────────────────
function buildScenario({ name, type, condition, entryPrice, probability, r, portfolioOptions }) {
  if (entryPrice == null) return { name, type, condition, probability, viable: false, reason: 'No entry price could be derived from available data' }

  const stop = selectStop({ price: entryPrice, low10Day: r.low10Day, ema21: r.ema21, baseLow: null, atr14: r.atr14 })
  if (!stop.viable) return { name, type, condition, triggerPrice: round(entryPrice), probability, viable: false, reason: stop.reason }

  const sizing = sizePosition({
    portfolioSize: portfolioOptions.portfolioSize, price: entryPrice, stopPrice: stop.stopPrice,
    grade: r.grade, riskEnvironment: portfolioOptions.riskEnvironment, openPositions: portfolioOptions.openPositions ?? [], sector: r.sector,
  })
  if (!sizing.viable) return { name, type, condition, triggerPrice: round(entryPrice), entry: round(entryPrice), stop: stop.stopPrice, stopMethod: stop.method, stopPct: stop.riskPct, probability, viable: false, reason: sizing.reason }

  const trimPlan = buildTrimPlan({ price: entryPrice, stopPrice: stop.stopPrice, shares: sizing.shares, atr14: r.atr14 })

  return {
    name, type, condition, probability, viable: true,
    triggerPrice: round(entryPrice),
    entry: round(entryPrice),
    stop: stop.stopPrice,
    stopMethod: stop.method,
    stopPct: stop.riskPct,
    trim1: trimPlan.trim1.price,
    trim1R: trimPlan.trim1.triggerR,
    trim2: trimPlan.trim2.price,
    trim2R: trimPlan.trim2.triggerR,
    timeStopDays: TIME_STOP_DAYS,
    shares: sizing.shares,
    position: sizing.positionValue,
    risk: sizing.riskAmount,
    riskPct: sizing.riskAmountPct,
  }
}

function buildScenarios(r, decision, portfolioOptions) {
  if (decision.action === 'SELL' || decision.action === 'AVOID') return []

  const breakoutEntry = r.tradePlan?.viable ? r.tradePlan.entryPrice : round((r.high52w ?? r.price) + 0.10)
  const pullbackEntry = r.ema21 ?? r.low10Day ?? null

  if (r.signalType === 'BUY_BREAKOUT') {
    return [
      buildScenario({ name: 'Primary entry', type: 'BREAKOUT', condition: `Close above 52W high ($${r.high52w?.toFixed(2) ?? '?'}) on volume >1.5x`, entryPrice: breakoutEntry, probability: 'MEDIUM', r, portfolioOptions }),
      buildScenario({ name: 'Retest entry (if breakout fails)', type: 'RETEST', condition: `Pullback toward $${pullbackEntry?.toFixed(2) ?? '?'} on low volume, then a green reversal`, entryPrice: pullbackEntry, probability: 'HIGH', r, portfolioOptions }),
    ]
  }
  if (r.signalType === 'BUY_RETEST') {
    return [
      buildScenario({ name: 'Retest entry', type: 'RETEST', condition: `Current support near $${r.price?.toFixed(2) ?? '?'} on light volume`, entryPrice: r.price, probability: 'HIGH', r, portfolioOptions }),
      buildScenario({ name: 'Momentum add (new high)', type: 'BREAKOUT', condition: `Breaks back above 52W high $${r.high52w?.toFixed(2) ?? '?'}`, entryPrice: breakoutEntry, probability: 'MEDIUM', r, portfolioOptions }),
    ]
  }
  if (r.signalType === 'WATCH' || r.signalType === 'APPROACHING') {
    return [
      buildScenario({ name: 'Breakout entry', type: 'BREAKOUT', condition: `Closes above 52W high $${r.high52w?.toFixed(2) ?? '?'} on confirmed volume`, entryPrice: breakoutEntry, probability: r.signalType === 'WATCH' ? 'MEDIUM' : 'LOW', r, portfolioOptions }),
      buildScenario({ name: 'Pullback entry', type: 'RETEST', condition: `Pulls back to $${pullbackEntry?.toFixed(2) ?? '?'} (21 EMA / 10-day low) first`, entryPrice: pullbackEntry, probability: 'MEDIUM', r, portfolioOptions }),
    ]
  }
  // No clear signal but decision isn't SELL/AVOID (e.g. WAIT on a borderline
  // grade-B setup) — still show a hypothetical breakout scenario per "never
  // show 0 scenarios for a BUY-shaped setup", with LOW probability.
  return [
    buildScenario({ name: 'If it breaks out', type: 'BREAKOUT', condition: `Closes above 52W high $${r.high52w?.toFixed(2) ?? '?'} on confirmed volume`, entryPrice: breakoutEntry, probability: 'LOW', r, portfolioOptions }),
  ]
}

// ── thesis (3 parts, every sentence references real fields) ───────────────
function generateThesis(r) {
  const chartParts = []
  if (r.pctFromHigh != null && r.pctFromHigh > -2 && r.emaFullStack) {
    chartParts.push(`Price is pressing against the 52-week high of $${r.high52w.toFixed(2)} with the 10/20/50 EMA bull stack intact — classic pre-breakout structure.`)
  }
  if (r.alligatorPhase === 'EATING_UP') {
    chartParts.push('The Williams Alligator is fully open and eating — the trend is confirmed at all three time horizons.')
  } else if (r.alligatorPhase === 'WAKING') {
    chartParts.push('The Williams Alligator is waking from sleep — trend is building but not yet fully confirmed.')
  }
  if (r.volRatio20 != null && r.volRatio20 < 0.9) {
    chartParts.push('Volume has been drying up over the past few days — possible accumulation before a move.')
  }
  if (chartParts.length === 0) {
    chartParts.push(`${r.symbol} is ${Math.abs(r.pctFromHigh ?? 0).toFixed(1)}% from its 52-week high of $${r.high52w?.toFixed(2) ?? '?'}, with ${r.emaFullStack ? 'an aligned' : 'a not-yet-aligned'} EMA stack.`)
  }

  const whyNowParts = []
  if (r.rsRank != null && r.rsRank > 90) {
    whyNowParts.push(`RS rank of ${r.rsRank} puts this stock in the top ${100 - r.rsRank}% of the scanned universe — relative momentum is strongly behind it.`)
  }
  if (r.sectorStatus === 'HOT') {
    whyNowParts.push('The sector ETF is within 3% of its own 52-week high — sector tailwind is supportive.')
  }
  if (r.macdPosture === 'BULLISH' && r.macdHistDirection === 'RISING') {
    whyNowParts.push('MACD histogram is rising — momentum is accelerating into the potential breakout.')
  }
  if (whyNowParts.length === 0) {
    whyNowParts.push(`RS rank ${r.rsRank ?? 'unknown'} and a sector reading of ${r.sectorStatus ?? 'unknown'} are the main context for timing here.`)
  }

  const riskParts = []
  if (r.rsiValue != null && r.rsiValue > 70) {
    riskParts.push(`RSI at ${r.rsiValue.toFixed(1)} is approaching overbought territory — a short-term pullback before (or instead of) the breakout is the primary risk.`)
  }
  if (r.volRatio20 != null && r.volRatio20 < 1.2) {
    riskParts.push(`Volume at ${r.volRatio20.toFixed(2)}x average is below the threshold for a confirmed breakout — without institutional participation the move may fail.`)
  }
  if (r.ret3m != null && r.ret3m > 100) {
    riskParts.push(`A 3-month return of ${r.ret3m.toFixed(0)}% raises the risk that this is the final exhaustion move of a parabolic run.`)
  }
  if (r.earningsDaysAway != null && r.earningsDaysAway < 14) {
    const tag = r.earningsSource === 'ESTIMATED' ? ' (estimated — verify)' : ''
    riskParts.push(`Earnings in ${r.earningsDaysAway} days${tag} creates gap risk that could blow through any stop.`)
  } else if (r.earningsSource === 'UNKNOWN') {
    riskParts.push('Earnings date is unavailable — verify before entry, since an unexpected report could blow through any stop.')
  }
  if (riskParts.length === 0) {
    riskParts.push('No single dominant risk flag from current data — manage size and respect the stop regardless.')
  }

  return {
    chartPattern: chartParts.slice(0, 2).join(' '),
    whyNow: whyNowParts.slice(0, 2).join(' '),
    risk: riskParts[0],
  }
}

// ── if already holding this (generic, current-technicals version — see
// analyzeOpenPosition below for the real-position variant used by
// OpenPositions.jsx, which prefers the actual entry/stop already on file) ──
function ifAlreadyLong(r) {
  if (r.rsiValue == null || r.atr14 == null) {
    return { action: 'Insufficient data to advise on an existing position.', trimTrigger: 'N/A', stopAction: 'N/A' }
  }

  let action, trimTrigger
  if (r.rsiValue > 75 && r.ret1m != null && r.ret1m > 20) {
    action = 'Consider trimming 25% — RSI overbought and stock extended. Lock in partial profit.'
    trimTrigger = `RSI ${r.rsiValue.toFixed(1)} above 75 with ${r.ret1m.toFixed(1)}% 1-month return`
  } else if (r.rsiValue > 72) {
    action = 'Hold current position. RSI slightly elevated — tighten trailing stop. Do not add here.'
    trimTrigger = 'Trim if RSI reaches 78 or the daily ATR stop is breached'
  } else {
    action = 'Hold. Trail the ATR stop daily. No action needed unless a trim target is hit.'
    trimTrigger = 'Trim 25% at the 1.5R target price'
  }

  const stopPrice = round(r.price - ATR_STOP_MULT * r.atr14)
  const stopAction = `ATR trailing stop: $${stopPrice} (entry − ${ATR_STOP_MULT} × $${r.atr14.toFixed(2)}). Update daily after close.`

  return { action, trimTrigger, stopAction }
}

// Main entry point — operates on a WeekHighScreener result object `r`
// (the same shape rendered by ResultCard). `portfolioOptions` is
// `{ portfolioSize, riskEnvironment, openPositions }`; all optional, default
// to a neutral risk stance so this stays a pure, synchronous function (no
// implicit market-condition fetch).
export function analyzeStock(r, portfolioOptions = {}) {
  const opts = {
    portfolioSize: portfolioOptions.portfolioSize ?? DEFAULT_PORTFOLIO_SIZE,
    riskEnvironment: portfolioOptions.riskEnvironment ?? 'neutral',
    openPositions: portfolioOptions.openPositions ?? [],
  }

  const grade = gradeBreakdown(r)
  const indicators = analyseIndicators(r)
  const flags = extractFlags(r, indicators)
  const decision = makeDecision(r, grade, indicators)
  const scenarios = buildScenarios(r, decision, opts)
  const thesis = generateThesis(r)
  const ifLong = ifAlreadyLong(r)

  return {
    ticker: r.symbol,
    company: r.name,
    sectorEtf: r.sector,
    signalType: r.signalType,
    signalGrade: r.grade,
    decision,
    gradeBreakdown: grade,
    indicators,
    flags,
    scenarios,
    thesis,
    ifAlreadyLong: ifLong,
  }
}

const POSITION_ACTION_MAP = {
  HOLD: 'WAIT',
  'TRIM 1': 'TRIM',
  'TRIM 2': 'TRIM',
  'TRIM (PARABOLIC)': 'TRIM',
  EXIT: 'SELL',
  'ADD ON RETEST': 'ADD',
}

// Lightweight adapter for OpenPositions.jsx, which tracks entry/shares/stop
// state per position but not the full indicator set a fresh scan result has
// (no RS rank/sector heat for a single already-held symbol without
// rescanning the whole universe). Rather than recompute a different grade
// from scratch, this reuses positions.js's evaluatePosition output directly
// — the same evaluation already driving that page's Hold/Trim/Exit actions
// — and reshapes it into the decision/ifAlreadyLong slice of the same
// AnalysisPanel contract. gradeBreakdown/indicators/scenarios are
// intentionally omitted (undefined): they answer "should I enter," which
// isn't the question for a position you already hold.
export function analyzeOpenPosition(position, evaluation) {
  const action = POSITION_ACTION_MAP[evaluation.action] ?? 'WAIT'
  const summary = evaluation.exitSignals?.length > 0
    ? evaluation.exitSignals.join('; ')
    : evaluation.partialExitSignal ?? `${evaluation.action} — ${evaluation.plPct >= 0 ? '+' : ''}${evaluation.plPct.toFixed(2)}% since entry`

  return {
    ticker: position.symbol,
    company: position.name,
    sectorEtf: position.sector,
    signalType: position.signalType ?? null,
    signalGrade: position.grade,
    decision: {
      action,
      confidence: evaluation.forceExit ? 'HIGH' : 'MEDIUM',
      summary,
      urgency: evaluation.forceExit ? 'NOW' : action === 'TRIM' ? 'TODAY' : 'NO_RUSH',
    },
    gradeBreakdown: undefined,
    indicators: undefined,
    flags: {
      redFlags: evaluation.exitSignals ?? [],
      amberFlags: evaluation.partialExitSignal ? [evaluation.partialExitSignal] : [],
      greenFlags: [],
    },
    scenarios: undefined,
    thesis: undefined,
    ifAlreadyLong: {
      action: evaluation.action === 'EXIT'
        ? 'Exit signal triggered — close the position.'
        : evaluation.action === 'TRIM 1' || evaluation.action === 'TRIM 2'
          ? `${evaluation.nextTrim.label} target reached — sell ${evaluation.nextTrim.shares} shares at $${evaluation.nextTrim.price?.toFixed(2) ?? 'market'}.`
          : evaluation.action === 'ADD ON RETEST'
            ? 'Eligible to add back on this retest per the A+ retest-add rule.'
            : `Hold. Next target: ${evaluation.nextTrim.label}${evaluation.nextTrim.price != null ? ` at $${evaluation.nextTrim.price.toFixed(2)}` : ''}.`,
      trimTrigger: evaluation.nextTrim.price != null ? `${evaluation.nextTrim.label} at $${evaluation.nextTrim.price.toFixed(2)}` : `${evaluation.nextTrim.label} (trailing — no fixed price)`,
      stopAction: `Current stop: $${evaluation.activeStop?.toFixed(2) ?? '?'} (${evaluation.stage}). Updates daily after close.`,
    },
  }
}
