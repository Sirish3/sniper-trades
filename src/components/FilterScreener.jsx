import { useMemo, useState } from 'react'
import { LoaderIcon, TrendingUpIcon } from './Icons'
import { SP500 } from '../data/sp500'
import { NASDAQ100 } from '../data/nasdaq100'
import { estimateScanMinutes } from '../utils/screener'
import { scanFilterCandidates, PENNY_STOCK_MAX_PRICE } from '../utils/filterScreener'

const EXCHANGES = [
  { id: 'sp500', label: 'S&P 500', companies: SP500 },
  { id: 'nasdaq100', label: 'Nasdaq 100', companies: NASDAQ100 },
]

function fmtPrice(value) {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

export default function FilterScreener() {
  const [selectedExchanges, setSelectedExchanges] = useState(new Set(['sp500']))
  const [excludePennyStocks, setExcludePennyStocks] = useState(true)
  const [emaStackOnly, setEmaStackOnly] = useState(false)

  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

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

  const filteredResults = useMemo(() => {
    if (!results) return []
    let rows = results
    if (excludePennyStocks) rows = rows.filter((r) => r.price >= PENNY_STOCK_MAX_PRICE)
    if (emaStackOnly) rows = rows.filter((r) => r.emaStackedUp)
    return [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [results, excludePennyStocks, emaStackOnly])

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Filter</div>
        <div className="bt-subtitle">
          Scans your selected exchange(s) for current price and the 10/20/50-day EMA stack, computed
          locally from Alpaca daily bars — no grading or signals, just the raw filter.
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
                    <th>10 EMA</th>
                    <th>20 EMA</th>
                    <th>50 EMA</th>
                    <th>EMA Stack</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((r) => (
                    <tr key={r.symbol}>
                      <td className="scanner-ticker-cell">{r.symbol}</td>
                      <td>{r.name}</td>
                      <td>{r.sector}</td>
                      <td>{fmtPrice(r.price)}</td>
                      <td>{fmtPrice(r.ema10)}</td>
                      <td>{fmtPrice(r.ema20)}</td>
                      <td>{fmtPrice(r.ema50)}</td>
                      <td className={r.emaStackedUp ? 'text-green' : 'text-muted'}>
                        {r.emaStackedUp ? '10>20>50' : '—'}
                      </td>
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
