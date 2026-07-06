import { useEffect, useMemo, useState } from 'react'
import { getUniverseGroups } from '../utils/agenticScreener'
import { getTotalStockMarketUniverse } from '../utils/assetUniverse'
import {
  scanWeekHighs, classifyWeekHighResults, buildWeekHighTradePlans, MAX_TRADE_PLAN_CANDIDATES,
} from '../utils/weekHighScreener'
import { getMarketCondition, DEFAULT_PORTFOLIO_SIZE } from '../utils/swingPlan'
import { loadPositions } from '../utils/positions'
import { fetchSp500FromWikipedia, fetchNasdaq100FromWikipedia, diffConstituents } from '../utils/indexConstituents'
import { validateEtfTickers } from '../utils/etfValidation'
import { analyzeStock } from '../utils/stockAnalysis'
import { logBuyAlerts } from '../utils/alerts'
import { fetchAlpacaCloses, returnOverLookback } from '../utils/marketRegime'
import { fetchEarningsCalendar } from '../utils/marketData'
import {
  FOMC_DECISION_DATES, CPI_DATES, PPI_DATES, NFP_DATES, ADP_DATES, PCE_DATES,
  nthBizDayOfMonth, inThisWeek,
} from '../utils/economicCalendar'
import { ema, sma } from '../utils/indicators'
import { SP500 } from '../data/sp500'
import { NASDAQ100 } from '../data/nasdaq100'
import { ETFS_AND_METALS } from '../data/etfsAndMetals'
import { getVerdict, bucketResultsByVerdict } from '../utils/verdict'
import { loadPriceAlerts, savePriceAlerts, addPriceAlert } from '../utils/priceAlerts'
import { LoaderIcon, TrendingUpIcon } from './Icons'
import AnalysisPanel from './AnalysisPanel'
import AvwapPanel from './AvwapPanel'
import VerdictPanel from './VerdictPanel'

const PORTFOLIO_STORAGE_KEY = 'sniper-trades-portfolio-size'

// ── MarketBanner helpers (module-level so sub-components can share them) ────

function analyzeMa(closes) {
  const price = closes[closes.length - 1]
  const e21   = ema(closes, 21)
  const s50   = sma(closes, 50)
  const s200  = sma(closes, 200)
  const above21  = e21  != null && price > e21
  const above50  = s50  != null && price > s50
  const above200 = s200 != null && price > s200
  const pct = (ma) => ma ? ((price - ma) / ma) * 100 : null
  let trend, mod, actionText
  if (!above200) {
    trend = 'Downtrend';   mod = 'bear';    actionText = 'Only SHORT setups or skip entirely'
  } else if (!above50) {
    trend = 'Correction';  mod = 'warn';    actionText = 'Below 50 MA — reduce position size 50%'
  } else if (!above21) {
    trend = 'Sideways';    mod = 'neutral'; actionText = 'Below 21 EMA — wait for reclaim'
  } else {
    trend = 'Trending Up'; mod = 'bull';    actionText = 'Full size OK — favorable for long setups'
  }
  return { price, e21, s50, s200, above21, above50, above200, pct21: pct(e21), pct50: pct(s50), pct200: pct(s200), trend, mod, actionText }
}

const VIX_TIERS = [
  { label: '< 15',  name: 'Low Fear',  mod: 'bull', action: 'Full position sizes.',                                                         check: (v) => v < 15  },
  { label: '15–20', name: 'Normal',    mod: 'bull', action: 'Standard sizing.',                                                              check: (v) => v < 20  },
  { label: '20–25', name: 'Elevated',  mod: 'warn', action: 'Elevated fear — reduce size 25%.',                                             check: (v) => v < 25  },
  { label: '25–30', name: 'High Fear', mod: 'warn', action: 'High fear — reduce size 50% or skip.',                                         check: (v) => v < 30  },
  { label: '> 30',  name: 'Crisis',    mod: 'bear', action: 'Crisis mode — only top 1-2 setups · tight stops · no new longs on weakness.',  check: () => true     },
]

const ACT_ICON = { bull: '✅', neutral: '⏸', warn: '⚠️', bear: '🚨' }

// SPDR sector ETFs mapped to GICS sector names used in SP500/NASDAQ100 data
const SECTOR_ETFS = [
  { name: 'Tech',      full: 'Information Technology', etf: 'XLK'  },
  { name: 'Health',    full: 'Health Care',             etf: 'XLV'  },
  { name: 'Finance',   full: 'Financials',              etf: 'XLF'  },
  { name: 'Discret.',  full: 'Consumer Discretionary',  etf: 'XLY'  },
  { name: 'Comm',      full: 'Communication Services',  etf: 'XLC'  },
  { name: 'Industl.',  full: 'Industrials',             etf: 'XLI'  },
  { name: 'Staples',   full: 'Consumer Staples',        etf: 'XLP'  },
  { name: 'Energy',    full: 'Energy',                  etf: 'XLE'  },
  { name: 'Utilities', full: 'Utilities',               etf: 'XLU'  },
  { name: 'R.Estate',  full: 'Real Estate',             etf: 'XLRE' },
  { name: 'Materials', full: 'Materials',               etf: 'XLB'  },
]

