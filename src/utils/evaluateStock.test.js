import { describe, it, expect, afterEach } from 'vitest'
import { evaluateStock, computeVerdict, deriveFlags } from './evaluateStock'
import { THRESHOLDS } from './screenerThresholds'

const strongCandidate = {
  sector: 'Information Technology',
  pctFromHigh: -1,
  macdPosture: 'BULLISH',
  emaFullStack: true,
  avgDollarVolume20: 50_000_000,
  avwapFromHigh: { signal: 'BULLISH', vsPricePct: 5 },
  ret1m: 10,
  earningsDaysAway: 20,
  earningsSource: 'CONFIRMED',
  newHighCountIn3Months: 0,
  volRatio50AtBreakout: 2.0,
  baseQuality: { durationDays: 35, rangePct: 15, tight: true },
  breakoutGapPct: 2,
  rsiValue: 65,
  extensionFrom50EmaPct: 8,
  adxValue: 28,
  rsRank: 90,
  price: 100,
  atr14: 3,
  peakAge: 1,
  ret3m: 15,
  alligatorPhase: 'EATING_UP',
  macdHistDirection: 'RISING',
  newHigh: true,
  volRatio20: 2.0,
  volRatioMaxN: 2.0,
  todayUp: true,
  volRising: true,
  pullbackVolRatio: null,
}
const goodRegime = { marketAbove50: true, sectorBySector: { 'Information Technology': { above50: true } }, portfolioSize: 100000 }
const badRegime = { marketAbove50: false, sectorBySector: { 'Information Technology': { above50: false } }, portfolioSize: 100000 }

describe('evaluateStock — Stage 0 hard disqualifiers', () => {
  it('all 6 MUST checks pass on a clean candidate, stock proceeds to scoring', () => {
    const e = evaluateStock(strongCandidate, goodRegime)
    const musts = e.reasons.filter((r) => r.tier === 'MUST')
    expect(musts).toHaveLength(6)
    expect(musts.every((m) => m.status === 'PASS')).toBe(true)
    expect(e.grade).not.toBeNull()
  })

  it('price too far from high (outside both breakout and retest zones) -> AVOID, no score, no stage', () => {
    const e = evaluateStock({ ...strongCandidate, pctFromHigh: -15 }, goodRegime)
    expect(e.verdict).toBe('AVOID')
    expect(e.grade).toBeNull()
    expect(e.score).toBeNull()
    expect(e.stage).toBeNull()
    expect(e.reasons.find((r) => r.label === 'Price near 52W high').status).toBe('FAIL')
  })

  it('price in the retest zone (-10% to -1%) is NOT disqualified — WATCH_RETEST must stay reachable', () => {
    const e = evaluateStock({ ...strongCandidate, pctFromHigh: -5, newHigh: false }, goodRegime)
    expect(e.reasons.find((r) => r.label === 'Price near 52W high').status).toBe('PASS')
    expect(e.verdict).not.toBe('AVOID')
  })

  it('MACD bearish or EMA not aligned -> AVOID', () => {
    const e = evaluateStock({ ...strongCandidate, emaFullStack: false }, goodRegime)
    expect(e.verdict).toBe('AVOID')
    expect(e.reasons.find((r) => r.label === 'MACD + EMA trend').status).toBe('FAIL')
  })

  it('liquidity below $15M/day -> AVOID', () => {
    const e = evaluateStock({ ...strongCandidate, avgDollarVolume20: 8_000_000 }, goodRegime)
    expect(e.verdict).toBe('AVOID')
  })

  it('AVWAP bearish -> AVOID', () => {
    const e = evaluateStock({ ...strongCandidate, avwapFromHigh: { signal: 'BEARISH', vsPricePct: -3 } }, goodRegime)
    expect(e.verdict).toBe('AVOID')
  })
  it('AVWAP unknown (no data) does NOT disqualify', () => {
    const e = evaluateStock({ ...strongCandidate, avwapFromHigh: null }, goodRegime)
    expect(e.verdict).not.toBe('AVOID')
  })

  it('confirmed earnings within 3 trading days -> AVOID', () => {
    const e = evaluateStock({ ...strongCandidate, earningsDaysAway: 2, earningsSource: 'CONFIRMED' }, goodRegime)
    expect(e.verdict).toBe('AVOID')
  })
  it('estimated earnings within 3 days does NOT hard-disqualify (only confirmed does)', () => {
    const e = evaluateStock({ ...strongCandidate, earningsDaysAway: 2, earningsSource: 'ESTIMATED' }, goodRegime)
    expect(e.verdict).not.toBe('AVOID')
  })
  it('unknown earnings date does NOT hard-disqualify', () => {
    const e = evaluateStock({ ...strongCandidate, earningsDaysAway: null, earningsSource: 'UNKNOWN' }, goodRegime)
    expect(e.verdict).not.toBe('AVOID')
  })

  it('1-month return > 35% (parabolic) -> AVOID', () => {
    const e = evaluateStock({ ...strongCandidate, ret1m: 40 }, goodRegime)
    expect(e.verdict).toBe('AVOID')
  })
  it('unknown 1-month return does NOT hard-disqualify', () => {
    const e = evaluateStock({ ...strongCandidate, ret1m: null }, goodRegime)
    expect(e.verdict).not.toBe('AVOID')
  })
})

