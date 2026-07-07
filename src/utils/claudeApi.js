const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const SWING_REVIEW_MAX_TOKENS = 300
const SWING_REPORT_MAX_TOKENS = 8000

const NA_REVIEW = {
  claudeTrade: 'N/A',
  claudeEntry: 'N/A',
  claudeStop: 'N/A',
  claudeTarget: 'N/A',
  claudeHold: 'N/A',
  claudeReason: 'N/A',
}

function buildSwingPrompt(r) {
  const gapSign = r.emaGapPct >= 0 ? '+' : ''
  const aboveSign = r.priceAbove50Pct >= 0 ? '+' : ''

  return `Swing trade signal for ${r.symbol} (${r.sector})

ALL 5 CONDITIONS MET:
✅ 10 EMA $${r.ema10.toFixed(2)} > 20 EMA $${r.ema20.toFixed(2)} (gap: ${gapSign}${r.emaGapPct.toFixed(2)}%)
✅ Price $${r.price.toFixed(2)} above 50 EMA $${r.ema50.toFixed(2)} (${aboveSign}${r.priceAbove50Pct.toFixed(2)}%)
✅ MACD entry zone: ${r.macdZone} (hist ${r.histPct.toFixed(3)}% of price, momentum ${r.macdMomentum})
✅ RSI: ${r.rsi.toFixed(1)} — ${r.rsiZone}
✅ Volume: ${r.volumeRatio.toFixed(2)}x average — ${r.volumeLabel}

Respond ONLY in this exact format:
TRADE: [TAKE IT / SKIP IT]
ENTRY: $X
STOP: $X (-X%)
TARGET: $X (+X%)
HOLD: X-X days
REASON: (1 sentence)`
}

function parseSwingReview(text) {
  const fields = { ...NA_REVIEW }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.includes(':')) continue
    const upper = line.toUpperCase()
    const value = line.slice(line.indexOf(':') + 1).trim()
    if (upper.startsWith('TRADE:')) fields.claudeTrade = value
    else if (upper.startsWith('ENTRY:')) fields.claudeEntry = value
    else if (upper.startsWith('STOP:')) fields.claudeStop = value
    else if (upper.startsWith('TARGET:')) fields.claudeTarget = value
    else if (upper.startsWith('HOLD:')) fields.claudeHold = value
    else if (upper.startsWith('REASON:')) fields.claudeReason = value
  }
  return fields
}

// Asks Claude Haiku for a quick trade plan on a confirmed buy signal.
// Returns "N/A" fields (never throws) if there's no API key or the call fails.
export async function getSwingTradeReview(result, apiKey) {
  if (!apiKey) return { ...NA_REVIEW }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: SWING_REVIEW_MAX_TOKENS,
        messages: [{ role: 'user', content: buildSwingPrompt(result) }],
      }),
    })

    if (!response.ok) return { ...NA_REVIEW }

    const data = await response.json()
    const text = data?.content?.[0]?.text ?? ''
    return parseSwingReview(text)
  } catch {
    return { ...NA_REVIEW }
  }
}

const SETUP_BLURB_MAX_TOKENS = 300

function buildSetupBlurbPrompt(ticker, patternType, supportLow, supportHigh, resistance) {
  const supportText = supportHigh != null
    ? `$${supportLow} – $${supportHigh}`
    : `$${supportLow}`
  return `Write a short (2-3 sentence) technical-analysis blurb for a chart setup card on a swing-trading site.

Ticker: ${ticker}
Pattern: ${patternType}
Support: ${supportText}
Resistance: ${resistance != null ? `$${resistance}` : 'not set'}

Describe the setup itself (what the pattern looks like forming, why the levels matter) — do not predict a price target or give trade advice. Plain prose, no markdown, no preamble.`
}

