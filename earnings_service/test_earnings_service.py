import time
from datetime import date, timedelta
from unittest.mock import MagicMock, PropertyMock

import pandas as pd
import pytest

import earnings_service as es


@pytest.fixture(autouse=True)
def clear_cache():
    es._cache.clear()
    yield
    es._cache.clear()


@pytest.fixture(autouse=True)
def reset_rate_limit_breaker():
    es._rate_limited_until = 0.0
    yield
    es._rate_limited_until = 0.0


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    # The service's politeness stagger is real in production; skip it in
    # tests so the suite doesn't pay REQUEST_DELAY_SECONDS per uncached call.
    monkeypatch.setattr(es.time, "sleep", lambda *_: None)


def _earnings_dates_df(rows):
    """rows: list of (date, reported_eps_or_None) — mirrors the shape of
    yfinance's get_earnings_dates() DataFrame (Timestamp index, 'Reported
    EPS' column with NaN/None for not-yet-reported rows)."""
    if not rows:
        return pd.DataFrame()
    index = pd.to_datetime([r[0] for r in rows])
    return pd.DataFrame({"Reported EPS": [r[1] for r in rows]}, index=index)


def _mock_ticker(calendar=None, earnings_dates_rows=None, raise_calendar=False, raise_earnings_dates=False):
    mock = MagicMock()
    if raise_calendar:
        type(mock).calendar = PropertyMock(side_effect=RuntimeError("calendar boom"))
    else:
        mock.calendar = calendar if calendar is not None else {}
    if raise_earnings_dates:
        mock.get_earnings_dates.side_effect = RuntimeError("get_earnings_dates boom")
    else:
        mock.get_earnings_dates.return_value = _earnings_dates_df(earnings_dates_rows or [])
    return mock


# ── _fetch_one: source tagging from the two yfinance quirks the spec calls out ──

def test_future_date_from_calendar_is_confirmed(monkeypatch):
    future = date.today() + timedelta(days=20)
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(calendar={"Earnings Date": [future]}))

    result = es._fetch_one("AAPL")

    assert result == {"date": future.isoformat(), "source": "CONFIRMED"}


def test_a_confirmed_calendar_date_skips_the_heavier_get_earnings_dates_call(monkeypatch):
    # The whole point of this fix: get_earnings_dates() is a ~1s HTML
    # scrape vs .calendar's ~0.5s — calling both unconditionally for every
    # symbol was why a full-scan batch took minutes (see module docstring).
    future = date.today() + timedelta(days=20)
    mock = _mock_ticker(calendar={"Earnings Date": [future]})
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: mock)

    es._fetch_one("AAPL")

    mock.get_earnings_dates.assert_not_called()


def test_calendar_range_of_two_dates_takes_the_earliest(monkeypatch):
    earlier = date.today() + timedelta(days=10)
    later = date.today() + timedelta(days=11)
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(calendar={"Earnings Date": [later, earlier]}))

    result = es._fetch_one("AAPL")

    assert result["date"] == earlier.isoformat()


def test_past_calendar_date_is_discarded_and_falls_to_estimate_from_history(monkeypatch):
    past = date.today() - timedelta(days=5)  # stale "next" date — must not be reported as-is
    history = [
        (date.today() - timedelta(days=80), 1.23),
        (date.today() - timedelta(days=80 + 91), 1.10),
    ]
    monkeypatch.setattr(
        es.yf, "Ticker",
        lambda symbol: _mock_ticker(calendar={"Earnings Date": [past]}, earnings_dates_rows=history),
    )

    result = es._fetch_one("XYZ")

    assert result["source"] == "ESTIMATED"
    assert result["date"] is not None
    assert date.fromisoformat(result["date"]) > date.today()


def test_past_calendar_date_with_no_history_at_all_is_unknown(monkeypatch):
    past = date.today() - timedelta(days=5)
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(calendar={"Earnings Date": [past]}, earnings_dates_rows=[]))

    result = es._fetch_one("NODATA")

    assert result == {"date": None, "source": "UNKNOWN"}


