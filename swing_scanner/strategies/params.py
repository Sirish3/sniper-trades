"""Every tunable threshold named and defaulted here — nothing hardcoded
inside pullback_ma.py / base_breakout.py / earnings_gap.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .earnings_calendar import EarningsCalendar


@dataclass
class PullbackMAParams:
    ma_touch_tolerance_pct: float = 1.0    # low must come within this % of EMA21 or SMA50
    rsi_low: float = 40.0
    rsi_high: float = 55.0
    trigger_expiry_days: int = 5           # trigger must fire within this many days of the touch day
    confirm_above_ema9: bool = False       # optional conservative-mode extra filter on the trigger day
    swing_high_lookback: int = 20          # Target 1 = highest high of the prior N days
    time_stop_days: int = 20
    stop_buffer_below_sma50_pct: float = 0.5


@dataclass
class BaseBreakoutParams:
    base_min_days: int = 15
    base_max_days: int = 40
    base_max_range_pct: float = 12.0             # (base high - base low) / base low
    volatility_contraction_max_pct: float = 80.0  # 2nd-half range must be <= this % of 1st-half range
    near_high_tolerance_pct: float = 3.0          # current close must be within this % of base high
    breakout_vol_mult: float = 1.5
    earnings_guard_days: int = 3                  # skip entry if earnings due within this many trading days
    time_stop_days: int = 30
    # Set per-ticker by backtest_engine.py before walking that ticker's bars.
    # check_entry() has no ticker/calendar argument of its own (see
    # strategies/types.py) so this is how the earnings-guard context reaches
    # it without breaking the shared check_setup/check_entry/check_exit
    # signature every strategy file uses.
    ticker: "str | None" = None
    earnings_calendar: "EarningsCalendar | None" = None


@dataclass
class EarningsGapParams:
    gap_min_pct: float = 3.0
    gap_vol_mult: float = 2.0
    variant: str = "orb"  # "orb" (gap-day close) | "pullback" (next N days, gap holds)
    pullback_window_days: int = 3
    time_stop_days: int = 15
    # Same purpose as BaseBreakoutParams.ticker/earnings_calendar above —
    # this strategy's setup condition IS "today was an earnings day", so it
    # needs the same per-ticker context threaded through.
    ticker: "str | None" = None
    earnings_calendar: "EarningsCalendar | None" = None


@dataclass
class PortfolioParams:
    account_equity: float = 100_000.0
    risk_pct_per_trade: float = 1.0
    max_concurrent_positions: int = 4
    fill_timing: str = "close"  # "close" | "next_open" — see backtest_engine.py docstring
    slippage_pct: float = 0.05
    commission_per_side: float = 0.0


DEFAULT_PARAMS: dict = {
    "pullback_ma": PullbackMAParams(),
    "base_breakout": BaseBreakoutParams(),
    "earnings_gap": EarningsGapParams(),
}