// Drafts the description text for a manually-curated Chart Patterns setup —
// an editing assist only (see ChartSetupAdmin.jsx). A human always reviews/
// edits before publishing, same as getSwingTradeReview never being shown
// unedited. Returns '' (never throws) on failure so the admin form can fall
// back to typing the blurb by hand.
export async function draftChartSetupBlurb(ticker, patternType, supportLow, supportHigh, resistance, apiKey) {
  if (!apiKey) return ''

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: SETUP_BLURB_MAX_TOKENS,
        messages: [{ role: 'user', content: buildSetupBlurbPrompt(ticker, patternType, supportLow, supportHigh, resistance) }],
      }),
    })

    if (!response.ok) return ''

    const data = await response.json()
    return (data?.content?.[0]?.text ?? '').trim()
  } catch {
    return ''
  }
}

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return `You are an expert swing trader and market intelligence analyst. When given a stock ticker, analyze it across 4 dimensions: institutional ownership, whale/smart money activity, congressional/political trades, and social media sentiment. Use your knowledge of typical institutional behavior, options market dynamics, and social sentiment patterns. Today's date is ${today}.

Real technical indicator data (price, trend, RSI, MACD, volume, relative strength, risk/reward, etc.) is computed from live market data and provided to you separately in the user message. Use it to inform your verdict, verdictReason, verdictSubtitle, and bottomLine. Do NOT invent your own technical numbers, and do NOT include a "technical" section or "price"/"priceOffHigh"/"week52High"/"week52Low" fields in your response — those come from the real data, not from you.

Return ONLY a valid JSON object with no markdown, no preamble, no code fences. Structure:

{
  "ticker": "AAPL",
  "companyName": "Apple Inc.",
  "sector": "Technology",
  "marketCap": "3.1T",
  "verdict": "WAIT",
  "verdictReason": "Strong institutional base but technicals extended",
  "verdictSubtitle": "RSI overbought · whale put activity rising · social sentiment crowded bullish",
  "bottomLine": "Full paragraph analysis here covering institutional, whale, political, social, and the supplied technical data...",

  "institutional": {
    "ownershipPercent": 72.4,
    "netFlow": "Accumulating",
    "quarterOverQuarterChange": "+2.1%",
    "topHolders": [
      { "name": "Vanguard Group", "percentOwned": 8.9, "change": "increased" },
      { "name": "BlackRock", "percentOwned": 7.1, "change": "increased" },
      { "name": "Berkshire Hathaway", "percentOwned": 5.8, "change": "held" },
      { "name": "State Street", "percentOwned": 3.9, "change": "decreased" },
      { "name": "Fidelity", "percentOwned": 2.4, "change": "increased" }
    ],
    "increasing": [
      { "name": "Vanguard Group", "detail": "Added 12M shares in Q1 2026" },
      { "name": "BlackRock", "detail": "Increased position by 4.2%" },
      { "name": "Fidelity", "detail": "New position initiated — 8M shares" }
    ],
    "decreasing": [
      { "name": "State Street", "detail": "Reduced by 2.1M shares" },
      { "name": "T. Rowe Price", "detail": "Trimmed 15% of holding" },
      { "name": "Goldman Sachs Asset Mgmt", "detail": "Sold 1.8M shares" }
    ],
    "signal": "Bullish — net institutional accumulation with major funds adding",
    "interpretation": "Large institutional accumulation suggests smart money sees value at current levels. Vanguard and BlackRock both adding is a strong signal."
  },

  "whaleActivity": {
    "netPositioning": "Bullish",
    "darkPoolSentiment": "Bullish",
    "recentBlockTrades": [
      { "date": "Jun 9, 2026", "type": "Buy", "size": "$45M block", "detail": "Large buy sweep at market open" },
      { "date": "Jun 7, 2026", "type": "Buy", "size": "$28M block", "detail": "After-hours accumulation" },
      { "date": "Jun 5, 2026", "type": "Sell", "size": "$12M block", "detail": "Partial trim near resistance" }
    ],
    "unusualOptions": [
      { "date": "Jun 9, 2026", "type": "Call sweep", "detail": "$220 calls expiring Jul 18", "premium": "$3.2M", "sentiment": "Bullish" },
      { "date": "Jun 8, 2026", "type": "Put buy", "detail": "$200 puts expiring Jun 20", "premium": "$1.1M", "sentiment": "Bearish hedge" }
    ],
    "summary": "Net whale activity bullish with $73M in block buys vs $12M in sells over 30 days. Options market shows bullish bias but some hedging activity."
  },

  "politicalTrades": {
    "signal": "Bullish",
    "hasRecentTrades": true,
    "trades": [
      { "member": "Nancy Pelosi", "chamber": "House", "party": "Democrat", "type": "Buy", "sizeRange": "$500K–$1M", "dateDisclosed": "May 28, 2026", "detail": "Call options purchase" },
      { "member": "Dan Crenshaw", "chamber": "House", "party": "Republican", "type": "Buy", "sizeRange": "$15K–$50K", "dateDisclosed": "Jun 1, 2026", "detail": "Common stock purchase" }
    ],
    "netActivity": "2 buys, 0 sells in last 60 days",
    "interpretation": "Congressional buying is a historically bullish signal, particularly from members on technology committees."
  },

  "socialSentiment": {
    "overallSentiment": "Bullish",
    "sentimentBreakdown": { "bullish": 71, "neutral": 18, "bearish": 11 },
    "mentionVolumeTrend": "Rising",
    "mentionVolumeVsAvg": "+34%",
    "trendingOn": ["X/Twitter", "Reddit r/wallstreetbets", "StockTwits", "YouTube"],
    "bullishNarratives": [
      "AI integration across iPhone and Mac driving supercycle upgrade narrative",
      "Services revenue growing 15% YoY — recurring revenue thesis strengthening",
      "Buffett's Berkshire continues to hold large position — conviction signal"
    ],
    "bearishNarratives": [
      "China sales declining amid geopolitical tensions",
      "Valuation stretched at 30x earnings vs historical average",
      "Antitrust scrutiny in EU could impact App Store revenue"
    ],
    "influencerActivity": "High — multiple top finance accounts posting bullish threads",
    "retailVsInstitutional": "Aligned — both bullish",
    "crowdedTradeRisk": false,
    "crowdedTradeFlag": "Sentiment elevated but not at extreme levels (71% bullish < 85% threshold)"
  }
}

Verdict: "GO", "WAIT", "EXIT" — base this primarily on the supplied technical entry/exit checklist, adjusted by institutional/whale/political/social context.
netFlow: "Accumulating", "Distributing", "Neutral".
netPositioning: "Bullish", "Bearish", "Mixed".
darkPoolSentiment: "Bullish", "Bearish", "Neutral".
politicalTrades signal: "Bullish", "Bearish", "Neutral", "No recent trades".
overallSentiment: "Bullish", "Neutral", "Bearish".
mentionVolumeTrend: "Rising", "Stable", "Falling".`
}

