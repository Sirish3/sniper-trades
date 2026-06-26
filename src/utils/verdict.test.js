import { describe, it, expect } from 'vitest'
import { getVerdict, bucketResultsByVerdict } from './verdict'
import { analyzeStock } from './stockAnalysis'

const PORTFOLIO_OPTIONS = { portfolioSize: 100000, riskEnvironment: 'neutral', openPositions: [] }

// A complete result object that clears every BUY condition in makeDecision()
// and every structural-weakness check in verdict.js — tests mutate just the
// field(s) needed to redirect it down a specific WATCH/AVOID_SELL branch,
// same baseline-mutation pattern as decisionEngine.test.js.
const BASE_R = {
  symbol: 'TEST', name: 'Test Co', sector: 'Technology',
  price: 100, high52w: 102, low52w: 60, low10Day: 95,
  pctFromHigh: -2, pctFromLow: 60,
  volRatio20: 2.0, volRatioMaxN: 2.0, volRatioMaxNDaysAgo: 0, volumeConfirmed: true,
  rsiValue: 60,
  adxValue: 30,
  ema10: 99, ema21: 97, ema50: 90, emaFullStack: true,
  macdPosture: 'BULLISH', macdHistogram: 0.5, macdHistDirection: 'RISING',
  alligatorPhase: 'EATING_UP',
  atr14: 2,
  ret1m: 10, ret3m: 20,
  rsRank: 90,
  sectorStatus: 'HOT',
  signalType: 'BUY_BREAKOUT',
  grade: 'A+',
  gradeReasons: [],
  earningsDaysAway: 30,
  earningsDate: '2099-01-01',
  earningsSource: 'CONFIRMED',
  tradePlan: null,
  thesis: null,
  avwapFromHigh: { value: 95, vsPricePct: 5.0, signal: 'BULLISH' },
}

function verdictFor(overrides) {
  const r = { ...BASE_R, ...overrides }
  const a = analyzeStock(r, PORTFOLIO_OPTIONS)
  return { r, a, v: getVerdict(r, a) }
}

