// 52-week-high ENTRY FILTER — a literal, ordered 14-rule PASS/CAUTION/FAIL
// screen plus a market/sector regime dampener and a simple stop/size
// calculator, layered ON TOP of (not replacing) the existing grade/
// signalType/tradePlan pipeline in weekHighScreener.js and positionPlan.js.
//
// Kept deliberately separate from weekHighScreener.js's own A+/A/B/C grading
// because the two systems encode genuinely different philosophies:
//   - gradeWeekHighSetup() is a weighted, mostly-continuous quality score
//     (a stock can miss a couple of A+ criteria and still grade A).
//   - evaluateEntryFilter() below is a literal "all 14 must pass" gate, with
//     explicit UNKNOWN states for data this app can't determine (ATH status,
//     serial-high history, base quality) that intentionally downgrade to
//     CAUTION rather than being silently treated as a pass.
// Replacing the existing grading with this would throw away a lot of tuned,
// validated logic (see weekHighScreener.js's own module history); adding it
// as a second, clearly-labeled lens lets both coexist without one silently
// overriding the other.
//
// Any rule whose required input is missing/unknown never fails outright —
// it's UNKNOWN, which (like CAUTION) prevents an overall PASS but doesn't
// force an overall FAIL. Only a rule with real data that actually violates
// its threshold produces FAIL. See evaluateEntryFilter's status rollup.

import { checkMarketRegime } from './marketRegime'
import { checkSectorRegimes } from './sectorRegime'

export const ENTRY_PCT_FROM_HIGH_MIN = -2
export const ENTRY_PCT_FROM_HIGH_MAX = 0
export const BREAKOUT_VOLUME_MIN = 1.5
export const GAP_MAX_PCT = 7 // stricter end of the spec's 7-10% range
export const RSI_MIN = 55
export const RSI_MAX = 75
export const RSI_EXTENDED = 80
export const EXTENSION_CAUTION_PCT = 15
export const EXTENSION_FAIL_PCT = 20
export const ADX_MIN = 20
export const RS_RANK_MIN = 80
export const LIQUIDITY_FLOOR_USD = 20_000_000
export const EARNINGS_AVOID_TRADING_DAYS = 5

