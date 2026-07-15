"""Three selectable swing-trading entry strategies sharing one interface
(check_setup / check_entry / check_exit) so backtest_engine.py can walk any
subset of them over the same OHLCV bars without special-casing any one.
"""
from __future__ import annotations

from . import base_breakout, earnings_gap, pullback_ma
from .params import DEFAULT_PARAMS

STRATEGIES = {
    "pullback_ma": pullback_ma,
    "base_breakout": base_breakout,
    "earnings_gap": earnings_gap,
}

STRATEGY_LABELS = {
    "pullback_ma": "Pullback to Moving Average",
    "base_breakout": "Consolidation Base Breakout",
    "earnings_gap": "Post-Earnings Gap-and-Hold",
}

__all__ = ["STRATEGIES", "STRATEGY_LABELS", "DEFAULT_PARAMS"]