const MAJOR_EARNINGS_TICKERS = ['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'NFLX', 'AMD', 'V', 'CRM']

function fmtDate(ds) {
  const [y, m, d] = ds.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

const VERDICT_CONFIG = {
  on:      { icon: '✅', label: 'RISK ON',      desc: 'Full size — trade all qualifying setups' },
  neutral: { icon: '⚠️', label: 'RISK NEUTRAL', desc: 'Half size — be picky, A+ setups only' },
  off:     { icon: '🚫', label: 'RISK OFF',     desc: 'Sit on cash — no new longs, protect capital' },
}

function computeVerdict(spy, qqq, vix, risks) {
  if (spy && !spy.above200) return 'off'
  if (vix != null && vix > 30) return 'off'
  if (spy && !spy.above50) return 'neutral'
  if (qqq && !qqq.above50) return 'neutral'
  if (vix != null && vix > 20) return 'neutral'
  if (risks?.fomcWeek) return 'neutral'
  if (risks?.nfpWeek) return 'neutral'
  if (risks?.pceWeek) return 'neutral'
  if (risks?.cpiWeek || risks?.ppiWeek) return 'neutral'
  if (risks?.ismMfgWeek || risks?.ismSvcWeek) return 'neutral'
  if ((risks?.majorEarnings?.length ?? 0) >= 2) return 'neutral'
  if (!spy && !qqq && vix == null) return null
  return 'on'
}

function SectorHeat() {
  const [ranked, setRanked] = useState(null)

  useEffect(() => {
    Promise.allSettled([
      fetchAlpacaCloses('SPY'),
      ...SECTOR_ETFS.map((s) => fetchAlpacaCloses(s.etf)),
    ]).then(([spyR, ...etfResults]) => {
      const spyCls   = spyR.status === 'fulfilled' ? spyR.value : null
      const spyRet1m = spyCls ? returnOverLookback(spyCls, 21) : 0
      const spyRet3m = spyCls ? returnOverLookback(spyCls, 63) : 0

      const scores = []
      etfResults.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        const cls    = r.value
        const ret1m  = returnOverLookback(cls, 21)
        const ret3m  = returnOverLookback(cls, 63)
        const rs1m   = ret1m - spyRet1m   // relative strength vs SPY
        const rs3m   = ret3m - spyRet3m
        const price  = cls[cls.length - 1]
        const s50    = sma(cls, 50)
        const above50 = s50 != null && price > s50
        // Weighted composite: recent RS more important than long-term
        const score  = rs1m * 0.55 + rs3m * 0.30 + (above50 ? 3 : -3) + ret1m * 0.15
        scores.push({ ...SECTOR_ETFS[i], ret1m, rs1m, score })
      })

      scores.sort((a, b) => b.score - a.score)
      setRanked(scores)
    })
  }, [])

  if (!ranked) {
    return (
      <div className="sector-heat">
        <span className="market-section-loading">Loading sector strength…</span>
      </div>
    )
  }
  if (ranked.length === 0) return null

  const label = (i) => i < 3 ? 'strong' : i >= ranked.length - 2 ? 'avoid' : 'neutral'
  const strong = ranked.filter((_, i) => i < 3)
  const avoid  = ranked.filter((_, i) => i >= ranked.length - 2)

  return (
    <div className="sector-heat">
      <div className="sector-heat-header">
        <span className="market-banner-title">Sector Heat</span>
        <span className="sector-heat-summary">
          <span className="sector-heat-focus">Focus: {strong.map((s) => s.full).join(' · ')}</span>
          <span className="sector-heat-sep"> &nbsp;·&nbsp; </span>
          <span className="sector-heat-avoid">Avoid: {avoid.map((s) => s.full).join(' · ')}</span>
        </span>
      </div>
      <div className="sector-chip-row">
        {ranked.map((s, i) => (
          <div
            key={s.etf}
            className={`sector-chip sector-chip-${label(i)}`}
            title={`${s.full} — 1m abs: ${s.ret1m >= 0 ? '+' : ''}${s.ret1m.toFixed(1)}% · vs SPY: ${s.rs1m >= 0 ? '+' : ''}${s.rs1m.toFixed(1)}%`}
          >
            <span className="sector-chip-name">{s.name}</span>
            <span className="sector-chip-ret">{s.ret1m >= 0 ? '+' : ''}{s.ret1m.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MaSection({ symbol, subtitle, data }) {
  if (!data) {
    return <div className="market-section"><span className="market-section-loading">Loading {symbol}…</span></div>
  }
  const { price, e21, s50, s200, above21, above50, above200, pct21, pct50, pct200, trend, mod, actionText } = data
  const fp   = (v) => v == null ? '—' : `$${v.toFixed(2)}`
  const fpct = (v) => v == null ? '' : ` (${v >= 0 ? '+' : ''}${v.toFixed(1)}%)`
  return (
    <div className="market-section">
      <div className="market-section-header">
        <div>
          <span className="market-section-symbol">{symbol}</span>
          {subtitle && <span className="market-section-sub">{subtitle}</span>}
        </div>
        <span className={`spy-trend-badge spy-trend-${mod}`}>{trend}</span>
      </div>
      <div className="market-section-price mono">${price.toFixed(2)}</div>
      <div className="spy-ma-row">
        <div className="spy-ma-stat">
          <span className="spy-ma-label">21 EMA</span>
          <span className={`spy-ma-value mono ${above21 ? 'spy-above' : 'spy-below'}`}>
            {fp(e21)}<span className="spy-ma-pct">{fpct(pct21)}</span>
          </span>
        </div>
        <div className="spy-ma-stat">
          <span className="spy-ma-label">50 SMA</span>
          <span className={`spy-ma-value mono ${above50 ? 'spy-above' : 'spy-below'}`}>
            {fp(s50)}<span className="spy-ma-pct">{fpct(pct50)}</span>
          </span>
        </div>
        <div className="spy-ma-stat">
          <span className="spy-ma-label">200 SMA</span>
          <span className={`spy-ma-value mono ${above200 ? 'spy-above' : 'spy-below'}`}>
            {fp(s200)}<span className="spy-ma-pct">{fpct(pct200)}</span>
          </span>
        </div>
      </div>
      <div className={`spy-action spy-action-${mod}`}>{ACT_ICON[mod]} {actionText}</div>
    </div>
  )
}

function VixSection({ value }) {
  if (value == null) {
    return <div className="market-section"><span className="market-section-loading">Loading VIX…</span></div>
  }
  const tier = VIX_TIERS.find((t) => t.check(value))
  return (
    <div className="market-section">
      <div className="market-section-header">
        <div>
          <span className="market-section-symbol">VIX</span>
          <span className="market-section-sub">Fear Index</span>
        </div>
        <span className={`spy-trend-badge spy-trend-${tier.mod}`}>{tier.name}</span>
      </div>
      <div className="market-section-price mono">{value.toFixed(1)}</div>
      <div className="vix-tier-list">
        {VIX_TIERS.map((t) => {
          const active = t === tier
          return (
            <div key={t.label} className={`vix-tier${active ? ` vix-tier-${t.mod}` : ''}`}>
              <span className="vix-tier-range">{t.label}</span>
              <span className="vix-tier-name">{t.name}</span>
              <span className="vix-tier-action">{t.action.split('—')[0].split(' — ')[0]}</span>
            </div>
          )
        })}
      </div>
      <div className={`spy-action spy-action-${tier.mod}`}>{ACT_ICON[tier.mod]} {tier.action}</div>
    </div>
  )
}

function MarketBanner() {
  const [spy,    setSpy]    = useState(null)
  const [qqq,    setQqq]    = useState(null)
  const [vix,    setVix]    = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [risks,  setRisks]  = useState(null)

  useEffect(() => {
    Promise.allSettled([
      fetchAlpacaCloses('SPY'),
      fetchAlpacaCloses('QQQ'),
    ]).then(([spyR, qqqR]) => {
      if (spyR.status === 'fulfilled') setSpy(analyzeMa(spyR.value))
      if (qqqR.status === 'fulfilled') setQqq(analyzeMa(qqqR.value))
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    const fomcDate   = FOMC_DECISION_DATES.find((d) => inThisWeek(d)) ?? null
    const fomcWeek   = fomcDate != null
    const cpiWeek    = CPI_DATES.some((d) => inThisWeek(d))
    const ppiWeek    = PPI_DATES.some((d) => inThisWeek(d))
    const nfpWeek    = NFP_DATES.some((d) => inThisWeek(d))
    const adpWeek    = ADP_DATES.some((d) => inThisWeek(d))
    const pceWeek    = PCE_DATES.some((d) => inThisWeek(d))
    const ismMfgWeek = inThisWeek(nthBizDayOfMonth(1))
    const ismSvcWeek = inThisWeek(nthBizDayOfMonth(3))
    // Set synchronous data immediately so verdict renders before earnings load
    setRisks({ fomcWeek, fomcDate, cpiWeek, ppiWeek, nfpWeek, adpWeek, pceWeek, ismMfgWeek, ismSvcWeek, majorEarnings: [] })

    // Small batches rather than all 12 at once — a burst this size can trip
    // Finnhub's free-tier rate limit even though 12 calls/min is well under it.
    const EARNINGS_BATCH_SIZE = 4
    const EARNINGS_BATCH_DELAY_MS = 1500

    async function loadMajorEarnings() {
      const majorEarnings = []
      for (let i = 0; i < MAJOR_EARNINGS_TICKERS.length; i += EARNINGS_BATCH_SIZE) {
        const batch = MAJOR_EARNINGS_TICKERS.slice(i, i + EARNINGS_BATCH_SIZE)
        const results = await Promise.allSettled(
          batch.map((sym) =>
            fetchEarningsCalendar(sym, 0, 7).then((entries) => {
              if (!entries || entries.length === 0) return null
              return entries.some((e) => inThisWeek(e.date)) ? sym : null
            })
          )
        )
        for (const r of results) if (r.status === 'fulfilled' && r.value) majorEarnings.push(r.value)
        setRisks((prev) => ({ ...prev, majorEarnings: [...majorEarnings] }))

        if (i + EARNINGS_BATCH_SIZE < MAJOR_EARNINGS_TICKERS.length) {
          await new Promise((resolve) => setTimeout(resolve, EARNINGS_BATCH_DELAY_MS))
        }
      }
    }
    loadMajorEarnings()
  }, [])

  const verdictMod = computeVerdict(spy, qqq, vix, risks)
  const verdict = verdictMod ? VERDICT_CONFIG[verdictMod] : null

  const overallMod = (() => {
    if (verdictMod === 'off') return 'bear'
    if (verdictMod === 'neutral') return 'warn'
    if (verdictMod === 'on') return 'bull'
    const mods = [spy?.mod, qqq?.mod].filter(Boolean)
    if (vix != null) mods.push((VIX_TIERS.find((t) => t.check(vix)) ?? VIX_TIERS.at(-1)).mod)
    if (mods.includes('bear'))    return 'bear'
    if (mods.includes('warn'))    return 'warn'
    if (mods.includes('neutral')) return 'neutral'
    return 'bull'
  })()

  if (!loaded) {
    return <div className="market-banner market-banner-neutral"><span className="market-section-loading">Loading market conditions…</span></div>
  }

  return (
    <div className={`market-banner market-banner-${overallMod}`}>
      <div className="market-banner-title">Market Conditions</div>
      <div className="market-banner-grid">
        <MaSection symbol="SPY" subtitle="S&P 500" data={spy} />
        <div className="market-section-divider" />
        <MaSection symbol="QQQ" subtitle="Tech / Growth" data={qqq} />
        <div className="market-section-divider" />
        <VixSection value={vix} />
      </div>
      <div className="market-section-divider-h" />
      <SectorHeat />
      <div className="market-section-divider-h" />
      <div className="week-risks">
        <div className="week-risks-header">
          <span className="market-banner-title">Weekly Risk Events</span>
        </div>
        {risks ? (
          <div className="risk-badges">
            {risks.fomcWeek && (
              <span className="risk-badge risk-badge-fomc">
                ⚡ FOMC Decision{risks.fomcDate ? ` · ${fmtDate(risks.fomcDate)} at 2:00 PM ET` : ''} — market can whipsaw on the announcement, wait until after
              </span>
            )}
            {risks.cpiWeek && (
              <span className="risk-badge risk-badge-eco">📊 CPI Release — inflation data can gap the market, reduce position size</span>
            )}
            {risks.ppiWeek && !risks.cpiWeek && (
              <span className="risk-badge risk-badge-eco">📊 PPI Release — inflation data can gap the market, reduce position size</span>
            )}
            {risks.pceWeek && (
              <span className="risk-badge risk-badge-eco">📊 PCE Inflation — Fed&apos;s preferred measure, can reprice rate-cut odds</span>
            )}
            {risks.nfpWeek && (
              <span className="risk-badge risk-badge-jobs">💼 Non-Farm Payrolls — biggest jobs report, wait for 9:30 AM open after 8:30 release</span>
            )}
            {risks.adpWeek && !risks.nfpWeek && (
              <span className="risk-badge risk-badge-jobs">💼 ADP Jobs Report — NFP preview, can shift rate-cut expectations</span>
            )}
            {risks.ismMfgWeek && (
              <span className="risk-badge risk-badge-ism">🏭 ISM Manufacturing — factory activity, watch for &lt;50 contraction signal</span>
            )}
            {risks.ismSvcWeek && (
              <span className="risk-badge risk-badge-ism">📋 ISM Services — 80% of US economy, highly market-moving</span>
            )}
            {risks.majorEarnings.map((sym) => (
              <span key={sym} className="risk-badge risk-badge-earnings">📈 {sym} Earnings</span>
            ))}
            {!risks.fomcWeek && !risks.cpiWeek && !risks.ppiWeek && !risks.pceWeek &&
             !risks.nfpWeek && !risks.adpWeek && !risks.ismMfgWeek && !risks.ismSvcWeek &&
             risks.majorEarnings.length === 0 && (
              <span className="risk-badge risk-badge-clear">No major risk events this week</span>
            )}
          </div>
        ) : (
          <span className="market-section-loading">Checking calendar…</span>
        )}
      </div>
      {verdict && (
        <>
          <div className="market-section-divider-h" />
          <div className={`market-verdict market-verdict-${verdictMod}`}>
            <span className="verdict-icon">{verdict.icon}</span>
            <span className="verdict-label">{verdict.label}</span>
            <span className="verdict-sep"> — </span>
            <span className="verdict-desc">{verdict.desc}</span>
          </div>
        </>
      )}
    </div>
  )
}

function formatRefreshDiff(diff) {
  if (!diff) return ''
  const parts = []
  if (diff.added.length > 0) parts.push(`+${diff.added.length} new: ${diff.added.join(', ')}`)
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed: ${diff.removed.join(', ')}`)
  return parts.length > 0 ? parts.join(' · ') : 'no membership changes'
}

function formatPct(value) {
  if (value == null) return 'N/A'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function matchesSearch(result, query) {
  if (!query) return true
  const q = query.trim().toLowerCase()
  return result.symbol.toLowerCase().includes(q) || result.name.toLowerCase().includes(q)
}

const GRADE_CLS = { 'A+': 'aplus', A: 'a', B: 'b', C: 'c' }
const GRADE_RANK = { 'A+': 0, A: 1, B: 2, C: 3 }

// Runs analyzeStock() over signal-bearing results and returns the ones whose
// decision resolves to BUY, as [{ r, a }] pairs ready for logBuyAlerts().
function computeBuyAlerts(results, portfolioOptions) {
  const buys = []
  for (const r of results) {
    if (!r.signalType) continue
    const a = analyzeStock(r, portfolioOptions)
    if (a.decision.action === 'BUY') buys.push({ r, a })
  }
  return buys
}

const SECTOR_STATUS_CLS = { HOT: 'sector-status-hot', WARM: 'sector-status-warm', COLD: 'sector-status-cold' }

const SIGNAL_OPTIONS = [
  { value: 'actionable', label: 'All Signals' },
  { value: 'BUY_BREAKOUT', label: 'Breakout' },
  { value: 'BUY_RETEST', label: 'Retest' },
  { value: 'WATCH', label: 'Watch' },
  { value: 'APPROACHING', label: 'Approaching' },
  { value: 'any', label: 'Any (incl. no signal)' },
]

function SectorHeatStrip({ sectorHeat }) {
  if (!sectorHeat) return null
  if (!sectorHeat.list || sectorHeat.list.length === 0) return null

  return (
    <div className="sector-heat">
      <div className="sector-heat-header">
        <span className="market-banner-title">Sector Heat (52W high gate)</span>
        <span className="sector-heat-summary text-muted">HOT = within 3% of own 52w high · WARM = within 8% · COLD = further out</span>
      </div>
      <div className="sector-chip-row">
        {sectorHeat.list.map((s) => (
          <div
            key={s.etf}
            className={`sector-chip ${SECTOR_STATUS_CLS[s.status] ?? 'sector-chip-neutral'}`}
            title={`${s.sector} (${s.etf}) — ${formatPct(s.pctFromHigh)} from 52w high`}
          >
            <span className="sector-chip-name">{s.etf}</span>
            <span className="sector-chip-ret">{s.status}</span>
          </div>
        ))}
      </div>
      {sectorHeat.warnings?.length > 0 && (
        <p className="section-empty">{sectorHeat.warnings.join(' · ')}</p>
      )}
    </div>
  )
}

// One section per verdict.js bucket — every visible result lands in exactly
// one of these three, no silent drops (see verdict.test.js's bucketing
// regression guard).
const SUMMARY_SECTIONS = [
  ['buyNow', '🟢 Buy Now', 'summary-chip-buy'],
  ['watch', '🟡 Watch', 'summary-chip-watch'],
  ['avoidSell', '🔴 Avoid / Sell', 'summary-chip-avoid'],
]

// Quick-glance dashboard above the full result list — buckets every
// currently-filtered result by its getVerdict() call so "which ones can I
// buy right now" doesn't require opening each card's Show Analysis panel
// one at a time. Purely a different view of the same data; clicking a chip
// jumps to and opens that stock's full analysis.
function BuyListSummary({ buckets, onSelect }) {
  const anyResults = SUMMARY_SECTIONS.some(([key]) => buckets[key].length > 0)
  if (!anyResults) return null

  return (
    <div className="result-card buy-list-summary">
      <h3 className="result-card-title">Quick Lists</h3>
      {SUMMARY_SECTIONS.map(([key, label, cls]) => {
        const items = buckets[key]
        if (items.length === 0) return null
        return (
          <div className="summary-row" key={key}>
            <span className="summary-row-label">
              {label} <span className="text-muted">({items.length})</span>
            </span>
            <div className="summary-chip-list">
              {items.map(({ r, verdict }) => (
                <button
                  type="button"
                  key={r.symbol}
                  className={`summary-chip ${cls}`}
                  onClick={() => onSelect(r.symbol)}
                  title={verdict.reason}
                >
                  {r.symbol} <span className="text-muted">{r.grade ?? '?'}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ResultCard({ result, expanded, onToggle, analysisOpen, onToggleAnalysis, portfolioSize, onSetAlert }) {
  const r = result
  // Computed unconditionally (not gated on analysisOpen) since getVerdict()
  // needs it for every visible card, not just the expanded "Show Analysis"
  // panel — bucketResultsByVerdict() already pays this same cost for every
  // filtered result for the Quick Lists dashboard, so this isn't a new
  // performance class.
  // attachTradePlan() (weekHighScreener.js, run by "Build Trade Plans")
  // mutates r.grade/r.tradePlan/r.earningsDaysAway IN PLACE rather than
  // replacing `r` — so `r` itself is the same object reference before and
  // after. useMemo compares deps by reference, so without listing the
  // specific mutable fields below, this card would keep showing its stale
  // pre-trade-plan verdict even though the Quick Lists dashboard (which
  // re-reads `r` fresh, not through a per-card memo) already updated —
  // exactly the kind of disagreeing-verdicts bug this component exists to
  // prevent.
  // The lint rule below assumes `r`'s reference alone captures its field
  // changes; it doesn't, since attachTradePlan() mutates these fields in
  // place (see comment above) — the explicit deps are required, not
  // redundant.
  const analysis = useMemo(
    () => analyzeStock(r, { portfolioSize, riskEnvironment: 'neutral', openPositions: loadPositions() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, r.grade, r.tradePlan, r.earningsDaysAway, portfolioSize]
  )
  const verdict = useMemo(() => getVerdict(r, analysis), [r, analysis])
  const canExpand = r.signalType === 'BUY_BREAKOUT' || r.signalType === 'BUY_RETEST'

  return (
    <div className="signal-card" id={`stock-${r.symbol}`}>
      <div className="signal-card-header">
        <div className="result-title">
          <span className="result-ticker mono">{r.symbol}</span>
          <span className="result-company">{r.name}</span>
        </div>
      </div>

      <VerdictPanel verdict={verdict} newHigh={r.newHigh} />

      <div className="card-meta-row">
        <span className="result-sector-tag">{r.sector}</span>
        {r.sectorStatus && (
          <span className={`sector-status-tag ${SECTOR_STATUS_CLS[r.sectorStatus] ?? ''}`}>{r.sectorStatus}</span>
        )}
      </div>

      <div className="result-stats">
        <div className="result-stat">
          <span className="result-stat-label">Price</span>
          <span className="result-stat-value mono">${r.price.toFixed(2)}</span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">52W High</span>
          <span className="result-stat-value mono">
            ${r.high52w.toFixed(2)} <span className="text-muted">({formatPct(r.pctFromHigh)})</span>
          </span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">52W Low</span>
          <span className="result-stat-value mono">
            ${r.low52w.toFixed(2)} <span className="text-muted">({formatPct(r.pctFromLow)})</span>
          </span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">Volume</span>
          <span className={`result-stat-value mono ${r.volumeConfirmed ? 'text-green' : ''}`}>
            {r.volRatio20 != null ? `${r.volRatio20.toFixed(2)}x` : 'N/A'}
            {r.volRatioMaxN != null && (
              <span className="text-muted">
                {' '}(best 5d {r.volRatioMaxN.toFixed(2)}x{r.volRatioMaxNDaysAgo ? `, ${r.volRatioMaxNDaysAgo}d ago` : ''})
              </span>
            )}
          </span>
        </div>
        {r.rsiValue != null && (
          <div className="result-stat">
            <span className="result-stat-label">RSI</span>
            <span className={`result-stat-value mono ${r.rsiValue >= 55 && r.rsiValue <= 72 ? 'text-green' : ''}`}>
              {r.rsiValue.toFixed(1)}
            </span>
          </div>
        )}
        {r.adxValue != null && (
          <div className="result-stat">
            <span className="result-stat-label">ADX</span>
            <span className={`result-stat-value mono ${r.adxValue > 28 ? 'text-green' : 'text-muted'}`}>
              {r.adxValue.toFixed(1)}
            </span>
          </div>
        )}
        <div className="result-stat">
          <span className="result-stat-label">Alligator</span>
          <span className={`result-stat-value mono ${r.alligatorPhase === 'EATING_UP' ? 'text-green' : 'text-muted'}`}>
            {r.alligatorPhase}
          </span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">MACD trend</span>
          <span className={`result-stat-value mono ${r.macdPosture === 'BULLISH' ? 'text-green' : 'text-muted'}`}>
            {r.macdPosture ?? 'unknown'}
          </span>
        </div>
        {r.rsRank != null && (
          <div className="result-stat">
            <span className="result-stat-label">RS Rank</span>
            <span className={`result-stat-value mono ${r.rsRank > 85 ? 'text-green' : r.rsRank > 70 ? '' : 'text-muted'}`}>
              {r.rsRank}
            </span>
          </div>
        )}
        <div className="result-stat">
          <span className="result-stat-label">1m / 3m</span>
          <span className="result-stat-value mono">{formatPct(r.ret1m)} / {formatPct(r.ret3m)}</span>
        </div>
        <div className="result-stat">
          <span className="result-stat-label">EMA Stack</span>
          <span className={`result-stat-value mono ${r.emaFullStack ? 'text-green' : 'text-muted'}`}>
            {r.emaFullStack ? '10>20>50 ✅' : '❌'}
          </span>
        </div>
        {r.avwapFromHigh && (
          <div className="result-stat">
            <span className="result-stat-label">AVWAP (52W High)</span>
            <span className={`result-stat-value mono ${r.avwapFromHigh.signal === 'BULLISH' ? 'text-green' : 'text-danger'}`}>
              {r.avwapFromHigh.signal} {r.avwapFromHigh.vsPricePct >= 0 ? '+' : ''}{r.avwapFromHigh.vsPricePct.toFixed(1)}%
            </span>
          </div>
        )}
      </div>

      <div className="badge-row">
        {canExpand && (
          <button type="button" className="btn" onClick={() => onToggle(r.symbol)}>
            {r.tradePlan ? (expanded ? 'Hide Trade Plan ▴' : 'Show Trade Plan ▾') : 'Build a trade plan to see details ▾'}
          </button>
        )}
        <button type="button" className="btn" onClick={() => onToggleAnalysis(r.symbol)}>
          {analysisOpen ? 'Hide Analysis ▴' : 'Show Analysis ▾'}
        </button>
      </div>

      {analysisOpen && (
        <>
          <AnalysisPanel data={analysis} onClose={() => onToggleAnalysis(r.symbol)} verdict={verdict} />
          <AvwapPanel symbol={r.symbol} />
        </>
      )}

      {expanded && r.tradePlan && (
        <div className="trade-plan-panel">
          {r.tradePlan.viable ? (
            <>
              <div className="result-stats">
                <div className="result-stat">
                  <span className="result-stat-label">Entry</span>
                  <span className="result-stat-value mono">${r.tradePlan.entryPrice.toFixed(2)}</span>
                  {onSetAlert && (
                    <button type="button" className="btn refresh-btn" onClick={() => onSetAlert(r, { price: r.tradePlan.entryPrice, label: 'Entry' })}>
                      Set Alert
                    </button>
                  )}
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Stop ({r.tradePlan.stopMethod})</span>
                  <span className="result-stat-value mono text-danger">
                    ${r.tradePlan.stopPrice.toFixed(2)} <span className="text-muted">(-{r.tradePlan.riskPct.toFixed(1)}%)</span>
                  </span>
                  {onSetAlert && (
                    <button type="button" className="btn refresh-btn" onClick={() => onSetAlert(r, { price: r.tradePlan.stopPrice, label: 'Stop' })}>
                      Set Alert
                    </button>
                  )}
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Shares</span>
                  <span className="result-stat-value mono">{r.tradePlan.shares}</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Position $</span>
                  <span className="result-stat-value mono">${r.tradePlan.positionValue.toLocaleString()} ({r.tradePlan.positionPct.toFixed(1)}%)</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Risk $</span>
                  <span className="result-stat-value mono">${r.tradePlan.riskAmount.toLocaleString()} ({r.tradePlan.riskAmountPct.toFixed(2)}%)</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Trim 1 (+1.5R, 25%)</span>
                  <span className="result-stat-value mono text-green">${r.tradePlan.trim1.price.toFixed(2)} · {r.tradePlan.trim1.shares} sh</span>
                  {onSetAlert && (
                    <button type="button" className="btn refresh-btn" onClick={() => onSetAlert(r, { price: r.tradePlan.trim1.price, label: 'Trim 1' })}>
                      Set Alert
                    </button>
                  )}
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Trim 2 (+2.5R, 25%)</span>
                  <span className="result-stat-value mono text-green">${r.tradePlan.trim2.price.toFixed(2)} · {r.tradePlan.trim2.shares} sh</span>
                  {onSetAlert && (
                    <button type="button" className="btn refresh-btn" onClick={() => onSetAlert(r, { price: r.tradePlan.trim2.price, label: 'Trim 2' })}>
                      Set Alert
                    </button>
                  )}
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Remaining (trail 2.5x ATR)</span>
                  <span className="result-stat-value mono">{r.tradePlan.trim3.shares} sh</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Time stop</span>
                  <span className="result-stat-value mono">{r.tradePlan.timeStopDate}</span>
                </div>
              </div>
              {r.earningsDaysAway != null && (
                <p className="section-empty">Earnings in {r.earningsDaysAway} day{r.earningsDaysAway === 1 ? '' : 's'}.</p>
              )}
            </>
          ) : (
            <p className="analysis-error">Not viable: {r.tradePlan.reason}</p>
          )}
          {r.thesis && <p className="thesis-text">{r.thesis}</p>}
        </div>
      )}
    </div>
  )
}

function WeekHighScreener() {
  const [totalMarketUniverse, setTotalMarketUniverse] = useState([])
  const [totalMarketStatus, setTotalMarketStatus] = useState('loading')

  useEffect(() => {
    getTotalStockMarketUniverse().then((companies) => {
      if (companies) {
        setTotalMarketUniverse(companies)
        setTotalMarketStatus('ready')
      } else {
        setTotalMarketStatus('error')
      }
    })
  }, [])

  const [sp500Override, setSp500Override] = useState(null)
  const [nasdaq100Override, setNasdaq100Override] = useState(null)
  const [sp500Refresh, setSp500Refresh] = useState({ status: 'idle' })
  const [nasdaq100Refresh, setNasdaq100Refresh] = useState({ status: 'idle' })
  const [etfValidation, setEtfValidation] = useState({ status: 'idle' })

  const universeGroups = useMemo(
    () => getUniverseGroups(totalMarketUniverse, { sp500: sp500Override, nasdaq100: nasdaq100Override }),
    [totalMarketUniverse, sp500Override, nasdaq100Override]
  )
  const [selectedGroups, setSelectedGroups] = useState(new Set(['sp500']))

  const handleRefreshSp500 = async () => {
    setSp500Refresh({ status: 'loading' })
    try {
      const next = await fetchSp500FromWikipedia()
      const diff = diffConstituents(sp500Override ?? SP500, next)
      setSp500Override(next)
      setSp500Refresh({ status: 'done', diff, count: next.length, at: new Date() })
    } catch (err) {
      setSp500Refresh({ status: 'error', error: err.message })
    }
  }

  const handleRefreshNasdaq100 = async () => {
    setNasdaq100Refresh({ status: 'loading' })
    try {
      const sectorBySymbol = new Map([...(sp500Override ?? SP500), ...NASDAQ100].map((c) => [c.symbol, c.sector]))
      const next = await fetchNasdaq100FromWikipedia(sectorBySymbol)
      const diff = diffConstituents(nasdaq100Override ?? NASDAQ100, next)
      setNasdaq100Override(next)
      setNasdaq100Refresh({ status: 'done', diff, count: next.length, at: new Date() })
    } catch (err) {
      setNasdaq100Refresh({ status: 'error', error: err.message })
    }
  }

  const handleValidateEtfs = async () => {
    setEtfValidation({ status: 'loading' })
    try {
      const results = await validateEtfTickers(ETFS_AND_METALS.map((e) => e.symbol))
      const flagged = results.filter((r) => r.tradable === false || r.status === 'error')
      setEtfValidation({ status: 'done', results, flagged, at: new Date() })
    } catch (err) {
      setEtfValidation({ status: 'error', error: err.message })
    }
  }

  const [portfolioSize] = useState(
    () => Number(localStorage.getItem(PORTFOLIO_STORAGE_KEY)) || DEFAULT_PORTFOLIO_SIZE
  )

  const [signalFilter, setSignalFilter] = useState('actionable')
  const [gradeFilter, setGradeFilter] = useState(new Set())
  const [emaFilter, setEmaFilter] = useState(false)
  const [resultSearch, setResultSearch] = useState('')

  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState(null)
  const [sectorHeat, setSectorHeat] = useState(null)
  const [error, setError] = useState(null)

  const [tradePlanLoading, setTradePlanLoading] = useState(false)
  const [tradePlanProgress, setTradePlanProgress] = useState(null)
  const [tradePlanError, setTradePlanError] = useState(null)
  const [expandedSymbol, setExpandedSymbol] = useState(null)
  const [analysisSymbol, setAnalysisSymbol] = useState(null)

  const [priceAlerts, setPriceAlerts] = useState(() => loadPriceAlerts())

  const handleSetAlert = (r, { price, label }) => {
    const next = addPriceAlert(priceAlerts, { symbol: r.symbol, name: r.name, price, label })
    setPriceAlerts(next)
    savePriceAlerts(next)
  }

  const toggleGroup = (id) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleScan = async () => {
    const groups = universeGroups.filter((g) => selectedGroups.has(g.id))
    if (groups.length === 0) return

    setScanning(true)
    setError(null)
    setResults(null)
    setSectorHeat(null)
    setExpandedSymbol(null)
    setTradePlanError(null)
    setProgress({ done: 0, total: 0 })

    try {
      const unionMap = new Map()
      for (const group of groups) {
        for (const company of group.companies) {
          if (!unionMap.has(company.symbol)) unionMap.set(company.symbol, company)
        }
      }
      const union = [...unionMap.values()]

      const { results: scanResults } = await scanWeekHighs((done, total) => setProgress({ done, total }), union)
      const { results: classified, sectorHeat: heat } = await classifyWeekHighResults(scanResults)
      setResults(classified)
      setSectorHeat(heat)
      logBuyAlerts(computeBuyAlerts(classified, { portfolioSize, riskEnvironment: 'neutral', openPositions: loadPositions() }))
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  const filteredResults = useMemo(() => {
    if (!results) return []
    let rows = results
    if (signalFilter === 'actionable') rows = rows.filter((r) => r.signalType != null)
    else if (signalFilter !== 'any') rows = rows.filter((r) => r.signalType === signalFilter)
    if (gradeFilter.size > 0) rows = rows.filter((r) => gradeFilter.has(r.grade))
    if (emaFilter) rows = rows.filter((r) => r.emaFullStack)
    rows = rows.filter((r) => matchesSearch(r, resultSearch))
    return [...rows].sort((a, b) => {
      const ga = GRADE_RANK[a.grade] ?? 4
      const gb = GRADE_RANK[b.grade] ?? 4
      if (ga !== gb) return ga - gb
      return (b.rsRank ?? -1) - (a.rsRank ?? -1)
    })
  }, [results, signalFilter, gradeFilter, emaFilter, resultSearch])

  // Buckets every currently-filtered result by getVerdict() for the Quick
  // Lists dashboard, via verdict.js's bucketResultsByVerdict() — every result
  // lands in exactly one of buyNow/watch/avoidSell, no dropped WAIT reasons
  // (see verdict.test.js's regression guard). analyzeStock is a pure,
  // synchronous function (no fetch), so running it over a few hundred
  // filtered results is still sub-second — this is just a different view of
  // data already on screen, not a new scan.
  const buyListBuckets = useMemo(() => {
    const portfolioOptions = { portfolioSize, riskEnvironment: 'neutral', openPositions: loadPositions() }
    const buckets = bucketResultsByVerdict(filteredResults, portfolioOptions)

    for (const items of Object.values(buckets)) {
      items.sort((x, y) => {
        const gx = GRADE_RANK[x.r.grade] ?? 4
        const gy = GRADE_RANK[y.r.grade] ?? 4
        return gx !== gy ? gx - gy : (y.r.rsRank ?? -1) - (x.r.rsRank ?? -1)
      })
    }
    return buckets
  }, [filteredResults, portfolioSize])

  const handleSelectFromSummary = (symbol) => {
    setAnalysisSymbol(symbol)
    requestAnimationFrame(() => {
      document.getElementById(`stock-${symbol}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const handleBuildTradePlans = async () => {
    const candidates = filteredResults.filter((r) => r.signalType === 'BUY_BREAKOUT' || r.signalType === 'BUY_RETEST')
    if (candidates.length === 0) return

    setTradePlanLoading(true)
    setTradePlanError(null)
    setTradePlanProgress({ done: 0, total: 0 })

    try {
      const marketCondition = await getMarketCondition()
      const openPositionsList = loadPositions()
      const portfolioOptions = { portfolioSize, riskEnvironment: marketCondition.riskEnvironment, openPositions: openPositionsList }
      await buildWeekHighTradePlans(
        candidates,
        portfolioOptions,
        (done, total) => setTradePlanProgress({ done, total })
      )
      setResults((prev) => [...prev])
      logBuyAlerts(computeBuyAlerts(candidates, portfolioOptions))
    } catch (err) {
      setTradePlanError(err.message)
    } finally {
      setTradePlanLoading(false)
      setTradePlanProgress(null)
    }
  }

  const actionableCount = filteredResults.filter((r) => r.signalType === 'BUY_BREAKOUT' || r.signalType === 'BUY_RETEST').length

  return (
    <div className="screener">
      {/* ── Market Conditions ── */}
      <MarketBanner />

      {/* ── Universe ── */}
      <div className="screener-intro">
        <h2 className="result-card-title">52-Week High Screener</h2>
        <p className="section-summary">
          Classifies every scanned stock into a breakout/retest/watch/approaching signal, grades the
          setup A+ through C (volume, RS rank, RSI, EMA stack, ADX, Alligator phase, sector heat,
          earnings distance), and — on request — builds a full stop/size/trim trade plan with a
          deterministic thesis. All computed locally from Alpaca/Finnhub data; no AI calls.
        </p>

        <h3 className="result-card-title">Universe</h3>
        <div className="checkbox-grid">
          {universeGroups.map((group) => {
            if (group.id === 'total-market') {
              return (
                <label key={group.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedGroups.has(group.id)}
                    onChange={() => toggleGroup(group.id)}
                    disabled={scanning || totalMarketStatus !== 'ready'}
                  />
                  {group.label}{' '}
                  <span className="text-muted">
                    {totalMarketStatus === 'loading' && '(loading…)'}
                    {totalMarketStatus === 'error' && '(unavailable)'}
                    {totalMarketStatus === 'ready' && `(${group.companies.length.toLocaleString()})`}
                  </span>
                </label>
              )
            }
            if (group.id === 'sp500' || group.id === 'nasdaq100') {
              const refreshState = group.id === 'sp500' ? sp500Refresh : nasdaq100Refresh
              const onRefresh = group.id === 'sp500' ? handleRefreshSp500 : handleRefreshNasdaq100
              const isOverridden = group.id === 'sp500' ? sp500Override != null : nasdaq100Override != null
              return (
                <div key={group.id} className="checkbox-label-with-refresh">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedGroups.has(group.id)}
                      onChange={() => toggleGroup(group.id)}
                      disabled={scanning}
                    />
                    {group.label} <span className="text-muted">({group.companies.length})</span>
                    {isOverridden && <span className="sector-status-tag sector-status-hot">LIVE</span>}
                  </label>
                  <button
                    type="button"
                    className="btn refresh-btn"
                    onClick={onRefresh}
                    disabled={scanning || refreshState.status === 'loading'}
                    title="Re-fetch current membership from Wikipedia (session-only)"
                  >
                    {refreshState.status === 'loading' ? <LoaderIcon className="spin-icon" /> : 'Refresh'}
                  </button>
                  {refreshState.status === 'done' && (
                    <span className="text-muted refresh-status">
                      Refreshed {group.companies.length} tickers — {formatRefreshDiff(refreshState.diff)}
                    </span>
                  )}
                  {refreshState.status === 'error' && (
                    <span className="text-danger refresh-status">Refresh failed: {refreshState.error}</span>
                  )}
                </div>
              )
            }
            if (group.id === 'etfs') {
              return (
                <div key={group.id} className="checkbox-label-with-refresh">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedGroups.has(group.id)}
                      onChange={() => toggleGroup(group.id)}
                      disabled={scanning}
                    />
                    {group.label} <span className="text-muted">({group.companies.length})</span>
                  </label>
                  <button
                    type="button"
                    className="btn refresh-btn"
                    onClick={handleValidateEtfs}
                    disabled={scanning || etfValidation.status === 'loading'}
                    title="Re-check every ticker against Alpaca's asset registry"
                  >
                    {etfValidation.status === 'loading' ? <LoaderIcon className="spin-icon" /> : 'Validate'}
                  </button>
                  {etfValidation.status === 'done' && (
                    <span className={etfValidation.flagged.length > 0 ? 'text-danger refresh-status' : 'text-green refresh-status'}>
                      {etfValidation.flagged.length === 0
                        ? `All ${etfValidation.results.length} tickers tradable`
                        : `${etfValidation.flagged.length} flagged: ${etfValidation.flagged.map((f) => `${f.symbol} (${f.status})`).join(', ')}`}
                    </span>
                  )}
                  {etfValidation.status === 'error' && (
                    <span className="text-danger refresh-status">Validation failed: {etfValidation.error}</span>
                  )}
                </div>
              )
            }
            return (
              <label key={group.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedGroups.has(group.id)}
                  onChange={() => toggleGroup(group.id)}
                  disabled={scanning}
                />
                {group.label} <span className="text-muted">({group.companies.length})</span>
              </label>
            )
          })}
        </div>

        <div className="screener-controls">
          <button
            className="btn btn-primary screener-scan-btn"
            onClick={handleScan}
            disabled={scanning || selectedGroups.size === 0}
          >
            {scanning ? (
              <>
                <LoaderIcon className="spin-icon" />
                Scanning {progress.done}/{progress.total}...
              </>
            ) : (
              <>
                <TrendingUpIcon />
                Scan Selected
              </>
            )}
          </button>
        </div>

        {scanning && (
          <div className="score-gauge-bar">
            <div
              className="score-gauge-fill"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        )}
      </div>

      {error && <div className="analysis-error">{error}</div>}

      <SectorHeatStrip sectorHeat={sectorHeat} />

      {results && (
        <div className="filter-panel filter-panel-active">
          <div className="filter-panel-header">
            <span className="filter-panel-title">Filters</span>
            <span className="filter-match-count">{results.length} scanned · {filteredResults.length} visible</span>
          </div>

          <div className="filter-row">
            <span className="filter-row-label">Signal</span>
            <div className="filter-chips">
              {SIGNAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`filter-chip${signalFilter === opt.value ? ' filter-chip-active' : ''}`}
                  onClick={() => setSignalFilter(opt.value)}
                >
                  {signalFilter === opt.value ? '✓ ' : ''}{opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-row">
            <span className="filter-row-label">Grade</span>
            <div className="filter-chips">
              {['A+', 'A', 'B', 'C'].map((g) => {
                const cls = GRADE_CLS[g]
                const active = gradeFilter.has(g)
                return (
                  <button
                    key={g}
                    type="button"
                    className={`grade-chip grade-chip-${cls}${active ? ' active' : ''}`}
                    onClick={() =>
                      setGradeFilter((prev) => {
                        const next = new Set(prev)
                        if (next.has(g)) next.delete(g)
                        else next.add(g)
                        return next
                      })
                    }
                  >
                    {active ? '✓ ' : ''}{g}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="filter-row">
            <span className="filter-row-label">Trend</span>
            <div className="filter-chips">
              <button
                type="button"
                className={`filter-chip${emaFilter ? ' filter-chip-active' : ''}`}
                onClick={() => setEmaFilter((v) => !v)}
              >
                {emaFilter ? '✓ ' : ''}EMA Stack (10&gt;20&gt;50)
              </button>
            </div>
          </div>

          <div className="filter-row">
            <span className="filter-row-label">Search</span>
            <input
              type="text"
              className="settings-input result-search filter-search"
              placeholder="Symbol or company name..."
              value={resultSearch}
              onChange={(e) => setResultSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      {results && <BuyListSummary buckets={buyListBuckets} onSelect={handleSelectFromSummary} />}

      {results && filteredResults.length > 0 && (
        <div className="result-card scan-summary">
          <p className="section-summary">
            {actionableCount} breakout/retest candidate{actionableCount === 1 ? '' : 's'} visible
            {actionableCount > MAX_TRADE_PLAN_CANDIDATES ? ` — first ${MAX_TRADE_PLAN_CANDIDATES} will get a trade plan.` : '.'}
          </p>
          <button
            className="btn btn-primary"
            onClick={handleBuildTradePlans}
            disabled={tradePlanLoading || actionableCount === 0}
          >
            {tradePlanLoading ? (
              <>
                <LoaderIcon className="spin-icon" />
                {tradePlanProgress && tradePlanProgress.total > 0
                  ? `Building ${tradePlanProgress.done}/${tradePlanProgress.total}...`
                  : 'Building trade plans...'}
              </>
            ) : (
              <>
                <TrendingUpIcon />
                Build Trade Plans
              </>
            )}
          </button>
          {tradePlanLoading && tradePlanProgress && (
            <div className="score-gauge-bar">
              <div
                className="score-gauge-fill"
                style={{ width: `${tradePlanProgress.total ? (tradePlanProgress.done / tradePlanProgress.total) * 100 : 0}%` }}
              />
            </div>
          )}
        </div>
      )}

      {tradePlanError && <div className="analysis-error">{tradePlanError}</div>}

      {results && (
        <div className="result-card">
          <h3 className="result-card-title">
            Results <span className="text-muted">({filteredResults.length} match{filteredResults.length === 1 ? '' : 'es'})</span>
          </h3>
          {filteredResults.length === 0 ? (
            <p className="section-empty">No stocks match the current filters.</p>
          ) : (
            <div className="signal-list">
              {filteredResults.map((r) => (
                <ResultCard
                  key={r.symbol}
                  result={r}
                  expanded={expandedSymbol === r.symbol}
                  onToggle={(symbol) => setExpandedSymbol((prev) => (prev === symbol ? null : symbol))}
                  analysisOpen={analysisSymbol === r.symbol}
                  onToggleAnalysis={(symbol) => setAnalysisSymbol((prev) => (prev === symbol ? null : symbol))}
                  portfolioSize={portfolioSize}
                  onSetAlert={handleSetAlert}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default WeekHighScreener
