"""Synthetic-fixture tests for strategies/base_breakout.py. Run from
swing_scanner/ with its venv active:
    python -m unittest strategies.tests.test_base_breakout
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from strategies import base_breakout  # noqa: E402
from strategies.earnings_calendar import EarningsCalendar  # noqa: E402
from strategies.params import BaseBreakoutParams  # noqa: E402
from strategies.types import Position  # noqa: E402

BASE_LEN = 20
BASE_START = 30
BASE_HIGH = 105.0
BASE_LOW = 98.0  # range = 7/98 = 7.1% < base_max_range_pct (12%)


def _base_breakout_df(n=90, breakout_i=None):
    """Flat pre-base noise, then a tight, contracting base [BASE_START,
    BASE_START+BASE_LEN), then (optionally) a breakout day."""
    idx = pd.bdate_range("2022-01-03", periods=n)
    closes = np.full(n, 100.0)
    highs = np.full(n, 101.0)
    lows = np.full(n, 99.0)
    volume = np.full(n, 500_000.0)

    half = BASE_LEN // 2
    for k in range(BASE_LEN):
        i = BASE_START + k
        if k < half:
            # first half: wide swings between base_low and base_high
            highs[i] = BASE_HIGH if k % 2 == 0 else 101.0
            lows[i] = BASE_LOW if k % 2 == 1 else 99.0
        else:
            # second half: tight range near the middle, low volume (contraction)
            highs[i] = 102.0
            lows[i] = 100.5
        closes[i] = (highs[i] + lows[i]) / 2
        volume[i] = 600_000.0 if k < half else 200_000.0

    base_end = BASE_START + BASE_LEN - 1
    closes[base_end] = BASE_HIGH - 0.5  # within near_high_tolerance_pct of BASE_HIGH
    highs[base_end] = max(highs[base_end], closes[base_end] + 0.5)

    opens = closes.copy()
    if breakout_i is not None:
        closes[breakout_i] = BASE_HIGH + 3.0
        highs[breakout_i] = closes[breakout_i] + 0.5
        lows[breakout_i] = BASE_LOW + 1.0
        opens[breakout_i] = BASE_HIGH + 0.5
        volume[breakout_i] = 3_000_000.0  # well above 1.5x a ~500k-600k SMA50

    df = pd.DataFrame({"o": opens, "h": highs, "l": lows, "c": closes, "v": volume}, index=idx)
    return base_breakout.prepare(df)


class TestBaseBreakoutSetup(unittest.TestCase):
    def setUp(self):
        self.params = BaseBreakoutParams()
        self.base_end = BASE_START + BASE_LEN - 1
        self.df = _base_breakout_df()

    def test_setup_detected_at_base_end(self):
        setup = base_breakout.check_setup(self.df, self.base_end, self.params)
        self.assertIsNotNone(setup)
        self.assertAlmostEqual(setup.data["base_high"], max(self.df["h"].iloc[BASE_START:self.base_end + 1]))

    def test_no_setup_mid_base_too_early(self):
        # Before base_min_days worth of the window has accumulated at all.
        setup = base_breakout.check_setup(self.df, BASE_START + 2, self.params)
        self.assertIsNone(setup)

    def test_no_setup_when_range_too_wide(self):
        df = self.df.copy()
        # base_min_days=15, so every candidate window length (15..20) ending
        # at base_end includes base_end-1 — corrupting it there (rather than
        # at BASE_START) means no shorter sub-window can dodge the blowout.
        df.loc[df.index[self.base_end - 1], "h"] = 200.0
        df = base_breakout.prepare(df.drop(columns=["vol_sma50"]))
        setup = base_breakout.check_setup(df, self.base_end, self.params)
        self.assertIsNone(setup)


class TestBaseBreakoutEntry(unittest.TestCase):
    def setUp(self):
        self.params = BaseBreakoutParams()
        self.base_end = BASE_START + BASE_LEN - 1
        self.breakout_i = self.base_end + 1
        self.df = _base_breakout_df(breakout_i=self.breakout_i)
        self.setup = base_breakout.check_setup(self.df, self.base_end, self.params)
        self.assertIsNotNone(self.setup)

    def test_entry_triggers_on_breakout_volume(self):
        entry = base_breakout.check_entry(self.df, self.breakout_i, self.setup, self.params)
        self.assertIsNotNone(entry)
        self.assertFalse(entry.skipped)
        self.assertGreater(entry.target_price, self.setup.data["base_high"])

    def test_no_entry_without_volume_expansion(self):
        df = self.df.copy()
        df.loc[df.index[self.breakout_i], "v"] = 400_000.0  # below 1.5x SMA50 volume
        df = base_breakout.prepare(df.drop(columns=["vol_sma50"]))
        entry = base_breakout.check_entry(df, self.breakout_i, self.setup, self.params)
        self.assertIsNone(entry)

    def test_earnings_guard_skips_entry(self):
        cal = EarningsCalendar()
        earnings_day = self.df.index[self.breakout_i + 1]
        # Fake a same-ticker CSV row via the in-memory structure directly.
        cal._dates["TEST"] = {pd.Timestamp(earnings_day).normalize()}
        params = BaseBreakoutParams(ticker="TEST", earnings_calendar=cal)
        entry = base_breakout.check_entry(self.df, self.breakout_i, self.setup, params)
        self.assertIsNotNone(entry)
        self.assertTrue(entry.skipped)

    def test_no_guard_without_known_earnings(self):
        cal = EarningsCalendar()  # loaded, but empty for this ticker
        params = BaseBreakoutParams(ticker="TEST", earnings_calendar=cal)
        entry = base_breakout.check_entry(self.df, self.breakout_i, self.setup, params)
        self.assertIsNotNone(entry)
        self.assertFalse(entry.skipped)


class TestBaseBreakoutExits(unittest.TestCase):
    def setUp(self):
        self.params = BaseBreakoutParams()
        n = 40
        idx = pd.bdate_range("2022-06-01", periods=n)
        closes = np.full(n, 110.0)
        self.df = pd.DataFrame({
            "o": closes, "h": closes + 1, "l": closes - 1, "c": closes, "v": np.full(n, 1_000_000.0),
        }, index=idx)
        self.df = base_breakout.prepare(self.df)
        self.entry_index = 3
        self.position = Position(
            strategy_id="base_breakout", ticker="TEST", entry_index=self.entry_index,
            entry_price=110.0, stop_price=105.0, target_price=125.0, shares=10.0,
            stage_data={"initial_risk": 5.0},
        )

    def test_stop_exit(self):
        i = self.entry_index + 1
        df = self.df.copy()
        df.loc[df.index[i], "l"] = 104.0
        df.loc[df.index[i], "o"] = 106.0
        exit_signal = base_breakout.check_exit(df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "stop")
        self.assertEqual(exit_signal.exit_price, 105.0)

    def test_target_exit(self):
        i = self.entry_index + 1
        df = self.df.copy()
        df.loc[df.index[i], "h"] = 126.0
        df.loc[df.index[i], "o"] = 111.0
        exit_signal = base_breakout.check_exit(df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "target")
        self.assertEqual(exit_signal.exit_price, 125.0)

    def test_breakeven_move_after_plus_1r(self):
        i = self.entry_index + 1
        df = self.df.copy()
        df.loc[df.index[i], "h"] = 115.5  # entry(110) + initial_risk(5) = 115 -> +1R touched
        result = base_breakout.check_exit(df, i, self.position, self.params)
        self.assertIsNone(result)
        self.assertTrue(self.position.stage_data.get("moved_to_breakeven"))
        self.assertEqual(self.position.stop_price, 110.0)

    def test_time_stop_exit(self):
        i = self.entry_index + self.params.time_stop_days
        exit_signal = base_breakout.check_exit(self.df, i, self.position, self.params)
        self.assertEqual(exit_signal.reason, "time")


if __name__ == "__main__":
    unittest.main()
