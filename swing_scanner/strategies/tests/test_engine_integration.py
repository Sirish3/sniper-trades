"""A synthetic end-to-end check of backtest_engine.py's portfolio layer
(sizing, one-per-ticker, max-concurrent, R-multiple/stat computation) —
independent of Alpaca, by monkeypatching get_daily_bars with synthetic bars.
Run from swing_scanner/ with its venv active:
    python -m unittest strategies.tests.test_engine_integration
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import backtest_engine  # noqa: E402
from strategies.params import PortfolioParams, PullbackMAParams  # noqa: E402
from strategies.tests.test_pullback_ma import _build_setup_fixture  # noqa: E402


def _pullback_bars():
    """Reuses test_pullback_ma.py's proven touch/RSI/volume-tuned fixture
    (an uptrend with one engineered pullback), then extends it with a sharp
    resumption so the entry trigger (close > prior day's high) also fires —
    this integration test only cares that setups AND trades come out the
    other end of the full engine, not the strategy's own edge cases."""
    df, touch_i = _build_setup_fixture(PullbackMAParams())
    trigger_i = touch_i + 1
    df.loc[df.index[trigger_i], "c"] = df["h"].iloc[touch_i] + 3.0
    df.loc[df.index[trigger_i], "h"] = df["c"].iloc[trigger_i] + 0.5
    df.loc[df.index[trigger_i], "o"] = df["c"].iloc[touch_i]
    df.loc[df.index[trigger_i], "l"] = df["c"].iloc[touch_i]
    # Keep climbing afterward so the position has room to run toward target/trail.
    tail_n = len(df) - trigger_i - 1
    bump = np.arange(1, tail_n + 1) * 0.6
    df.loc[df.index[trigger_i + 1:], "c"] = df["c"].iloc[trigger_i] + bump
    df.loc[df.index[trigger_i + 1:], "o"] = df["c"].iloc[trigger_i + 1:] - 0.3
    df.loc[df.index[trigger_i + 1:], "h"] = df["c"].iloc[trigger_i + 1:] + 1.0
    df.loc[df.index[trigger_i + 1:], "l"] = df["c"].iloc[trigger_i + 1:] - 1.0
    return df[["o", "h", "l", "c", "v"]]


class TestEngineIntegration(unittest.TestCase):
    def test_run_comparison_produces_trades_and_stats(self):
        df = _pullback_bars()

        def fake_get_daily_bars(symbol, lookback_days=400, feed="iex", use_cache=True):
            return df.copy()

        start = df.index[0].date().isoformat()
        end = df.index[-1].date().isoformat()

        with mock.patch("backtest_engine.get_daily_bars", side_effect=fake_get_daily_bars):
            result = backtest_engine.run_comparison(
                strategy_ids=["pullback_ma"],
                tickers=["FAKE"],
                start_date=start,
                end_date=end,
                portfolio_params=PortfolioParams(account_equity=100_000.0, max_concurrent_positions=4),
            )

        stats = result["per_strategy"]["pullback_ma"]
        self.assertGreaterEqual(stats.setups_found, 1)
        self.assertGreaterEqual(stats.num_trades, 1)
        for trade in result["trades"]:
            self.assertLess(trade.setup_date, trade.entry_date) if trade.entry_date != trade.setup_date else None
            self.assertLessEqual(trade.entry_date, trade.exit_date)
            self.assertGreater(trade.shares, 0)

        csv_text = backtest_engine.trades_to_csv(result["trades"])
        self.assertIn("ticker,strategy,setup_date", csv_text.splitlines()[0])

    def test_max_concurrent_positions_enforced(self):
        df = _pullback_bars()

        def fake_get_daily_bars(symbol, lookback_days=400, feed="iex", use_cache=True):
            return df.copy()

        start = df.index[0].date().isoformat()
        end = df.index[-1].date().isoformat()

        with mock.patch("backtest_engine.get_daily_bars", side_effect=fake_get_daily_bars):
            result = backtest_engine.run_comparison(
                strategy_ids=["pullback_ma"],
                tickers=["A", "B", "C"],  # identical bars -> identical signals every ticker
                start_date=start,
                end_date=end,
                portfolio_params=PortfolioParams(account_equity=100_000.0, max_concurrent_positions=1),
            )
        # With max_concurrent_positions=1 and 3 identical tickers firing the
        # same setup on the same day, at most one of them should ever be
        # open at a time — i.e. no two trades' [entry, exit] windows overlap.
        trades = sorted(result["trades"], key=lambda t: t.entry_date)
        for a, b in zip(trades, trades[1:]):
            self.assertLessEqual(a.exit_date, b.entry_date)


if __name__ == "__main__":
    unittest.main()