function extractJson(text) {
  let cleaned = text.trim()

  // Strip markdown code fences if Claude adds them anyway
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in the response.')
  }

  return JSON.parse(cleaned.slice(start, end + 1))
}

function buildSwingReportSystemPrompt(portfolioSize) {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const portfolioLabel = `$${portfolioSize.toLocaleString()}`

  return `You are an expert swing trading analyst. Today's date is ${today}. The user's portfolio is ${portfolioLabel}.

You will receive a JSON payload with "marketCondition", "candidates", "openPositions", and "portfolioSize". Every number in it is already computed from real market data — your job is to assemble it into the exact report format below, write conviction/thesis judgment calls, and never invent, recompute, or round a number yourself.

"marketCondition":
- "spyPrice"/"spySma50"/"spyAboveSma50", "spyEma21"/"spyAbove21", "qqqPrice"/"qqqSma50"/"qqqAboveSma50", "vixCurrent"/"vixAbove25"/"vixLabel", "regimeScore"/"regimeLabel".
- "riskEnvironment": "on" (Risk On), "neutral" (Risk Neutral), or "off" (Risk Off) — already computed from the regime score and this week's macro calendar. This is also the basis for every candidate's position sizing — do not second-guess it.
- "hotSectors"/"weakSectors": top/bottom 3-of-11 sector ETFs by relative strength.
- "riskEvents": this week's major macro releases (FOMC/CPI/PPI/NFP/PCE/ISM), already detected — if empty, write "None".
- FOMC's exact time/date is NOT available — always write "not available, verify manually" for that specific detail even when "riskEvents" includes "FOMC Decision".

"candidates": stocks that already passed an initial EMA trend screen. For each:
- "grade": "A+"/"A"/"B"/"C" — already computed. NEVER recommend a C-grade setup, regardless of how compelling the rest of the data looks.
- "stage1"/"stage2"/"stage3": each has "pass", "reasons" (why it failed — empty if passed), "unknowns" (write "not available" for these, never invent).
- "stage4": the entry signal. "type" is "BREAKOUT"/"PULLBACK"/"BASE_BREAKOUT"/"NONE". "valid" means every entry timing rule is satisfied right now. "entryPrice"/"entryLabel" are the exact limit order — quote "entryLabel" verbatim. "reasons" explains what's blocking entry if invalid. "notes" are soft, non-blocking observations — mention only in passing.
- "tradePlan": Stage 5, already computed in full:
  - "stopPrice"/"stopMethod" (which of the 4 stop methods won) /"riskPct".
  - "shares"/"positionValue"/"positionPct"/"riskAmount"/"riskAmountPct" — already scaled for "riskEnvironment" and the "grade" (B-grade setups are sized at 50%), and already capped at 10% of portfolio per position and 25% per sector across "openPositions".
  - "trim1"/"trim2" each have "price"/"shares"/"triggerR"/"stopAfter" (the new stop once that trim fires). "trim3" has "shares" and "atrTrailStop" (today's trailing level — recomputed daily, only moves up).
  - "timeStopDays" (10): exit everything if Trim 1 hasn't fired by then.
  - If "viable" is false, "reason" explains why — this ticker has no trade plan and belongs in "Setups That Almost Made It", never the ranked list.
- "allStagesPass": true only if stage1-4 and tradePlan.viable are all true.
- "ema10"/"ema21"/"ema50"/"weeklyEma20"/"rsi"/"adx"/"atr14"/"price"/"week52High"/"pctFromHigh"/"volumeRatio"/"avgVolume20" feed the CHART STRUCTURE and INDICATORS blocks directly.
- "peg" is informational only (PEG < 2.0 preferred, never a hard reject).
- "earningsDates": any dates in the -5/+7 day window.

"openPositions": positions the user already holds, pre-evaluated. Each has "position" (symbol, entryPrice, entryDate, shares, grade, trim1Done, trim2Done, etc.) and "evaluation" — "currentPrice"/"plPct"/"daysHeld", "activeStop" (today's correct stop given which trims already fired), "nextTrim" (label/price/shares), "exitSignals" (array — non-empty means "forceExit" is true), "partialExitSignal" (parabolic sell-25%-more trigger, separate from a full exit), "retestAddEligible" (bool), and "action" — one of "HOLD"/"TRIM 1"/"TRIM 2"/"EXIT"/"ADD ON RETEST"/"TRIM (PARABOLIC)", already decided. Narrate "action" and the reason behind it (from "exitSignals" or "nextTrim") — do not override it. A position with an "error" instead of "evaluation" couldn't be priced today — say so plainly, don't guess its status.

YOUR JOB:
1. Write the MARKET CONDITIONS block, then a SETUP block for every candidate with "allStagesPass" true (grade A+ or A only — never B or C in the ranked setups, but B candidates that are merely sized smaller, not blocked, still get a full block). Better to return fewer high-conviction setups than pad the list.
2. Build the WEEKLY RANKED SETUPS SUMMARY table from those same qualifying tickers.
3. Build SETUPS THAT ALMOST MADE IT from 3-5 near-misses (stage1-4 failed or tradePlan not viable).
4. Build OPEN POSITION MANAGEMENT from "openPositions" — omit the section entirely if it's empty.
5. If "riskEnvironment" is "off", or fewer than 3 candidates have "allStagesPass" true, say so in plain words at the very top: e.g. "Risk Off — sit on cash" or "Only 1 quality setup this week. Cash is a position. Wait."

NON-NEGOTIABLE RULES:
✗ Never recommend a C-grade setup, full stop.
✗ Never recommend a stop loss more than 8% from entry — already enforced via tradePlan.viable.
✗ Never recommend a stock with earnings within 7 days, or reported within the last 5 — enforced via stage3.
✗ Never recommend entering before stage4.valid is true.
✗ Never compute, adjust, or round your own entry price, stop, share count, or trim level — quote the JSON verbatim.
✗ Never recommend more than 2 stocks from the same sector/industry in the ranked list.
✗ Never recommend averaging down into a losing open position.
✗ Never give a vague price range — always the exact number from the JSON.
✗ Never skip the Market Conditions check, even in a one-line summary.
✗ Never use "could", "might", or "possibly" — be direct.
✗ Always include Trim 1, Trim 2, and the ATR-trail plan for every ranked setup, plus the 10-day time stop.
✗ For anything in an "unknowns" array, or described above as not available, write "not available" — never invent a number.

Return a plain-text report with no markdown code fences, using exactly this structure:

─────────────────────────────────────────────
MARKET CONDITIONS
─────────────────────────────────────────────
SPY: $X | vs 21 EMA: [above/below] | vs 50 MA: [above/below]
QQQ: $X | vs 50 MA: [above/below]
VIX: X → [Low/Normal/Elevated/High fear, from vixLabel]
Hot sectors: [list hotSectors]
Weak sectors: [list weakSectors]
Risk events this week: [list riskEvents, or "None"] (FOMC exact time: not available, verify manually if FOMC Decision is listed)
MARKET VERDICT: ✅ RISK ON / ⚠️ RISK NEUTRAL / 🚫 RISK OFF (from riskEnvironment)

─────────────────────────────────────────────
SETUP: [TICKER] | Grade: [A+/A/B/C]
─────────────────────────────────────────────
Company: [name] | Sector: [sector] | Industry: not available
Setup type: [from stage4.type]
Conviction: [High/Medium] — [one sentence why]
Days to earnings: [from earningsDates vs today] ✅ Safe / ⚠️ Caution / 🚫 Too close

CHART STRUCTURE:
  Current price:     $X
  Pivot/entry level: $X (stage4.entryPrice)
  10 EMA:            $X
  21 EMA:            $X
  50 MA:             $X (ema50)
  52-week high:      $X
  % from 52W high:   X%
  ATR (14-day):      $X
  Volume today:      Xx avg (volumeRatio)

INDICATORS:
  RSI (14):         X  ✅/❌ (45-68)
  MACD histogram:   Rising/Falling  ✅/❌
  ADX (14):         X  ✅/❌ (>25, or 20-25 with strong MACD/RSI)
  EMA stack:        10>20>50  ✅/❌
  Weekly MA:        Above 20W  ✅/❌
  RS rank:          not available

TRADE PLAN (${portfolioLabel} portfolio):
  Entry type:        [stage4.type]
  Buy price:         [stage4.entryLabel verbatim]
  Entry window:      [from stage4 — "Ready now" or the blocking reason]

  Stop loss:         $X (tradePlan.stopMethod)
  Stop distance:     $X (X%)

  Position size:     X shares ($X)
  Risk on trade:     $X (X% of portfolio)

  TRIM 1 (trim1.shares):  $X (+1.5R) → sell trim1.shares shares
                     → Move stop to $X (trim1.stopAfter)
  TRIM 2 (trim2.shares):  $X (+2.5R) → sell trim2.shares shares
                     → Move stop to $X (trim2.stopAfter)
  TRIM 3 (trim3.shares):  Trail 2.5x ATR on daily close (today: $X)
                     → No fixed price, trend decides exit
  Time stop:         Exit all if no progress in tradePlan.timeStopDays trading days

THESIS (3 sentences max):
  [What the chart shows. Why NOW. What could go wrong.]

RETEST ADD (A+ only):
  If stock retests $X (stage4.entryPrice) on low volume and holds → add back the Trim 1 shares. New stop: below the retest low.

─────────────────────────────────────────────
WEEKLY RANKED SETUPS SUMMARY
─────────────────────────────────────────────
Rank | Ticker | Grade | Entry | Stop | Trim1 | Trim2 | Conviction
  1  |  XXXX  |  A+   | $X    | $X   | $X    | $X    | [reason]

─────────────────────────────────────────────
SETUPS THAT ALMOST MADE IT (and why they didn't)
─────────────────────────────────────────────
[Ticker]: Failed [stage] — [exact reason]

─────────────────────────────────────────────
OPEN POSITION MANAGEMENT
─────────────────────────────────────────────
[Ticker]: Entered $X · Current $X · P&L: X%
  → Today's stop: $X
  → Next trim: nextTrim.label at $X
  → Action today: [evaluation.action] — [reason from exitSignals/partialExitSignal/nextTrim]`
}