describe('evaluateStock — Stage 1 market stage', () => {
  it('established uptrend classifies MARKUP', () => {
    const e = evaluateStock(strongCandidate, goodRegime)
    expect(e.stage).toBe('MARKUP')
  })
  it('fresh breakout out of a real base, Alligator not yet eating up -> ACCUMULATION', () => {
    const e = evaluateStock({ ...strongCandidate, alligatorPhase: 'WAKING', peakAge: 0 }, goodRegime)
    expect(e.stage).toBe('ACCUMULATION')
  })
  it('weak ADX + falling MACD histogram near highs -> DISTRIBUTION', () => {
    const e = evaluateStock(
      { ...strongCandidate, alligatorPhase: 'WAKING', peakAge: 20, baseQuality: null, adxValue: 15, macdHistDirection: 'FALLING' },
      goodRegime
    )
    expect(e.stage).toBe('DISTRIBUTION')
  })
})

describe('evaluateStock — Stage 2/3 scoring and grade', () => {
  it('near-perfect candidate scores high and grades A', () => {
    const e = evaluateStock(strongCandidate, goodRegime)
    // 11 factors at 2pts (22) + factor 4 (ATH, always capped at 1) = 23
    expect(e.score).toBe(23)
    expect(e.grade).toBe('A')
  })

  it('missing scored-factor data defaults to neutral 1, not 0 or 2', () => {
    const e = evaluateStock({ ...strongCandidate, rsiValue: null, adxValue: null, newHighCountIn3Months: null }, goodRegime)
    expect(e.reasons.find((r) => r.n === 1).points).toBe(1)
    expect(e.reasons.find((r) => r.n === 6).points).toBe(1)
    expect(e.reasons.find((r) => r.n === 8).points).toBe(1)
  })

  it('unfavorable regime lowers score via factor 11, not a separate veto', () => {
    const e = evaluateStock(strongCandidate, badRegime)
    expect(e.reasons.find((r) => r.n === 11).points).toBe(0)
    expect(e.verdict).not.toBe('AVOID') // regime alone never hard-disqualifies
  })

  it('earnings 4-5 days out is not hard-disqualified but scores 0 on factor 10', () => {
    const e = evaluateStock({ ...strongCandidate, earningsDaysAway: 4, earningsSource: 'CONFIRMED' }, goodRegime)
    expect(e.grade).not.toBeNull() // cleared Stage 0 (only <=3 days blocks)
    expect(e.reasons.find((r) => r.n === 10).points).toBe(0)
  })
})

