import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getEarningsMap } from './earningsProvider'
import { fetchFinnhub } from './finnhubApi'

vi.mock('./finnhubApi', () => ({ fetchFinnhub: vi.fn() }))

function isoDaysFromToday(days) {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// The confirmed-calendar window is fetched in several date-range chunks
// (see earningsProvider.js's ASSUMPTION FLAGGED note re: Finnhub's ~1500-row
// truncation cap), so tests mock by URL shape rather than call order/count:
// every /calendar/earnings chunk request gets the same full entry list
// (harmless — merging is idempotent), and /stock/earnings requests are
// routed by the `symbol` query param.
function mockFinnhub({ calendarEntries = [], historyBySymbol = {} } = {}) {
  fetchFinnhub.mockImplementation(async (path) => {
    if (path.startsWith('/calendar/earnings')) {
      return { earningsCalendar: calendarEntries }
    }
    const symbol = path.match(/symbol=([^&]+)/)?.[1]
    return historyBySymbol[symbol] ?? []
  })
}

function calendarCallCount() {
  return fetchFinnhub.mock.calls.filter(([path]) => path.startsWith('/calendar/earnings')).length
}

function historyCallsFor(symbol) {
  return fetchFinnhub.mock.calls.filter(([path]) => path.includes(`/stock/earnings?symbol=${symbol}`))
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchFinnhub.mockReset()
})

describe('getEarningsMap — confirmed calendar (chunked market-wide calls, never per-ticker)', () => {
  it('finds a scheduled date for every ticker present in the calendar, with no per-ticker history calls', async () => {
    const dateStr = isoDaysFromToday(9)
    mockFinnhub({ calendarEntries: [{ symbol: 'AAPL', date: dateStr }, { symbol: 'MSFT', date: dateStr }] })

    const map = await getEarningsMap(['AAPL', 'MSFT'])

    expect(map.AAPL).toEqual({ date: dateStr, daysAway: 9, source: 'CONFIRMED' })
    expect(map.MSFT.source).toBe('CONFIRMED')
    expect(historyCallsFor('AAPL')).toHaveLength(0)
    expect(historyCallsFor('MSFT')).toHaveLength(0)
  })

  it('makes more than one calendar request (chunked, not a single wide request)', async () => {
    mockFinnhub({ calendarEntries: [] })

    await getEarningsMap(['AAPL'])

    // The exact count is an implementation detail (window size / chunk size),
    // but it must be MORE than 1 — a single wide request is exactly the bug
    // that silently dropped near-term dates (see module docstring).
    expect(calendarCallCount()).toBeGreaterThan(1)
  })

  it('returns an empty map without calling fetchFinnhub for an empty ticker list', async () => {
    const map = await getEarningsMap([])

    expect(map).toEqual({})
    expect(fetchFinnhub).not.toHaveBeenCalled()
  })

  it('ignores a calendar entry dated in the past (already reported, nothing new scheduled)', async () => {
    mockFinnhub({ calendarEntries: [{ symbol: 'AAPL', date: isoDaysFromToday(-5) }], historyBySymbol: {} })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })
})

describe('getEarningsMap — ESTIMATED fallback (per-symbol history, only for tickers missing a confirmed date)', () => {
  it('estimates from historical quarter-end dates when no confirmed date is found', async () => {
    mockFinnhub({
      calendarEntries: [],
      historyBySymbol: {
        AAPL: [
          { period: '2025-12-31' },
          { period: '2025-09-30' },
          { period: '2025-06-30' },
          { period: '2025-03-31' },
        ],
      },
    })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL.source).toBe('ESTIMATED')
    expect(map.AAPL.date).not.toBeNull()
    expect(typeof map.AAPL.daysAway).toBe('number')
    expect(historyCallsFor('AAPL')).toHaveLength(1)
  })

  it('a ticker with no earnings history at all degrades to UNKNOWN', async () => {
    mockFinnhub({ calendarEntries: [], historyBySymbol: {} })

    const map = await getEarningsMap(['NODATA'])

    expect(map.NODATA).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })

  it('only fetches history for tickers missing a confirmed date, not ones already CONFIRMED', async () => {
    const dateStr = isoDaysFromToday(20)
    mockFinnhub({
      calendarEntries: [{ symbol: 'AAPL', date: dateStr }],
      historyBySymbol: { MSFT: [{ period: '2025-12-31' }, { period: '2025-09-30' }] },
    })

    const map = await getEarningsMap(['AAPL', 'MSFT'])

    expect(map.AAPL.source).toBe('CONFIRMED')
    expect(map.MSFT.source).toBe('ESTIMATED')
    expect(historyCallsFor('AAPL')).toHaveLength(0)
    expect(historyCallsFor('MSFT')).toHaveLength(1)
  })
})

describe('getEarningsMap — graceful degradation (Finnhub unreachable)', () => {
  it('a confirmed-calendar failure falls through to per-symbol estimation instead of failing the whole scan', async () => {
    fetchFinnhub.mockImplementation(async (path) => {
      if (path.startsWith('/calendar/earnings')) throw new TypeError('fetch failed')
      return [{ period: '2025-12-31' }, { period: '2025-09-30' }]
    })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL.source).toBe('ESTIMATED')
    expect(console.error).toHaveBeenCalled()
  })

  it('total Finnhub failure (calendar and per-symbol history both fail) degrades to UNKNOWN, never throws', async () => {
    fetchFinnhub.mockRejectedValue(new TypeError('fetch failed'))

    const map = await getEarningsMap(['AAPL', 'MSFT'])

    expect(map).toEqual({
      AAPL: { date: null, daysAway: null, source: 'UNKNOWN' },
      MSFT: { date: null, daysAway: null, source: 'UNKNOWN' },
    })
  })

  it('fetchFinnhub returning null (its own "unavailable" signal) degrades to UNKNOWN, never throws', async () => {
    fetchFinnhub.mockResolvedValue(null)

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })
})