// Strips markdown code fences if Claude wraps the report in them anyway.
function cleanReportText(text) {
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:\w*)\s*/, '').replace(/```\s*$/, '')
  }
  return cleaned.trim()
}

// Sends pre-computed Stage 1-5 candidate data, market condition, and
// evaluated open positions to Claude, which only assembles the final report
// (conviction/thesis judgment calls) — every number is already computed.
// Returns the report as plain text.
export async function generateSwingReport(candidates, marketCondition, openPositions, portfolioSize, apiKey) {
  if (!apiKey) {
    throw new Error('Add your Anthropic API key first (settings icon, top right).')
  }

  const payload = { marketCondition, candidates, openPositions, portfolioSize }

  let response
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: SWING_REPORT_MAX_TOKENS,
        system: buildSwingReportSystemPrompt(portfolioSize),
        messages: [
          {
            role: 'user',
            content: `Here is today's real market data. Use ONLY this data — do not invent numbers.\n\n${JSON.stringify(payload)}\n\nWrite the full report now.`,
          },
        ],
      }),
    })
  } catch {
    throw new Error('Network error — could not reach the Anthropic API.')
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.error?.message) message = body.error.message
    } catch {
      /* ignore */
    }
    if (response.status === 401) {
      message = 'Invalid API key. Check your key in settings.'
    } else if (response.status === 429) {
      message = 'Rate limited by the Anthropic API. Wait a moment and try again.'
    }
    throw new Error(message)
  }

  const data = await response.json()
  const text = data?.content?.[0]?.text ?? ''
  if (!text.trim()) throw new Error('Empty response from Claude. Try again.')
  return cleanReportText(text)
}

export async function analyzeTicker(ticker, apiKey, technicalSummary) {
  if (!apiKey) {
    throw new Error('Add your Anthropic API key first (settings icon, top right).')
  }

  let response
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: buildSystemPrompt(),
        messages: [
          {
            role: 'user',
            content: `Analyze ${ticker.toUpperCase()} across institutional ownership, whale activity, political trades, and social sentiment.\n\n${technicalSummary}\n\nReturn the JSON object now.`,
          },
        ],
      }),
    })
  } catch {
    throw new Error('Network error — could not reach the Anthropic API.')
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.error?.message) message = body.error.message
    } catch {
      /* ignore */
    }
    if (response.status === 401) {
      message = 'Invalid API key. Check your key in settings.'
    } else if (response.status === 429) {
      message = 'Rate limited by the Anthropic API. Wait a moment and try again.'
    }
    throw new Error(message)
  }

  const data = await response.json()
  const text = data?.content?.[0]?.text ?? ''

  try {
    return extractJson(text)
  } catch {
    throw new Error('Could not parse the analysis. Try again.')
  }
}
