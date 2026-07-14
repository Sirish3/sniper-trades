import { describe, it, expect } from 'vitest'
import { evaluateEntryFilter, computeSimpleTradePlan } from './entryFilter'

const strongCandidate = {
  sector: 'Information Technology',
  pctFromHigh: -1,
  newHighCountIn3Months: 0,
  macdPosture: 'BULLISH',
  emaFullStack: true,
  avgDollarVolume20: 50_000_000,
  baseQuality: { durationDays: 35, rangePct: 15, tight: true },
  volRatio50AtBreakout: 2.0,
  breakoutGapPct: 2,
  rsiValue: 65,
  extensionFrom50EmaPct: 8,
  adxValue: 28,
  rsRank: 90,
  earningsDaysAway: 20,
  price: 100,
  atr14: 3,
  peakAge: 1,
  ret3m: 15,
  alligatorPhase: 'EATING_UP',
  macdHistDirection: 'RISING',
}
const goodRegime = { marketAbove50: true, sectorBySector: { 'Information Technology': { above50: true } } }
const badRegime = { marketAbove50: false, sectorBySector: { 'Information Technology': { above50: false } } }

function withEntryFilter(candidate, regime) {
  return { ...candidate, entryFilter: evaluateEntryFilter(candidate, regime) }
}

describe('entryFilter (0-24 scoring model with market stage)', () => {
  it('strong candidate + favorable regime scores near max and grades A', () => {
    const r = evaluateEntryFilter(strongCandidate, goodRegime)
    expect(r.eligible).toBe(true)
    expect(r.stage).toBe('MARKUP')
    // 10 factors at 2pts (20) + factor 4 (ATH, always capped at 1) + stage (2) = 23
    expect(r.score).toBe(23)
    expect(r.grade).toBe('A')
  })

  it('failing a hard filter drops the stock entirely — no score, no stage', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, emaFullStack: false }, goodRegime)
    expect(r.eligible).toBe(false)
    expect(r.failures.some((f) => f.startsWith('B:'))).toBe(true)
    expect(r.score).toBeUndefined()
    expect(r.stage).toBeUndefined()
  })

  it('fresh breakout out of a real base, not yet fully trending, classifies as ACCUMULATION', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, alligatorPhase: 'WAKING', peakAge: 0 }, goodRegime)
    expect(r.stage).toBe('ACCUMULATION')
    expect(r.stageScore).toBe(2)
  })

  it('near highs but ADX weak and MACD histogram falling classifies as DISTRIBUTION (scores 0)', () => {
    const r = evaluateEntryFilter(
      { ...strongCandidate, alligatorPhase: 'WAKING', peakAge: 20, baseQuality: null, adxValue: 15, macdHistDirection: 'FALLING' },
      goodRegime
    )
    expect(r.stage).toBe('DISTRIBUTION')
    expect(r.stageScore).toBe(0)
  })

  it('unfavorable regime lowers score via factor 11, not a separate veto', () => {
    const r = evaluateEntryFilter(strongCandidate, badRegime)
    expect(r.eligible).toBe(true)
    expect(r.regimeFit.fit).toBe('UNFAVORABLE')
    expect(r.factors.find((f) => f.n === 11).points).toBe(0)
  })

  it('missing scored-factor data defaults to neutral (1), not 0 or 2', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, rsiValue: null, adxValue: null, newHighCountIn3Months: null }, goodRegime)
    expect(r.factors.find((f) => f.n === 1).points).toBe(1)
    expect(r.factors.find((f) => f.n === 6).points).toBe(1)
    expect(r.factors.find((f) => f.n === 8).points).toBe(1)
    expect(r.watchOuts).toContain('serial-high history unverified')
  })

  it('serial new-high maker (3+ prior highs in 3mo) scores factor 1 at 0', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, newHighCountIn3Months: 4 }, goodRegime)
    expect(r.factors.find((f) => f.n === 1).points).toBe(0)
  })

  it('grade D is never sized', () => {
    const weak = {
      ...strongCandidate, rsiValue: 90, adxValue: 5, extensionFrom50EmaPct: 40,
      breakoutGapPct: 15, baseQuality: null, volRatio50AtBreakout: 0.5, earningsDaysAway: 2,
      alligatorPhase: 'WAKING', peakAge: 20, macdHistDirection: 'FALLING', newHighCountIn3Months: 5,
    }
    const r = withEntryFilter(weak, badRegime)
    expect(r.entryFilter.grade).toBe('D')
    const plan = computeSimpleTradePlan(r, 100000)
    expect(plan.viable).toBe(false)
  })

  it('simple trade plan: stop is the wider (lower) of ATR and 5% fixed, sized at 1% for grade A', () => {
    const r = withEntryFilter(strongCandidate, goodRegime)
    const plan = computeSimpleTradePlan(r, 100000)
    expect(plan.viable).toBe(true)
    // ATR stop = 100 - 1.5*3 = 95.5; fixed = 95; wider (lower) = 95
    expect(plan.stopPrice).toBe(95)
    expect(plan.stopMethod).toBe('5% fixed')
    expect(plan.accountRiskPct).toBe(1) // grade A -> 1% risk
  })

  it('grade C is sized at half the risk % of grade A/B', () => {
    // Lands in the C band (7-12) with several weak factors and an
    // UNFAVORABLE regime; exact arithmetic verified via the score assertion
    // below rather than hand-derived, since the point is the grade band and
    // resulting sizing, not the specific total.
    const cCandidate = {
      ...strongCandidate, extensionFrom50EmaPct: 40, breakoutGapPct: 15,
      baseQuality: null, adxValue: 15, rsRank: 50, newHighCountIn3Months: 5,
      alligatorPhase: 'WAKING', peakAge: 20, macdHistDirection: 'FALLING',
    }
    const r = withEntryFilter(cCandidate, badRegime)
    expect(r.entryFilter.stage).toBe('DISTRIBUTION')
    expect(r.entryFilter.score).toBeGreaterThanOrEqual(7)
    expect(r.entryFilter.score).toBeLessThanOrEqual(12)
    expect(r.entryFilter.grade).toBe('C')
    const plan = computeSimpleTradePlan(r, 100000)
    expect(plan.accountRiskPct).toBe(0.5)
  })
})
