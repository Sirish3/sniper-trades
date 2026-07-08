import { useEffect, useState } from 'react'
import { createSetup, deleteSetup, getAllSetupsForAdmin, runPatternScan, updateSetup } from '../utils/chartSetupsApi'
import { draftChartSetupBlurb } from '../utils/claudeApi'

const STATUSES = ['draft', 'published', 'archived']

// Mirrors swing_scanner/pipeline.py's TEST_SUBSET — the same default
// watchlist the scheduled 4:30pm ET pattern scan uses when no custom
// ticker list is given.
const DEFAULT_WATCHLIST = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'MA',
  'HD', 'UNH', 'JNJ', 'PG', 'XOM', 'CVX', 'WMT', 'KO', 'PEP', 'DIS',
]

const EMPTY_FORM = {
  ticker: '',
  patternType: '',
  supportLow: '',
  supportHigh: '',
  resistance: '',
  description: '',
  status: 'draft',
  annotationsJson: '{\n  "trendlines": [],\n  "zones": [],\n  "hlines": []\n}',
}

function toFormState(setup) {
  return {
    ticker: setup.ticker,
    patternType: setup.patternType,
    supportLow: setup.supportLow ?? '',
    supportHigh: setup.supportHigh ?? '',
    resistance: setup.resistance ?? '',
    description: setup.description || '',
    status: setup.status,
    annotationsJson: JSON.stringify(setup.chartAnnotations || {}, null, 2),
  }
}

