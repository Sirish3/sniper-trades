import { describe, it, expect, afterEach } from 'vitest'
import { gradeWeekHighSetup, classifySignalType } from './weekHighScreener'
import { THRESHOLDS } from './screenerThresholds'

// A complete, otherwise-clean A+ result object — tests mutate only the
// volume-related fields needed to exercise FIX 1 (the breakout volume gates
// read the best day in a recent window, not just today's bar).
const BASE_R = {
  pctFromHigh: -2, volRatio20: 2.0, volRatioMaxN: 2.0, volRatioMaxNDaysAgo: 0,
  rsiValue: 60, adxValue: 30, rsRank: 90, emaFullStack: true,
  alligatorPhase: 'EATING_UP', sectorStatus: 'HOT', earningsDaysAway: 30,
  avwapFromHigh: { value: 95, vsPricePct: 5.0, signal: 'BULLISH' },
}

describe('gradeWeekHighSetup — FIX 1 (volume MUST floor reads the breakout window)', () => {
  it('today quiet (0.8x) but 2.4x 3 bars ago — MUST floor PASSES via volRatioMaxN, not forced to C', () => {
    const r = { ...BASE_R, volRatio20: 0.8, volRatioMaxN: 2.4, volRatioMaxNDaysAgo: 3 }
    const { grade } = gradeWeekHighSetup(r)
    // Without FIX 1 this would be forced to grade C on the C-disqualifier
    // alone (today's 0.8x < 1.2x) regardless of any other criteria.
    expect(grade).not.toBe('C')
  })

  it('no day above 1.2x anywhere in the window — still grades C', () => {
    const r = { ...BASE_R, volRatio20: 0.8, volRatioMaxN: 0.83, volRatioMaxNDaysAgo: 2 }
    const { grade, reasons } = gradeWeekHighSetup(r)
    expect(grade).toBe('C')
    expect(reasons.join(' ')).toMatch(/Vol/)
  })
})

describe('gradeWeekHighSetup — earnings gate (CONFIRMED real threshold vs ESTIMATED widened threshold)', () => {
  it('CONFIRMED earnings comfortably past the real 10-day threshold is not a miss', () => {
    const r = { ...BASE_R, earningsDaysAway: 15, earningsSource: 'CONFIRMED' }
    const { reasons } = gradeWeekHighSetup(r)
    expect(reasons.join(' ')).not.toMatch(/Earnings/)
  })

  it('ESTIMATED earnings inside the widened window (clears the real 10d threshold but not the +14d-padded one) is a miss', () => {
    const r = { ...BASE_R, earningsDaysAway: 15, earningsSource: 'ESTIMATED' }
    const { reasons } = gradeWeekHighSetup(r)
    expect(reasons.join(' ')).toMatch(/Earnings/)
  })

  it('ESTIMATED earnings comfortably outside the widened window is a soft-clear, not a miss', () => {
    const r = { ...BASE_R, earningsDaysAway: 30, earningsSource: 'ESTIMATED' }
    const { reasons } = gradeWeekHighSetup(r)
    expect(reasons.join(' ')).not.toMatch(/Earnings/)
  })
})

describe('classifySignalType — FIX 1 (BREAKOUT volume gate reads the breakout window)', () => {
  const breakoutShape = { pctFromHigh: -0.5, newHigh: false, peakAge: 0, pullbackVolRatio: null, todayUp: true, volRising: false }

  it('confirms BUY_BREAKOUT on volRatioMaxN even when today is quiet', () => {
    const r = { ...BASE_R, ...breakoutShape, volRatio20: 0.8, volRatioMaxN: 2.4, volRatioMaxNDaysAgo: 3 }
    expect(classifySignalType(r)).toBe('BUY_BREAKOUT')
  })

  it('does not confirm BUY_BREAKOUT when no day in the window clears the strong floor', () => {
    const r = { ...BASE_R, ...breakoutShape, volRatio20: 0.8, volRatioMaxN: 0.9, volRatioMaxNDaysAgo: 2 }
    expect(classifySignalType(r)).not.toBe('BUY_BREAKOUT')
  })
})

describe('classifySignalType — FIX 2 (THRESHOLDS.adxConfirmsTrend, default OFF, with GUARD 1 + GUARD 2)', () => {
  afterEach(() => {
    THRESHOLDS.adxConfirmsTrend = false
  })

  // URI-like: very strong ADX, elite RS, bullish AVWAP, grade A, otherwise a
  // clean retest pullback — but the Alligator has only just woken up.
  const strongAdxWakingRetest = {
    ...BASE_R,
    pctFromHigh: -5, newHigh: false, peakAge: 5, pullbackVolRatio: 0.5,
    todayUp: true, volRising: true,
    adxValue: 41.5, rsRank: 100, grade: 'A',
    avwapFromHigh: { value: 95, vsPricePct: 5.0, signal: 'BULLISH' },
    alligatorPhase: 'WAKING',
  }

  it('flag OFF: strong-ADX/Alligator-WAKING stays WATCH, not BUY_RETEST (unchanged baseline)', () => {
    expect(THRESHOLDS.adxConfirmsTrend).toBe(false)
    const r = { ...strongAdxWakingRetest }
    expect(classifySignalType(r)).toBe('WATCH')
    expect(r.trendConfirmedBy).toBeNull()
  })

  it('flag ON, all guards pass: the same setup becomes BUY_RETEST-eligible, tagged ADX_OVERRIDE', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const r = { ...strongAdxWakingRetest }
    expect(classifySignalType(r)).toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBe('ADX_OVERRIDE')
  })

  it('flag ON, GUARD 1 fails: ADX 45 but Alligator EATING_DOWN is never eligible', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const r = { ...strongAdxWakingRetest, adxValue: 45, alligatorPhase: 'EATING_DOWN' }
    expect(classifySignalType(r)).not.toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBeNull()
  })

  it('flag ON, GUARD 2 fails: ADX 45, Alligator WAKING, but grade B is never eligible (override must not rescue a weak card)', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const r = { ...strongAdxWakingRetest, adxValue: 45, grade: 'B' }
    expect(classifySignalType(r)).not.toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBeNull()
  })

  it('flag ON, ADX below the bar: 32 (< 40) is not exceptional enough even at grade A', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const r = { ...strongAdxWakingRetest, adxValue: 32 }
    expect(classifySignalType(r)).not.toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBeNull()
  })

  it('flag OFF: EATING_UP still confirms BUY_RETEST on its own, tagged ALLIGATOR (baseline unchanged)', () => {
    const r = { ...strongAdxWakingRetest, alligatorPhase: 'EATING_UP' }
    expect(classifySignalType(r)).toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBe('ALLIGATOR')
  })

  it('flag ON: EATING_UP (grade B, low ADX) still confirms via ALLIGATOR — the normal path never needs the guards', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const r = { ...strongAdxWakingRetest, alligatorPhase: 'EATING_UP', grade: 'B', adxValue: 10 }
    expect(classifySignalType(r)).toBe('BUY_RETEST')
    expect(r.trendConfirmedBy).toBe('ALLIGATOR')
  })
})
