"""Shared helpers used by more than one strategy file — swing high/low
lookups, position sizing, and fill-price resolution — so these aren't
duplicated across pullback_ma.py / base_breakout.py / earnings_gap.py.
Pure functions only, per the no-I/O-inside-strategy-files rule.
"""
from __future__ import annotations

import pandas as pd


def swing_high(df: pd.DataFrame, end_index: int, lookback: int, include_current: bool = False) -> float:
    """Highest High over the `lookback` bars before `end_index` — today's
    own bar excluded by default, since "the swing high before the pullback"
    or "the base's highest high" both mean bars that already happened, not
    today's (which would let a breakout day's own high count against itself)."""
    stop = end_index + 1 if include_current else end_index
    start = max(0, stop - lookback)
    window = df["h"].iloc[start:stop]
    return float(window.max()) if len(window) else float("nan")


def swing_low(df: pd.DataFrame, start_index: int, end_index: int) -> float:
    """Lowest Low across bars [start_index, end_index], inclusive."""
    window = df["l"].iloc[start_index:end_index + 1]
    return float(window.min()) if len(window) else float("nan")


def position_size(account_equity: float, risk_pct_per_trade: float, entry_price: float, stop_price: float) -> float:
    """Risk-based share count: risk_pct_per_trade% of equity / per-share
    risk. 0 if entry <= stop (no valid long risk to size against)."""
    per_share_risk = entry_price - stop_price
    if per_share_risk <= 0:
        return 0.0
    risk_dollars = account_equity * (risk_pct_per_trade / 100.0)
    return risk_dollars / per_share_risk


def apply_slippage(price: float, slippage_pct: float, side: str) -> float:
    """Slippage always makes a fill worse, never better: buys pay up,
    sells receive less. `side` is 'buy' or 'sell'."""
    factor = slippage_pct / 100.0
    return price * (1 + factor) if side == "buy" else price * (1 - factor)


def entry_fill(df: pd.DataFrame, trigger_index: int, fill_timing: str) -> tuple[int, float] | None:
    """Resolves an entry trigger (detected using trigger_index's own close)
    to an actual (fill_index, fill_price) per the shared fill_timing config:
    'close' fills at the trigger day's own close (the ambiguity the spec's
    "enter at the CLOSE of day X" language matches most literally); 'next_open'
    defers the fill to the following bar's open, as real same-day-close orders
    can't be placed before knowing that close printed. Returns None if
    'next_open' is requested but there's no next bar yet in the DataFrame."""
    if fill_timing == "close":
        return trigger_index, float(df["c"].iloc[trigger_index])
    next_index = trigger_index + 1
    if next_index >= len(df):
        return None
    return next_index, float(df["o"].iloc[next_index])
