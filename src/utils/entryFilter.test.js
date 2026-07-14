import { describe, it, expect } from 'vitest'
import { evaluateEntryFilter, computeSimpleTradePlan } from './entryFilter'

const cleanPass = {
  sector: 'Information Technology',
  pctFromHigh: -1,
  firstNewHighIn3Months: true,
  baseQuality: { durationDays: 35, rangePct: 15, tight: true },
  volRatio50AtBreakout: 2.0,
  breakoutGapPct: 2,
  rsiValue: 65,
  extensionFrom50EmaPct: 8,
  adxValue: 25,
  macdPosture: 'BULLISH',
  emaFullStack: true,
  rsRank: 90,
  avgDollarVolume20: 50_000_000,
  earningsDaysAway: 20,
  earningsSource: 'CONFIRMED',
  price: 100,
  atr14: 3,
}
const goodRegime = { marketAbove50: true, sectorBySector: { 'Information Technology': { above50: true } } }
const badMarketRegime = { marketAbove50: false, sectorBySector: { 'Information Technology': { above50: true } } }

describe('entryFilter smoke', () => {
  it('clean candidate + good regime => PASS', () => {
    expect(evaluateEntryFilter(cleanPass, goodRegime).status).toBe('PASS')
  })
  it('clean candidate + bad market regime => CAUTION (dampener, not veto)', () => {
    const r = evaluateEntryFilter(cleanPass, badMarketRegime)
    expect(r.status).toBe('CAUTION')
    expect(r.regime.reasons.length).toBeGreaterThan(0)
  })
  it('extended RSI + weak ADX => FAIL', () => {
    const r = evaluateEntryFilter({ ...cleanPass, rsiValue: 85, adxValue: 10 }, goodRegime)
    expect(r.status).toBe('FAIL')
  })
  it('missing serial-high/base data => CAUTION, not FAIL', () => {
    const r = evaluateEntryFilter({ ...cleanPass, firstNewHighIn3Months: null, baseQuality: null }, goodRegime)
    expect(r.status).toBe('CAUTION')
  })
  it('simple trade plan: wider-of-stop, halved sizing under caution', () => {
    const plan = computeSimpleTradePlan(cleanPass, 100000, false)
    expect(plan.viable).toBe(true)
    // ATR stop = 100 - 1.5*3 = 95.5; fixed = 95; wider (lower) = 95
    expect(plan.stopPrice).toBe(95)
    expect(plan.stopMethod).toBe('5% fixed')
    const planHalved = computeSimpleTradePlan(cleanPass, 100000, true)
    expect(planHalved.shares).toBe(Math.floor(plan.shares / 2))
  })
})
