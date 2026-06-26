"""Earnings-date microservice — yfinance-backed, called by the JS app's
src/utils/earningsProvider.js over HTTP (proxied in dev via Vite's
'/earnings-api' rule, see vite.config.js). yfinance is Python-only and this
app is JS/React, so this is the small boundary service that keeps yfinance
entirely server-side; the JS side never knows or cares that yfinance is the
source underneath getEarningsMap()'s {date, daysAway, source} shape — swap
this service (or the URL earningsProvider.js calls) for a different
provider later and nothing in weekHighScreener.js / stockAnalysis.js /
verdict.js changes.

Standalone process, separate from backend/app.py's execution scheduler
(different concern, different port) — run with:
    python earnings_service.py
See the project's setup notes for the venv/install steps.

Source tags returned per symbol (same three tiers used everywhere else in
the app):
  CONFIRMED — yfinance returned a real, future earnings date.
  ESTIMATED — no usable upcoming date, but earnings history exists to
              project one from (same-fiscal-quarter-last-year preferred,
              else +~91d) — see _self_estimate_next_earnings.
  UNKNOWN   — no usable date and no history, or the fetch failed outright.
yfinance is an unofficial Yahoo scrape: it can return None, raise, or hang
for any given symbol. Every per-symbol fetch is wrapped so one bad ticker
never breaks the batch (see _fetch_one).

Yahoo rate-limits this scrape aggressively — confirmed live: a few dozen
calls in quick succession (well within a single S&P-500-sized scan) trips
yfinance's YFRateLimitError. Once that happens, every other in-flight
symbol would otherwise also fail the same way, one at a time, for no
benefit — see the _rate_limited_until circuit breaker below, which trips
on the first rate-limit hit and short-circuits every other symbol in the
batch straight to UNKNOWN for a cooldown window instead of continuing to
hammer an endpoint that's already blocking us.
"""
from __future__ import annotations

import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import yfinance as yf
from flask import Flask, jsonify, request
from yfinance.exceptions import YFRateLimitError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ── config — single source of truth for this service's tunables, matching
# the JS side's screenerThresholds.js convention (no scattered magic
# numbers) ───────────────────────────────────────────────────────────────
CACHE_TTL_HOURS = 12
MAX_CONCURRENT_FETCHES = 8
REQUEST_DELAY_SECONDS = 0.3  # politeness stagger before each uncached Yahoo hit
EARNINGS_HISTORY_LIMIT = 12  # quarters of get_earnings_dates() to pull (~3 years)
SAME_QUARTER_TOLERANCE_DAYS = 45  # how close a history date must be to "exactly a year before the naive guess" to be preferred
FALLBACK_CADENCE_DAYS = 91  # ~1 quarter, the naive "next earnings" guess when no better anchor exists
RATE_LIMIT_COOLDOWN_SECONDS = 90  # how long to back off entirely after Yahoo rate-limits us once

_cache: dict[str, dict] = {}  # symbol -> {"fetched_at": float, "result": {"date": str|None, "source": str}}
_rate_limited_until = 0.0  # time.time() value; circuit breaker, see module docstring


def _cache_ttl_seconds() -> float:
    return CACHE_TTL_HOURS * 3600


