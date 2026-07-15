"""Strategy 3: Post-Earnings Gap-and-Hold.

Both entry variants are daily-bar approximations of the classic intraday
opening-range breakout, as flagged in the source spec — if minute bars are
ever added to this engine, the "orb" variant's "top 40% of the day's range"
close-quality proxy is the piece that would most benefit from being
replaced with an actual first-30/60-minute range breakout.

Earnings-day detection: params.ticker/params.earnings_calendar (same
mechanism as base_breakout.py, see params.py) gate this when a calendar
with real dates for the ticker was supplied. Without one, this falls back
to treating the gap_min_pct/gap_vol_mult signature alone as "earnings-like"
— Alpaca doesn't expose historical earnings dates on any plan (see
strategies/earnings_calendar.py), so this heuristic is what makes the
strategy runnable out of the box rather than requiring a hand-built CSV
before it can find a single trade.
"""
from __future__ import annotations

import pandas as pd

from indicators import avg_volume, ema

from .params import EarningsGapParams
from .types import EntrySignal, ExitSignal, Position, SetupState

STRATEGY_ID = "earnings_gap"


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["ema9"] = ema(out["c"], 9)
    out["vol_sma50"] = avg_volume(out["v"], 50)
    return out


def check_setup(df: pd.DataFrame, i: int, params: EarningsGapParams) -> SetupState | None:
    if i < 1:
        return None
    vol_sma50 = df["vol_sma50"].iloc[i]
    if pd.isna(vol_sma50):
        return None

    prior_close = float(df["c"].iloc[i - 1])
    if prior_close <= 0:
        return None
    open_i = float(df["o"].iloc[i])
    if open_i < prior_close * (1 + params.gap_min_pct / 100):
        return None
    if df["v"].iloc[i] < params.gap_vol_mult * vol_sma50:
        return None

    cal = params.earnings_calendar
    if cal is not None and params.ticker and cal.has_any_dates(params.ticker):
        if not cal.is_earnings_day(params.ticker, df.index[i]):
            return None
    # else: no known earnings dates for this ticker — fall back to the
    # gap/volume signature alone (documented above).

    # "orb": only the gap day itself is eligible, so expiry == anchor day
    # (the engine drops the setup the very next bar if it didn't trigger).
    # "pullback": the next N trading days are eligible.
    expires = i if params.variant == "orb" else i + params.pullback_window_days
    return SetupState(strategy_id=STRATEGY_ID, anchor_index=i, expires_index=expires,
                       data={"pre_gap_close": prior_close})


def check_entry(df: pd.DataFrame, i: int, setup_state: SetupState, params: EarningsGapParams) -> EntrySignal | None:
    pre_gap_close = setup_state.data["pre_gap_close"]

    if params.variant == "orb":
        if i != setup_state.anchor_index:
            return None
        close, open_, low, high = df["c"].iloc[i], df["o"].iloc[i], df["l"].iloc[i], df["h"].iloc[i]
        if high <= low or close <= open_:
            return None
        if (close - low) / (high - low) < 0.6:
            return None
    else:  # "pullback"
        if i <= setup_state.anchor_index:
            return None
        if df["l"].iloc[i] <= pre_gap_close:
            return None
        if df["c"].iloc[i] <= df["o"].iloc[i]:
            return None

    return EntrySignal(
        strategy_id=STRATEGY_ID,
        trigger_index=i,
        stop_price=pre_gap_close,
        target_price=None,
        reason=f"{params.variant} entry",
    )


def check_exit(df: pd.DataFrame, i: int, position: Position, params: EarningsGapParams) -> ExitSignal | None:
    low, close, open_ = df["l"].iloc[i], df["c"].iloc[i], df["o"].iloc[i]

    if low <= position.stop_price:
        return ExitSignal(exit_index=i, exit_price=min(position.stop_price, open_), reason="stop")

    ema9 = df["ema9"].iloc[i]
    if pd.notna(ema9) and close < ema9:
        return ExitSignal(exit_index=i, exit_price=close, reason="trail")

    if (i - position.entry_index) >= params.time_stop_days:
        return ExitSignal(exit_index=i, exit_price=close, reason="time")

    return None
