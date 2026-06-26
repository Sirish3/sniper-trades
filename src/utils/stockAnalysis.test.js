import { describe, it, expect } from 'vitest'
import { analyzeStock } from './stockAnalysis'

const PORTFOLIO_OPTIONS = { portfolioSize: 100000, riskEnvironment: 'neutral', openPositions: [] }

// A complete result object that clears every BUY condition in makeDecision()
// — same baseline pattern as verdict.test.js's BASE_R. Tests mutate just the
// MACD fields needed to exercise the FIX (histogram DIRECTION vs
// line-vs-signal POSTURE no longer collide under one name).
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
  avwapFromHigh: { value: 95, vsPricePct: 5.0, signal: 'BULLISH' },
}

describe('analyseIndicators — FIX (MACD momentum vs posture no longer collide)', () => {
  it('rising histogram + bearish posture (the URI case) shows BOTH readings without contradiction', () => {
    const r = { ...BASE_R, macdHistDirection: 'RISING', macdPosture: 'BEARISH' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    expect(a.indicators.macdMomentum.value).toBe('RISING')
    expect(a.indicators.macdMomentum.status).toBe('PASS')
    expect(a.indicators.macdTrend.value).toBe('BEARISH')
  })

  it('a bearish posture is lagging context only — never reads as a hard FAIL', () => {
    const r = { ...BASE_R, macdHistDirection: 'RISING', macdPosture: 'BEARISH' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    expect(a.indicators.macdTrend.status).not.toBe('FAIL')
  })

  it('is NOT blocked from BUY-eligibility solely by a bearish posture', () => {
    const r = { ...BASE_R, macdHistDirection: 'RISING', macdPosture: 'BEARISH' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    expect(a.decision.action).toBe('BUY')
  })

  it('control: the same setup with a bullish posture also resolves to BUY', () => {
    const r = { ...BASE_R, macdHistDirection: 'RISING', macdPosture: 'BULLISH' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    expect(a.decision.action).toBe('BUY')
  })

  it('missing MACD data degrades both rows to DATA_MISSING, not a false reading', () => {
    const r = { ...BASE_R, macdHistDirection: null, macdPosture: null }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    expect(a.indicators.macdMomentum.status).toBe('DATA_MISSING')
    expect(a.indicators.macdTrend.status).toBe('DATA_MISSING')
  })
})

describe('gradeBreakdown — FIX label rename (no more "MACD rising" colliding with the indicator row)', () => {
  it('the criteria list names this row "MACD momentum", sourced from macdHistDirection', () => {
    const r = { ...BASE_R, macdHistDirection: 'FALLING' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)

    const criterion = a.gradeBreakdown.criteria.find((c) => c.name === 'MACD momentum')
    expect(criterion).toBeDefined()
    expect(criterion.value).toBe('FALLING')
    expect(criterion.result).toBe('WARN')
  })
})

// makeDecision() doesn't compute r.trendConfirmedBy itself — that's
// weekHighScreener.js's classifySignalType (see its own test suite for the
// guard logic). These tests treat trendConfirmedBy as an already-computed
// upstream field (same convention BASE_R already uses for signalType/grade)
// and check that makeDecision (a) still applies every other BUY requirement
// regardless of which path confirmed the trend, and (b) surfaces the
// override in the BUY reason text for auditability.
describe('makeDecision — ADX-override visibility (THRESHOLDS.adxConfirmsTrend)', () => {
  const adxOverrideRetest = {
    ...BASE_R,
    signalType: 'BUY_RETEST',
    alligatorPhase: 'WAKING',
    adxValue: 41.5,
    trendConfirmedBy: 'ADX_OVERRIDE',
  }

  it('a BUY granted via the ADX override still reaches decision.action BUY when everything else is clean', () => {
    const a = analyzeStock(adxOverrideRetest, PORTFOLIO_OPTIONS)
    expect(a.decision.action).toBe('BUY')
  })

  it('the BUY reason text names the override and the ADX value, for auditing', () => {
    const a = analyzeStock(adxOverrideRetest, PORTFOLIO_OPTIONS)
    expect(a.decision.summary).toMatch(/ADX/)
    expect(a.decision.summary).toMatch(/41\.5/)
  })

  it('a BUY_RETEST tagged ALLIGATOR (the normal path) gets the unmodified summary, no ADX mention', () => {
    const r = { ...BASE_R, signalType: 'BUY_RETEST', trendConfirmedBy: 'ALLIGATOR' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)
    expect(a.decision.action).toBe('BUY')
    expect(a.decision.summary).not.toMatch(/ADX/)
  })

  it('the override does not bypass OTHER BUY requirements — earnings too close still blocks it', () => {
    const r = { ...adxOverrideRetest, earningsDaysAway: 5, earningsSource: 'CONFIRMED' }
    const a = analyzeStock(r, PORTFOLIO_OPTIONS)
    expect(a.decision.action).not.toBe('BUY')
  })
})
