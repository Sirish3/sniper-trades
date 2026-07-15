"""Value types passed between check_setup/check_entry/check_exit — kept
here so all three strategy files agree on one shape instead of each
inventing its own, per strategy files being pure functions on DataFrames
with no I/O.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SetupState:
    """A setup identified but not yet triggered into a position. `data`
    carries whatever a given strategy needs (touch index, base-window
    bounds, gap-day index, ...) as a plain dict rather than a per-strategy
    subclass, so the engine can hold/pass these without importing each
    strategy's own types."""
    strategy_id: str
    anchor_index: int
    expires_index: int | None  # bar index after which the setup goes stale; None = never expires
    data: dict = field(default_factory=dict)


@dataclass
class EntrySignal:
    strategy_id: str
    trigger_index: int          # bar index the entry condition was confirmed on
    stop_price: float
    target_price: float | None
    reason: str = ""
    # True when an otherwise-valid trigger was deliberately vetoed (e.g. the
    # base_breakout earnings guard) rather than simply not having fired —
    # the engine records these separately ("entries skipped by earnings
    # guard") instead of counting them as no-signal.
    skipped: bool = False


@dataclass
class ExitSignal:
    exit_index: int
    exit_price: float
    reason: str  # "stop" | "target" | "trail" | "time"


@dataclass
class Position:
    """Open-position state the engine hands back into check_exit() each
    bar. `stage_data` is for a strategy's own trailing-stage bookkeeping
    (e.g. "target1_hit": True) — the engine never inspects it."""
    strategy_id: str
    ticker: str
    entry_index: int
    entry_price: float
    stop_price: float
    target_price: float | None
    shares: float
    stage_data: dict = field(default_factory=dict)
