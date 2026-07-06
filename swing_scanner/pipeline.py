"""Streamlit-independent scan pipeline — shared by app.py (Streamlit UI)
and api.py (Flask API for the React tab), so the actual scan logic exists
in exactly one place regardless of which frontend calls it.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Callable

import numpy as np
import pandas as pd

from data import get_daily_bars
from indicators import atr, avg_volume
from levels import compute_levels
from screener import check_trend_template, compute_rs_ratios, detect_vcp, rs_percentile_scores

# 20 well-known large caps — for a quick pipeline smoke test before running
# the (much slower) full NYSE+NASDAQ universe scan.
TEST_SUBSET = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "MA",
    "HD", "UNH", "JNJ", "PG", "XOM", "CVX", "WMT", "KO", "PEP", "DIS",
]

MIN_HISTORY_DAYS = 220  # enough for SMA200 + a bit of buffer

# Rough expected swing-trade duration for a VCP breakout targeting +20%
# (levels.py's target1) — used only to decide whether an upcoming earnings
# date falls "within the position's expected holding window" per the
# economic/earnings calendar integration below. Not an exact model of any
# one trade's actual exit timing.
EXPECTED_HOLDING_WINDOW_DAYS = 60

ProgressCallback = Callable[[int, int, str], None]


def _next_trading_day(d: date) -> date:
    nxt = d + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    return nxt


def _compute_caution_tags(breakout_tickers: list[str]) -> dict[str, str]:
    """For tickers about to be flagged as a new breakout entry (VCP
    confirmed), checks the economic and earnings calendars and returns a
    {ticker: tag_string} map — never suppresses a breakout, just tags it
    so the user can decide (per spec). Both calendar modules already
    degrade gracefully on their own (economic_calendar falls back to the
    static schedule; earnings_calendar returns per-ticker error rows) —
    this wraps them again anyway, since a bug in either new module must
    never break the core Trend Template + VCP scan itself.
    """
    if not breakout_tickers:
        return {}

    near_high_impact_event = False
    try:
        from economic_calendar import get_high_impact_dates
        today = date.today()
        check_dates = {today.isoformat(), _next_trading_day(today).isoformat()}
        near_high_impact_event = bool(check_dates & get_high_impact_dates())
    except Exception:
        pass  # economic calendar unavailable — proceed without this tag rather than failing the scan

    earnings_by_ticker = {}
    try:
        from earnings_calendar import get_earnings_for_tickers
        earnings_by_ticker = {info.ticker: info for info in get_earnings_for_tickers(breakout_tickers)}
    except Exception:
        pass  # earnings calendar unavailable — proceed without this tag rather than failing the scan

    tags: dict[str, str] = {}
    for ticker in breakout_tickers:
        ticker_tags = []
        if near_high_impact_event:
            ticker_tags.append("Caution: high-impact event nearby")

        info = earnings_by_ticker.get(ticker)
        if info and not info.error and info.days_until is not None and 0 <= info.days_until <= EXPECTED_HOLDING_WINDOW_DAYS:
            ticker_tags.append("Earnings before exit")

        tags[ticker] = "; ".join(ticker_tags)
    return tags


def run_scan(symbols: list[str], progress_callback: ProgressCallback | None = None) -> pd.DataFrame:
    """Runs the Trend Template + VCP scan over `symbols`. `progress_callback`
    (optional), called as `progress_callback(done, total, current_symbol)`
    after each fetch — lets any frontend (Streamlit's progress bar, a Flask
    SSE stream, etc.) show scan progress without this module knowing which
    UI framework is asking.
    """
    spy_df = get_daily_bars("SPY", lookback_days=400)
    if spy_df is None:
        raise RuntimeError("Could not fetch SPY data — RS score needs a benchmark.")

    bars_by_symbol: dict[str, pd.DataFrame] = {}
    closes_by_symbol: dict[str, pd.Series] = {}

    for i, symbol in enumerate(symbols):
        df = get_daily_bars(symbol, lookback_days=400)
        if progress_callback:
            progress_callback(i + 1, len(symbols), symbol)
        if df is None or len(df) < MIN_HISTORY_DAYS:
            continue
        bars_by_symbol[symbol] = df
        closes_by_symbol[symbol] = df["c"]

    rs_ratios = compute_rs_ratios(closes_by_symbol, spy_df["c"])
    rs_scores = rs_percentile_scores(rs_ratios)

    rows = []
    for symbol, df in bars_by_symbol.items():
        rs = rs_scores.get(symbol)
        trend = check_trend_template(df, rs)
        if not trend.passed:
            continue

        vcp = detect_vcp(df)
        atr14 = atr(df, 14).iloc[-1]
        vol50_series = avg_volume(df["v"], 50)
        vol50 = vol50_series.iloc[-1]
        today_vol = df["v"].iloc[-1]

        row = {
            "Ticker": symbol,
            "Setup": "VCP confirmed" if vcp.detected else "Trend OK, no VCP yet",
            "Current Price": round(trend.close, 2),
            "Pivot / Entry": np.nan,
            "Initial Stop": np.nan,
            "Risk/Share $": np.nan,
            "Risk/Share %": np.nan,
            "Target +20%": np.nan,
            "RS Score": round(rs, 1) if rs is not None else None,
            "% Off 52w High": round(trend.pct_off_high, 1),
            "Vol vs 50d Avg": round(today_vol / vol50, 2) if vol50 and vol50 > 0 else None,
            "Caution Tags": "",
        }

        if vcp.detected:
            levels = compute_levels(vcp.pivot, atr14, vol50)
            row.update({
                "Pivot / Entry": round(levels.entry_trigger, 2),
                "Initial Stop": round(levels.initial_stop, 2),
                "Risk/Share $": round(levels.risk_per_share, 2),
                "Risk/Share %": round(levels.risk_pct, 1),
                "Target +20%": round(levels.target1, 2),
            })

        rows.append(row)

    if not rows:
        return pd.DataFrame()

    # Only VCP-confirmed rows are "a new breakout entry" — Trend Template
    # passes with no VCP yet aren't an entry signal, so they don't need an
    # economic/earnings-calendar check.
    breakout_tickers = [row["Ticker"] for row in rows if row["Setup"] == "VCP confirmed"]
    caution_tags = _compute_caution_tags(breakout_tickers)
    for row in rows:
        if row["Ticker"] in caution_tags:
            row["Caution Tags"] = caution_tags[row["Ticker"]]

    return pd.DataFrame(rows).sort_values("RS Score", ascending=False).reset_index(drop=True)
