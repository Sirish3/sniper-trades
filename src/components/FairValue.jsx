import { useState } from 'react'

// Calls the swing_scanner Flask API's /api/fair-value/<ticker> endpoint —
// same API_BASE pattern as EarningsCalendar.jsx/SwingScanner.jsx.
const API_BASE = import.meta.env.VITE_SWING_SCANNER_API_URL || '/swing-scanner-api'

const FLAG_LABELS = {
  PRICE_DATA_UNAVAILABLE: 'Price data unavailable — Alpaca fetch failed for this ticker',
  LOW_LIQUIDITY: 'Thin trading volume — current price is a less reliable anchor',
  MISSING_FINANCIALS: 'No financial statements found for this ticker (foreign filer, very new IPO, etc.)',
  THIN_HISTORY: 'Fewer than 3 years of financial history — trend figures are low-confidence',
  CONCEPT_MISMATCH: "This filer's financial statements didn't match any known line-item format",
  STALE_ANNUAL_DATA: 'Most recent fiscal year ended over a year ago — FCF figures may be dated',
  INSUFFICIENT_TREND_DATA: 'Not enough consistent history to compute a growth trend',
  FINVIZ_UNAVAILABLE: 'Could not reach Finviz for multiples/context data',
  LOW_CONFIDENCE_PEER_GROUP: 'Fewer than 8 sector peers had usable data for at least one multiple — sector-relative estimate is low-confidence',
  INSUFFICIENT_OWN_HISTORY_DATA: "Not enough of this ticker's own price/fundamental history to compute an own-average multiple",
}

const MULTIPLE_LABELS = {
  peTrailing: 'P/E',
  priceToSales: 'P/S',
  priceToFcf: 'P/FCF',
  priceToBook: 'P/B',
  evToEbitda: 'EV/EBITDA',
  roe: 'ROE',
}

function fmtMoney(value) {
  if (value == null) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  return `$${value.toFixed(2)}`
}

function fmtPct(value) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtNum(value, decimals = 2) {
  return value == null ? '—' : value.toFixed(decimals)
}

function Stat({ label, value, className = '' }) {
  return (
    <div className="result-stat">
      <span className="result-stat-label">{label}</span>
      <span className={`result-stat-value mono ${className}`}>{value}</span>
    </div>
  )
}

