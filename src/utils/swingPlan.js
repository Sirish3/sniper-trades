import { ema, emaSlopeUp, weeklyCloses, macd, rsi, volumeRatio, pctChange, adx, atr } from './indicators'
import { fetchBars, fetchEarningsCalendar, fetchIntradayVolume } from './marketData'
import { getFundamentals } from './finnhubApi'
import { checkMarketRegime, classifyRiskEnvironment } from './marketRegime'
import { checkSectorRegimes } from './sectorRegime'
import { getRiskEventsThisWeek } from './economicCalendar'
import { classifyEntrySignal, detectBase } from './entrySignal'
import { selectStop, sizePosition, buildTrimPlan } from './positionPlan'

// Sending the whole framework's worth of data per ticker to Claude gets
// expensive fast — cap how many scan results get a full candidate build.
export const MAX_SWING_CANDIDATES = 15
export const DEFAULT_PORTFOLIO_SIZE = 100000

const CANDIDATE_BATCH_SIZE = 5
const CANDIDATE_BATCH_DELAY_MS = 1000
const EMA_SLOPE_LOOKBACK = 5
const SECTOR_HEAT_TOP = 3
const SECTOR_HEAT_BOTTOM = 2

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// Stage 5 — picks the tightest of the 4 stop methods (10-day low / 21 EMA /
// base-pivot low / entry - 2.5x ATR), sizes the position off the
// risk-environment-scaled risk budget plus the 10%-position/25%-sector/
// 8-position/B-grade-50% limits, then builds the 3-stage trim plan. Returns
// `{ viable: false, reason }` at whichever step blocks the trade.
function buildTradePlan({ price, low10Day, ema21, baseLow, atr14, grade, sector, portfolioSize, riskEnvironment, openPositions }) {
  const stop = selectStop({ price, low10Day, ema21, baseLow, atr14 })
  if (!stop.viable) return stop

  const sizing = sizePosition({ portfolioSize, price, stopPrice: stop.stopPrice, grade, riskEnvironment, openPositions, sector })
  if (!sizing.viable) return sizing

  const trimPlan = buildTrimPlan({ price, stopPrice: stop.stopPrice, shares: sizing.shares, atr14 })

  return { viable: true, stopPrice: stop.stopPrice, stopMethod: stop.method, ...sizing, ...trimPlan }
}