def _to_date(value) -> date | None:
    """yfinance returns earnings dates as pandas Timestamps, datetimes, or
    occasionally plain date objects depending on the call site — normalize
    all of them to a plain date, or None if unparseable."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except (ValueError, TypeError):
        return None


def _is_nan(value) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value))


def _add_days_keeping_weekday(d: date, days: int) -> date:
    """Shifts `d` forward by `days`, then nudges 0-6 days further forward to
    land back on the same weekday — earnings calls tend to recur on the
    same weekday each quarter, and 365 days is 52 weeks + 1 day."""
    shifted = d + timedelta(days=days)
    drift = (d.weekday() - shifted.weekday()) % 7
    return shifted + timedelta(days=drift)


def _self_estimate_next_earnings(history_dates: list[date]) -> date:
    """Estimates the next report date from real report-date history (not
    fiscal quarter-ends — yfinance's get_earnings_dates() index IS the
    actual report date, unlike some providers whose 'period' field is the
    quarter-end, so no quarter-end correction is needed here). The naive
    guess is the most recent report + ~91 days; refined by looking for a
    historical report close to exactly 365 days before THAT guess (the same
    calendar quarter, one year earlier) and projecting it forward +365d
    (weekday-adjusted) instead, since a company's actual report date drifts
    less year-over-year within the same quarter than a flat +91d cadence
    assumes. Falls back to the naive +91d guess when no such anchor exists.
    """
    sorted_dates = sorted(history_dates)
    most_recent = sorted_dates[-1]
    next_approx = most_recent + timedelta(days=FALLBACK_CADENCE_DAYS)
    target_last_year = next_approx - timedelta(days=365)

    best: date | None = None
    best_diff: int | None = None
    for d in sorted_dates:
        diff = abs((d - target_last_year).days)
        if best_diff is None or diff < best_diff:
            best, best_diff = d, diff

    if best is not None and best_diff is not None and best_diff <= SAME_QUARTER_TOLERANCE_DAYS:
        return _add_days_keeping_weekday(best, 365)
    return next_approx


def _rate_limit_active() -> bool:
    return time.time() < _rate_limited_until


def _trip_rate_limit_breaker(symbol: str) -> None:
    global _rate_limited_until
    _rate_limited_until = time.time() + RATE_LIMIT_COOLDOWN_SECONDS
    logger.error(
        "Yahoo rate-limited us while fetching %s — backing off for %ds, every other "
        "symbol in this (and any concurrent) batch will short-circuit to UNKNOWN "
        "until then instead of also getting rate-limited one at a time",
        symbol, RATE_LIMIT_COOLDOWN_SECONDS,
    )


def _fetch_one(symbol: str) -> dict:
    """Never raises — see module docstring. Tries `.calendar` first for the
    upcoming date (it may return a 1-2 date range; take the earliest), then
    only falls through to the much heavier `.get_earnings_dates()` HTML
    scrape (~1s vs `.calendar`'s ~0.5s — confirmed by direct timing; calling
    both unconditionally for every symbol was the original cause of a
    full-scan batch taking minutes) when `.calendar` didn't already answer
    the question, then scans that for any future date plus past actuals to
    estimate from. `.get_earnings_dates()` is also independently flaky: it
    can raise a plain KeyError on some symbols when Yahoo's HTML table comes
    back without an 'Earnings Date' column — that's a real, observed
    yfinance/Yahoo scrape incompatibility, not a typo, and is just one more
    reason this path degrades to UNKNOWN rather than crashing."""
    if _rate_limit_active():
        return {"date": None, "source": "UNKNOWN"}

    try:
        ticker = yf.Ticker(symbol)
        today = date.today()
        upcoming_date: date | None = None

        try:
            cal = ticker.calendar
            dates = cal.get("Earnings Date") if isinstance(cal, dict) else None
            if dates:
                candidate = _to_date(min(dates))
                if candidate is not None and candidate >= today:
                    upcoming_date = candidate
        except YFRateLimitError:
            _trip_rate_limit_breaker(symbol)
            return {"date": None, "source": "UNKNOWN"}
        except Exception:
            logger.warning("yfinance .calendar failed for %s", symbol, exc_info=True)

        if upcoming_date is not None:
            return {"date": upcoming_date.isoformat(), "source": "CONFIRMED"}

        history_dates: list[date] = []
        try:
            df = ticker.get_earnings_dates(limit=EARNINGS_HISTORY_LIMIT)
            if df is not None and not df.empty:
                for idx, row in df.iterrows():
                    d = _to_date(idx)
                    if d is None:
                        continue
                    has_actual = not _is_nan(row.get("Reported EPS"))
                    if d >= today and not has_actual:
                        if upcoming_date is None or d < upcoming_date:
                            upcoming_date = d
                    elif d < today and has_actual:
                        history_dates.append(d)
        except YFRateLimitError:
            _trip_rate_limit_breaker(symbol)
            return {"date": None, "source": "UNKNOWN"}
        except Exception:
            logger.warning("yfinance .get_earnings_dates failed for %s", symbol, exc_info=True)

        if upcoming_date is not None:
            return {"date": upcoming_date.isoformat(), "source": "CONFIRMED"}
        if history_dates:
            estimate = _self_estimate_next_earnings(history_dates)
            return {"date": estimate.isoformat(), "source": "ESTIMATED"}
        return {"date": None, "source": "UNKNOWN"}
    except Exception:
        logger.warning("Earnings fetch failed entirely for %s", symbol, exc_info=True)
        return {"date": None, "source": "UNKNOWN"}


def _fetch_with_cache(symbol: str) -> dict:
    cached = _cache.get(symbol)
    if cached and (time.time() - cached["fetched_at"]) < _cache_ttl_seconds():
        return cached["result"]

    # Short-circuit before sleeping/fetching — and don't cache a result
    # produced (or contaminated) while the breaker is active: caching it
    # would pin this symbol at UNKNOWN for the full TTL even after Yahoo's
    # rate limit clears.
    if _rate_limit_active():
        return {"date": None, "source": "UNKNOWN"}

    time.sleep(REQUEST_DELAY_SECONDS)  # politeness stagger before hitting Yahoo
    result = _fetch_one(symbol)
    if not _rate_limit_active():
        _cache[symbol] = {"fetched_at": time.time(), "result": result}
    return result


@app.route("/earnings")
def earnings():
    raw = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in raw.split(",") if s.strip()]
    if not symbols:
        return jsonify({"error": "symbols query param required, e.g. ?symbols=AAPL,MSFT"}), 400

    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_FETCHES) as pool:
        fetched = list(pool.map(_fetch_with_cache, symbols))
    results = dict(zip(symbols, fetched))

    counts = {"CONFIRMED": 0, "ESTIMATED": 0, "UNKNOWN": 0}
    for r in results.values():
        counts[r["source"]] += 1
    logger.info(
        "earnings: %d confirmed / %d estimated / %d unknown (of %d)",
        counts["CONFIRMED"], counts["ESTIMATED"], counts["UNKNOWN"], len(symbols),
    )

    return jsonify(results)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8001)