describe('getVerdict', () => {
  it('maps decision.action BUY (everything confirmed) to BUY_NOW', () => {
    const { v } = verdictFor({})
    expect(v.verdict).toBe('BUY_NOW')
    expect(v.tier).toBe('green')
    expect(v.headline).toBe('Buy Now')
  })

  it('maps WAIT (volume too light) to WATCH, not AVOID — FIX 2', () => {
    const { a, v } = verdictFor({ volRatio20: 0.8, volRatioMaxN: 0.8, volRatioMaxNDaysAgo: 0 })
    expect(a.decision.action).toBe('WAIT')
    expect(v.verdict).toBe('WATCH')
  })

  it('maps WAIT (RSI overbought, >72) to WATCH, not AVOID — FIX 2', () => {
    const { a, v } = verdictFor({ rsiValue: 80 })
    expect(a.decision.action).toBe('WAIT')
    expect(v.verdict).toBe('WATCH')
  })

  it('maps WAIT (extended past the high) to WATCH', () => {
    const { a, v } = verdictFor({ signalType: null, pctFromHigh: 10 })
    expect(a.decision.action).toBe('WAIT')
    expect(v.verdict).toBe('WATCH')
  })

  it('maps WAIT (APPROACHING signal) to WATCH', () => {
    const { a, v } = verdictFor({ signalType: 'APPROACHING', pctFromHigh: -6 })
    expect(a.decision.action).toBe('WAIT')
    expect(v.verdict).toBe('WATCH')
  })

  it('maps WAIT (grade B) to WATCH', () => {
    const { a, v } = verdictFor({ grade: 'B' })
    expect(a.decision.action).toBe('WAIT')
    expect(v.verdict).toBe('WATCH')
  })

  it('maps decision.action WATCH (signalType WATCH) to WATCH verdict too', () => {
    const { a, v } = verdictFor({ signalType: 'WATCH', pctFromHigh: -3 })
    expect(a.decision.action).toBe('WATCH')
    expect(v.verdict).toBe('WATCH')
  })

  it('a trade plan that failed on stop/sizing mechanics (not structural weakness) maps to WATCH, not AVOID — FIX 2 (the GLW case)', () => {
    const { a, v } = verdictFor({ tradePlan: { viable: false, reason: 'Tightest available stop requires 18.3% risk (> 8% max) — skip' } })
    expect(a.decision.action).toBe('AVOID')
    expect(v.verdict).toBe('WATCH')
    expect(v.reason.toLowerCase()).toContain('stop')
  })

  it('Alligator still WAKING (not EATING_UP) holds an otherwise-BUY setup at WATCH, never promoted to BUY_NOW', () => {
    const { a, v } = verdictFor({ alligatorPhase: 'WAKING' })
    expect(a.decision.action).toBe('BUY')
    expect(v.verdict).toBe('WATCH')
    expect(v.reason.toLowerCase()).toContain('trend')
  })

  it('grade C maps to AVOID_SELL', () => {
    const { a, v } = verdictFor({ grade: 'C' })
    expect(a.decision.action).toBe('AVOID')
    expect(v.verdict).toBe('AVOID_SELL')
    expect(v.tier).toBe('red')
  })

  it('Alligator EATING_DOWN maps to AVOID_SELL with a Sell headline', () => {
    const { a, v } = verdictFor({ alligatorPhase: 'EATING_DOWN' })
    expect(a.decision.action).toBe('SELL')
    expect(v.verdict).toBe('AVOID_SELL')
    expect(v.headline).toBe('Sell')
  })

  it('weak card (RS 37, bearish AVWAP, cold sector) maps to AVOID_SELL — FIX 2 (the EA case)', () => {
    const { v } = verdictFor({
      rsRank: 37,
      avwapFromHigh: { value: 95, vsPricePct: -3, signal: 'BEARISH' },
      sectorStatus: 'COLD',
    })
    expect(v.verdict).toBe('AVOID_SELL')
    expect(v.tier).toBe('red')
  })

  it('UNKNOWN earnings (no calendar entry, no history) on an otherwise-strong card caps it at WATCH, never AVOID', () => {
    const { v } = verdictFor({ earningsDaysAway: null, earningsDate: null, earningsSource: 'UNKNOWN' })
    expect(v.verdict).toBe('WATCH')
    expect(v.evidence.earningsUnknown).toBe(true)
    expect(v.evidence.earningsSource).toBe('UNKNOWN')
    expect(v.reason.toLowerCase()).toContain('earnings')
  })

  it('CONFIRMED earnings 4 days out triggers AVOID_SELL — the real, unwidened threshold', () => {
    const { v } = verdictFor({ earningsDaysAway: 4, earningsDate: '2099-02-01', earningsSource: 'CONFIRMED' })
    expect(v.verdict).toBe('AVOID_SELL')
    expect(v.evidence.earningsUnknown).toBe(false)
  })

  it('ESTIMATED earnings inside the widened danger window caps it at WATCH with a verify flag, NOT AVOID', () => {
    // Real buffer is 7 days; ESTIMATED widens it by the ±14d pad, so 10 days
    // out is still inside the danger window for an estimate even though it
    // would clear the real 7-day buffer for a CONFIRMED date.
    const { v } = verdictFor({ earningsDaysAway: 10, earningsDate: '2099-02-01', earningsSource: 'ESTIMATED' })
    expect(v.verdict).toBe('WATCH')
    expect(v.reason.toLowerCase()).toContain('estimate')
  })

  it('ESTIMATED earnings comfortably outside the widened window is a soft-clear, still reaches BUY_NOW', () => {
    const { v } = verdictFor({ earningsDaysAway: 30, earningsDate: '2099-03-01', earningsSource: 'ESTIMATED' })
    expect(v.verdict).toBe('BUY_NOW')
  })

  it('reason is always a single sentence, never a joined list', () => {
    const { v } = verdictFor({ volRatio20: 0.8, volRatioMaxN: 0.8, rsiValue: 80, grade: 'B' })
    expect(v.reason.split('. ').length).toBeLessThanOrEqual(1)
    expect(v.reason).not.toContain(';')
  })

  it('every output carries grade/signal/indicator evidence, not a competing call', () => {
    const { v } = verdictFor({})
    expect(v.evidence.grade).toBe('A+')
    expect(v.evidence.signal).toBe('Breakout confirmed')
    expect(v.evidence.indicators.length).toBeGreaterThan(0)
  })
})

