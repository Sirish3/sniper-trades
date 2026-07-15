"""Historical earnings-date lookup for backtesting — deliberately separate
from the top-level swing_scanner/earnings_calendar.py, which estimates each
ticker's NEXT earnings date from today for the live Earnings Calendar tab.
Backtesting instead needs to know, for an arbitrary past bar, whether THAT
specific date was an actual reported earnings date, which a "next earnings
from today" estimator can't answer.

Alpaca's market data API does not expose historical earnings-report dates
(its corporate-actions endpoint covers dividends/splits/mergers, not
earnings) on any plan, so there's no live-data path to wire up here — this
is a genuine CSV-only lookup, not a stub pending an Alpaca fallback. Isolated
behind one class so a real data source (a paid earnings-calendar API, a
scraped historical archive, ...) can be swapped in later without touching
any strategy file.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd


class EarningsCalendar:
    """Ticker -> set of known earnings-report dates. Empty until
    load_from_csv() is called; every lookup on an unloaded/unknown ticker
    returns False rather than raising, so callers can pass an empty
    calendar and just get "no known earnings" instead of a crash."""

    def __init__(self) -> None:
        self._dates: dict[str, set[pd.Timestamp]] = {}

    def load_from_csv(self, path: str | Path) -> None:
        """CSV columns: ticker, earnings_date (YYYY-MM-DD). Additive —
        calling this more than once (e.g. once per ticker's own file)
        merges rather than replaces."""
        df = pd.read_csv(path)
        for _, row in df.iterrows():
            ticker = str(row["ticker"]).upper()
            d = pd.Timestamp(row["earnings_date"]).normalize()
            self._dates.setdefault(ticker, set()).add(d)

    def is_earnings_day(self, ticker: str, date) -> bool:
        return pd.Timestamp(date).normalize() in self._dates.get(ticker.upper(), set())

    def has_earnings_within(self, ticker: str, dates_index: pd.DatetimeIndex, i: int, trading_days: int) -> bool:
        """True if any of the next `trading_days` TRADING days (per this
        ticker's own bar index, not calendar days) is a known earnings date.
        Looks forward from i+1 (today itself is never "within the next N days
        of itself")."""
        known = self._dates.get(ticker.upper())
        if not known:
            return False
        for j in range(i + 1, min(i + 1 + trading_days, len(dates_index))):
            if dates_index[j].normalize() in known:
                return True
        return False

    def has_any_dates(self, ticker: str) -> bool:
        return bool(self._dates.get(ticker.upper()))
