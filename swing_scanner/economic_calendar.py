"""Economic calendar: Finviz's free live scrape (finvizfinance) for the
current trading week, merged with known_events.py's static schedule so
the combined view reaches "this week + next week" even though Finviz's
free page only ever shows the week in progress.

finvizfinance is an unofficial scraper (not a Finviz API) — its output
shape can change without notice, and the page itself can rate-limit or
go down. Every call into it is wrapped in try/except; a scrape failure
degrades to "static schedule only," it never raises out to the caller.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

from known_events import KNOWN_HIGH_IMPACT_EVENTS

CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_FILE = CACHE_DIR / "economic_calendar.json"
CACHE_TTL_SECONDS = 3 * 60 * 60  # a few hours, per spec — release actual/forecast/previous values do change intraday

IMPACT_ORDER = {"High": 0, "Medium": 1, "Low": 2}
IMPACT_COLORS = {"High": "#dc2626", "Medium": "#eab308", "Low": "#9ca3af"}  # red, yellow, gray


@dataclass
class EconomicEvent:
    date: str          # "YYYY-MM-DD"
    time: str          # "HH:MM" (ET) or "" if unknown
    event: str
    impact: str        # "High" / "Medium" / "Low"
    actual: str = ""
    forecast: str = ""
    previous: str = ""
    source: str = ""   # "Finviz" or the static list's own source (BLS, Federal Reserve, ...)

    def to_dict(self) -> dict:
        return {
            "Date": self.date, "Time": self.time, "Event": self.event, "Impact": self.impact,
            "Actual": self.actual, "Forecast": self.forecast, "Previous": self.previous, "Source": self.source,
        }


def _normalize_impact(raw) -> str:
    """Finviz's embedded JSON uses an integer `importance` field — 3 =
    High, 2 = Medium, 1 = Low, confirmed live against real events (e.g.
    "FOMC Minutes" and "ISM Services PMI" both come back as 3). Falls
    back to Low for anything unrecognized rather than dropping the row."""
    try:
        return {3: "High", 2: "Medium", 1: "Low"}[int(raw)]
    except (TypeError, ValueError, KeyError):
        return "Low"


def _fmt_value(raw) -> str:
    return "" if raw is None else str(raw).strip()


def _scrape_finviz() -> list[EconomicEvent]:
    """Raises on any failure — caller (get_economic_calendar) is
    responsible for catching and falling back to the static list.

    finvizfinance's own Calendar.calendar() parses an HTML <table
    class="calendar">, which Finviz's current calendar page — now a
    client-side-rendered SPA — no longer serves; confirmed live, that
    table doesn't exist in the page at all anymore, so Calendar.calendar()
    always silently returns an empty DataFrame. The real calendar data
    ships as JSON embedded in a <script id="route-init-data"> tag (the
    page's own hydration payload) instead, so this parses that directly.
    Only finvizfinance.util.web_scrap is reused here, for its User-Agent
    handling — not the library's own (broken) table parser.
    """
    from finvizfinance.util import web_scrap  # imported lazily so the whole module still loads if finvizfinance is missing/broken

    soup = web_scrap("https://finviz.com/calendar.ashx")
    tag = soup.find("script", id="route-init-data")
    if tag is None or not tag.string:
        raise ValueError("Finviz calendar page layout has changed — route-init-data script tag not found")

    payload = json.loads(tag.string)
    entries = payload.get("data", {}).get("entries")
    if entries is None:
        raise ValueError("Finviz calendar JSON payload has changed shape — no data.entries key")

    events = []
    for entry in entries:
        raw_date = entry.get("date")
        if not raw_date:
            continue
        try:
            dt = datetime.fromisoformat(raw_date)
        except ValueError:
            continue
        events.append(EconomicEvent(
            date=dt.strftime("%Y-%m-%d"),
            time="" if entry.get("allDay") else dt.strftime("%H:%M"),
            event=str(entry.get("event") or "").strip(),
            impact=_normalize_impact(entry.get("importance")),
            actual=_fmt_value(entry.get("actual")),
            forecast=_fmt_value(entry.get("forecast")),
            previous=_fmt_value(entry.get("previous")),
            source="Finviz",
        ))
    return events


def _static_events() -> list[EconomicEvent]:
    return [
        EconomicEvent(
            date=e["date"], time=e.get("time", ""), event=e["event"],
            impact=e.get("impact", "Low"), source=e.get("source", ""),
        )
        for e in KNOWN_HIGH_IMPACT_EVENTS
    ]


def _dedupe_key(e: EconomicEvent) -> tuple:
    # Loose match on event name (case/whitespace-insensitive) — Finviz's
    # wording for a release ("CPI m/m") won't exactly match the static
    # list's ("CPI (June)"), so key on date + the first significant word
    # instead of an exact string match, which would rarely fire.
    first_word = e.event.strip().split(" ")[0].lower() if e.event.strip() else ""
    return (e.date, first_word)


def _merge(live: list[EconomicEvent], static: list[EconomicEvent]) -> list[EconomicEvent]:
    """Live (Finviz) rows win on overlap, since they carry actual/forecast/
    previous values the static list never has — static rows only fill in
    dates Finviz's current-week window doesn't reach yet."""
    seen = {_dedupe_key(e) for e in live}
    merged = list(live) + [e for e in static if _dedupe_key(e) not in seen]
    return sorted(merged, key=lambda e: (e.date, e.time or "99:99"))


def _load_cache() -> list[EconomicEvent] | None:
    if not CACHE_FILE.exists():
        return None
    try:
        payload = json.loads(CACHE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("cached_at", 0) > CACHE_TTL_SECONDS:
        return None
    return [EconomicEvent(**row) for row in payload["events"]]


def _save_cache(events: list[EconomicEvent]) -> None:
    """Stores lowercase field names (not to_dict()'s capitalized display
    keys) so EconomicEvent(**row) round-trips cleanly on load."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "cached_at": time.time(),
        "events": [
            {"date": e.date, "time": e.time, "event": e.event, "impact": e.impact,
             "actual": e.actual, "forecast": e.forecast, "previous": e.previous, "source": e.source}
            for e in events
        ],
    }
    CACHE_FILE.write_text(json.dumps(payload))