describe('bucketResultsByVerdict (Quick Lists regression guard)', () => {
  it('places every result in exactly one bucket — no dropped reasons', () => {
    const results = [
      { ...BASE_R, symbol: 'BUY1' },
      { ...BASE_R, symbol: 'WAIT_VOL', volRatio20: 0.8, volRatioMaxN: 0.8 },
      { ...BASE_R, symbol: 'WAIT_RSI', rsiValue: 80 },
      { ...BASE_R, symbol: 'WAIT_EXT', signalType: null, pctFromHigh: 10 },
      { ...BASE_R, symbol: 'WAIT_APPROACH', signalType: 'APPROACHING', pctFromHigh: -6 },
      { ...BASE_R, symbol: 'WAIT_GRADEB', grade: 'B' },
      { ...BASE_R, symbol: 'WAIT_STOPFAIL', tradePlan: { viable: false, reason: 'Tightest available stop requires 18% risk (> 8% max) — skip' } },
      { ...BASE_R, symbol: 'WAIT_ALLIGATOR', alligatorPhase: 'WAKING' },
      { ...BASE_R, symbol: 'WAIT_EARNINGS_UNKNOWN', earningsDaysAway: null, earningsDate: null, earningsSource: 'UNKNOWN' },
      { ...BASE_R, symbol: 'WAIT_EARNINGS_ESTIMATED_SOON', earningsDaysAway: 10, earningsDate: '2099-02-01', earningsSource: 'ESTIMATED' },
      { ...BASE_R, symbol: 'WATCH_SIGNAL', signalType: 'WATCH', pctFromHigh: -3 },
      { ...BASE_R, symbol: 'AVOID_GRADE_C', grade: 'C' },
      { ...BASE_R, symbol: 'AVOID_EARNINGS_SOON', earningsDaysAway: 4, earningsDate: '2099-02-01', earningsSource: 'CONFIRMED' },
      { ...BASE_R, symbol: 'AVOID_RS_WEAK', rsRank: 37, avwapFromHigh: { value: 95, vsPricePct: -3, signal: 'BEARISH' }, sectorStatus: 'COLD' },
      { ...BASE_R, symbol: 'SELL_ALLIGATOR', alligatorPhase: 'EATING_DOWN' },
    ]

    const buckets = bucketResultsByVerdict(results, PORTFOLIO_OPTIONS)
    const bucketed = [...buckets.buyNow, ...buckets.watch, ...buckets.avoidSell]

    expect(bucketed.length).toBe(results.length)
    const bucketedSymbols = new Set(bucketed.map((entry) => entry.r.symbol))
    for (const r of results) expect(bucketedSymbols.has(r.symbol)).toBe(true)

    expect(buckets.buyNow.map((e) => e.r.symbol)).toEqual(['BUY1'])
    expect(buckets.watch.map((e) => e.r.symbol).sort()).toEqual(
      [
        'WAIT_APPROACH', 'WAIT_EXT', 'WAIT_GRADEB', 'WAIT_RSI', 'WAIT_VOL',
        'WAIT_STOPFAIL', 'WAIT_ALLIGATOR', 'WAIT_EARNINGS_UNKNOWN', 'WAIT_EARNINGS_ESTIMATED_SOON', 'WATCH_SIGNAL',
      ].sort()
    )
    expect(buckets.avoidSell.map((e) => e.r.symbol).sort()).toEqual(
      ['AVOID_GRADE_C', 'AVOID_EARNINGS_SOON', 'AVOID_RS_WEAK', 'SELL_ALLIGATOR'].sort()
    )
  })
})
