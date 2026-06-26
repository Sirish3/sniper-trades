import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getEarningsMap } from './earningsProvider'

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

function mockFetchOnce(body, { ok = true, status = 200 } = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

describe('getEarningsMap — batching (ONE request per scan, never per-ticker)', () => {
  it('a 50-ticker scan makes exactly ONE request to the earnings service', async () => {
    const tickers = Array.from({ length: 50 }, (_, i) => `T${i}`)
    mockFetchOnce({ T0: { date: '2099-01-10', source: 'CONFIRMED' } })

    await getEarningsMap(tickers)

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('every requested ticker is included in the result, including ones the service has no entry for', async () => {
    mockFetchOnce({ PRESENT: { date: '2099-01-10', source: 'CONFIRMED' } })

    const map = await getEarningsMap(['PRESENT', 'MISSING'])

    expect(map.PRESENT.source).toBe('CONFIRMED')
    expect(map.MISSING).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })

  it('requests a comma-joined symbols query param', async () => {
    mockFetchOnce({})

    await getEarningsMap(['AAPL', 'MSFT', 'WMB'])

    const url = globalThis.fetch.mock.calls[0][0]
    expect(url).toContain('symbols=AAPL,MSFT,WMB')
  })

  it('returns an empty map without calling fetch for an empty ticker list', async () => {
    globalThis.fetch = vi.fn()

    const map = await getEarningsMap([])

    expect(map).toEqual({})
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('getEarningsMap — source tagging passthrough', () => {
  it('CONFIRMED entries compute a correct daysAway from the returned date', async () => {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const future = new Date(today)
    future.setUTCDate(future.getUTCDate() + 9)
    const dateStr = future.toISOString().slice(0, 10)
    mockFetchOnce({ AAPL: { date: dateStr, source: 'CONFIRMED' } })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL.source).toBe('CONFIRMED')
    expect(map.AAPL.daysAway).toBe(9)
  })

  it('ESTIMATED entries pass the source through with a computed daysAway', async () => {
    mockFetchOnce({ XYZ: { date: '2099-01-10', source: 'ESTIMATED' } })

    const map = await getEarningsMap(['XYZ'])

    expect(map.XYZ.source).toBe('ESTIMATED')
    expect(typeof map.XYZ.daysAway).toBe('number')
  })

  it('a service-tagged UNKNOWN entry (date null) stays UNKNOWN with no daysAway', async () => {
    mockFetchOnce({ NODATA: { date: null, source: 'UNKNOWN' } })

    const map = await getEarningsMap(['NODATA'])

    expect(map.NODATA).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })
})

describe('getEarningsMap — graceful degradation (service unreachable)', () => {
  it('a network failure degrades every ticker to UNKNOWN, never throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const map = await getEarningsMap(['AAPL', 'MSFT'])

    expect(map).toEqual({
      AAPL: { date: null, daysAway: null, source: 'UNKNOWN' },
      MSFT: { date: null, daysAway: null, source: 'UNKNOWN' },
    })
  })

  it('a network failure logs loudly so degradation is never silent', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    await getEarningsMap(['AAPL'])

    expect(console.error).toHaveBeenCalled()
  })

  it('a non-200 response degrades every ticker to UNKNOWN, never throws', async () => {
    mockFetchOnce({}, { ok: false, status: 500 })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })

  it('a malformed (non-JSON-parseable) response degrades every ticker to UNKNOWN, never throws', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    })

    const map = await getEarningsMap(['AAPL'])

    expect(map.AAPL).toEqual({ date: null, daysAway: null, source: 'UNKNOWN' })
  })
})
