import { useEffect, useState } from 'react'
import { createSetup, deleteSetup, getAllSetupsForAdmin, updateSetup } from '../utils/chartSetupsApi'
import { draftChartSetupBlurb } from '../utils/claudeApi'

const STATUSES = ['draft', 'published', 'archived']

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

  function loadSetups() {
    getAllSetupsForAdmin().then(setSetups).catch((err) => setError(err.message))
  }

  useEffect(() => { loadSetups() }, [])

  function selectSetup(setup) {
    setSelectedId(setup.id)
    setForm(toFormState(setup))
    setError(null)
  }

  function newSetup() {
    setSelectedId(null)
    setForm(EMPTY_FORM)
    setError(null)
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
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
      if (selectedId) await updateSetup(selectedId, payload)
      else await createSetup(payload)
      loadSetups()
      newSetup()
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

  return (
    <div className="backtester">
      <div className="bt-header-block">
        <div className="bt-title">Chart Patterns — Admin</div>
        <div className="bt-subtitle">Manually curated setups. Pick the ticker, pattern, and levels yourself — Claude only drafts the blurb.</div>
      </div>

      {error && <div className="bt-error">{error}</div>}

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
          </div>
        </div>
      </div>
    </div>
  )
}
