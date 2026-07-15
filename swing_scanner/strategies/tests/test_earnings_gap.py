"""Synthetic-fixture tests for strategies/earnings_gap.py. Run from
swing_scanner/ with its venv active:
    python -m unittest strategies.tests.test_earnings_gap
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from strategies import earnings_gap  # noqa: E402
from strategies.params import EarningsGapParams  # noqa: E402
from strategies.types import Position  # noqa: E402

GAP_DAY = 60


def _gap_df(n=90, variant="orb", gapped=True):
    idx = pd.bdate_range("2023-01-02", periods=n)
    closes = np.full(n, 100.0)
    highs = closes + 1.0
    lows = closes - 1.0
    opens = closes - 0.2
    volume = np.full(n, 500_000.0)

    if gapped:
        prior_close = closes[GAP_DAY - 1]
        gap_open = prior_close * 1.05  # 5% gap, above gap_min_pct (3%)
        opens[GAP_DAY] = gap_open
        if variant == "orb":
            closes[GAP_DAY] = gap_open + 2.0
            lows[GAP_DAY] = gap_open - 0.3
            highs[GAP_DAY] = closes[GAP_DAY] + 0.3  # close near the top of the day's range
        else:
            closes[GAP_DAY] = gap_open - 0.5  # gap day itself doesn't resolve for "pullback"
            lows[GAP_DAY] = gap_open - 1.0
            highs[GAP_DAY] = gap_open + 0.5
        volume[GAP_DAY] = 3_000_000.0  # well above 2x a 500k SMA50

    df = pd.DataFrame({"o": opens, "h": highs, "l": lows, "c": closes, "v": volume}, index=idx)
    return earnings_gap.prepare(df)


class TestEarningsGapSetup(unittest.TestCase):
    def test_setup_detected_on_gap_day(self):
        params = EarningsGapParams()
        df = _gap_df()
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        self.assertIsNotNone(setup)
        self.assertEqual(setup.data["pre_gap_close"], 100.0)

    def test_no_setup_without_gap(self):
        params = EarningsGapParams()
        df = _gap_df(gapped=False)
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        self.assertIsNone(setup)

    def test_orb_expiry_is_same_day(self):
        params = EarningsGapParams(variant="orb")
        df = _gap_df(variant="orb")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        self.assertEqual(setup.expires_index, GAP_DAY)

    def test_pullback_expiry_is_window_days_later(self):
        params = EarningsGapParams(variant="pullback")
        df = _gap_df(variant="pullback")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        self.assertEqual(setup.expires_index, GAP_DAY + params.pullback_window_days)


class TestEarningsGapEntry(unittest.TestCase):
    def test_orb_entry_same_day(self):
        params = EarningsGapParams(variant="orb")
        df = _gap_df(variant="orb")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        entry = earnings_gap.check_entry(df, GAP_DAY, setup, params)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.stop_price, 100.0)

    def test_orb_no_entry_next_day(self):
        params = EarningsGapParams(variant="orb")
        df = _gap_df(variant="orb")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        entry = earnings_gap.check_entry(df, GAP_DAY + 1, setup, params)
        self.assertIsNone(entry)

    def test_pullback_entry_when_gap_holds_and_closes_green(self):
        params = EarningsGapParams(variant="pullback")
        df = _gap_df(variant="pullback")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        i = GAP_DAY + 1
        df.loc[df.index[i], "l"] = setup.data["pre_gap_close"] + 0.5  # gap never filled
        df.loc[df.index[i], "o"] = 102.0
        df.loc[df.index[i], "c"] = 103.0  # closes green
        entry = earnings_gap.check_entry(df, i, setup, params)
        self.assertIsNotNone(entry)

    def test_pullback_no_entry_if_gap_fills(self):
        params = EarningsGapParams(variant="pullback")
        df = _gap_df(variant="pullback")
        setup = earnings_gap.check_setup(df, GAP_DAY, params)
        i = GAP_DAY + 1
        df.loc[df.index[i], "l"] = setup.data["pre_gap_close"] - 1.0  # gap fills
        entry = earnings_gap.check_entry(df, i, setup, params)
        self.assertIsNone(entry)


class TestEarningsGapExits(unittest.TestCase):
    def setUp(self):
        self.params = EarningsGapParams()
        n = 50
        idx = pd.bdate_range("2023-06-01", periods=n)
        closes = np.full(n, 110.0)
        self.df = pd.DataFrame({
            "o": closes, "h": closes + 1, "l": closes - 1, "c": closes, "v": np.full(n, 1_000_000.0),
        }, index=idx)
        self.df = earnings_gap.prepare(self.df)
        self.entry_index = 25  # >= 9 so EMA9 (min_periods=9) is defined
        self.position = Position(
            strategy_id="earnings_gap", ticker="TEST", entry_index=self.entry_index,
            entry_price=110.0, stop_price=103.0, target_price=None, shares=10.0,
        )

    def test_stop_exit(self):
        i = self.entry_index + 1
        df = self.df.copy()
        df.loc[df.index[i], "l"] = 102.0
        df.loc[df.index[i], "o"] = 108.0
        exit_signal = earnings_gap.check_exit(df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "stop")
        self.assertEqual(exit_signal.exit_price, 103.0)

    def test_trail_exit_below_ema9(self):
        i = self.entry_index + 1
        df = self.df.copy()
        ema9_here = df["ema9"].iloc[i]
        df.loc[df.index[i], "c"] = ema9_here - 1.0
        exit_signal = earnings_gap.check_exit(df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "trail")

    def test_time_stop_exit(self):
        i = self.entry_index + self.params.time_stop_days
        exit_signal = earnings_gap.check_exit(self.df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "time")


if __name__ == "__main__":
    unittest.main()
