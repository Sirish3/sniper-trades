"""Strategy 1: Pullback to a rising moving average in an established
uptrend. See the module-level spec this was built from for the full rule
text; only the timing resolutions non-obvious from that spec are commented
here.
"""
from __future__ import annotations

import pandas as pd

from indicators import ema, rsi, sma

from .params import PullbackMAParams
from .types import EntrySignal, ExitSignal, Position, SetupState
from .utils import swing_high, swing_low

STRATEGY_ID = "pullback_ma"


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    """Adds the indicator columns this strategy needs, once per ticker,
    so check_setup/check_entry/check_exit are cheap O(1) column lookups
    per bar instead of recomputing rolling windows at every index. Safe
    against lookahead: every column here is causal (rolling/ewm only look
    backward from each row)."""
    out = df.copy()
    out["sma50"] = sma(out["c"], 50)
    out["sma200"] = sma(out["c"], 200)
    out["ema21"] = ema(out["c"], 21)
    out["ema9"] = ema(out["c"], 9)
    out["rsi14"] = rsi(out["c"], 14)
    return out


def _touches_ma(low: float, ma_value: float, tolerance_pct: float) -> bool:
    if pd.isna(ma_value) or ma_value == 0:
        return False
    return abs(low - ma_value) / ma_value * 100 <= tolerance_pct


def check_setup(df: pd.DataFrame, i: int, params: PullbackMAParams) -> SetupState | None:
    row = df.iloc[i]
    if pd.isna(row["sma50"]) or pd.isna(row["sma200"]) or pd.isna(row["ema21"]) or pd.isna(row["rsi14"]):
        return None

    # Regime filter
    if not (row["c"] > row["sma50"] > row["sma200"]):
        return None

    # Touch condition: today's low within tolerance of EMA21 or SMA50
    if not (_touches_ma(row["l"], row["ema21"], params.ma_touch_tolerance_pct)
            or _touches_ma(row["l"], row["sma50"], params.ma_touch_tolerance_pct)):
        return None

    # Volume declining: "last 3 days" taken as [i-2, i] (today inclusive),
    # "prior 10 days" as the 10 immediately before that, [i-12, i-3].
    if i < 12:
        return None
    last3_vol = df["v"].iloc[i - 2:i + 1].mean()
    prior10_vol = df["v"].iloc[i - 12:i - 2].mean()
    if not (last3_vol < prior10_vol):
        return None

    # RSI band on the touch day
    if not (params.rsi_low <= row["rsi14"] <= params.rsi_high):
        return None

    return SetupState(strategy_id=STRATEGY_ID, anchor_index=i, expires_index=i + params.trigger_expiry_days)


def check_entry(df: pd.DataFrame, i: int, setup_state: SetupState, params: PullbackMAParams) -> EntrySignal | None:
    if df["c"].iloc[i] <= df["h"].iloc[i - 1]:
        return None
    if params.confirm_above_ema9 and df["c"].iloc[i] <= df["ema9"].iloc[i]:
        return None

    swing_low_price = swing_low(df, setup_state.anchor_index, i)
    sma50_buffer_price = df["sma50"].iloc[i] * (1 - params.stop_buffer_below_sma50_pct / 100)
    # "Whichever is TIGHTER" = whichever stop sits closer to price (smaller
    # risk) for a long, i.e. the higher of the two candidate stop prices.
    stop_price = max(swing_low_price, sma50_buffer_price)

    # "Most recent swing high before the pullback" — anchored at the touch
    # day, excluding it, not at today's (post-breakout) bar.
    target_price = swing_high(df, setup_state.anchor_index, params.swing_high_lookback, include_current=False)

    return EntrySignal(
        strategy_id=STRATEGY_ID,
        trigger_index=i,
        stop_price=stop_price,
        target_price=target_price if not pd.isna(target_price) else None,
        reason="close above prior day's high",
    )


def check_exit(df: pd.DataFrame, i: int, position: Position, params: PullbackMAParams) -> ExitSignal | None:
    low, high, close, open_ = df["l"].iloc[i], df["h"].iloc[i], df["c"].iloc[i], df["o"].iloc[i]

    if not position.stage_data.get("target1_hit"):
        if low <= position.stop_price:
            fill = min(position.stop_price, open_)  # gapped-through fills worse, at the open
            return ExitSignal(exit_index=i, exit_price=fill, reason="stop")
        if position.target_price is not None and high >= position.target_price:
            # Touching Target 1 doesn't close the trade — it switches
            # management to an EMA21 trailing-close exit, per spec.
            position.stage_data["target1_hit"] = True
    else:
        ema21 = df["ema21"].iloc[i]
        if close < ema21:
            return ExitSignal(exit_index=i, exit_price=close, reason="trail")

    if (i - position.entry_index) >= params.time_stop_days:
        return ExitSignal(exit_index=i, exit_price=close, reason="time")

    return None