describe('evaluateStock — Stage 4 verdict (pure function of grade + signalType)', () => {
  it('grade A + confirmed breakout -> BUY_NOW', () => {
    const e = evaluateStock(strongCandidate, goodRegime)
    expect(e.grade).toBe('A')
    expect(e.signalType).toBe('BUY_BREAKOUT')
    expect(e.verdict).toBe('BUY_NOW')
  })

  it('grade C -> WATCH regardless of signal type', () => {
    expect(computeVerdict('C', 'BUY_BREAKOUT')).toBe('WATCH')
    expect(computeVerdict('C', null)).toBe('WATCH')
  })

  it('grade D -> AVOID', () => {
    expect(computeVerdict('D', 'BUY_BREAKOUT')).toBe('AVOID')
  })

  it('grade A/B with no actionable signal -> WATCH (not BUY_NOW/WATCH_RETEST)', () => {
    expect(computeVerdict('A', 'WATCH')).toBe('WATCH')
    expect(computeVerdict('B', 'APPROACHING')).toBe('WATCH')
    expect(computeVerdict('A', null)).toBe('WATCH')
  })

  it('grade A/B + retest -> WATCH_RETEST', () => {
    expect(computeVerdict('A', 'BUY_RETEST')).toBe('WATCH_RETEST')
    expect(computeVerdict('B', 'BUY_RETEST')).toBe('WATCH_RETEST')
  })

  // Regression: Stage 0's price check was briefly a literal "-2% to 0%",
  // which would disqualify every retest setup before it ever reached
  // scoring — making WATCH_RETEST unreachable end-to-end even though
  // Stage 4 explicitly names it. Broadened to also admit the retest zone
  // (-10% to -1%); this proves a real retest-shaped candidate can actually
  // reach WATCH_RETEST through the full pipeline, not just via
  // computeVerdict() in isolation.
  it('a real retest-shaped candidate reaches WATCH_RETEST end-to-end, not just in computeVerdict isolation', () => {
    const retestCandidate = {
      ...strongCandidate,
      pctFromHigh: -5, newHigh: false, peakAge: 5,
      pullbackVolRatio: 0.5, todayUp: true, volRising: true,
      alligatorPhase: 'EATING_UP', // normal (non-override) retest trend confirmation
    }
    const e = evaluateStock(retestCandidate, goodRegime)
    expect(['A', 'B']).toContain(e.grade)
    expect(e.signalType).toBe('BUY_RETEST')
    expect(e.verdict).toBe('WATCH_RETEST')
  })
})

