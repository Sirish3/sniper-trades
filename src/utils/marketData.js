import { authHeaders } from './alpacaApi'
import { fetchFinnhub } from './finnhubApi'
import { sma, ema, rsi, macd, bollingerBands, atr, findSupportResistance, pctChange } from './indicators'
import { getEasternTime, isRegularSession, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } from './marketTime'

const ALPACA_DATA_URL = '/alpaca-data/v2/stocks'
const YAHOO_URL = import.meta.env.VITE_YAHOO_BASE_URL ?? '/yahoo'

const POSITIVE_WORDS = [
  'beat', 'beats', 'surge', 'surges', 'upgrade', 'upgrades', 'growth', 'record', 'strong',
  'rally', 'outperform', 'soar', 'soars', 'jump', 'jumps', 'gain', 'gains', 'bullish',
  'raises', 'raise', 'tops', 'win', 'wins', 'profit', 'profits', 'expand', 'expands',
]
const NEGATIVE_WORDS = [
  'miss', 'misses', 'downgrade', 'downgrades', 'decline', 'declines', 'lawsuit',
  'investigation', 'cuts', 'weak', 'sell-off', 'selloff', 'plunge', 'plunges', 'drop',
  'drops', 'recall', 'bearish', 'lowers', 'loss', 'losses', 'falls', 'fraud', 'probe',
]

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

// Up to 1000 daily bars (~400 calendar days) of full OHLCV, with timestamps —
// enough for 52-week high/low, ADX, and weekly resampling.
export async function fetchBars(symbol) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 400)

  const params = new URLSearchParams({
    timeframe: '1Day',
    start: dateStr(start),
    end: dateStr(end),
    limit: '1000',
    feed: 'iex',
    adjustment: 'split',
  })

  let response
  try {
    response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
  } catch {
    throw new Error('Network error — could not reach Alpaca market data.')
  }

  if (!response.ok) {
    throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)
  }

  const data = await response.json()
  const bars = data.bars || []
  if (bars.length === 0) {
    throw new Error(`No market data returned for ${symbol}. Check the ticker symbol.`)
  }
  return bars
}

// Full daily OHLCV history going back `lookbackDays`, paginating past
// Alpaca's 1000-bars-per-request cap when the range needs it (e.g. 5y is
// ~1260 trading days). Separate from fetchBars() above, which is hardcoded
// to ~400 days and used by callers that only need ~1 year of context —
// this is for the backtester, which needs multi-year history.
export async function fetchDailyBars(symbol, lookbackDays) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - lookbackDays)

  const bars = []
  let pageToken = null
  do {
    const params = new URLSearchParams({
      timeframe: '1Day',
      start: dateStr(start),
      end: dateStr(end),
      limit: '1000',
      feed: 'iex',
      adjustment: 'split',
    })
    if (pageToken) params.set('page_token', pageToken)

    let response
    try {
      response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
    } catch {
      throw new Error('Network error — could not reach Alpaca market data.')
    }
    if (!response.ok) {
      throw new Error(`Alpaca market data request failed (${response.status}) for ${symbol}`)
    }

    const data = await response.json()
    bars.push(...(data.bars || []))
    pageToken = data.next_page_token || null
  } while (pageToken)

  if (bars.length === 0) {
    throw new Error(`No market data returned for ${symbol}. Check the ticker symbol.`)
  }
  return bars
}

