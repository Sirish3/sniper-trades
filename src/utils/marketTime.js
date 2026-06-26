// Eastern-time helpers shared by the intraday volume fetch and the entry-rule
// time/day gates — all entry windows in the trading rules are quoted in ET.

export const MARKET_OPEN_MIN = 9 * 60 + 30 // 9:30am
export const MARKET_CLOSE_MIN = 16 * 60 // 4:00pm

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Resolves `date` (default now) to its New York wall-clock time, handling DST
// automatically via Intl rather than a fixed UTC offset.
export function getEasternTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const map = {}
  for (const p of parts) map[p.type] = p.value

  const hour = map.hour === '24' ? 0 : Number(map.hour)
  const minute = Number(map.minute)
  const dayOfWeek = WEEKDAYS.indexOf(map.weekday)

  return {
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    dayOfWeek,
    isWeekday: dayOfWeek >= 1 && dayOfWeek <= 5,
    dateStr: `${map.year}-${map.month}-${map.day}`,
  }
}

export function isRegularSession(et) {
  return et.isWeekday && et.totalMinutes >= MARKET_OPEN_MIN && et.totalMinutes <= MARKET_CLOSE_MIN
}
