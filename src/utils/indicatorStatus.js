// Shared PASS/WARN/FAIL/DATA_MISSING -> icon/className mapping for any
// component rendering stockAnalysis.js's per-indicator status fields.
// Previously duplicated locally inside AnalysisPanel.jsx.
export const STATUS_ICON = { PASS: '✅', WARN: '⚠️', FAIL: '❌', DATA_MISSING: '➖' }
export const STATUS_CLS = { PASS: 'text-green', WARN: 'text-amber', FAIL: 'text-danger', DATA_MISSING: 'text-muted' }