// Today's regular-session 5-minute bars so far, each tagged with its ET
// minute-of-day — lets the entry-rule engine sum volume over specific
// intraday windows (e.g. "first 90 minutes", "by 11am") without re-deriving
// timezone math itself. Returns null outside market hours, on a non-trading
// day, or if the request fails — callers treat that as "intraday data
// unavailable" rather than inventing a volume figure.
export async function fetchIntradayVolume(symbol) {
  const et = getEasternTime()
  if (!isRegularSession(et)) return null

  const now = new Date()
  const startOfDayUtc = new Date(now)
  startOfDayUtc.setUTCHours(0, 0, 0, 0) // always before 9:30am ET regardless of DST

  const params = new URLSearchParams({
    timeframe: '5Min',
    start: startOfDayUtc.toISOString(),
    end: now.toISOString(),
    limit: '150',
    feed: 'iex',
    adjustment: 'split',
  })

  let response
  try {
    response = await fetch(`${ALPACA_DATA_URL}/${symbol}/bars?${params}`, { headers: authHeaders() })
  } catch {
    return null
  }
  if (!response.ok) return null

  const data = await response.json()
  const bars = data.bars || []

  const sessionBars = bars
    .map((b) => ({ v: b.v, etMinutes: getEasternTime(new Date(b.t)).totalMinutes }))
    .filter((b) => b.etMinutes >= MARKET_OPEN_MIN && b.etMinutes <= MARKET_CLOSE_MIN)

  if (sessionBars.length === 0) return null

  return {
    nowMinutes: et.totalMinutes,
    volumeByMinute: sessionBars,
    volumeSoFar: sessionBars.reduce((sum, b) => sum + b.v, 0),
  }
}

// Earnings calendar entries for `symbol` within [today - daysBack, today + daysForward].
// Returns null if the Finnhub key is missing or the request fails after retries
// (degrades to "unavailable" rather than throwing).
export async function fetchEarningsCalendar(symbol, daysBack = 0, daysForward = 14) {
  const from = new Date()
  from.setDate(from.getDate() - daysBack)
  const to = new Date()
  to.setDate(to.getDate() + daysForward)

  const data = await fetchFinnhub(`/calendar/earnings?symbol=${symbol}&from=${dateStr(from)}&to=${dateStr(to)}`)
  return Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : data ? [] : null
}

async function fetchCompanyNews(symbol) {
  const today = new Date()
  const past = new Date()
  past.setDate(past.getDate() - 7)

  const data = await fetchFinnhub(`/company-news?symbol=${symbol}&from=${dateStr(past)}&to=${dateStr(today)}`)
  return Array.isArray(data) ? data : data === null ? null : []
}

function scoreNewsSentiment(articles) {
  let positive = 0
  let negative = 0
  for (const article of articles) {
    const text = `${article.headline || ''} ${article.summary || ''}`.toLowerCase()
    for (const word of POSITIVE_WORDS) if (text.includes(word)) positive++
    for (const word of NEGATIVE_WORDS) if (text.includes(word)) negative++
  }
  return { positive, negative, total: articles.length }
}

// Unofficial Yahoo Finance endpoint (the same one yfinance scrapes). Requires
// a crumb token tied to a cookie from the same proxy origin. Either step can
// fail or change shape without notice, so any failure just means "unavailable".
async function fetchShortInterest(symbol) {
  try {
    const crumbRes = await fetch(`${YAHOO_URL}/v1/test/getcrumb`, { credentials: 'include' })
    if (!crumbRes.ok) return null
    const crumb = (await crumbRes.text()).trim()
    if (!crumb || crumb.includes('<')) return null

    const statsRes = await fetch(
      `${YAHOO_URL}/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`,
      { credentials: 'include' }
    )
    if (!statsRes.ok) return null
    const data = await statsRes.json()
    const stats = data?.quoteSummary?.result?.[0]?.defaultKeyStatistics
    if (!stats) return null

    return { shortPercentOfFloat: stats.shortPercentOfFloat?.raw ?? null }
  } catch {
    return null
  }
}