export default function ChartSetupAdmin({ apiKey }) {
  const [setups, setSetups] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const [checkedDefaults, setCheckedDefaults] = useState(new Set())
  const [customTicker, setCustomTicker] = useState('')
  const [customTickers, setCustomTickers] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [scanSummary, setScanSummary] = useState(null)

  function loadSetups() {
    getAllSetupsForAdmin().then(setSetups).catch((err) => setError(err.message))
  }

  useEffect(() => { loadSetups() }, [])

  function selectSetup(setup) {
    setSelectedId(setup.id)
    setForm(toFormState(setup))
    setError(null)
    setJustSaved(false)
  }

  function newSetup() {
    setSelectedId(null)
    setForm(EMPTY_FORM)
    setError(null)
    setJustSaved(false)
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    setJustSaved(false)
  }

  async function handleDraft() {
    if (!form.ticker || !form.patternType) {
      setError('Enter a ticker and pattern type before drafting a blurb.')
      return
    }
    setDrafting(true)
    setError(null)
    try {
      const blurb = await draftChartSetupBlurb(
        form.ticker,
        form.patternType,
        form.supportLow || null,
        form.supportHigh || null,
        form.resistance || null,
        apiKey,
      )
      if (blurb) update('description', blurb)
      else setError('Claude draft came back empty — check your API key, or write the blurb by hand.')
    } catch (err) {
      setError(err.message)
    } finally {
      setDrafting(false)
    }
  }

  function buildPayload() {
    let chartAnnotations
    try {
      chartAnnotations = JSON.parse(form.annotationsJson || '{}')
    } catch {
      throw new Error('Chart annotations JSON is invalid — check the syntax.')
    }
    return {
      ticker: form.ticker.trim().toUpperCase(),
      patternType: form.patternType.trim(),
      supportLow: form.supportLow === '' ? null : Number(form.supportLow),
      supportHigh: form.supportHigh === '' ? null : Number(form.supportHigh),
      resistance: form.resistance === '' ? null : Number(form.resistance),
      description: form.description,
      status: form.status,
      chartAnnotations,
    }
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const payload = buildPayload()
      const saved = selectedId ? await updateSetup(selectedId, payload) : await createSetup(payload)
      loadSetups()
      selectSetup(saved) // keep the just-saved setup loaded (was resetting to a blank form, making a successful save look like it did nothing)
      setJustSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!selectedId || !confirm(`Delete ${form.ticker}'s "${form.patternType}" setup? This can't be undone.`)) return
    setSaving(true)
    setError(null)
    try {
      await deleteSetup(selectedId)
      loadSetups()
      newSetup()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function toggleDefaultTicker(ticker) {
    setCheckedDefaults((prev) => {
      const next = new Set(prev)
      if (next.has(ticker)) next.delete(ticker)
      else next.add(ticker)
      return next
    })
  }

  function addCustomTicker() {
    const t = customTicker.trim().toUpperCase()
    if (t && !customTickers.includes(t)) setCustomTickers((prev) => [...prev, t])
    setCustomTicker('')
  }

  function removeCustomTicker(t) {
    setCustomTickers((prev) => prev.filter((x) => x !== t))
  }

  async function handleRunScan() {
    const symbols = [...checkedDefaults, ...customTickers]
    if (symbols.length === 0) {
      setScanError('Check at least one watchlist ticker, or add a custom one, before running a scan.')
      return
    }
    setScanning(true)
    setScanError(null)
    setScanSummary(null)
    try {
      const summary = await runPatternScan(symbols)
      setScanSummary(summary)
      loadSetups()
    } catch (err) {
      setScanError(err.message)
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Chart Patterns — Admin</div>
        <div className="bt-subtitle">Manually curated setups. Pick the ticker, pattern, and levels yourself — Claude only drafts the blurb.</div>
      </div>

      {error && <div className="bt-error">{error}</div>}

      <div className="bt-section-divider"><span>Run Pattern Scan</span></div>
      <div className="cp-scan-panel">
        <div className="bt-subtitle">
          Runs the same rule-based detector (Double Top/Bottom, Cup and Handle, Triangles, Wedges, Bull Flag) the
          4:30pm ET daily job uses — on demand, against whatever tickers you pick below. Results land as drafts,
          same as always.
        </div>

        <div className="cp-watchlist-grid">
          {DEFAULT_WATCHLIST.map((ticker) => (
            <label key={ticker} className="scanner-checkbox-label">
              <input type="checkbox" checked={checkedDefaults.has(ticker)} onChange={() => toggleDefaultTicker(ticker)} />
              {ticker}
            </label>
          ))}
        </div>

        <div className="cp-custom-tickers">
          <label className="scanner-input-label" style={{ flex: 1 }}>
            Add a custom ticker
            <input
              className="bt-input"
              value={customTicker}
              onChange={(e) => setCustomTicker(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTicker() } }}
              placeholder="e.g. SOFI"
            />
          </label>
          <button className="btn" onClick={addCustomTicker}>Add</button>
        </div>

        {customTickers.length > 0 && (
          <div className="cp-ticker-chip-row">
            {customTickers.map((t) => (
              <span key={t} className="cp-ticker-chip">
                {t}
                <button className="cp-ticker-chip-remove" onClick={() => removeCustomTicker(t)} aria-label={`Remove ${t}`}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className="bt-run-row" style={{ marginTop: '0.75rem' }}>
          <button className="btn btn-primary bt-run-btn" onClick={handleRunScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Run Scan'}
          </button>
        </div>

        {scanError && <div className="bt-error">{scanError}</div>}

        {scanSummary && (
          <div className="cp-scan-results">
            <div className="cp-scan-results-title">
              {Object.keys(scanSummary.detectedPerTicker).length} ticker(s) scanned — {scanSummary.rows.length} new/updated,{' '}
              {scanSummary.skipped} unchanged, {scanSummary.claudeCalls} Claude call{scanSummary.claudeCalls === 1 ? '' : 's'}
            </div>
            <div className="cp-scan-per-ticker">
              {Object.entries(scanSummary.detectedPerTicker).map(([ticker, count]) => (
                <span key={ticker} className="cp-scan-ticker-chip">{ticker}: {count}</span>
              ))}
            </div>
            {scanSummary.rows.length > 0 && (
              <div className="cp-admin-list" style={{ marginTop: '0.5rem' }}>
                {scanSummary.rows.map((row) => (
                  <button key={row.id} className="cp-sidebar-item" onClick={() => selectSetup(row)}>
                    <span>{row.ticker} — {row.patternType}</span>
                    <span className="cp-sidebar-count">{row.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bt-section-divider"><span>Manage Setups</span></div>

      <div className="cp-admin-layout">
        <div className="cp-admin-list">
          <button className="btn btn-primary" style={{ width: '100%', marginBottom: '0.5rem' }} onClick={newSetup}>
            + New setup
          </button>
          {setups?.map((s) => (
            <button
              key={s.id}
              className={`cp-sidebar-item ${selectedId === s.id ? 'active' : ''}`}
              onClick={() => selectSetup(s)}
            >
              <span>{s.ticker} — {s.patternType}</span>
              <span className="cp-sidebar-count">{s.status}</span>
            </button>
          ))}
        </div>

        <div className="cp-admin-form">
          <div className="scanner-sizing-grid">
            <label className="scanner-input-label">
              Ticker
              <input className="bt-input" value={form.ticker} onChange={(e) => update('ticker', e.target.value)} placeholder="AAPL" />
            </label>
            <label className="scanner-input-label">
              Pattern type
              <input className="bt-input" value={form.patternType} onChange={(e) => update('patternType', e.target.value)} placeholder="Cup & Handle" list="cp-pattern-options" />
              <datalist id="cp-pattern-options">
                {[...new Set(setups?.map((s) => s.patternType))].map((p) => <option key={p} value={p} />)}
              </datalist>
            </label>
            <label className="scanner-input-label">
              Status
              <select className="bt-input" value={form.status} onChange={(e) => update('status', e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>

          <div className="scanner-sizing-grid">
            <label className="scanner-input-label">
              Support low
              <input className="bt-input" type="number" step="0.01" value={form.supportLow} onChange={(e) => update('supportLow', e.target.value)} />
            </label>
            <label className="scanner-input-label">
              Support high (optional — leave blank for a single line)
              <input className="bt-input" type="number" step="0.01" value={form.supportHigh} onChange={(e) => update('supportHigh', e.target.value)} />
            </label>
            <label className="scanner-input-label">
              Resistance
              <input className="bt-input" type="number" step="0.01" value={form.resistance} onChange={(e) => update('resistance', e.target.value)} />
            </label>
          </div>

          <label className="scanner-input-label" style={{ display: 'block', marginTop: '0.75rem' }}>
            Description
            <textarea
              className="bt-input cp-textarea"
              rows={4}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
            />
          </label>
          <button className="btn" onClick={handleDraft} disabled={drafting} style={{ marginTop: '0.5rem' }}>
            {drafting ? 'Drafting…' : 'Draft with Claude'}
          </button>

          <label className="scanner-input-label" style={{ display: 'block', marginTop: '0.75rem' }}>
            Chart annotations (JSON — trendlines / zones / hlines)
            <textarea
              className="bt-input cp-textarea cp-textarea-mono"
              rows={8}
              value={form.annotationsJson}
              onChange={(e) => update('annotationsJson', e.target.value)}
            />
          </label>

          <div className="bt-run-row" style={{ marginTop: '1rem' }}>
            <button className="btn btn-primary bt-run-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : selectedId ? 'Save changes' : 'Create setup'}
            </button>
            {selectedId && (
              <button className="btn bt-run-btn" onClick={handleDelete} disabled={saving} style={{ color: 'var(--red)' }}>
                Delete
              </button>
            )}
            {justSaved && <span style={{ color: 'var(--green)', fontSize: '0.85rem' }}>✓ Saved</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
