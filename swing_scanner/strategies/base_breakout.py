"""Strategy 2: Consolidation Base Breakout.

Earnings guard: params.ticker/params.earnings_calendar are set per-ticker
by backtest_engine.py before it walks that ticker's bars (see params.py) —
check_entry() itself has no separate ticker/calendar argument, so this is
how the "skip entry within N trading days of earnings" rule reaches it
without changing the shared check_setup/check_entry/check_exit signature.
If no calendar (or no known dates for this ticker) was supplied, the guard
is skipped entirely rather than silently blocking every breakout.
"""
from __future__ import annotations

import pandas as pd

from indicators import avg_volume

from .params import BaseBreakoutParams
from .types import EntrySignal, ExitSignal, Position, SetupState

STRATEGY_ID = "base_breakout"


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["vol_sma50"] = avg_volume(out["v"], 50)
    return out


def _find_base(df: pd.DataFrame, i: int, params: BaseBreakoutParams) -> tuple[int, float, float] | None:
    """Searches base lengths longest-first and returns the first (i.e.
    longest) window ending at bar i that satisfies every base condition —
    the spec doesn't say which length to prefer when several qualify, and
    a longer, more fully-formed base is the more conservative pick."""
    for length in range(params.base_max_days, params.base_min_days - 1, -1):
        start = i - length + 1
        if start < 0:
            continue
        base_high = float(df["h"].iloc[start:i + 1].max())
        base_low = float(df["l"].iloc[start:i + 1].min())
        if base_low <= 0:
            continue
        if (base_high - base_low) / base_low * 100 > params.base_max_range_pct:
            continue

        mid = start + length // 2
        first_h, first_l = df["h"].iloc[start:mid], df["l"].iloc[start:mid]
        second_h, second_l = df["h"].iloc[mid:i + 1], df["l"].iloc[mid:i + 1]
        if not len(first_h) or not len(second_h):
            continue
        first_range = float(first_h.max() - first_l.min())
        second_range = float(second_h.max() - second_l.min())
        if first_range <= 0 or second_range > first_range * (params.volatility_contraction_max_pct / 100):
            continue

        first_vol = df["v"].iloc[start:mid].mean()
        second_vol = df["v"].iloc[mid:i + 1].mean()
        if not (second_vol < first_vol):
            continue

        close_i = float(df["c"].iloc[i])
        if (base_high - close_i) / base_high * 100 > params.near_high_tolerance_pct:
            continue

        return start, base_high, base_low
    return None


def check_setup(df: pd.DataFrame, i: int, params: BaseBreakoutParams) -> SetupState | None:
    if i < params.base_min_days:
        return None
    found = _find_base(df, i, params)
    if found is None:
        return None
    start, base_high, base_low = found
    return SetupState(
        strategy_id=STRATEGY_ID,
        anchor_index=i,
        # No expiry given in the spec for how long a base stays actionable;
        # capped at one more base-length so a permanently-flat, never-
        # breaking-out ticker doesn't block re-scanning for a fresher base.
        expires_index=i + params.base_max_days,
        data={"base_start": start, "base_high": base_high, "base_low": base_low},
    )


def check_entry(df: pd.DataFrame, i: int, setup_state: SetupState, params: BaseBreakoutParams) -> EntrySignal | None:
    vol_sma50 = df["vol_sma50"].iloc[i]
    if pd.isna(vol_sma50):
        return None
    base_high = setup_state.data["base_high"]
    base_low = setup_state.data["base_low"]
    if not (df["c"].iloc[i] > base_high and df["v"].iloc[i] >= params.breakout_vol_mult * vol_sma50):
        return None

    cal = params.earnings_calendar
    if cal is not None and params.ticker and cal.has_any_dates(params.ticker):
        if cal.has_earnings_within(params.ticker, df.index, i, params.earnings_guard_days):
            return EntrySignal(
                strategy_id=STRATEGY_ID, trigger_index=i, stop_price=0.0, target_price=None,
                reason=f"earnings within {params.earnings_guard_days} trading days", skipped=True,
            )

    midpoint = (base_high + base_low) / 2
    # "Whichever is TIGHTER" = the higher (closer-to-price) of the two candidates.
    stop_price = max(float(df["l"].iloc[i]), midpoint)
    target_price = base_high + (base_high - base_low)  # measured move

    return EntrySignal(
        strategy_id=STRATEGY_ID,
        trigger_index=i,
        stop_price=stop_price,
        target_price=target_price,
        reason="close above base high on expansion volume",
    )


def check_exit(df: pd.DataFrame, i: int, position: Position, params: BaseBreakoutParams) -> ExitSignal | None:
    low, high, close, open_ = df["l"].iloc[i], df["h"].iloc[i], df["c"].iloc[i], df["o"].iloc[i]

    if low <= position.stop_price:
        return ExitSignal(exit_index=i, exit_price=min(position.stop_price, open_), reason="stop")
    if position.target_price is not None and high >= position.target_price:
        return ExitSignal(exit_index=i, exit_price=max(position.target_price, open_), reason="target")

    if not position.stage_data.get("moved_to_breakeven"):
        initial_risk = position.stage_data.get("initial_risk", 0.0)
        # Uses the day's HIGH (intrabar) to detect +1R, since this only
        # moves the stop in the trader's favor — never triggers an exit.
        if initial_risk > 0 and (high - position.entry_price) >= initial_risk:
            position.stop_price = position.entry_price
            position.stage_data["moved_to_breakeven"] = True

    if (i - position.entry_index) >= params.time_stop_days:
        return ExitSignal(exit_index=i, exit_price=close, reason="time")

    return None
