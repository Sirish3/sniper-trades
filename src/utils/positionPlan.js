// Deterministic position-sizing, stop-selection, and trim-plan engine — pure
// arithmetic on already-computed indicators, no LLM involved. Mirrors the
// trading rules verbatim:
//   Stop:  tightest of (10-day low, 21 EMA, base/pivot low, entry - 2.5*ATR),
//          rejected outright if even the tightest is > 8% from entry.
//   Size:  Risk $ = portfolio * riskPct (1.5% Risk On / 0.75% Risk Neutral /
//          0% Risk Off), shares = Risk $ / stop distance, capped at 10% of
//          portfolio per position and 25% of portfolio per sector, scaled to
//          50% for B-grade setups, blocked outright past 8 open positions.
//   Trims: 25% at +1.5R (stop -> breakeven), 25% at +2.5R (stop -> Trim 1
//          price), remaining 50% trailed at 2.5x ATR with no fixed target.

export const RISK_PCT_BY_ENVIRONMENT = { on: 0.015, neutral: 0.0075, off: 0 }
export const MAX_STOP_PCT = 0.08
export const MAX_POSITION_PCT = 0.10
export const MAX_SECTOR_PCT = 0.25
export const MAX_OPEN_POSITIONS = 8
export const B_GRADE_SCALE = 0.5
export const ATR_STOP_MULT = 2.5
export const TRIM1_R = 1.5
export const TRIM2_R = 2.5
export const TRIM1_PCT = 0.25
export const TRIM2_PCT = 0.25
export const TIME_STOP_DAYS = 10
export const PARABOLIC_RSI = 82
export const PARABOLIC_PCT_20D = 40

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// Picks the tightest (closest-to-price) of the four stop methods, each only
// considered if it's a real, positive level below price. Returns
// { viable: false, reason } if none qualify or the tightest is still > 8%.
export function selectStop({ price, low10Day, ema21, baseLow, atr14 }) {
  const candidates = [
    ['10-day low', low10Day],
    ['21 EMA', ema21],
    ['base/pivot low', baseLow],
    ['entry - 2.5x ATR', atr14 != null ? price - ATR_STOP_MULT * atr14 : null],
  ].filter(([, level]) => level != null && level > 0 && level < price)

  if (candidates.length === 0) {
    return { viable: false, reason: 'No valid stop level below current price' }
  }

  const [method, stopPrice] = candidates.reduce((best, c) => (c[1] > best[1] ? c : best))
  const riskPct = (price - stopPrice) / price

  if (riskPct > MAX_STOP_PCT) {
    return { viable: false, reason: `Tightest available stop requires ${(riskPct * 100).toFixed(1)}% risk (> ${MAX_STOP_PCT * 100}% max) — skip` }
  }

  return { viable: true, stopPrice: round(stopPrice), method, riskPct: round(riskPct * 100) }
}

// Applies the risk-environment-scaled risk budget plus the hard portfolio
// limits (10% per position, 25% per sector, 8 open positions, 50% for
// B-grade). Returns { viable: false, reason } if blocked outright.
export function sizePosition({ portfolioSize, price, stopPrice, grade, riskEnvironment, openPositions, sector }) {
  if ((openPositions?.length ?? 0) >= MAX_OPEN_POSITIONS) {
    return { viable: false, reason: `Already at the ${MAX_OPEN_POSITIONS}-position max — close something before adding` }
  }

  const riskPct = RISK_PCT_BY_ENVIRONMENT[riskEnvironment] ?? RISK_PCT_BY_ENVIRONMENT.neutral
  if (riskPct <= 0) {
    return { viable: false, reason: 'Risk Off — no new positions' }
  }

  const riskPerShare = price - stopPrice
  if (riskPerShare <= 0) return { viable: false, reason: 'Stop is not below entry' }

  const riskBudget = portfolioSize * riskPct
  let shares = Math.floor(riskBudget / riskPerShare)

  const maxPositionShares = Math.floor((portfolioSize * MAX_POSITION_PCT) / price)
  shares = Math.min(shares, maxPositionShares)

  const sectorValue = (openPositions ?? [])
    .filter((p) => p.sector === sector)
    .reduce((sum, p) => sum + p.shares * p.entryPrice, 0)
  const sectorBudgetRemaining = Math.max(0, portfolioSize * MAX_SECTOR_PCT - sectorValue)
  const maxSectorShares = Math.floor(sectorBudgetRemaining / price)
  shares = Math.min(shares, maxSectorShares)

  if (grade === 'B') shares = Math.floor(shares * B_GRADE_SCALE)

  if (shares <= 0) {
    return { viable: false, reason: maxSectorShares <= 0 ? 'Sector concentration cap (25%) reached' : 'Position size rounds to 0 shares' }
  }

  const positionValue = shares * price
  const riskAmount = shares * riskPerShare

  return {
    viable: true,
    riskPct: round(riskPct * 100, 2),
    shares,
    positionValue: round(positionValue),
    positionPct: round((positionValue / portfolioSize) * 100),
    riskAmount: round(riskAmount),
    riskAmountPct: round((riskAmount / portfolioSize) * 100),
    cappedByPosition: shares === maxPositionShares && maxPositionShares < Math.floor(riskBudget / riskPerShare),
    cappedBySector: shares === maxSectorShares,
  }
}

// Three-stage exit plan: Trim 1 (25% @ +1.5R, stop -> breakeven), Trim 2
// (25% @ +2.5R, stop -> Trim 1 price), Trim 3 (remaining 50%, ATR-trailed,
// no fixed target). `atr14` is only needed for display of today's trailing
// level; the trail itself is recomputed daily by evaluatePosition.
export function buildTrimPlan({ price, stopPrice, shares, atr14 }) {
  const riskPerShare = price - stopPrice
  const trim1Price = price + TRIM1_R * riskPerShare
  const trim2Price = price + TRIM2_R * riskPerShare
  const trim1Shares = Math.round(shares * TRIM1_PCT)
  const trim2Shares = Math.round(shares * TRIM2_PCT)
  const trim3Shares = shares - trim1Shares - trim2Shares

  return {
    trim1: { price: round(trim1Price), shares: trim1Shares, triggerR: TRIM1_R, stopAfter: round(price) },
    trim2: { price: round(trim2Price), shares: trim2Shares, triggerR: TRIM2_R, stopAfter: round(trim1Price) },
    trim3: { shares: trim3Shares, atrTrailStop: atr14 != null ? round(price - ATR_STOP_MULT * atr14) : null },
    timeStopDays: TIME_STOP_DAYS,
  }
}