describe('evaluateStock — internal signal-type ADX-override (THRESHOLDS.adxConfirmsTrend)', () => {
  afterEach(() => {
    THRESHOLDS.adxConfirmsTrend = false
  })

  // Grade-A retest setup where the Alligator has only just woken up (not
  // EATING_UP) — the normal retest path requires EATING_UP outright, so
  // this can only reach BUY_RETEST via the opt-in ADX override.
  const strongAdxWakingRetest = {
    ...strongCandidate,
    pctFromHigh: -5, newHigh: false, peakAge: 5,
    pullbackVolRatio: 0.5, todayUp: true, volRising: true,
    adxValue: 41.5, alligatorPhase: 'WAKING',
  }

  it('flag OFF: strong-ADX/Alligator-WAKING stays WATCH, not WATCH_RETEST (unchanged baseline)', () => {
    expect(THRESHOLDS.adxConfirmsTrend).toBe(false)
    const e = evaluateStock(strongAdxWakingRetest, goodRegime)
    expect(e.verdict).not.toBe('WATCH_RETEST')
  })

  it('flag ON, all guards pass (grade A): becomes WATCH_RETEST-eligible', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const e = evaluateStock(strongAdxWakingRetest, goodRegime)
    expect(e.grade).toBe('A')
    expect(e.verdict).toBe('WATCH_RETEST')
  })

  it('flag ON, GUARD 1: ADX high but Alligator EATING_DOWN is never eligible (real downtrend never overridden)', () => {
    THRESHOLDS.adxConfirmsTrend = true
    // EATING_DOWN also trips Stage 1 -> DECLINE and Stage 0's MACD/EMA
    // check would normally already block this; forcing macdPosture/
    // emaFullStack bullish isolates the ADX-override guard specifically.
    const e = evaluateStock({ ...strongAdxWakingRetest, adxValue: 45, alligatorPhase: 'EATING_DOWN' }, goodRegime)
    expect(e.verdict).not.toBe('WATCH_RETEST')
  })

  it('flag ON, GUARD 2: override must not rescue a non-A-grade card even with high ADX', () => {
    THRESHOLDS.adxConfirmsTrend = true
    // Degrade several unrelated scored factors to guarantee a sub-A grade
    // while leaving the ADX/Alligator/retest-shape fields untouched.
    const notGradeA = {
      ...strongAdxWakingRetest, adxValue: 45,
      rsiValue: 78, extensionFrom50EmaPct: 22, baseQuality: null,
      breakoutGapPct: 8, rsRank: 72,
    }
    const e = evaluateStock(notGradeA, goodRegime)
    expect(e.grade).not.toBe('A')
    expect(e.verdict).not.toBe('WATCH_RETEST')
  })

  it('flag ON, ADX below the override bar (32 < 40) is not exceptional enough even at grade A', () => {
    THRESHOLDS.adxConfirmsTrend = true
    const e = evaluateStock({ ...strongAdxWakingRetest, adxValue: 32 }, goodRegime)
    expect(e.verdict).not.toBe('WATCH_RETEST')
  })

  it('flag OFF: EATING_UP still confirms retest on its own (baseline unchanged)', () => {
    const e = evaluateStock({ ...strongAdxWakingRetest, alligatorPhase: 'EATING_UP' }, goodRegime)
    expect(e.verdict).toBe('WATCH_RETEST')
  })
})

describe('evaluateStock — Stage 5 sizing', () => {
  it('stop is the wider (lower) of 1.5x ATR and 5% fixed; grade A sizes at 1% risk', () => {
    const e = evaluateStock(strongCandidate, goodRegime)
    // ATR stop = 100 - 1.5*3 = 95.5; fixed = 95; wider (lower) = 95
    expect(e.stop).toBe(95)
    expect(e.entry).toBe(100)
    // risk/share = 5, 1% of 100k = 1000 -> 200 shares
    expect(e.size).toBe(200)
    expect(e.riskDollars).toBe(1000)
  })

  it('grade D is never sized', () => {
    const weak = {
      ...strongCandidate, rsiValue: 90, adxValue: 5, extensionFrom50EmaPct: 40,
      breakoutGapPct: 15, baseQuality: null, volRatio50AtBreakout: 0.5,
      alligatorPhase: 'WAKING', peakAge: 20, macdHistDirection: 'FALLING', newHighCountIn3Months: 5, rsRank: 40,
    }
    const e = evaluateStock(weak, badRegime)
    expect(e.grade).toBe('D')
    expect(e.entry).toBeNull()
    expect(e.size).toBeNull()
  })

  it('disqualified stock (Stage 0 fail) is never sized', () => {
    const e = evaluateStock({ ...strongCandidate, pctFromHigh: -15 }, goodRegime)
    expect(e.entry).toBeNull()
    expect(e.stop).toBeNull()
    expect(e.size).toBeNull()
    expect(e.riskDollars).toBeNull()
  })
})

describe('deriveFlags — filter over reasons, not a separately computed object', () => {
  it('red = MUST fails, amber = SCORED 0-1, green = MUST pass or SCORED 2', () => {
    const e = evaluateStock(strongCandidate, badRegime) // regime factor will be 0 (amber-ish/red-adjacent -> amber since it's SCORED)
    const flags = deriveFlags(e.reasons)
    expect(flags.red.length).toBe(0) // all MUST passed
    expect(flags.amber.some((f) => f.n === 11)).toBe(true) // regime scored 0
    expect(flags.green.length).toBeGreaterThan(0)
  })
})
