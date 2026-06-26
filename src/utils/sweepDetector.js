// Liquidity sweep detection — reads the daily bars already fetched for the
// AVWAP panel (no new API call) to find whether price recently pierced
// below the AVWAP from the 52-week high (triggering stops) and then
// reclaimed it. A clean sweep + reclaim is one of the highest-probability
// entries for this strategy: weak hands get shaken out on the wick, then
// real buyers step back in above the level.
//
// Adapted to daily-bar resolution rather than the tick/intraday data a
// live sweep monitor would use: a bar's LOW piercing below the AVWAP while
// its CLOSE reclaims (same bar or within a few sessions) is the daily-chart
// signature of the same event. "Duration" is trading days, not hours.

export const SWEEP_STATUS = {
  ABOVE: 'above',
  TESTING: 'testing',
  SWEEPING: 'sweeping',
  RECLAIMED: 'reclaimed',
  FAILED: 'failed',
}

const LOOKBACK_DAYS = 10
const TESTING_BAND_PCT = 0.5
const SWEEP_MAX_DEPTH_PCT = 3.0
const SWEEP_MAX_AGE_DAYS = 3

function gradeSweep({ depthPct, durationDays, volVsAvg }) {
  let score = 0
  if (depthPct >= 0.3 && depthPct <= 1.0) score += 3
  else if (depthPct <= 2.0) score += 2
  else if (depthPct <= 3.0) score += 1

  if (durationDays === 0) score += 3
  else if (durationDays === 1) score += 2
  else if (durationDays <= 3) score += 1

  if (volVsAvg >= 2.0) score += 2
  else if (volVsAvg >= 1.5) score += 1

  // Max 8 (depth 3 + speed 3 + volume 2) — no dark-pool/delta-reversal
  // bonus here since daily bars alone don't carry that information.
  if (score >= 7) return 'A'
  if (score >= 5) return 'B'
  if (score >= 3) return 'C'
  return 'F'
}

// `bars` must be the same sorted (oldest->newest) array buildAvwapAnalysis()
// returned, and `series` the from_52w_high anchor's per-bar AVWAP series
// (same length, same order) — both already computed, zero extra cost.
export function detectSweep(bars, series) {
  const n = bars.length
  if (n === 0 || series.length !== n) return null

  const lastAvwap = series[n - 1].avwap
  if (lastAvwap == null) return null

  const last = bars[n - 1]
  const pctVsAvwap = ((last.c - lastAvwap) / lastAvwap) * 100

  const window = []
  for (let i = Math.max(0, n - LOOKBACK_DAYS); i < n; i++) {
    if (series[i].avwap == null) continue
    window.push({ bar: bars[i], avwap: series[i].avwap, idx: i })
  }

  // The deepest recent bar whose low pierced below its AVWAP — the sweep
  // candidate.
  let sweepBar = null
  for (const w of window) {
    const depthPct = ((w.avwap - w.bar.l) / w.avwap) * 100
    if (depthPct > 0 && (!sweepBar || depthPct > sweepBar.depthPct)) {
      sweepBar = { ...w, depthPct }
    }
  }

  if (!sweepBar) {
    if (pctVsAvwap > TESTING_BAND_PCT) return { status: SWEEP_STATUS.ABOVE, pctVsAvwap, event: null }
    if (pctVsAvwap > -TESTING_BAND_PCT) return { status: SWEEP_STATUS.TESTING, pctVsAvwap, event: null }
    if (pctVsAvwap > -SWEEP_MAX_DEPTH_PCT) return { status: SWEEP_STATUS.SWEEPING, pctVsAvwap, event: null }
    return { status: SWEEP_STATUS.FAILED, pctVsAvwap, event: null }
  }

  // First bar from the sweep onward whose CLOSE reclaims back above its AVWAP.
  let reclaimIdx = null
  for (let i = sweepBar.idx; i < n; i++) {
    if (series[i].avwap == null) continue
    if (bars[i].c > series[i].avwap) { reclaimIdx = i; break }
  }

  const avgVol = bars.slice(Math.max(0, n - 20)).reduce((sum, b) => sum + b.v, 0) / Math.min(20, n)
  const volVsAvg = avgVol > 0 ? sweepBar.bar.v / avgVol : 1

  if (reclaimIdx == null) {
    const daysSinceSweep = n - 1 - sweepBar.idx
    if (sweepBar.depthPct > SWEEP_MAX_DEPTH_PCT || daysSinceSweep > SWEEP_MAX_AGE_DAYS) {
      return { status: SWEEP_STATUS.FAILED, pctVsAvwap, event: { ...sweepBar, volVsAvg } }
    }
    return { status: SWEEP_STATUS.SWEEPING, pctVsAvwap, event: { ...sweepBar, volVsAvg } }
  }

  const durationDays = reclaimIdx - sweepBar.idx
  const grade = gradeSweep({ depthPct: sweepBar.depthPct, durationDays, volVsAvg })

  return {
    status: SWEEP_STATUS.RECLAIMED,
    pctVsAvwap,
    event: {
      sweepDate: sweepBar.bar.t.slice(0, 10),
      sweepLow: sweepBar.bar.l,
      depthPct: sweepBar.depthPct,
      reclaimDate: bars[reclaimIdx].t.slice(0, 10),
      durationDays,
      volVsAvg,
      grade,
    },
  }
}
