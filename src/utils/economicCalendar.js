// Shared macro economic calendar — used by the Market Banner's weekly risk
// badges (AgenticScreener.jsx) and by the entry-rule engine's "never enter
// the day before a major market event" gate (entrySignal.js).

// FOMC published; CPI/PPI verified 2025, estimated 2026.
export const FOMC_DECISION_DATES = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]
export const CPI_DATES = [
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10',
  '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12',
  '2025-09-10', '2025-10-15', '2025-11-13', '2025-12-11',
  '2026-01-14', '2026-02-11', '2026-03-11', '2026-04-09',
  '2026-05-13', '2026-06-10', '2026-07-14', '2026-08-12',
  '2026-09-11', '2026-10-13', '2026-11-12', '2026-12-10',
]
export const PPI_DATES = [
  '2025-01-14', '2025-02-13', '2025-03-13', '2025-04-11',
  '2025-05-15', '2025-06-12', '2025-07-16', '2025-08-14',
  '2025-09-11', '2025-10-14', '2025-11-14', '2025-12-12',
  '2026-01-15', '2026-02-12', '2026-03-12', '2026-04-10',
  '2026-05-14', '2026-06-11', '2026-07-16', '2026-08-13',
  '2026-09-10', '2026-10-14', '2026-11-13', '2026-12-11',
]
// NFP: First Friday of each month (BLS confirmed 2025, estimated 2026).
export const NFP_DATES = [
  '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04',
  '2025-05-02', '2025-06-06', '2025-07-03', '2025-08-01',
  '2025-09-05', '2025-10-03', '2025-11-07', '2025-12-05',
  '2026-01-09', '2026-02-06', '2026-03-06', '2026-04-03',
  '2026-05-01', '2026-06-05', '2026-07-03', '2026-08-07',
  '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
]
// ADP: Wednesday ~2 days before NFP.
export const ADP_DATES = [
  '2025-01-08', '2025-02-05', '2025-03-05', '2025-04-02',
  '2025-04-30', '2025-06-04', '2025-07-02', '2025-07-30',
  '2025-09-03', '2025-10-01', '2025-11-05', '2025-12-03',
  '2026-01-07', '2026-02-04', '2026-03-04', '2026-04-01',
  '2026-04-29', '2026-06-03', '2026-07-01', '2026-08-05',
  '2026-09-02', '2026-09-30', '2026-11-04', '2026-12-02',
]
// PCE: BEA Personal Income & Outlays (confirmed 2025, estimated 2026).
export const PCE_DATES = [
  '2025-01-31', '2025-02-28', '2025-03-28', '2025-04-30',
  '2025-05-30', '2025-06-27', '2025-07-31', '2025-08-29',
  '2025-09-26', '2025-10-31', '2025-11-26', '2025-12-19',
  '2026-01-30', '2026-02-27', '2026-03-27', '2026-04-30',
  '2026-05-29', '2026-06-26', '2026-07-31', '2026-08-28',
  '2026-09-25', '2026-10-30', '2026-11-25', '2026-12-18',
]

// ISM Manufacturing = 1st business day of `monthDate`'s month; ISM Services
// = 3rd business day. Defaults to the current month.
export function nthBizDayOfMonth(n, monthDate = new Date()) {
  const cur = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  let count = 0
  while (count < n) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) count++
    if (count < n) cur.setDate(cur.getDate() + 1)
  }
  return cur.toISOString().slice(0, 10)
}

export function getWeekBounds(date = new Date()) {
  const dow = date.getDay()
  const mon = new Date(date)
  mon.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1))
  mon.setHours(0, 0, 0, 0)
  const fri = new Date(mon)
  fri.setDate(mon.getDate() + 4)
  fri.setHours(23, 59, 59, 999)
  return { mon: mon.toISOString().slice(0, 10), fri: fri.toISOString().slice(0, 10) }
}

export function inThisWeek(ds, date = new Date()) {
  const { mon, fri } = getWeekBounds(date)
  return ds >= mon && ds <= fri
}

// True if `dateStr` (YYYY-MM-DD) is a FOMC/CPI/PPI/NFP/PCE release, or an ISM
// Manufacturing/Services release day for the month `dateStr` falls in.
export function isMajorMacroEventDate(dateStr) {
  if ([...FOMC_DECISION_DATES, ...CPI_DATES, ...PPI_DATES, ...NFP_DATES, ...PCE_DATES].includes(dateStr)) {
    return true
  }
  const [y, m, d] = dateStr.split('-').map(Number)
  const monthDate = new Date(y, m - 1, d)
  return dateStr === nthBizDayOfMonth(1, monthDate) || dateStr === nthBizDayOfMonth(3, monthDate)
}

// True if tomorrow (relative to `date`, default now) is a major macro event
// day — used for the entry rule "never enter the day before a major market
// event".
export function isDayBeforeMajorEvent(date = new Date()) {
  const tomorrow = new Date(date)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return isMajorMacroEventDate(tomorrow.toISOString().slice(0, 10))
}

// True if any major macro release falls within the current calendar week —
// used to downgrade the weekly risk environment (Risk On -> Risk Neutral)
// even when the trend/VIX score alone would call it Risk On.
export function isMajorEventThisWeek(date = new Date()) {
  const allDates = [...FOMC_DECISION_DATES, ...CPI_DATES, ...PPI_DATES, ...NFP_DATES, ...PCE_DATES]
  return allDates.some((d) => inThisWeek(d, date))
    || inThisWeek(nthBizDayOfMonth(1, date), date)
    || inThisWeek(nthBizDayOfMonth(3, date), date)
}

// Plain-text labels for every major macro release landing in the current
// calendar week — for the report's "Risk events this week" line.
export function getRiskEventsThisWeek(date = new Date()) {
  const events = []
  if (FOMC_DECISION_DATES.some((d) => inThisWeek(d, date))) events.push('FOMC Decision')
  if (CPI_DATES.some((d) => inThisWeek(d, date))) events.push('CPI Release')
  if (PPI_DATES.some((d) => inThisWeek(d, date))) events.push('PPI Release')
  if (NFP_DATES.some((d) => inThisWeek(d, date))) events.push('Non-Farm Payrolls')
  if (PCE_DATES.some((d) => inThisWeek(d, date))) events.push('PCE Inflation')
  if (inThisWeek(nthBizDayOfMonth(1, date), date)) events.push('ISM Manufacturing')
  if (inThisWeek(nthBizDayOfMonth(3, date), date)) events.push('ISM Services')
  return events
}