function round(value, decimals = 2) {
  if (value == null) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function rule(n, label, status, detail) {
  return { n, label, status, detail }
}

// ── The 14 numbered entry-filter rules, evaluated in order ─────────────────
function evaluateRules(r) {
  const rules = []

  rules.push(
    r.pctFromHigh == null
      ? rule(1, 'Within 2% of 52W high', 'UNKNOWN', 'No 52W high data')
      : r.pctFromHigh >= ENTRY_PCT_FROM_HIGH_MIN && r.pctFromHigh <= ENTRY_PCT_FROM_HIGH_MAX
        ? rule(1, 'Within 2% of 52W high', 'PASS', `${r.pctFromHigh.toFixed(1)}% from high`)
        : rule(1, 'Within 2% of 52W high', 'FAIL', `${r.pctFromHigh.toFixed(1)}% from high (need -2% to 0%)`)
  )

  rules.push(
    r.firstNewHighIn3Months == null
      ? rule(2, 'First new high in 3 months (not serial)', 'UNKNOWN', 'Not enough history to check — verify')
      : r.firstNewHighIn3Months
        ? rule(2, 'First new high in 3 months (not serial)', 'PASS', 'No prior new high in trailing 3 months')
        : rule(2, 'First new high in 3 months (not serial)', 'FAIL', 'Repeated/serial new-high maker')
  )

  rules.push(
    r.baseQuality == null
      ? rule(3, 'Base quality (6-8wk, ≤20% range)', 'UNKNOWN', 'Not enough pre-breakout history — verify')
      : r.baseQuality.tight
        ? rule(3, 'Base quality (6-8wk, ≤20% range)', 'PASS', `${r.baseQuality.durationDays}d range, ${r.baseQuality.rangePct.toFixed(1)}% (estimate — verify chart)`)
        : rule(3, 'Base quality (6-8wk, ≤20% range)', 'CAUTION', `${r.baseQuality.durationDays}d range, ${r.baseQuality.rangePct.toFixed(1)}% wide (estimate — verify chart)`)
  )

  // Never determinable from this app's ~1-year Alpaca history — always
  // UNKNOWN, informational only, never itself forces the overall status
  // below (only listed for visibility; see evaluateEntryFilter).
  rules.push(rule(4, 'All-time high (no overhead resistance)', 'UNKNOWN', "Can't be determined — Alpaca free-tier history is ~13 months, not enough to know if this is also an ATH"))

  rules.push(
    r.volRatio50AtBreakout == null
      ? rule(5, 'Breakout-day volume ≥1.5x 50d avg', 'UNKNOWN', 'No breakout-day volume data')
      : r.volRatio50AtBreakout >= BREAKOUT_VOLUME_MIN
        ? rule(5, 'Breakout-day volume ≥1.5x 50d avg', 'PASS', `${r.volRatio50AtBreakout.toFixed(2)}x on breakout day`)
        : rule(5, 'Breakout-day volume ≥1.5x 50d avg', 'FAIL', `${r.volRatio50AtBreakout.toFixed(2)}x on breakout day (need ≥1.5x)`)
  )

  rules.push(
    r.breakoutGapPct == null
      ? rule(6, `No gap >${GAP_MAX_PCT}% on breakout day`, 'UNKNOWN', 'No gap data for breakout day')
      : r.breakoutGapPct <= GAP_MAX_PCT
        ? rule(6, `No gap >${GAP_MAX_PCT}% on breakout day`, 'PASS', `${r.breakoutGapPct >= 0 ? '+' : ''}${r.breakoutGapPct.toFixed(1)}% gap`)
        : rule(6, `No gap >${GAP_MAX_PCT}% on breakout day`, 'FAIL', `+${r.breakoutGapPct.toFixed(1)}% gap — exhaustion risk`)
  )

  rules.push(
    r.rsiValue == null
      ? rule(7, `RSI ${RSI_MIN}-${RSI_MAX}`, 'UNKNOWN', 'No RSI data')
      : r.rsiValue > RSI_EXTENDED
        ? rule(7, `RSI ${RSI_MIN}-${RSI_MAX}`, 'FAIL', `RSI ${r.rsiValue.toFixed(0)} — extended`)
        : r.rsiValue >= RSI_MIN && r.rsiValue <= RSI_MAX
          ? rule(7, `RSI ${RSI_MIN}-${RSI_MAX}`, 'PASS', `RSI ${r.rsiValue.toFixed(0)}`)
          : rule(7, `RSI ${RSI_MIN}-${RSI_MAX}`, 'FAIL', `RSI ${r.rsiValue.toFixed(0)} outside range`)
  )

  rules.push(
    r.extensionFrom50EmaPct == null
      ? rule(8, `Extension from 50 EMA ≤${EXTENSION_CAUTION_PCT}-${EXTENSION_FAIL_PCT}%`, 'UNKNOWN', 'No 50 EMA data')
      : r.extensionFrom50EmaPct > EXTENSION_FAIL_PCT
        ? rule(8, `Extension from 50 EMA ≤${EXTENSION_CAUTION_PCT}-${EXTENSION_FAIL_PCT}%`, 'FAIL', `+${r.extensionFrom50EmaPct.toFixed(1)}% above 50 EMA — chasing`)
        : r.extensionFrom50EmaPct > EXTENSION_CAUTION_PCT
          ? rule(8, `Extension from 50 EMA ≤${EXTENSION_CAUTION_PCT}-${EXTENSION_FAIL_PCT}%`, 'CAUTION', `+${r.extensionFrom50EmaPct.toFixed(1)}% above 50 EMA`)
          : rule(8, `Extension from 50 EMA ≤${EXTENSION_CAUTION_PCT}-${EXTENSION_FAIL_PCT}%`, 'PASS', `+${r.extensionFrom50EmaPct.toFixed(1)}% above 50 EMA`)
  )

  rules.push(
    r.adxValue == null
      ? rule(9, `ADX ≥${ADX_MIN}`, 'UNKNOWN', 'No ADX data')
      : r.adxValue >= ADX_MIN
        ? rule(9, `ADX ≥${ADX_MIN}`, 'PASS', `ADX ${r.adxValue.toFixed(0)}`)
        : rule(9, `ADX ≥${ADX_MIN}`, 'FAIL', `ADX ${r.adxValue.toFixed(0)} (need ≥${ADX_MIN})`)
  )

  rules.push(
    r.macdPosture == null
      ? rule(10, 'MACD trend bullish', 'UNKNOWN', 'No MACD data')
      : r.macdPosture === 'BULLISH'
        ? rule(10, 'MACD trend bullish', 'PASS', 'MACD bullish')
        : rule(10, 'MACD trend bullish', 'FAIL', 'MACD bearish')
  )

  rules.push(
    rule(11, 'EMA stack bullish (10>20>50)', r.emaFullStack ? 'PASS' : 'FAIL', r.emaFullStack ? '10>20>50 aligned' : 'Not aligned')
  )

  rules.push(
    r.rsRank == null
      ? rule(12, `RS Rank ≥${RS_RANK_MIN}`, 'UNKNOWN', 'No RS rank yet')
      : r.rsRank >= RS_RANK_MIN
        ? rule(12, `RS Rank ≥${RS_RANK_MIN}`, 'PASS', `RS rank ${r.rsRank}`)
        : rule(12, `RS Rank ≥${RS_RANK_MIN}`, 'FAIL', `RS rank ${r.rsRank} (need ≥${RS_RANK_MIN})`)
  )

  rules.push(
    r.avgDollarVolume20 == null
      ? rule(13, 'Liquidity ≥$20M/day', 'UNKNOWN', 'No dollar-volume data')
      : r.avgDollarVolume20 >= LIQUIDITY_FLOOR_USD
        ? rule(13, 'Liquidity ≥$20M/day', 'PASS', `$${(r.avgDollarVolume20 / 1e6).toFixed(1)}M/day`)
        : rule(13, 'Liquidity ≥$20M/day', 'FAIL', `$${(r.avgDollarVolume20 / 1e6).toFixed(1)}M/day (need ≥$20M)`)
  )

  rules.push(
    r.earningsDaysAway == null
      ? rule(14, `No earnings within ${EARNINGS_AVOID_TRADING_DAYS} trading days`, 'UNKNOWN', 'Earnings date unknown — verify before entry')
      : r.earningsDaysAway > EARNINGS_AVOID_TRADING_DAYS
        ? rule(14, `No earnings within ${EARNINGS_AVOID_TRADING_DAYS} trading days`, 'PASS', `Earnings in ${r.earningsDaysAway}d`)
        : r.earningsSource === 'ESTIMATED'
          ? rule(14, `No earnings within ${EARNINGS_AVOID_TRADING_DAYS} trading days`, 'CAUTION', `Earnings ~${r.earningsDaysAway}d away (estimated) — verify`)
          : rule(14, `No earnings within ${EARNINGS_AVOID_TRADING_DAYS} trading days`, 'FAIL', `Earnings in ${r.earningsDaysAway}d — uncontrolled gap risk`)
  )

  return rules
}

// ── Market/sector regime dampener ───────────────────────────────────────────
// Fetched ONCE per scan (not per stock) via WeekHighScreener.jsx, then looked
// up per result by sector. Reuses marketRegime.js/sectorRegime.js's existing
// fetches rather than adding new network calls.
export async function fetchEntryFilterRegime() {
  const [marketResult, sectorResult] = await Promise.allSettled([
    checkMarketRegime(),
    checkSectorRegimes(),
  ])

  const marketAbove50 = marketResult.status === 'fulfilled' ? marketResult.value.spyAbove50 : null
  const sectorBySector = sectorResult.status === 'fulfilled' ? sectorResult.value.bySector : {}
  const warnings = []
  if (marketResult.status === 'rejected') warnings.push(`Market regime check failed: ${marketResult.reason?.message ?? 'unknown error'}`)
  if (sectorResult.status === 'fulfilled') warnings.push(...(sectorResult.value.warnings ?? []))
  else warnings.push('Sector regime check failed')

  return { marketAbove50, sectorBySector, warnings }
}

// Regime is a DAMPENER, not a veto (per spec) — it never turns a rule-based
// PASS/FAIL result into something else on its own, it only ever prevents an
// otherwise-clean PASS from reporting as PASS (downgraded to CAUTION) and
// halves the simple position size below. Unknown regime data (fetch failure)
// is never treated as a violation — same "don't punish a missing fetch"
// philosophy as everywhere else in this app.
function regimeCautionFor(sector, regime) {
  const sectorAbove50 = regime.sectorBySector?.[sector]?.above50 ?? null
  const reasons = []
  if (regime.marketAbove50 === false) reasons.push('S&P 500 below its 50-day MA')
  if (sectorAbove50 === false) reasons.push(`${sector || 'sector'} ETF below its 50-day MA`)
  return { caution: reasons.length > 0, reasons, marketAbove50: regime.marketAbove50, sectorAbove50 }
}

// ── Overall rollup ───────────────────────────────────────────────────────
// A single real FAIL anywhere fails the whole entry filter (rules 1-14 are
// "all must be true for a PASS" per spec). Any CAUTION or UNKNOWN (missing
// data this app genuinely can't determine, e.g. ATH status) prevents a clean
// PASS but doesn't force a FAIL — it downgrades to CAUTION, matching rules
// 2/3/4's own explicit "flag CAUTION/UNKNOWN — verify" escape hatches,
// extended consistently to every rule rather than only the three the spec
// called out by name. The market/sector regime dampener applies last, same
// non-veto rule.
export function evaluateEntryFilter(r, regime) {
  const rules = evaluateRules(r)
  // Rule 4 (ATH) is never determinable — exclude it from the pass/fail
  // rollup so every single stock isn't permanently capped at CAUTION for a
  // question this app can never answer either way.
  const scored = rules.filter((x) => x.n !== 4)

  const hasFail = scored.some((x) => x.status === 'FAIL')
  const hasSoft = scored.some((x) => x.status === 'CAUTION' || x.status === 'UNKNOWN')
  let status = hasFail ? 'FAIL' : hasSoft ? 'CAUTION' : 'PASS'

  const regimeResult = regimeCautionFor(r.sector, regime)
  if (status === 'PASS' && regimeResult.caution) status = 'CAUTION'

  return { status, rules, regime: regimeResult }
}

// Attaches `entryFilter` to every result in place — call after
// classifyWeekHighResults (needs rsRank already computed) and after
// fetchEntryFilterRegime (one regime fetch shared across the whole scan).
export function attachEntryFilters(results, regime) {
  for (const r of results) {
    r.entryFilter = evaluateEntryFilter(r, regime)
  }
}

// ── Additive simple stop/size calculator (literal spec formula) ────────────
// Deliberately NOT a replacement for positionPlan.js's selectStop/
// sizePosition (tightest-of-4-stops, risk-environment-scaled, portfolio/
// sector caps) — that engine is the one actually wired into "Build Trade
// Plans" / trims / thesis generation elsewhere in this app, and replacing it
// would discard a lot of tuned, validated logic for a much simpler formula.
// This is a separate, explicitly-labeled quick-reference number using
// exactly the formula given: stop = wider (further from entry) of
// entry-1.5xATR and entry*0.95; size = 1% account risk, halved in a
// CAUTION regime.
export function computeSimpleTradePlan(r, accountSize, regimeCaution) {
  if (r.price == null || r.atr14 == null) {
    return { viable: false, reason: 'Missing price or ATR data' }
  }
  const atrStopPrice = r.price - 1.5 * r.atr14
  const fixedStopPrice = r.price * 0.95
  // "Wider" = further from entry = the LOWER of the two stop prices.
  const stopPrice = Math.min(atrStopPrice, fixedStopPrice)
  const stopMethod = atrStopPrice <= fixedStopPrice ? '1.5x ATR' : '5% fixed'

  const riskPerShare = r.price - stopPrice
  if (riskPerShare <= 0) return { viable: false, reason: 'Stop is not below entry' }

  const riskBudget = accountSize * 0.01
  let shares = Math.floor(riskBudget / riskPerShare)
  if (regimeCaution) shares = Math.floor(shares / 2)
  if (shares <= 0) return { viable: false, reason: 'Position size rounds to 0 shares' }

  const dollarRisk = shares * riskPerShare

  return {
    viable: true,
    entryPrice: round(r.price),
    atrStopPrice: round(atrStopPrice),
    fixedStopPrice: round(fixedStopPrice),
    stopPrice: round(stopPrice),
    stopMethod,
    riskPct: round((riskPerShare / r.price) * 100),
    shares,
    dollarRisk: round(dollarRisk),
    dollarRiskPct: round((dollarRisk / accountSize) * 100, 2),
    regimeHalved: !!regimeCaution,
  }
}
