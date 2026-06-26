"""Market-state guards: is the market open, what's the regime, is it an
FOMC day, is earnings too close. Every scheduler job checks these before
doing anything.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas_market_calendars as mcal
import pytz
import yfinance as yf

from config import FOMC_DATES

logger = logging.getLogger(__name__)

ET = pytz.timezone("US/Eastern")
NYSE = mcal.get_calendar("NYSE")

MARKET_OPEN_CACHE_SECONDS = 60
REGIME_CACHE_SECONDS = 3600
EARNINGS_CACHE_SECONDS = 24 * 3600

_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: int, compute):
    """Tiny in-memory TTL cache shared by the functions below — this is a
    single long-running process, so a module-level dict is enough; no
    external cache service needed.
    """
    now = time.time()
    cached = _cache.get(key)
    if cached is not None and now - cached[0] < ttl:
        return cached[1]
    value = compute()
    _cache[key] = (now, value)
    return value


def utc_to_et(dt: datetime) -> datetime:
    """Converts a DB-read datetime to ET, treating naive values as UTC.

    SQLite round-trips DateTime columns as naive, even though every row
    here is written via utcnow() (timezone-aware UTC). Calling
    dt.astimezone(ET) directly on a naive value silently assumes the
    *server's local* timezone instead of UTC — wrong unless the host
    happens to run in UTC. This makes the UTC assumption explicit.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ET)


def is_market_open() -> bool:
    """True only on an NYSE trading day, between 9:30 and 16:05 ET."""
    def compute() -> bool:
        now_et = datetime.now(ET)
        schedule = NYSE.schedule(start_date=now_et.date(), end_date=now_et.date())

        if schedule.empty:
            reason = "weekend" if now_et.weekday() >= 5 else "holiday"
            logger.info("Market closed: %s", reason)
            return False

        market_open = schedule.iloc[0]["market_open"].tz_convert(ET)
        market_close = schedule.iloc[0]["market_close"].tz_convert(ET)
        # The spec wants a 4:05 PM cutoff — a few minutes past the official
        # 4:00 PM close — so pad NYSE's official close time.
        close_cutoff = market_close + timedelta(minutes=5)

        if now_et < market_open or now_et > close_cutoff:
            logger.info("Market closed: after_hours")
            return False

        logger.info("Market open")
        return True

    return _cached("is_market_open", MARKET_OPEN_CACHE_SECONDS, compute)


def yf_symbol(ticker: str) -> str:
    """Yahoo Finance wants dash notation for dual-class tickers (BRK-B),
    not the dot notation GICS/most data providers use (BRK.B) — passing
    the dot form silently 404s as "possibly delisted", confirmed live
    against BRK.B and BF.B. Only affects the yfinance call; the original
    ticker string (with the dot) is still what's stored/displayed/alerted.
    """
    return ticker.replace(".", "-")


def latest_price(ticker: str) -> float:
    info = yf.Ticker(yf_symbol(ticker)).fast_info
    return float(info["last_price"])


def market_regime() -> str:
    """Returns RISK_ON / RISK_NEUTRAL / RISK_OFF from SPY/QQQ trend + VIX."""
    def compute() -> str:
        try:
            # 200-day SMA needs real 200-day history — fetch a year+ of
            # daily closes, not just the last 60 days (60 days can't
            # produce a 200-day average).
            spy_hist = yf.Ticker("SPY").history(period="14mo")["Close"]
            qqq_hist = yf.Ticker("QQQ").history(period="14mo")["Close"]
            vix_hist = yf.Ticker("^VIX").history(period="5d")["Close"]

            spy_close = float(spy_hist.iloc[-1])
            qqq_close = float(qqq_hist.iloc[-1])
            vix_close = float(vix_hist.iloc[-1])

            spy_sma50 = float(spy_hist.tail(50).mean())
            spy_sma200 = float(spy_hist.tail(200).mean())
            qqq_sma50 = float(qqq_hist.tail(50).mean())
            qqq_sma200 = float(qqq_hist.tail(200).mean())

            if spy_close < spy_sma200 or qqq_close < qqq_sma200 or vix_close > 28:
                regime = "RISK_OFF"
            elif spy_close < spy_sma50 or qqq_close < qqq_sma50 or 22 <= vix_close <= 28:
                regime = "RISK_NEUTRAL"
            else:
                regime = "RISK_ON"

            logger.info(
                "Regime=%s SPY=%.2f (50d=%.2f 200d=%.2f) QQQ=%.2f (50d=%.2f 200d=%.2f) VIX=%.2f",
                regime, spy_close, spy_sma50, spy_sma200, qqq_close, qqq_sma50, qqq_sma200, vix_close,
            )
            return regime
        except Exception as exc:
            logger.warning("market_regime: yfinance fetch failed (%s) — defaulting RISK_NEUTRAL", exc)
            return "RISK_NEUTRAL"

    return _cached("market_regime", REGIME_CACHE_SECONDS, compute)


def is_fomc_day() -> bool:
    """True if today (ET) is in config.FOMC_DATES."""
    today_str = datetime.now(ET).strftime("%Y-%m-%d")
    return today_str in FOMC_DATES


def earnings_within_days(ticker: str, days: int = 7) -> bool:
    """True if `ticker` reports earnings within `days` trading days from today."""
    def compute() -> bool:
        try:
            calendar = yf.Ticker(yf_symbol(ticker)).calendar
            earnings_date = _extract_earnings_date(calendar)
            if earnings_date is None:
                return False

            today = datetime.now(ET).date()
            trading_days = NYSE.schedule(start_date=today, end_date=earnings_date)
            # trading_days includes today; "within N trading days" means at
            # most N sessions from (and including) today through the
            # earnings date.
            return 0 <= len(trading_days) - 1 <= days
        except Exception as exc:
            logger.warning("earnings_within_days(%s): %s — defaulting False", ticker, exc)
            return False

    return _cached(f"earnings:{ticker}", EARNINGS_CACHE_SECONDS, compute)


_EMAIL_REQUIRED_VARS = ("EMAIL_ADDRESS", "EMAIL_APP_PASSWORD", "ALERT_TO_EMAIL")


def validate_email_config() -> bool:
    """Checks EMAIL_ADDRESS/EMAIL_APP_PASSWORD/ALERT_TO_EMAIL are set.

    Called once at scheduler startup. Makes no real SMTP connection. Logs
    which vars are missing if any — never logs the actual values. Returns
    True only if all 3 are set and non-empty.
    """
    all_ok = True
    for var in _EMAIL_REQUIRED_VARS:
        if not os.getenv(var, ""):
            logger.error("Email config invalid: %s not set", var)
            all_ok = False
    if all_ok:
        logger.info("Email config OK")
    return all_ok


def _extract_earnings_date(calendar) -> "datetime.date | None":
    """yfinance's .calendar shape has changed across versions — handle
    both the dict form ({'Earnings Date': [date, ...]}) and the older
    DataFrame form defensively rather than assuming one.
    """
    if calendar is None:
        return None
    try:
        if isinstance(calendar, dict):
            dates = calendar.get("Earnings Date")
            if not dates:
                return None
            return dates[0] if isinstance(dates, (list, tuple)) else dates
        # DataFrame form: index includes an 'Earnings Date' row.
        if "Earnings Date" in getattr(calendar, "index", []):
            value = calendar.loc["Earnings Date"]
            first = value.iloc[0] if hasattr(value, "iloc") else value
            return first.date() if hasattr(first, "date") else first
    except Exception:
        return None
    return None
