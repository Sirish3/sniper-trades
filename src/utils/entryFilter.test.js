import { describe, it, expect } from 'vitest'
import { evaluateEntryFilter, computeSimpleTradePlan } from './entryFilter'

const strongCandidate = {
  sector: 'Information Technology',
  pctFromHigh: -1,
  firstNewHighIn3Months: true,
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
}
const goodRegime = { marketAbove50: true, sectorBySector: { 'Information Technology': { above50: true } } }
const badRegime = { marketAbove50: false, sectorBySector: { 'Information Technology': { above50: false } } }

function withEntryFilter(candidate, regime) {
  return { ...candidate, entryFilter: evaluateEntryFilter(candidate, regime) }
}

describe('entryFilter (scoring model)', () => {
  it('strong candidate + favorable regime scores near max and grades A', () => {
    const r = evaluateEntryFilter(strongCandidate, goodRegime)
    expect(r.eligible).toBe(true)
    // 9 factors at 2pts (18) + factor 3 (ATH, always capped at 1) = 19
    expect(r.score).toBe(19)
    expect(r.grade).toBe('A')
  })

  it('failing a hard filter drops the stock entirely — no score', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, emaFullStack: false }, goodRegime)
    expect(r.eligible).toBe(false)
    expect(r.failures.some((f) => f.startsWith('C:'))).toBe(true)
    expect(r.score).toBeUndefined()
  })

  it('undeterminable serial-high (rule B) does not block eligibility', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, firstNewHighIn3Months: null }, goodRegime)
    expect(r.eligible).toBe(true)
  })

  it('unfavorable regime lowers score via factor 10, not a separate veto', () => {
    const r = evaluateEntryFilter(strongCandidate, badRegime)
    expect(r.eligible).toBe(true)
    expect(r.regimeFit.fit).toBe('UNFAVORABLE')
    expect(r.factors.find((f) => f.n === 10).points).toBe(0)
  })

  it('missing scored-factor data defaults to neutral (1), not 0 or 2', () => {
    const r = evaluateEntryFilter({ ...strongCandidate, rsiValue: null, adxValue: null }, goodRegime)
    expect(r.factors.find((f) => f.n === 5).points).toBe(1)
    expect(r.factors.find((f) => f.n === 7).points).toBe(1)
  })

  it('grade D is never sized', () => {
    const weak = {
      ...strongCandidate, rsiValue: 90, adxValue: 5, extensionFrom50EmaPct: 40,
      breakoutGapPct: 15, baseQuality: null, volRatio50AtBreakout: 0.5, earningsDaysAway: 2,
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
    // Push score into the C band (6-10) while staying hard-filter-eligible:
    // factors 1,4,6,7,8,10 at 0, factor 2/3 neutral (1), factors 5/9 at 2 -> 6.
    const cCandidate = {
      ...strongCandidate, extensionFrom50EmaPct: 40, breakoutGapPct: 15,
      baseQuality: null, volRatio50AtBreakout: 0.5, adxValue: 10, rsRank: 50,
    }
    const r = withEntryFilter(cCandidate, badRegime)
    expect(r.entryFilter.score).toBe(6)
    expect(r.entryFilter.grade).toBe('C')
    const plan = computeSimpleTradePlan(r, 100000)
    expect(plan.accountRiskPct).toBe(0.5)
  })
})
