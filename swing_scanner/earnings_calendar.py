"""Per-ticker earnings data for the scanner's current watchlist/scan
results — not the whole market, so this stays fast and only asks Finviz
about tickers the user actually cares about right now.

Scrapes each ticker's Finviz quote page (finvizfinance.quote wraps this,
but its own ticker_fundament() parser crashes on Finviz's current page —
confirmed live, it looks for a `quote_links` container that no longer
exists — so this parses the still-server-rendered snapshot table and an
embedded historical-earnings JSON blob directly instead).

Finviz's own "Earnings" snapshot field (e.g. "Apr 30 AMC") turned out to
be ambiguous in testing: no year, and it can still show the LAST reported
date rather than the next one if Finviz hasn't posted the upcoming date
yet. Rather than trust it for the date, this estimates the next earnings
date from the historical report cadence — the same self-estimation
approach already used in src/utils/earningsProvider.js for the identical
problem against a different data source. The BMO/AMC suffix from that
field is still used, since the timing convention for a given company is
stable even when the specific date isn't.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from finviz_snapshot import parse_snapshot_table
from pathlib import Path

CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR_EARNINGS = CACHE_DIR / "earnings"
CACHE_TTL_SECONDS = 20 * 60 * 60  # ~daily — earnings dates/estimates don't move intraday like economic actuals do

EARNINGS_RISK_TRADING_DAYS = 10
REQUEST_DELAY_SECONDS = 0.75  # be polite to Finviz across a multi-ticker batch — same spirit as the repo's other scrapers' rate-limit pacing

_EARNINGS_FIELD_RE = re.compile(r"([A-Za-z]{3}\s+\d{1,2})\s*(AMC|BMO)?", re.IGNORECASE)


@dataclass
class EarningsInfo:
    ticker: str
    next_earnings_date: str | None    # "YYYY-MM-DD", estimated
    days_until: int | None            # calendar days from today
    before_after: str                 # "BMO" / "AMC" / ""
    est_eps: str                      # next quarter's consensus estimate, as Finviz displays it
    prior_qtr_eps: str                # most recently reported quarter's actual EPS
    earnings_risk: bool               # True if within EARNINGS_RISK_TRADING_DAYS trading days
    error: str = ""                   # non-empty if this ticker's fetch failed (row still returned so one bad ticker doesn't drop out of a batch silently)

    def to_dict(self) -> dict:
        return {
            "Ticker": self.ticker,
            "Next Earnings Date": self.next_earnings_date or "Unknown",
            "Days Until": self.days_until if self.days_until is not None else "",
            "Before/After Market": self.before_after or "Unknown",
            "Est. EPS": self.est_eps or "",
            "Prior Qtr EPS": self.prior_qtr_eps or "",
        }


def _trading_days_between(start: date, end: date) -> int:
    """Weekend-skipping trading-day count — doesn't account for market
    holidays, a reasonable simplification for a 10-trading-day risk
    window (off by at most 1-2 days around a holiday)."""
    if end <= start:
        return 0
    days = 0
    d = start
    while d < end:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days += 1
    return days


def _extract_earnings_events(html: str) -> list[dict]:
    """Pulls the embedded `chartEvent/earnings` JSON objects (real
    reported quarters, with actual EPS) out of the quote page's inline
    chart-data script. Returns them sorted oldest-to-newest."""
    events = []
    for match in re.finditer(r'\{"dateTimestamp":\d+,"eventType":"chartEvent/earnings"[^}]*\}', html):
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        obj["date"] = datetime.fromtimestamp(obj["dateTimestamp"]).date()
        events.append(obj)
    return sorted(events, key=lambda e: e["date"])


def _estimate_next_earnings_date(events: list[dict]) -> date | None:
    """Historical-cadence estimate: last reported date + the average gap
    between the last few reports (falls back to a 91-day quarterly
    cadence with fewer than 2 historical points to measure a gap from)."""
    if not events:
        return None
    last_date = events[-1]["date"]
    recent = events[-4:]
    if len(recent) >= 2:
        gaps = [(recent[i]["date"] - recent[i - 1]["date"]).days for i in range(1, len(recent))]
        avg_gap = round(sum(gaps) / len(gaps))
    else:
        avg_gap = 91
    return last_date + timedelta(days=avg_gap)


def _fetch_one(ticker: str) -> EarningsInfo:
    from finvizfinance.util import web_scrap  # lazy import, see module docstring

    try:
        soup = web_scrap(f"https://finviz.com/quote.ashx?t={ticker}")
        html = str(soup)

        events = _extract_earnings_events(html)
        prior_qtr_eps = f"{events[-1]['epsActual']:.2f}" if events and events[-1].get("epsActual") is not None else ""

        snapshot = parse_snapshot_table(soup)
        est_eps = snapshot.get("EPS next Q", "")

        earnings_field = snapshot.get("Earnings", "")
        before_after_match = re.search(r"(AMC|BMO)", earnings_field, re.IGNORECASE)
        before_after = before_after_match.group(1).upper() if before_after_match else ""

        next_date = _estimate_next_earnings_date(events)
        # Trading-day count drives the risk flag (spec: "within the next
        # 10 trading days"); calendar days is what the table displays as
        # "Days Until" — the two diverge across a weekend, so both are
        # computed rather than reusing one for both purposes.
        trading_days_until = _trading_days_between(date.today(), next_date) if next_date else None
        calendar_days_until = (next_date - date.today()).days if next_date else None

        return EarningsInfo(
            ticker=ticker,
            next_earnings_date=next_date.strftime("%Y-%m-%d") if next_date else None,
            days_until=calendar_days_until,
            before_after=before_after,
            est_eps=est_eps,
            prior_qtr_eps=prior_qtr_eps,
            earnings_risk=(trading_days_until is not None and 0 <= trading_days_until <= EARNINGS_RISK_TRADING_DAYS),
        )
    except Exception as exc:
        return EarningsInfo(
            ticker=ticker, next_earnings_date=None, days_until=None, before_after="",
            est_eps="", prior_qtr_eps="", earnings_risk=False, error=str(exc),
        )


def _cache_file(ticker: str) -> Path:
    return CACHE_DIR_EARNINGS / f"{ticker.upper()}.json"


def _load_cached(ticker: str) -> EarningsInfo | None:
    path = _cache_file(ticker)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("cached_at", 0) > CACHE_TTL_SECONDS:
        return None
    row = payload["row"]
    return EarningsInfo(**row)


def _save_cache(info: EarningsInfo) -> None:
    CACHE_DIR_EARNINGS.mkdir(parents=True, exist_ok=True)
    row = {
        "ticker": info.ticker, "next_earnings_date": info.next_earnings_date, "days_until": info.days_until,
        "before_after": info.before_after, "est_eps": info.est_eps, "prior_qtr_eps": info.prior_qtr_eps,
        "earnings_risk": info.earnings_risk, "error": info.error,
    }
    _cache_file(info.ticker).write_text(json.dumps({"cached_at": time.time(), "row": row}))


def get_earnings_for_tickers(tickers: list[str], force_refresh: bool = False) -> list[EarningsInfo]:
    """One EarningsInfo per ticker, sorted soonest-earnings-first (unknown
    dates sort last). A failed fetch for one ticker doesn't drop it from
    the list or abort the rest of the batch — it comes back with
    `error` set and blank fields, so the caller can still show the row."""
    results = []
    for i, ticker in enumerate(tickers):
        cached = None if force_refresh else _load_cached(ticker)
        if cached is not None:
            results.append(cached)
            continue

        if i > 0:
            time.sleep(REQUEST_DELAY_SECONDS)
        info = _fetch_one(ticker)
        _save_cache(info)
        results.append(info)

    return sorted(results, key=lambda r: (r.days_until is None, r.days_until if r.days_until is not None else 0))


def get_earnings_risk_tickers(tickers: list[str], force_refresh: bool = False) -> set[str]:
    """Tickers whose earnings fall within EARNINGS_RISK_TRADING_DAYS
    trading days — what the screener checks before flagging a breakout
    entry (Part 3 integration)."""
    return {info.ticker for info in get_earnings_for_tickers(tickers, force_refresh=force_refresh) if info.earnings_risk}


if __name__ == "__main__":
    test_tickers = ["AAPL", "MSFT", "NVDA", "TSLA"]
    infos = get_earnings_for_tickers(test_tickers)
    for info in infos:
        if info.error:
            print(f"{info.ticker}: ERROR — {info.error}")
            continue
        flag = "  << EARNINGS RISK" if info.earnings_risk else ""
        print(
            f"{info.ticker:<6} next={info.next_earnings_date or 'unknown':<12} "
            f"days={info.days_until if info.days_until is not None else '?':<5} "
            f"{info.before_after:<4} est_eps={info.est_eps:<8} prior_qtr_eps={info.prior_qtr_eps:<8}{flag}"
        )

    risky = get_earnings_risk_tickers(test_tickers)
    print(f"\nget_earnings_risk_tickers() -> {sorted(risky)}")
