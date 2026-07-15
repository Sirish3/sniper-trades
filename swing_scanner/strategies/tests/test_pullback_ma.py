"""Synthetic-fixture tests for strategies/pullback_ma.py. Run directly:
    python -m strategies.tests.test_pullback_ma
from the swing_scanner/ directory (needs its venv active, for pandas).

Fixtures are built in two passes: construct a plausible price path, run the
SAME indicator functions the strategy uses, then pin the touch day's low to
the computed EMA21 value (a real touch, by construction, not a hand-picked
number) — the only way to guarantee determinism against indicator math
without duplicating that math by hand.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # swing_scanner/ root

from indicators import rsi as rsi_ind  # noqa: E402
from strategies import pullback_ma  # noqa: E402
from strategies.params import PullbackMAParams  # noqa: E402
from strategies.types import Position  # noqa: E402


def _base_df(n=260, dip_start=205, dip_len=8, dip_pct=0.08):
    """Steady uptrend (guarantees close > sma50 > sma200 well before the
    pullback) with one engineered dip-then-recovery around `dip_start`."""
    idx = pd.bdate_range("2020-01-02", periods=n)
    closes = 100 + np.arange(n) * 0.4
    for k in range(dip_len):
        # A smooth dip and partial recovery: deepest at the middle of the window.
        frac = np.sin(np.pi * k / (dip_len - 1))  # 0 -> 1 -> 0
        closes[dip_start + k] -= dip_pct * closes[dip_start] * frac
    opens = closes - 0.3
    highs = np.maximum(opens, closes) + 1.0
    lows = np.minimum(opens, closes) - 1.0
    volume = np.full(n, 1_000_000.0)
    return pd.DataFrame({"o": opens, "h": highs, "l": lows, "c": closes, "v": volume}, index=idx)


def _find_touch_day(df, dip_start, dip_len, params):
    """Searches the dip window for a day whose RSI lands in [rsi_low, rsi_high]
    once EMA21 touch + volume-decline are also engineered there."""
    rsi_series = rsi_ind(df["c"], 14)
    for i in range(dip_start, dip_start + dip_len):
        if params.rsi_low <= rsi_series.iloc[i] <= params.rsi_high:
            return i
    return None


def _build_setup_fixture(params: PullbackMAParams):
    df = _base_df()
    dip_start, dip_len = 205, 8
    touch_i = _find_touch_day(df, dip_start, dip_len, params)
    assert touch_i is not None, "fixture tuning failed to land RSI in range — adjust dip_pct/dip_len"

    df = pullback_ma.prepare(df)  # adds sma50/sma200/ema21/ema9/rsi14
    ema21_touch = df["ema21"].iloc[touch_i]
    close_orig = df["c"].iloc[touch_i]

    # A +1.0 nudge (empirically, comfortably inside both the RSI band and
    # the 1% MA-touch tolerance for this fixture's dip shape) brings the
    # touch day's close near EMA21 without materially disturbing RSI, then
    # the low sits just under that nudged close — a real touch-from-above.
    new_close = close_orig + 1.0 if close_orig < ema21_touch else close_orig
    df.loc[df.index[touch_i], "c"] = new_close
    df.loc[df.index[touch_i], "o"] = new_close - 0.2
    df.loc[df.index[touch_i], "h"] = new_close + 1.0
    df.loc[df.index[touch_i], "l"] = new_close - 0.1
    # Re-derive RSI/EMA/SMA after nudging the touch-day close.
    df = pullback_ma.prepare(df.drop(columns=["sma50", "sma200", "ema21", "ema9", "rsi14"]))

    # Volume decline: last-3 (including touch day) below prior-10.
    df.loc[df.index[touch_i - 12:touch_i - 2], "v"] = 2_000_000.0
    df.loc[df.index[touch_i - 2:touch_i + 1], "v"] = 800_000.0

    return df, touch_i


class TestPullbackMASetupAndEntry(unittest.TestCase):
    def setUp(self):
        self.params = PullbackMAParams()
        self.df, self.touch_i = _build_setup_fixture(self.params)

    def test_setup_detected_on_touch_day(self):
        setup = pullback_ma.check_setup(self.df, self.touch_i, self.params)
        self.assertIsNotNone(setup, "expected a setup on the engineered touch day")
        self.assertEqual(setup.anchor_index, self.touch_i)

    def test_no_setup_a_week_before_touch(self):
        # Sanity check the fixture isn't accidentally satisfying the setup
        # conditions on every bar in the dip.
        setup = pullback_ma.check_setup(self.df, self.touch_i - 3, self.params)
        self.assertIsNone(setup)

    def test_entry_triggers_when_close_breaks_prior_high(self):
        setup = pullback_ma.check_setup(self.df, self.touch_i, self.params)
        trigger_i = self.touch_i + 1
        df = self.df.copy()
        df.loc[df.index[trigger_i], "c"] = df["h"].iloc[self.touch_i] + 2.0
        df.loc[df.index[trigger_i], "h"] = df["c"].iloc[trigger_i] + 0.5
        df.loc[df.index[trigger_i], "l"] = df["c"].iloc[self.touch_i]

        entry = pullback_ma.check_entry(df, trigger_i, setup, self.params)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.trigger_index, trigger_i)
        self.assertLess(entry.stop_price, df["c"].iloc[trigger_i])

    def test_entry_does_not_trigger_without_breaking_prior_high(self):
        setup = pullback_ma.check_setup(self.df, self.touch_i, self.params)
        trigger_i = self.touch_i + 1
        df = self.df.copy()
        df.loc[df.index[trigger_i], "c"] = df["h"].iloc[self.touch_i] - 0.5  # stays below prior high
        entry = pullback_ma.check_entry(df, trigger_i, setup, self.params)
        self.assertIsNone(entry)

    def test_setup_expires_after_trigger_expiry_days(self):
        setup = pullback_ma.check_setup(self.df, self.touch_i, self.params)
        self.assertEqual(setup.expires_index, self.touch_i + self.params.trigger_expiry_days)


class TestPullbackMAExits(unittest.TestCase):
    def setUp(self):
        self.params = PullbackMAParams()
        n = 60
        idx = pd.bdate_range("2021-01-04", periods=n)
        closes = np.full(n, 100.0)
        self.df = pd.DataFrame({
            "o": closes, "h": closes + 1, "l": closes - 1, "c": closes, "v": np.full(n, 1_000_000.0),
        }, index=idx)
        self.df = pullback_ma.prepare(self.df)
        # >= 21 so EMA21 (min_periods=21) is already defined by the trail check.
        self.entry_index = 25
        self.position = Position(
            strategy_id="pullback_ma", ticker="TEST", entry_index=self.entry_index,
            entry_price=100.0, stop_price=95.0, target_price=110.0, shares=10.0,
        )

    def test_stop_exit(self):
        i = self.entry_index + 2
        df = self.df.copy()
        df.loc[df.index[i], "l"] = 94.0  # breaches stop
        df.loc[df.index[i], "o"] = 96.0
        exit_signal = pullback_ma.check_exit(df, i, self.position, self.params)
        self.assertIsNotNone(exit_signal)
        self.assertEqual(exit_signal.reason, "stop")
        self.assertEqual(exit_signal.exit_price, 95.0)  # open (96) didn't gap through, fills at the stop level

    def test_target_then_trail_exit(self):
        df = self.df.copy()
        hit_i = self.entry_index + 2
        df.loc[df.index[hit_i], "h"] = 111.0  # touches target, doesn't close the trade
        result = pullback_ma.check_exit(df, hit_i, self.position, self.params)
        self.assertIsNone(result)
        self.assertTrue(self.position.stage_data.get("target1_hit"))

        trail_i = hit_i + 1
        ema21_here = df["ema21"].iloc[trail_i]
        df.loc[df.index[trail_i], "c"] = ema21_here - 1.0  # close drops below EMA21
        exit_signal = pullback_ma.check_exit(df, trail_i, self.position, self.params)
        self.assertIsNotNone(exit_signal)
        self.assertEqual(exit_signal.reason, "trail")

    def test_time_stop_exit(self):
        i = self.entry_index + self.params.time_stop_days
        exit_signal = pullback_ma.check_exit(self.df, i, self.position, self.params)
        self.assertIsNotNone(exit_signal)
        self.assertEqual(exit_signal.reason, "time")

    def test_no_exit_before_any_condition(self):
        i = self.entry_index + 2
        exit_signal = pullback_ma.check_exit(self.df, i, self.position, self.params)
        self.assertIsNone(exit_signal)


if __name__ == "__main__":
    unittest.main()
