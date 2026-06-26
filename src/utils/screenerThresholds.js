// Single source of truth for the tunable numbers introduced by the
// volume-window, verdict-split, and earnings-handling correctness fixes
// (weekHighScreener.js, stockAnalysis.js, verdict.js). Pre-existing
// grade/signal thresholds that predate this file (e.g. gradeWeekHighSetup's
// A+ bar) stay where they are — only what these specific fixes need or
// reuse lives here. Values are unchanged from where they previously lived;
// this file relocates them, it doesn't loosen or tighten anything.

export const THRESHOLDS = {
  // Volume confirmed over a window, not a single bar — a stock that broke
  // out on big volume and is now resting on a quiet day shouldn't read as
  // "volume FAIL". Anchored tight (5 days) so a random high-volume day
  // weeks ago can't pass it.
  volumeBreakoutWindowDays: 5,
  volumeMustFloor: 1.2, // was weekHighScreener.js's GRADE_C_MIN_VOL_RATIO
  volumeStrongFloor: 1.5, // was weekHighScreener.js's STRONG_VOLUME_RATIO

  // Structural-weakness AVOID_SELL criteria (verdict.js) — reserved for
  // genuine weakness, not a strong setup missing one timing gate.
  rsRankWeakMax: 40, // "well below 70"
  sectorColdRsOverride: 85, // mirrors makeDecision()'s existing sector-COLD override, unchanged
  rsiWeakMax: 35, // mirrors makeDecision()'s existing SELL threshold, unchanged

  // Earnings buffer (verdict.js) — mirrors stockAnalysis.js's
  // EARNINGS_BLOCK_DAYS, the canonical "too close to earnings" cutoff.
  // Only a CONFIRMED earnings date is held to this real threshold.
  // Source-provider-agnostic: earningsProvider.js (currently a yfinance
  // microservice client — see earnings_service/) only has to return
  // { date, daysAway, source }; the cache TTL, request politeness, and
  // self-estimate cadence/tolerance for THAT provider live in
  // earnings_service.py's own config block, not here, since they're
  // specific to whatever sits behind the swappable interface.
  earningsBufferDays: 7,
  // An ESTIMATED date (self-estimated, or provider-returned but not
  // confirmed) carries ~±2-week real-world error, so every threshold that
  // gates on "days to earnings" is widened by this much for ESTIMATED
  // dates — an estimate can never produce a confident "clear".
  earningsEstimatedPadDays: 14,

  // RULE CHANGE, default OFF — being A/B tested across a full scan before
  // being trusted (see classifySignalType's BUY_RETEST trend-confirmation
  // check in weekHighScreener.js). ADX and the Williams Alligator are both
  // trend-confirmation tools; when ON, an exceptionally strong ADX reading
  // can stand in for the Alligator not yet being EATING_UP — but only to
  // promote an already-excellent (grade A/A+) setup, never to rescue a
  // weak one, and never when the Alligator is EATING_DOWN (a real
  // downtrend, not a lagging confirmation, is never overridden).
  adxConfirmsTrend: false,
  adxStrongTrendConfirm: 40, // start conservative — only true outliers like URI's 41.5 clear this
}