// Fetches ~400 days of OHLCV plus earnings calendar, Finnhub fundamentals,
// and today's intraday volume for one ticker, and computes the real-data
// parts of Stages 1/2/3/4/5 from the framework — including Stage 4 (entry
// type: breakout / pullback / base breakout, via classifyEntrySignal) and
// Stage 5 (stop/size/trim plan, via positionPlan.js). Only the written
// thesis is left to Claude. `portfolioOptions` is `{ portfolioSize,
// riskEnvironment, openPositions }` from getMarketCondition()/positions.js.
// Returns `{ symbol, name, sector, error }` if data couldn't be fetched.
export async function buildSwingCandidate(result, portfolioOptions) {
  const { symbol, name, sector, grade } = result

  let bars
  try {
    bars = await fetchBars(symbol)
  } catch (err) {
    return { symbol, name, sector, error: err.message }
  }

  if (bars.length < 60) return { symbol, name, sector, error: 'Insufficient price history' }

  const closes = bars.map((b) => b.c)
  const highs = bars.map((b) => b.h)
  const lows = bars.map((b) => b.l)
  const volumes = bars.map((b) => b.v)
  const price = closes[closes.length - 1]

  const ema10 = ema(closes, 10)
  const ema20 = ema(closes, 20)
  const ema21 = ema(closes, 21)
  const ema50 = ema(closes, 50)
  const ema10SlopeUp = emaSlopeUp(closes, 10, EMA_SLOPE_LOOKBACK)
  const ema20SlopeUp = emaSlopeUp(closes, 20, EMA_SLOPE_LOOKBACK)
  const ema50SlopeUp = emaSlopeUp(closes, 50, EMA_SLOPE_LOOKBACK)

  const weekly = weeklyCloses(bars)
  const weeklyEma20 = weekly.length >= 20 ? ema(weekly, 20) : null

  const macdData = macd(closes)
  const rsiValue = rsi(closes, 14)
  const volRatio = volumeRatio(volumes, 20)
  const pct10Day = pctChange(closes, 10)
  const adxValue = adx(highs, lows, closes, 14)
  const atr14 = atr(bars, 14)
  const low10Day = Math.min(...lows.slice(-10))
  const baseLow = detectBase(bars).baseLow ?? null

  const last252 = bars.slice(-252)
  const week52High = Math.max(...last252.map((b) => b.h))
  const week52Low = Math.min(...last252.map((b) => b.l))
  const pctFromHigh = ((price - week52High) / week52High) * 100

  const [earnings, fundamentals, intraday] = await Promise.all([
    fetchEarningsCalendar(symbol, 5, 7),
    getFundamentals(symbol),
    fetchIntradayVolume(symbol),
  ])

  const entrySignal = classifyEntrySignal(bars, intraday)

  let earningsRecent = null
  let earningsUpcoming = null
  const earningsDates = []
  if (earnings != null) {
    earningsRecent = false
    earningsUpcoming = false
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (const e of earnings) {
      if (!e.date) continue
      earningsDates.push(e.date)
      const diffDays = Math.round((new Date(`${e.date}T00:00:00Z`) - today) / 86400000)
      if (diffDays < 0 && diffDays >= -5) earningsRecent = true
      if (diffDays >= 0 && diffDays <= 7) earningsUpcoming = true
    }
  }

  // --- Stage 1: liquidity & quality ---
  const stage1Reasons = []
  const stage1Unknowns = []

  if (!(price >= 5 && price <= 500)) stage1Reasons.push(`Price $${price.toFixed(2)} outside $5-$500 range`)
  if (!/^[A-Z]{1,5}$/.test(symbol)) stage1Reasons.push(`Ticker "${symbol}" has a non-standard suffix`)

  if (fundamentals.marketCap == null) stage1Unknowns.push('Market cap unavailable')
  else if (fundamentals.marketCap < 300e6) {
    stage1Reasons.push(`Market cap $${Math.round(fundamentals.marketCap / 1e6)}M < $300M minimum`)
  }

  if (fundamentals.avgVolume10D == null) stage1Unknowns.push('Average daily volume unavailable')
  else if (fundamentals.avgVolume10D < 500000) {
    stage1Reasons.push(`Avg daily volume ${Math.round(fundamentals.avgVolume10D).toLocaleString()} < 500,000 minimum`)
  }

  stage1Unknowns.push('Float, SPAC/warrant/leveraged-ETF status not screened — verify manually')

  // --- Stage 2: trend (EMA stack) ---
  const stage2Reasons = []
  const stage2Unknowns = []

  if (ema10 == null || ema20 == null || ema50 == null) {
    stage2Unknowns.push('EMA stack unavailable (insufficient history)')
  } else {
    if (!(ema10 > ema20 && ema20 > ema50)) {
      stage2Reasons.push(`EMA stack not bullish (10: ${ema10.toFixed(2)}, 20: ${ema20.toFixed(2)}, 50: ${ema50.toFixed(2)})`)
    }
    if (!(price > ema50)) stage2Reasons.push(`Price $${price.toFixed(2)} below 50 EMA $${ema50.toFixed(2)}`)
  }

  for (const [label, slope] of [['10', ema10SlopeUp], ['20', ema20SlopeUp], ['50', ema50SlopeUp]]) {
    if (slope == null) stage2Unknowns.push(`${label} EMA slope unavailable`)
    else if (!slope) stage2Reasons.push(`${label} EMA not sloping up over the last ${EMA_SLOPE_LOOKBACK} sessions`)
  }

  if (weeklyEma20 == null) stage2Unknowns.push('Weekly 20 EMA unavailable')
  else if (!(price > weeklyEma20)) {
    stage2Reasons.push(`Price below weekly 20 EMA $${weeklyEma20.toFixed(2)} — weekly downtrend`)
  }

  // --- Stage 3: momentum quality ---
  const stage3Reasons = []
  const stage3Unknowns = []

  if (!macdData) {
    stage3Unknowns.push('MACD unavailable')
  } else {
    const histNow = macdData.histogram
    const histRising = histNow > macdData.histPrev && macdData.histPrev > macdData.histPrev2
    if (!histRising) stage3Reasons.push('MACD histogram not rising over the last 2 sessions')
    if (!(macdData.value > macdData.signal)) stage3Reasons.push('MACD line not above signal line')
    if (!(histNow > 0)) stage3Reasons.push('MACD histogram not above zero')
  }

  if (rsiValue == null) {
    stage3Unknowns.push('RSI unavailable')
  } else if (!(rsiValue >= 45 && rsiValue <= 68)) {
    stage3Reasons.push(rsiValue > 68 ? `RSI ${rsiValue.toFixed(1)} > 68 — overbought` : `RSI ${rsiValue.toFixed(1)} < 45 — weak momentum`)
  }

  if (pct10Day == null) stage3Unknowns.push('10-day price change unavailable')
  else if (pct10Day > 20) stage3Reasons.push(`Up ${pct10Day.toFixed(1)}% in the last 10 trading days — too extended`)

  if (!(pctFromHigh >= -15)) stage3Reasons.push(`${Math.abs(pctFromHigh).toFixed(1)}% below 52-week high — too far from highs`)

  if (earningsRecent == null) {
    stage3Unknowns.push('Earnings calendar unavailable')
  } else {
    if (earningsRecent) stage3Reasons.push('Earnings released within the last 5 days')
    if (earningsUpcoming) stage3Reasons.push('Earnings within the next 7 days — gap risk')
  }

  if (adxValue == null) {
    stage3Unknowns.push('ADX unavailable')
  } else {
    const macdStrong = macdData && macdData.histogram > 0 && macdData.value > macdData.signal
    const rsiStrong = rsiValue != null && rsiValue >= 45 && rsiValue <= 68
    if (adxValue <= 20) stage3Reasons.push(`ADX ${adxValue.toFixed(1)} <= 20 — no directional trend (chop)`)
    else if (adxValue < 25 && !(macdStrong && rsiStrong)) {
      stage3Reasons.push(`ADX ${adxValue.toFixed(1)} in the 20-25 range without strong MACD/RSI confirmation`)
    }
  }

  const valuationNotes = []
  if (fundamentals.peg != null) {
    valuationNotes.push(`PEG ${fundamentals.peg.toFixed(2)} ${fundamentals.peg < 2.0 ? '(< 2.0, OK)' : '(>= 2.0, elevated)'}`)
  } else {
    valuationNotes.push('PEG unavailable')
  }
  valuationNotes.push('Forward P/E and revenue growth YoY not available')

  const { portfolioSize = DEFAULT_PORTFOLIO_SIZE, riskEnvironment = 'neutral', openPositions = [] } = portfolioOptions ?? {}
  const tradePlan = buildTradePlan({
    price, low10Day, ema21, baseLow, atr14, grade, sector, portfolioSize, riskEnvironment, openPositions,
  })

  const avgVolume20 = volumes.length >= 20 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null

  const stage1Pass = stage1Reasons.length === 0
  const stage2Pass = stage2Reasons.length === 0
  const stage3Pass = stage3Reasons.length === 0
  const stage4Pass = entrySignal.type !== 'NONE' && entrySignal.valid

  return {
    symbol,
    name,
    sector,
    grade,
    price: round(price),
    ema10: round(ema10),
    ema20: round(ema20),
    ema21: round(ema21),
    ema50: round(ema50),
    weeklyEma20: round(weeklyEma20),
    rsi: round(rsiValue, 1),
    adx: round(adxValue, 1),
    atr14: round(atr14),
    volumeRatio: round(volRatio),
    avgVolume20: avgVolume20 != null ? Math.round(avgVolume20) : null,
    macd: macdData
      ? {
          value: round(macdData.value, 4),
          signal: round(macdData.signal, 4),
          histogram: round(macdData.histogram, 4),
          histPrev: round(macdData.histPrev, 4),
          histPrev2: round(macdData.histPrev2, 4),
        }
      : null,
    pct10Day: round(pct10Day),
    week52High: round(week52High),
    week52Low: round(week52Low),
    pctFromHigh: round(pctFromHigh),
    low10Day: round(low10Day),
    marketCap: fundamentals.marketCap != null ? Math.round(fundamentals.marketCap) : null,
    avgVolume10D: fundamentals.avgVolume10D != null ? Math.round(fundamentals.avgVolume10D) : null,
    peg: round(fundamentals.peg),
    earningsDates,
    valuationNotes,
    stage1: { pass: stage1Pass, reasons: stage1Reasons, unknowns: stage1Unknowns },
    stage2: { pass: stage2Pass, reasons: stage2Reasons, unknowns: stage2Unknowns },
    stage3: { pass: stage3Pass, reasons: stage3Reasons, unknowns: stage3Unknowns },
    stage4: { pass: stage4Pass, ...entrySignal },
    tradePlan,
    allStagesPass: stage1Pass && stage2Pass && stage3Pass && stage4Pass && tradePlan.viable,
  }
}