export default function FairValue() {
  const [ticker, setTicker] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function handleAnalyze() {
    const symbol = ticker.trim().toUpperCase()
    if (!symbol) return

    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`${API_BASE}/api/fair-value/${symbol}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load fair value data')
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const fcf = result?.fcfYieldTrend
  const week = result?.weekRangeContext
  const mult = result?.multiplesContext
  const analyst = result?.analystSentiment
  const methodA = result?.methodA
  const methodB = result?.methodB

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Fair Value</div>
        <div className="bt-subtitle">
          Two independent fair-value estimates — Method A (this ticker&apos;s own fundamentals x its sector peers&apos;
          median multiple) and Method B (this ticker&apos;s own multiple, averaged over its own recent history) —
          plus FCF yield/trend, relative multiples, and 52-week range as supporting context. Never blended into
          one number. Built entirely from Alpaca, Finnhub, Finviz, and Wikipedia&apos;s free tiers; no analyst
          price target exists free from any of them, so none is shown.
        </div>
      </div>

      <div className="bt-controls">
        <label className="scanner-input-label" style={{ flex: 1 }}>
          Ticker
          <input
            className="bt-input"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAnalyze() }}
            placeholder="AAPL"
          />
        </label>
        <div className="bt-run-row">
          <button className="btn btn-primary bt-run-btn" onClick={handleAnalyze} disabled={loading || !ticker.trim()}>
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      {result && (
        <div className="bt-result">
          <div className="bt-result-title">{result.ticker}</div>

          {result.confidenceFlags?.length > 0 && (
            <div className="bt-error" style={{ marginBottom: '1rem' }}>
              {result.confidenceFlags.map((flag) => (
                <div key={flag}>⚠ {FLAG_LABELS[flag] || flag}</div>
              ))}
            </div>
          )}

          {result.currentPrice != null && (
            <div className="result-stats" style={{ marginBottom: '1rem' }}>
              <Stat label="Current price" value={fmtMoney(result.currentPrice)} />
            </div>
          )}

          <div className="bt-section-divider"><span>Method A — Sector-Relative</span></div>
          {methodA?.available ? (
            <>
              <p className="section-empty">
                Sector: {methodA.sector} · {methodA.peerUniverseSize} S&amp;P 500 / Nasdaq 100 peers in universe
              </p>
              <div className="result-stats">
                {Object.entries(methodA.multiples).map(([field, m]) => (
                  <Stat
                    key={field}
                    label={`${MULTIPLE_LABELS[field] || field} (peer median ${fmtNum(m.peerMedian)}, n=${m.peerCount}${m.lowConfidence ? ', low confidence' : ''})`}
                    value={
                      field === 'roe'
                        ? fmtPct(m.peerMedian)
                        : m.reason
                          ? m.reason
                          : `${fmtMoney(m.impliedFairValue)} (${fmtPct(m.pctFromCurrentPrice)})`
                    }
                    className={m.lowConfidence ? 'text-danger' : ''}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="section-empty">{methodA?.reason || 'Not available for this ticker.'}</p>
          )}

          <div className="bt-section-divider"><span>Method B — Own-History Reversion</span></div>
          {methodB?.available ? (
            <>
              {['peTrailing', 'priceToFcf'].map((field) => {
                const m = methodB[field]
                if (!m?.available) {
                  return (
                    <p key={field} className="section-empty">
                      {MULTIPLE_LABELS[field]}: {m?.reason || 'Not available for this ticker.'}
                    </p>
                  )
                }
                return (
                  <div key={field} className="result-stats" style={{ marginBottom: '0.5rem' }}>
                    <Stat label={`${MULTIPLE_LABELS[field]} — own avg (${m.windowStart} to ${m.windowEnd}, ${m.pointsUsed} pts)`} value={fmtNum(m.ownAvgMultiple)} />
                    <Stat label={`${MULTIPLE_LABELS[field]} — current`} value={fmtNum(m.currentMultiple)} />
                    <Stat label="Implied fair value" value={fmtMoney(m.impliedFairValue)} />
                  </div>
                )
              })}
              <p className="section-empty" style={{ marginTop: '0.5rem' }}>{methodB.note}</p>
            </>
          ) : (
            <p className="section-empty">{methodB?.note}</p>
          )}

          <div className="bt-section-divider"><span>FCF Yield &amp; Trend</span></div>
          {fcf?.available ? (
            <div className="result-stats">
              <Stat label="FCF (last fiscal year)" value={fmtMoney(fcf.fcf)} />
              <Stat label="Fiscal year" value={`FY${fcf.asOfFiscalYear} (ended ${fcf.asOfDate})`} />
              <Stat label="Operating cash flow" value={fmtMoney(fcf.operatingCashFlow)} />
              <Stat label="CapEx" value={fmtMoney(fcf.capex)} />
              <Stat
                label="FCF yield (vs. market cap)"
                value={fmtPct(fcf.fcfYieldPct)}
                className={fcf.yieldVsOwnHistory === 'above_average' ? 'text-green' : fcf.yieldVsOwnHistory === 'below_average' ? 'text-danger' : ''}
              />
              <Stat label={`Own ${fcf.yearsOfHistory}y avg FCF yield`} value={fmtPct(fcf.ownHistoryAvgYieldPct)} />
              <Stat label="FCF CAGR" value={fcf.fcfCagrPct != null ? fmtPct(fcf.fcfCagrPct) : 'insufficient data'} />
            </div>
          ) : (
            <p className="section-empty">{fcf?.reason || 'Not available for this ticker.'}</p>
          )}

          <div className="bt-section-divider"><span>52-Week Range Context</span></div>
          {week?.available ? (
            <div className="result-stats">
              <Stat label="Current price" value={fmtMoney(week.price)} />
              <Stat label="52W High" value={`${fmtMoney(week.high52w)} (${fmtPct(week.pctFromHigh)})`} />
              <Stat label="52W Low" value={`${fmtMoney(week.low52w)} (${fmtPct(week.pctFromLow)})`} />
              <Stat label="Avg volume (20d)" value={week.avgVolume20?.toLocaleString() ?? '—'} />
            </div>
          ) : (
            <p className="section-empty">Price data unavailable for this ticker.</p>
          )}

          <div className="bt-section-divider"><span>Relative Multiples (context only)</span></div>
          <div className="result-stats">
            <Stat label="P/E (trailing)" value={fmtNum(mult?.peTrailing)} />
            <Stat label="P/E (forward)" value={fmtNum(mult?.peForward)} />
            <Stat label="PEG" value={fmtNum(mult?.peg)} />
            <Stat label="P/S" value={fmtNum(mult?.priceToSales)} />
            <Stat label="P/B" value={fmtNum(mult?.priceToBook)} />
            <Stat label="P/FCF" value={fmtNum(mult?.priceToFcf)} />
            <Stat label="EV/EBITDA" value={fmtNum(mult?.evToEbitda)} />
            <Stat label="Debt/Equity" value={fmtNum(mult?.debtToEquity)} />
            <Stat label="ROE" value={fmtPct(mult?.roe)} />
            <Stat label="ROA" value={fmtPct(mult?.roa)} />
            <Stat label="ROIC" value={fmtPct(mult?.roic)} />
            <Stat label="Gross margin" value={fmtPct(mult?.grossMarginPct)} />
            <Stat label="Operating margin" value={fmtPct(mult?.operatingMarginPct)} />
            <Stat label="Profit margin" value={fmtPct(mult?.profitMarginPct)} />
          </div>
          <p className="section-empty" style={{ marginTop: '0.5rem' }}>{mult?.note}</p>

          <div className="bt-section-divider"><span>Analyst Sentiment</span></div>
          {analyst?.available ? (
            <>
              <div className="result-stats">
                <Stat label="Strong Buy" value={analyst.strongBuy} className="text-green" />
                <Stat label="Buy" value={analyst.buy} className="text-green" />
                <Stat label="Hold" value={analyst.hold} />
                <Stat label="Sell" value={analyst.sell} className="text-danger" />
                <Stat label="Strong Sell" value={analyst.strongSell} className="text-danger" />
                <Stat label="As of" value={analyst.period} />
              </div>
              <p className="section-empty" style={{ marginTop: '0.5rem' }}>{analyst.note}</p>
            </>
          ) : (
            <p className="section-empty">No analyst coverage found for this ticker.</p>
          )}
        </div>
      )}
    </div>
  )
}
