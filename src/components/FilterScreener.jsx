import { useMemo, useState } from 'react'
import { LoaderIcon, TrendingUpIcon } from './Icons'
import { SP500 } from '../data/sp500'
import { NASDAQ100 } from '../data/nasdaq100'
import { estimateScanMinutes } from '../utils/screener'
import {
  scanFilterCandidates,
  checkFundamentals,
  estimateFundamentalsMinutes,
  PENNY_STOCK_MAX_PRICE,
  EPS_GROWTH_MIN_PCT,
  REVENUE_GROWTH_MIN_PCT,
  ROE_MIN_PCT,
  DEBT_EQUITY_MAX,
  MARKET_CAP_MIN,
} from '../utils/filterScreener'

const EXCHANGES = [
  { id: 'sp500', label: 'S&P 500', companies: SP500 },
  { id: 'nasdaq100', label: 'Nasdaq 100', companies: NASDAQ100 },
]

function fmtPrice(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

function fmtPct(value) {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

function fmtRatio(value) {
  return value == null ? '—' : value.toFixed(2)
}

function fmtMarketCap(value) {
  if (value == null) return '—'
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`
  return `$${value.toFixed(0)}`
}

function fmtFcf(r) {
  if (!r.fundamentalsChecked) return '—'
  if (r.fcfPositive == null || r.fcfGrowing == null) return 'Unknown'
  return r.fcfPositive && r.fcfGrowing ? 'Positive & growing' : 'No'
}

export default function FilterScreener() {
  const [selectedExchanges, setSelectedExchanges] = useState(new Set(['sp500']))

  // Technical filters — free, computed from the Alpaca bars already fetched by Run Filter.
  const [excludePennyStocks, setExcludePennyStocks] = useState(true)
  const [emaStackOnly, setEmaStackOnly] = useState(false)
  const [above200Sma, setAbove200Sma] = useState(false)

  // Fundamental filters — only meaningful once Check Fundamentals has run (see below).
  const [epsGrowthFilter, setEpsGrowthFilter] = useState(false)
  const [revenueGrowthFilter, setRevenueGrowthFilter] = useState(false)
  const [roeFilter, setRoeFilter] = useState(false)
  const [fcfFilter, setFcfFilter] = useState(false)
  const [debtEquityFilter, setDebtEquityFilter] = useState(false)
  const [marketCapFilter, setMarketCapFilter] = useState(false)

  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  const [fundamentalsChecking, setFundamentalsChecking] = useState(false)
  const [fundamentalsProgress, setFundamentalsProgress] = useState({ done: 0, total: 0 })
  const [fundamentalsError, setFundamentalsError] = useState(null)

  const toggleExchange = (id) => {
    setSelectedExchanges((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Deduped union of every selected exchange's constituents — some Nasdaq
  // 100 names are also in the S&P 500, so this both drives the scan itself
  // and gives an accurate (not double-counted) ticker count for the time
  // estimate below.
  const selectedUniverse = useMemo(() => {
    const unionMap = new Map()
    for (const group of EXCHANGES) {
      if (!selectedExchanges.has(group.id)) continue
      for (const company of group.companies) {
        if (!unionMap.has(company.symbol)) unionMap.set(company.symbol, company)
      }
    }
    return [...unionMap.values()]
  }, [selectedExchanges])

  const handleFilter = async () => {
    if (selectedUniverse.length === 0) return

    setScanning(true)
    setError(null)
    setResults(null)
    setFundamentalsError(null)
    setProgress({ done: 0, total: 0 })

    try {
      const { results: scanResults } = await scanFilterCandidates(
        (done, total) => setProgress({ done, total }),
        selectedUniverse
      )
      setResults(scanResults)
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  // Technical filters only — this is both what's shown when no fundamental
  // filter is active AND the subset Check Fundamentals fetches against, so
  // Finnhub cost scales with "stocks that already passed the free filters,"
  // not the whole scanned universe (see filterScreener.js's file header).
  const technicallyFilteredResults = useMemo(() => {
    if (!results) return []
    let rows = results
    if (excludePennyStocks) rows = rows.filter((r) => r.price >= PENNY_STOCK_MAX_PRICE)
    if (emaStackOnly) rows = rows.filter((r) => r.emaStackedUp)
    if (above200Sma) rows = rows.filter((r) => r.aboveSma200)
    return rows
  }, [results, excludePennyStocks, emaStackOnly, above200Sma])

  const anyFundamentalFilterOn =
    epsGrowthFilter || revenueGrowthFilter || roeFilter || fcfFilter || debtEquityFilter || marketCapFilter

  const needsFundamentalsCheck =
    anyFundamentalFilterOn && technicallyFilteredResults.some((r) => !r.fundamentalsChecked)

  const filteredResults = useMemo(() => {
    let rows = technicallyFilteredResults
    if (epsGrowthFilter) rows = rows.filter((r) => r.epsGrowth != null && r.epsGrowth > EPS_GROWTH_MIN_PCT)
    if (revenueGrowthFilter) rows = rows.filter((r) => r.revenueGrowth != null && r.revenueGrowth > REVENUE_GROWTH_MIN_PCT)
    if (roeFilter) rows = rows.filter((r) => r.roe != null && r.roe > ROE_MIN_PCT)
    if (fcfFilter) rows = rows.filter((r) => r.fcfPositive === true && r.fcfGrowing === true)
    if (debtEquityFilter) rows = rows.filter((r) => r.debtToEquity != null && r.debtToEquity < DEBT_EQUITY_MAX)
    if (marketCapFilter) rows = rows.filter((r) => r.marketCap != null && r.marketCap > MARKET_CAP_MIN)
    return [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [technicallyFilteredResults, epsGrowthFilter, revenueGrowthFilter, roeFilter, fcfFilter, debtEquityFilter, marketCapFilter])

  const handleCheckFundamentals = async () => {
    if (technicallyFilteredResults.length === 0) return

    setFundamentalsChecking(true)
    setFundamentalsError(null)
    setFundamentalsProgress({ done: 0, total: 0 })

    try {
      await checkFundamentals(technicallyFilteredResults, (done, total) => setFundamentalsProgress({ done, total }))
      setResults((prev) => [...prev]) // checkFundamentals mutates in place — force a re-render
    } catch (err) {
      setFundamentalsError(err.message)
    } finally {
      setFundamentalsChecking(false)
    }
  }

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Filter</div>
        <div className="bt-subtitle">
          Scans your selected exchange(s) for price, the 10/20/50-day EMA stack, and price vs. the 200-day
          SMA — computed locally from Alpaca daily bars. Fundamentals (EPS/revenue growth, ROE, debt/equity,
          market cap, free cash flow) are a separate step below, since each ticker needs its own Finnhub
          lookup — no grading or signals, just the raw filters.
        </div>
      </div>

      <div className="bt-controls">
        <div className="bt-signal-builder">
          {EXCHANGES.map((group) => (
            <label key={group.id} className="scanner-checkbox-label">
              <input
                type="checkbox"
                checked={selectedExchanges.has(group.id)}
                onChange={() => toggleExchange(group.id)}
                disabled={scanning}
              />
              {group.label} <span className="text-muted">({group.companies.length})</span>
            </label>
          ))}
        </div>

        <div className="bt-signal-builder">
          <label className="scanner-checkbox-label">
            <input
              type="checkbox"
              checked={excludePennyStocks}
              onChange={(e) => setExcludePennyStocks(e.target.checked)}
            />
            Exclude penny stocks (below ${PENNY_STOCK_MAX_PRICE})
          </label>
          <label className="scanner-checkbox-label">
            <input
              type="checkbox"
              checked={emaStackOnly}
              onChange={(e) => setEmaStackOnly(e.target.checked)}
            />
            10 EMA &gt; 20 EMA &gt; 50 EMA
          </label>
          <label className="scanner-checkbox-label">
            <input
              type="checkbox"
              checked={above200Sma}
              onChange={(e) => setAbove200Sma(e.target.checked)}
            />
            Price &gt; 200-day SMA
          </label>
        </div>

        <div className="bt-run-row">
          <button
            className="btn btn-primary bt-run-btn"
            onClick={handleFilter}
            disabled={scanning || selectedUniverse.length === 0}
          >
            {scanning ? (
              <>
                <LoaderIcon className="spin-icon" />
                Filtering {progress.done}/{progress.total}...
              </>
            ) : (
              <>
                <TrendingUpIcon />
                Run Filter
              </>
            )}
          </button>
          {!scanning && selectedUniverse.length > 0 && (
            <span className="text-muted">
              {selectedUniverse.length} tickers · ~{estimateScanMinutes(selectedUniverse.length)} min estimated
            </span>
          )}
        </div>

        {scanning && (
          <div className="score-gauge-bar">
            <div
              className="score-gauge-fill"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        )}

        {results && (
          <>
            <div className="bt-signal-builder">
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={epsGrowthFilter} onChange={(e) => setEpsGrowthFilter(e.target.checked)} />
                EPS growth &gt; {EPS_GROWTH_MIN_PCT}%
              </label>
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={revenueGrowthFilter} onChange={(e) => setRevenueGrowthFilter(e.target.checked)} />
                Revenue growth &gt; {REVENUE_GROWTH_MIN_PCT}%
              </label>
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={roeFilter} onChange={(e) => setRoeFilter(e.target.checked)} />
                ROE &gt; {ROE_MIN_PCT}%
              </label>
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={fcfFilter} onChange={(e) => setFcfFilter(e.target.checked)} />
                Free cash flow positive &amp; growing
              </label>
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={debtEquityFilter} onChange={(e) => setDebtEquityFilter(e.target.checked)} />
                Debt/Equity &lt; {DEBT_EQUITY_MAX}
              </label>
              <label className="scanner-checkbox-label">
                <input type="checkbox" checked={marketCapFilter} onChange={(e) => setMarketCapFilter(e.target.checked)} />
                Market cap &gt; ${MARKET_CAP_MIN / 1e9}B
              </label>
            </div>

            <div className="bt-run-row">
              <button
                className="btn bt-run-btn"
                onClick={handleCheckFundamentals}
                disabled={fundamentalsChecking || technicallyFilteredResults.length === 0}
              >
                {fundamentalsChecking ? (
                  <>
                    <LoaderIcon className="spin-icon" />
                    Checking {fundamentalsProgress.done}/{fundamentalsProgress.total}...
                  </>
                ) : (
                  `Check Fundamentals (${technicallyFilteredResults.length} ticker${technicallyFilteredResults.length === 1 ? '' : 's'})`
                )}
              </button>
              {!fundamentalsChecking && technicallyFilteredResults.length > 0 && (
                <span className="text-muted">
                  ~{estimateFundamentalsMinutes(technicallyFilteredResults.length)} min estimated
                </span>
              )}
            </div>

            {fundamentalsChecking && (
              <div className="score-gauge-bar">
                <div
                  className="score-gauge-fill"
                  style={{
                    width: `${fundamentalsProgress.total ? (fundamentalsProgress.done / fundamentalsProgress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            )}

            {needsFundamentalsCheck && !fundamentalsChecking && (
              <div className="qqq-state-loading">
                A fundamental filter is on but some of these tickers haven&apos;t been checked yet — click Check
                Fundamentals above to fetch their data.
              </div>
            )}

            {fundamentalsError && <div className="bt-error">{fundamentalsError}</div>}
          </>
        )}
      </div>

      {error && <div className="bt-error">{error}</div>}

      {!results && !error && !scanning && (
        <div className="qqq-state-loading">Select exchange(s) above, then click Run Filter.</div>
      )}

      {results && (
        <div className="bt-result">
          <div className="bt-result-title">
            {filteredResults.length} of {results.length} ticker{results.length === 1 ? '' : 's'}
          </div>

          {filteredResults.length === 0 ? (
            <div className="qqq-state-loading">No tickers match the current filters.</div>
          ) : (
            <div className="scanner-table-wrap">
              <table className="scanner-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Company</th>
                    <th>Sector</th>
                    <th>Price</th>
                    <th>200 SMA</th>
                    <th>EMA Stack</th>
                    <th>Mkt Cap</th>
                    <th>EPS Gr.</th>
                    <th>Rev Gr.</th>
                    <th>ROE</th>
                    <th>D/E</th>
                    <th>FCF</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((r) => (
                    <tr key={r.symbol}>
                      <td className="scanner-ticker-cell">{r.symbol}</td>
                      <td>{r.name}</td>
                      <td>{r.sector}</td>
                      <td>{fmtPrice(r.price)}</td>
                      <td className={r.aboveSma200 ? 'text-green' : 'text-muted'}>
                        {r.aboveSma200 == null ? '—' : r.aboveSma200 ? 'Above' : 'Below'}
                      </td>
                      <td className={r.emaStackedUp ? 'text-green' : 'text-muted'}>
                        {r.emaStackedUp ? '10>20>50' : '—'}
                      </td>
                      <td>{fmtMarketCap(r.marketCap)}</td>
                      <td>{fmtPct(r.epsGrowth)}</td>
                      <td>{fmtPct(r.revenueGrowth)}</td>
                      <td>{fmtPct(r.roe)}</td>
                      <td>{fmtRatio(r.debtToEquity)}</td>
                      <td className={r.fcfPositive && r.fcfGrowing ? 'text-green' : ''}>{fmtFcf(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