// Builds candidates for up to MAX_SWING_CANDIDATES of `results` (rate-limited
// in small batches), returning { candidates, truncated, totalAvailable }.
// `portfolioOptions` is `{ portfolioSize, riskEnvironment, openPositions }`,
// forwarded to buildSwingCandidate for Stage 5 sizing.
export async function buildSwingCandidates(results, portfolioOptions, onProgress) {
  const subset = results.slice(0, MAX_SWING_CANDIDATES)
  const candidates = []

  for (let i = 0; i < subset.length; i += CANDIDATE_BATCH_SIZE) {
    const batch = subset.slice(i, i + CANDIDATE_BATCH_SIZE)
    const batchResults = await Promise.all(batch.map((r) => buildSwingCandidate(r, portfolioOptions)))
    candidates.push(...batchResults)
    onProgress?.(candidates.length, subset.length)

    if (i + CANDIDATE_BATCH_SIZE < subset.length) {
      await new Promise((resolve) => setTimeout(resolve, CANDIDATE_BATCH_DELAY_MS))
    }
  }

  return { candidates, truncated: results.length > MAX_SWING_CANDIDATES, totalAvailable: results.length }
}

// SPY/QQQ trend, VIX level, sector heat, this week's risk events, and the
// Risk On/Neutral/Off environment used both for the report's "MARKET
// CONDITIONS" block and for Stage 5 position-sizing's risk-per-trade. FOMC
// week is folded into riskEnvironment via classifyRiskEnvironment, but the
// exact FOMC time isn't available from any data source here, so the report
// should still say "verify manually" for that specific line.
export async function getMarketCondition() {
  try {
    const [regime, sectors] = await Promise.all([checkMarketRegime(), checkSectorRegimes().catch(() => null)])

    const hotSectors = sectors?.list?.slice(0, SECTOR_HEAT_TOP).map((s) => s.sector) ?? []
    const weakSectors = sectors?.list?.slice(-SECTOR_HEAT_BOTTOM).map((s) => s.sector) ?? []

    return {
      available: true,
      spyPrice: round(regime.spyPrice),
      spySma50: round(regime.spySma50),
      spyAboveSma50: regime.spyAbove50,
      spyAbove200: regime.spyAbove200,
      spyEma21: round(regime.spyEma21),
      spyAbove21: regime.spyAbove21,
      spyTrendLabel: regime.spyTrendLabel,
      qqqPrice: round(regime.qqqPrice),
      qqqSma50: round(regime.qqqSma50),
      qqqAboveSma50: regime.qqqAbove50,
      vixCurrent: round(regime.vixCurrent, 1),
      vixAbove25: regime.vixCurrent > 25,
      vixLabel: regime.vixLabel,
      regimeScore: regime.regimeScore,
      regimeLabel: regime.regimeLabel,
      riskEnvironment: classifyRiskEnvironment(regime.regimeScore),
      hotSectors,
      weakSectors,
      riskEvents: getRiskEventsThisWeek(),
    }
  } catch {
    return { available: false, riskEnvironment: 'neutral' }
  }
}