def get_economic_calendar(force_refresh: bool = False) -> tuple[list[EconomicEvent], bool]:
    """Returns (events, live_data_available). `live_data_available` is
    False when the Finviz scrape failed and this fell back to the static
    schedule only — callers (the Streamlit tab) use it to show the
    "Live data unavailable" note."""
    if not force_refresh:
        cached = _load_cache()
        if cached is not None:
            # Cache stores the already-merged result; live_data_available
            # isn't persisted, so recompute it cheaply from whether any
            # cached row is Finviz-sourced.
            return cached, any(e.source == "Finviz" for e in cached)

    static = _static_events()
    try:
        live = _scrape_finviz()
        live_ok = True
    except Exception:
        live = []
        live_ok = False

    merged = _merge(live, static) if live_ok else sorted(static, key=lambda e: (e.date, e.time or "99:99"))
    _save_cache(merged)
    return merged, live_ok


def filter_calendar(
    events: list[EconomicEvent],
    impact_levels: set[str] | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
) -> list[EconomicEvent]:
    """impact_levels defaults to {"High", "Medium"} (spec default). Date
    range defaults to "this week + next week" when both bounds are None."""
    if impact_levels is None:
        impact_levels = {"High", "Medium"}
    if start_date is None or end_date is None:
        today = date.today()
        monday_this_week = today - timedelta(days=today.weekday())
        start_date = start_date or monday_this_week
        end_date = end_date or (monday_this_week + timedelta(days=13))  # through the end of next week

    def in_range(e: EconomicEvent) -> bool:
        try:
            d = datetime.strptime(e.date, "%Y-%m-%d").date()
        except ValueError:
            return False
        return start_date <= d <= end_date

    filtered = [e for e in events if e.impact in impact_levels and in_range(e)]
    return sorted(filtered, key=lambda e: (e.date, e.time or "99:99"))


def next_high_impact_event(events: list[EconomicEvent], from_date: date | None = None) -> tuple[EconomicEvent, int] | None:
    """Nearest upcoming High-impact event at/after `from_date` (today by
    default), paired with the number of calendar days until it — powers
    the "Next high-impact event: X in N days" banner."""
    from_date = from_date or date.today()
    upcoming = []
    for e in events:
        if e.impact != "High":
            continue
        try:
            d = datetime.strptime(e.date, "%Y-%m-%d").date()
        except ValueError:
            continue
        if d >= from_date:
            upcoming.append((e, (d - from_date).days))
    if not upcoming:
        return None
    return min(upcoming, key=lambda pair: pair[1])


def get_high_impact_dates(force_refresh: bool = False) -> set[str]:
    """Set of "YYYY-MM-DD" strings for every known High-impact event
    (not filtered to any date range) — what screener.py/pipeline.py
    check before flagging a new breakout entry."""
    events, _ = get_economic_calendar(force_refresh=force_refresh)
    return {e.date for e in events if e.impact == "High"}


if __name__ == "__main__":
    events, live_ok = get_economic_calendar()
    print(f"live_data_available={live_ok}, total events (merged)={len(events)}")

    filtered = filter_calendar(events)
    print(f"\nFiltered (High+Medium, this week + next week): {len(filtered)} events")
    for e in filtered:
        print(f"  {e.date} {e.time:>5}  [{e.impact:>6}]  {e.event}  (actual={e.actual!r} forecast={e.forecast!r} previous={e.previous!r})  src={e.source}")

    nearest = next_high_impact_event(events)
    if nearest:
        event, days = nearest
        print(f"\nNext high-impact event: {event.event} in {days} day{'s' if days != 1 else ''} ({event.date})")
    else:
        print("\nNo upcoming high-impact events found.")

    print(f"\nget_high_impact_dates() -> {sorted(get_high_impact_dates())}")