def test_future_row_in_get_earnings_dates_is_confirmed_even_without_calendar_data(monkeypatch):
    future = date.today() + timedelta(days=12)
    rows = [(future, None)]  # None/NaN actual = not yet reported = upcoming
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(calendar={}, earnings_dates_rows=rows))

    result = es._fetch_one("ABC")

    assert result == {"date": future.isoformat(), "source": "CONFIRMED"}


def test_calendar_raising_does_not_break_the_get_earnings_dates_fallback(monkeypatch):
    future = date.today() + timedelta(days=12)
    rows = [(future, None)]
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(raise_calendar=True, earnings_dates_rows=rows))

    result = es._fetch_one("ABC")

    assert result == {"date": future.isoformat(), "source": "CONFIRMED"}


def test_both_calls_raising_is_unknown_not_a_crash(monkeypatch):
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(raise_calendar=True, raise_earnings_dates=True))

    result = es._fetch_one("BROKEN")

    assert result == {"date": None, "source": "UNKNOWN"}


def test_ticker_constructor_itself_raising_is_unknown_not_a_crash(monkeypatch):
    def boom(symbol):
        raise RuntimeError("yfinance blew up constructing the Ticker")

    monkeypatch.setattr(es.yf, "Ticker", boom)

    result = es._fetch_one("BROKEN")

    assert result == {"date": None, "source": "UNKNOWN"}


# ── self-estimate (CRITICAL FIX: report dates, no quarter-end correction needed) ──

def test_self_estimate_prefers_same_quarter_last_year_over_flat_91d():
    # mostRecent = 2098-06-15; the naive +91d guess would be ~2098-09-14.
    # A report from a year-ago anchor (2097-09-01) sits close enough to that
    # guess's year-ago target (2097-09-14) to win, projecting to ~2098-09-01 —
    # close to but clearly distinct from the naive guess, so this proves the
    # anchor path actually ran rather than the flat fallback.
    history = [date(2097, 9, 1), date(2098, 6, 15)]

    estimate = es._self_estimate_next_earnings(history)

    assert date(2098, 9, 1) <= estimate <= date(2098, 9, 8)


def test_self_estimate_falls_back_to_91d_with_no_year_ago_anchor():
    history = [date(2099, 1, 10)]  # single data point, nothing to anchor "last year" to

    estimate = es._self_estimate_next_earnings(history)

    assert date(2099, 4, 1) <= estimate <= date(2099, 4, 20)


def test_two_calendar_aligned_tickers_do_not_collapse_to_an_identical_date():
    # Same fiscal calendar (quarter-ends would coincide), but real report
    # dates differ by a few days — the bug this fix targets made every
    # calendar-aligned company collapse onto the same date.
    ticker_a_history = [date(2097, 4, 22), date(2098, 1, 24)]
    ticker_b_history = [date(2097, 4, 29), date(2098, 1, 31)]

    estimate_a = es._self_estimate_next_earnings(ticker_a_history)
    estimate_b = es._self_estimate_next_earnings(ticker_b_history)

    assert estimate_a != estimate_b


# ── cache ──

def test_cache_hit_within_ttl_avoids_a_second_yfinance_call(monkeypatch):
    calls = {"count": 0}
    future = date.today() + timedelta(days=10)

    def ticker_factory(symbol):
        calls["count"] += 1
        return _mock_ticker(calendar={"Earnings Date": [future]})

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)

    es._fetch_with_cache("AAPL")
    es._fetch_with_cache("AAPL")

    assert calls["count"] == 1


def test_cache_expired_ttl_makes_a_fresh_call(monkeypatch):
    calls = {"count": 0}
    future = date.today() + timedelta(days=10)

    def ticker_factory(symbol):
        calls["count"] += 1
        return _mock_ticker(calendar={"Earnings Date": [future]})

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)
    monkeypatch.setattr(es, "_cache_ttl_seconds", lambda: 0)  # force immediate expiry

    es._fetch_with_cache("AAPL")
    es._fetch_with_cache("AAPL")

    assert calls["count"] == 2


# ── /earnings endpoint: batching, partial failure, shape ──