export async function getTechnicalAnalysis(ticker) {
  const symbol = ticker.toUpperCase()

  const [bars, spyBars] = await Promise.all([fetchBars(symbol), fetchBars('SPY')])

  const closes = bars.map((b) => b.c)
  const volumes = bars.map((b) => b.v)
  const price = closes[closes.length - 1]

  const last252 = bars.slice(-252)
  const week52High = Math.max(...last252.map((b) => b.h))
  const week52Low = Math.min(...last252.map((b) => b.l))
  const priceOffHigh = Math.round(((price - week52High) / week52High) * 100)

  // --- Trend (50/200 DMA) — 25% ---
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  let trendStatus = 'warn'
  let trendValue = 'Insufficient history for 50/200 DMA.'
  if (sma50 != null && sma200 != null) {
    if (price > sma50 && sma50 > sma200) {
      trendStatus = 'pass'
      trendValue = `Price $${price.toFixed(2)} above 50 DMA $${sma50.toFixed(2)}, above 200 DMA $${sma200.toFixed(2)}. Uptrend.`
    } else if (price < sma50 && sma50 < sma200) {
      trendStatus = 'fail'
      trendValue = `Price $${price.toFixed(2)} below 50 DMA $${sma50.toFixed(2)}, below 200 DMA $${sma200.toFixed(2)}. Downtrend.`
    } else {
      trendValue = `Price $${price.toFixed(2)}, 50 DMA $${sma50.toFixed(2)}, 200 DMA $${sma200.toFixed(2)}. Mixed trend.`
    }
  }

  // --- RSI — 15% ---
  const rsiVal = rsi(closes, 14)
  let rsiStatus = 'warn'
  let rsiValue = 'RSI unavailable.'
  if (rsiVal != null) {
    if (rsiVal >= 80) {
      rsiStatus = 'fail'
      rsiValue = `RSI ${rsiVal.toFixed(1)} — deeply overbought.`
    } else if (rsiVal >= 70) {
      rsiStatus = 'warn'
      rsiValue = `RSI ${rsiVal.toFixed(1)} — overbought.`
    } else if (rsiVal <= 30) {
      rsiStatus = 'warn'
      rsiValue = `RSI ${rsiVal.toFixed(1)} — oversold.`
    } else {
      rsiStatus = 'pass'
      rsiValue = `RSI ${rsiVal.toFixed(1)} — neutral range.`
    }
  }

  // --- MACD — 15% ---
  const macdData = macd(closes)
  let macdStatus = 'warn'
  let macdValue = 'MACD unavailable.'
  if (macdData) {
    macdStatus = macdData.value > macdData.signal ? 'pass' : 'fail'
    macdValue = `MACD ${macdData.value.toFixed(2)} vs signal ${macdData.signal.toFixed(2)} (hist ${macdData.histogram.toFixed(2)}). ${macdStatus === 'pass' ? 'Bullish' : 'Bearish'}.`
  }

  // --- Volume confirmation — 15% ---
  const priorVolumes = volumes.slice(-21, -1)
  const avgVol20 = priorVolumes.length === 20 ? sma(priorVolumes, 20) : null
  let volStatus = 'warn'
  let volValue = 'Volume data unavailable.'
  const todayVol = volumes[volumes.length - 1]
  if (avgVol20 != null) {
    const ratio = todayVol / avgVol20
    if (ratio >= 1.1) {
      volStatus = 'pass'
      volValue = `${ratio.toFixed(2)}x avg volume — confirming move.`
    } else if (ratio >= 0.8) {
      volStatus = 'warn'
      volValue = `${ratio.toFixed(2)}x avg volume — near average.`
    } else {
      volStatus = 'fail'
      volValue = `${ratio.toFixed(2)}x avg volume — below average, weak conviction.`
    }
  }

  // --- Relative strength vs SPY — 10% ---
  const spyCloses = spyBars.map((b) => b.c)
  const tickerReturn = pctChange(closes, 63)
  const spyReturn = pctChange(spyCloses, 63)
  let rsStatus = 'warn'
  let rsValue = 'Relative strength unavailable.'
  if (tickerReturn != null && spyReturn != null) {
    rsStatus = tickerReturn > spyReturn ? 'pass' : 'fail'
    rsValue = `${symbol} ${tickerReturn.toFixed(1)}% vs SPY ${spyReturn.toFixed(1)}% (63 trading days).`
  }

  // --- Bollinger Bands (context) ---
  const bb = bollingerBands(closes, 20, 2)
  let bbStatus = 'warn'
  let bbValue = 'Bollinger Bands unavailable.'
  if (bb) {
    if (price > bb.upper) {
      bbStatus = 'warn'
      bbValue = `Price $${price.toFixed(2)} above upper band $${bb.upper.toFixed(2)} — extended.`
    } else if (price < bb.lower) {
      bbStatus = 'warn'
      bbValue = `Price $${price.toFixed(2)} below lower band $${bb.lower.toFixed(2)} — oversold/breakdown.`
    } else {
      bbStatus = 'pass'
      bbValue = `Price $${price.toFixed(2)} within bands ($${bb.lower.toFixed(2)} – $${bb.upper.toFixed(2)}).`
    }
  }

  // --- Support / Resistance (levels) + Risk/Reward — 5% ---
  const sr = findSupportResistance(bars, 60)
  const srValue = `Support $${sr.support.toFixed(2)}, resistance $${sr.resistance.toFixed(2)}.`

  let rrStatus = 'warn'
  let rrValue = 'Risk/reward unavailable.'
  const upside = sr.resistance - price
  const downside = price - sr.support
  if (downside > 0) {
    const rr = upside / downside
    if (rr >= 2) {
      rrStatus = 'pass'
      rrValue = `R:R ${rr.toFixed(1)}:1 (upside $${upside.toFixed(2)}, downside $${downside.toFixed(2)}).`
    } else if (rr >= 1) {
      rrStatus = 'warn'
      rrValue = `R:R ${rr.toFixed(1)}:1 — modest.`
    } else {
      rrStatus = 'fail'
      rrValue = `R:R ${rr.toFixed(1)}:1 — poor.`
    }
  } else {
    rrStatus = 'fail'
    rrValue = `Price at/below support $${sr.support.toFixed(2)} — no margin.`
  }

  // --- ATR (position sizing context) ---
  const atrVal = atr(bars, 14)
  const atrValue =
    atrVal != null
      ? `ATR(14) $${atrVal.toFixed(2)} — suggested stop ~$${(price - 1.5 * atrVal).toFixed(2)}.`
      : 'ATR unavailable.'

  // --- Earnings calendar (risk filter) — Finnhub ---
  const earnings = await fetchEarningsCalendar(symbol)
  let earningsStatus = 'pass'
  let earningsValue = 'No earnings in the next 14 days.'
  if (earnings === null) {
    earningsStatus = 'warn'
    earningsValue = 'Earnings calendar unavailable.'
  } else if (earnings.length > 0) {
    earningsStatus = 'warn'
    earningsValue = `Earnings on ${earnings[0].date} — event risk.`
  }

  // --- News sentiment — 10% — Finnhub ---
  const news = await fetchCompanyNews(symbol)
  let newsStatus = 'warn'
  let newsValue = 'News sentiment unavailable.'
  if (news !== null) {
    if (news.length === 0) {
      newsValue = 'No recent news found.'
    } else {
      const { positive, negative, total } = scoreNewsSentiment(news)
      if (positive > negative) {
        newsStatus = 'pass'
        newsValue = `${total} headlines (7d): ${positive} positive signals vs ${negative} negative.`
      } else if (negative > positive) {
        newsStatus = 'fail'
        newsValue = `${total} headlines (7d): ${negative} negative signals vs ${positive} positive.`
      } else {
        newsValue = `${total} headlines (7d): mixed/neutral sentiment.`
      }
    }
  }

  // --- Short interest — 5% — Yahoo (unofficial, graceful fallback) ---
  const short = await fetchShortInterest(symbol)
  let shortStatus = 'warn'
  let shortValue = 'Short interest unavailable.'
  if (short?.shortPercentOfFloat != null) {
    const pct = short.shortPercentOfFloat * 100
    if (pct < 5) {
      shortStatus = 'pass'
      shortValue = `${pct.toFixed(1)}% of float short — low.`
    } else if (pct < 15) {
      shortStatus = 'warn'
      shortValue = `${pct.toFixed(1)}% of float short — elevated.`
    } else {
      shortStatus = 'fail'
      shortValue = `${pct.toFixed(1)}% of float short — heavily shorted.`
    }
  }

  const entryMetrics = [
    { name: 'Trend (50/200 DMA)', status: trendStatus, value: trendValue },
    { name: 'RSI (14)', status: rsiStatus, value: rsiValue },
    { name: 'MACD', status: macdStatus, value: macdValue },
    { name: 'Volume confirmation', status: volStatus, value: volValue },
    { name: 'Relative strength vs SPY', status: rsStatus, value: rsValue },
    { name: 'Short interest', status: shortStatus, value: shortValue },
    { name: 'News sentiment', status: newsStatus, value: newsValue },
    { name: 'Risk / reward ratio', status: rrStatus, value: rrValue },
    { name: 'Bollinger Band position', status: bbStatus, value: bbValue },
    { name: 'Support / resistance', status: 'pass', value: srValue },
    { name: 'ATR / volatility', status: 'pass', value: atrValue },
    { name: 'Earnings calendar', status: earningsStatus, value: earningsValue },
  ]

  // --- Exit checklist ---
  const ema10 = ema(closes, 10)
  const prevRsi = rsi(closes.slice(0, -1), 14)
  const lastBar = bars[bars.length - 1]

  const stopStatus = price <= sr.support ? 'fail' : 'pass'
  const stopValue =
    price <= sr.support
      ? `Price $${price.toFixed(2)} at/below support $${sr.support.toFixed(2)} — stop triggered.`
      : `Price $${price.toFixed(2)} above support $${sr.support.toFixed(2)}.`

  let macdExitStatus = 'pass'
  let macdExitValue = 'MACD above signal — not triggered.'
  if (macdData && macdData.value < macdData.signal) {
    macdExitStatus = 'fail'
    macdExitValue = `MACD ${macdData.value.toFixed(2)} below signal ${macdData.signal.toFixed(2)} — bearish cross.`
  }

  let rsiExitStatus = 'pass'
  let rsiExitValue = 'No overbought reversal detected.'
  if (rsiVal != null && prevRsi != null && rsiVal >= 70 && rsiVal < prevRsi) {
    rsiExitStatus = 'fail'
    rsiExitValue = `RSI rolling over from overbought (${prevRsi.toFixed(1)} → ${rsiVal.toFixed(1)}).`
  }

  let emaExitStatus = 'pass'
  let emaExitValue = 'Price above 10 EMA.'
  if (ema10 != null && price < ema10) {
    emaExitStatus = 'fail'
    emaExitValue = `Price $${price.toFixed(2)} below 10 EMA $${ema10.toFixed(2)}.`
  }

  let volExitStatus = 'pass'
  let volExitValue = 'No volume climax detected.'
  if (avgVol20 != null && todayVol > 2 * avgVol20 && price < lastBar.o) {
    volExitStatus = 'fail'
    volExitValue = `Volume ${(todayVol / avgVol20).toFixed(1)}x avg on a red candle — possible climax.`
  }

  const exitMetrics = [
    { name: 'Stop-loss level', status: stopStatus, value: stopValue },
    { name: 'MACD bearish cross', status: macdExitStatus, value: macdExitValue },
    { name: 'RSI overbought reversal', status: rsiExitStatus, value: rsiExitValue },
    { name: 'Price vs 10 EMA', status: emaExitStatus, value: emaExitValue },
    { name: 'Volume climax', status: volExitStatus, value: volExitValue },
  ]

  const entryScore = entryMetrics.filter((m) => m.status === 'pass').length
  const exitScore = exitMetrics.filter((m) => m.status === 'fail').length

  const summary = `Real market data for ${symbol}, computed locally from Alpaca/Finnhub/Yahoo (do not invent your own technical numbers):
- Price: $${price.toFixed(2)} | 52-week range: $${week52Low.toFixed(2)} - $${week52High.toFixed(2)} (${priceOffHigh}% off high)
- ${trendValue}
- ${rsiValue}
- ${macdValue}
- Volume: ${volValue}
- Relative strength: ${rsValue}
- ${rrValue}
- Short interest: ${shortValue}
- News sentiment: ${newsValue}
- Earnings: ${earningsValue}
- Entry checklist: ${entryScore}/${entryMetrics.length} passing
- Exit signals triggered: ${exitScore}/${exitMetrics.length}`

  return {
    price,
    week52High,
    week52Low,
    priceOffHigh,
    technical: { entryScore, exitScore, entryMetrics, exitMetrics },
    summary,
  }
}