def test_one_symbol_failing_does_not_break_the_batch(monkeypatch):
    good_future = date.today() + timedelta(days=15)

    def ticker_factory(symbol):
        if symbol == "BAD":
            raise RuntimeError("yfinance blew up")
        return _mock_ticker(calendar={"Earnings Date": [good_future]})

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)
    client = es.app.test_client()

    resp = client.get("/earnings?symbols=GOOD,BAD")

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["GOOD"]["source"] == "CONFIRMED"
    assert body["BAD"] == {"date": None, "source": "UNKNOWN"}


def test_earnings_endpoint_requires_symbols_param():
    client = es.app.test_client()

    resp = client.get("/earnings")

    assert resp.status_code == 400


def test_earnings_endpoint_returns_one_entry_per_requested_symbol(monkeypatch):
    future = date.today() + timedelta(days=10)
    monkeypatch.setattr(es.yf, "Ticker", lambda symbol: _mock_ticker(calendar={"Earnings Date": [future]}))
    client = es.app.test_client()

    resp = client.get("/earnings?symbols=AAPL,MSFT,WMB")

    assert resp.status_code == 200
    body = resp.get_json()
    assert set(body.keys()) == {"AAPL", "MSFT", "WMB"}
    assert all(v["source"] == "CONFIRMED" for v in body.values())


def test_health_endpoint():
    client = es.app.test_client()

    resp = client.get("/health")

    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


# ── rate-limit circuit breaker — observed live: Yahoo blocks after a few
# dozen rapid calls, well within one S&P-500-sized scan ──

def test_rate_limit_error_from_calendar_trips_the_breaker(monkeypatch):
    def ticker_factory(symbol):
        mock = MagicMock()
        type(mock).calendar = PropertyMock(side_effect=es.YFRateLimitError())
        return mock

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)

    result = es._fetch_one("AAPL")

    assert result == {"date": None, "source": "UNKNOWN"}
    assert es._rate_limit_active()


def test_rate_limit_error_from_get_earnings_dates_trips_the_breaker(monkeypatch):
    def ticker_factory(symbol):
        mock = _mock_ticker(calendar={})
        mock.get_earnings_dates.side_effect = es.YFRateLimitError()
        return mock

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)

    result = es._fetch_one("AAPL")

    assert result == {"date": None, "source": "UNKNOWN"}
    assert es._rate_limit_active()


def test_once_tripped_the_breaker_short_circuits_without_touching_yfinance(monkeypatch):
    es._rate_limited_until = time.time() + 90

    calls = {"count": 0}

    def ticker_factory(symbol):
        calls["count"] += 1
        return _mock_ticker(calendar={"Earnings Date": [date.today() + timedelta(days=5)]})

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)

    result = es._fetch_one("AAPL")

    assert result == {"date": None, "source": "UNKNOWN"}
    assert calls["count"] == 0


def test_a_rate_limited_result_is_never_cached_so_it_can_recover_after_cooldown(monkeypatch):
    future = date.today() + timedelta(days=20)
    calls = {"count": 0}

    def ticker_factory(symbol):
        calls["count"] += 1
        if calls["count"] == 1:
            mock = MagicMock()
            type(mock).calendar = PropertyMock(side_effect=es.YFRateLimitError())
            return mock
        return _mock_ticker(calendar={"Earnings Date": [future]})

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)

    first = es._fetch_with_cache("AAPL")
    assert first == {"date": None, "source": "UNKNOWN"}
    assert "AAPL" not in es._cache  # must not be pinned at UNKNOWN for the full TTL

    es._rate_limited_until = 0.0  # cooldown elapsed
    second = es._fetch_with_cache("AAPL")
    assert second == {"date": future.isoformat(), "source": "CONFIRMED"}


def test_batch_endpoint_recovers_gracefully_when_rate_limited_mid_batch(monkeypatch):
    def ticker_factory(symbol):
        mock = MagicMock()
        type(mock).calendar = PropertyMock(side_effect=es.YFRateLimitError())
        return mock

    monkeypatch.setattr(es.yf, "Ticker", ticker_factory)
    client = es.app.test_client()

    resp = client.get("/earnings?symbols=AAPL,MSFT,NVDA")

    assert resp.status_code == 200
    body = resp.get_json()
    assert all(v == {"date": None, "source": "UNKNOWN"} for v in body.values())
