"""Rule-based chart-pattern detector: pivot detection + linear-regression
trendlines + geometric pattern rules. No LLM calls anywhere in this file —
every pattern returned here is a deterministic function of price history
alone, decided entirely by the numeric thresholds below (flagged as
judgment calls, same as screener.py's VCP heuristics).

Operates on a plain OHLCV DataFrame (columns open/high/low/close/volume,
indexed by date, chronological order) — deliberately independent of
data.py's Alpaca-specific o/h/l/c/v column convention, so this module has
no Alpaca dependency of its own. See from_alpaca_json.py for the adapter
that builds this DataFrame from this app's own candle-JSON shape.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

PIVOT_WINDOW = 5           # bars each side that must be lower/higher for a pivot to count
MIN_BARS = 60               # below this there isn't enough history to trust any pattern
TOLERANCE_PCT = 3.0         # how close two pivot prices must be to count as "roughly equal"
MIN_TRENDLINE_POINTS = 3    # fewer points make R^2 meaningless (2 points always "fit" perfectly)
FIT_QUALITY_MIN = 0.5       # minimum R^2 for a trendline to count as a real trend, not noise
FLAT_SLOPE_PCT = 0.05       # slope below this (% of avg price per bar) counts as "flat"
MAX_PATTERN_AGE_BARS = 15   # if the pivots that define a pattern are older than this, price has
                             # likely already moved on (broken out/down) and the pattern is stale —
                             # reject it rather than describe a setup that's no longer live

FLAGPOLE_LOOKBACK = 15      # bars to look back for a sharp prior move
FLAG_LOOKBACK = 20          # bars of consolidation searched after the flagpole
FLAGPOLE_MIN_GAIN_PCT = 15.0
FLAG_MAX_RANGE_PCT = 8.0    # consolidation range must be tight relative to the flagpole move


@dataclass
class Pivot:
    index: int
    price: float
    kind: str  # "high" | "low"


@dataclass
class Trendline:
    slope: float
    intercept: float
    r_squared: float

    def value_at(self, index: int) -> float:
        return self.slope * index + self.intercept


@dataclass
class PatternMatch:
    pattern_type: str
    confidence: float  # 0-1, informational only — never gates whether a match is returned
    support_low: float
    support_high: float | None = None
    resistance: float | None = None
    trendlines: list[dict] = field(default_factory=list)
    zones: list[dict] = field(default_factory=list)
    hlines: list[dict] = field(default_factory=list)


def find_pivots(df: pd.DataFrame, window: int = PIVOT_WINDOW) -> list[Pivot]:
    """Local-extrema swing points, same technique as screener.py's
    _find_swing_points: bar i is a pivot high if its high is the max
    within [i-window, i+window], pivot low symmetrically. Returned in
    chronological order, highs and lows interleaved as they actually
    occur (not two separate lists) so pattern rules can walk the
    sequence in time order."""
    highs, lows = df["high"].values, df["low"].values
    n = len(df)
    pivots: list[Pivot] = []
    for i in range(window, n - window):
        window_highs = highs[i - window:i + window + 1]
        if highs[i] == window_highs.max():
            pivots.append(Pivot(i, float(highs[i]), "high"))
            continue  # a bar can't be both a pivot high and a pivot low
        window_lows = lows[i - window:i + window + 1]
        if lows[i] == window_lows.min():
            pivots.append(Pivot(i, float(lows[i]), "low"))
    return pivots


def fit_trendline(points: list[tuple[int, float]]) -> Trendline | None:
    """Least-squares line through (index, price) points. None if fewer
    than 2 points, or all points share the same index (a vertical line
    has no slope in this model)."""
    if len(points) < 2:
        return None
    xs = np.array([p[0] for p in points], dtype=float)
    ys = np.array([p[1] for p in points], dtype=float)
    if np.all(xs == xs[0]):
        return None
    slope, intercept = np.polyfit(xs, ys, 1)
    predicted = slope * xs + intercept
    ss_res = float(np.sum((ys - predicted) ** 2))
    ss_tot = float(np.sum((ys - ys.mean()) ** 2))
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 1.0
    return Trendline(float(slope), float(intercept), r_squared)


def _pct_diff(a: float, b: float) -> float:
    return abs(a - b) / ((a + b) / 2) * 100


def _slope_pct(trendline: Trendline, avg_price: float) -> float:
    """Trendline slope as % of average price per bar — makes the flat/
    rising/falling thresholds scale-independent (work the same for a $5
    stock and a $500 one)."""
    return trendline.slope / avg_price * 100


def _date_str(df: pd.DataFrame, index: int) -> str:
    return df.index[index].strftime("%Y-%m-%d")


def _hline(y: float, label: str, color: str) -> dict:
    return {"y": round(y, 2), "label": label, "color": color}


def _trendline_annotation(df: pd.DataFrame, points: list[tuple[int, float]], trendline: Trendline, color: str) -> dict:
    start_idx, end_idx = points[0][0], points[-1][0]
    return {
        "points": [
            [_date_str(df, start_idx), round(trendline.value_at(start_idx), 2)],
            [_date_str(df, end_idx), round(trendline.value_at(end_idx), 2)],
        ],
        "color": color,
        "style": "dashed",
    }


# ── Pattern rules ──────────────────────────────────────────────────────
# Each rule takes (df, pivots) and returns one PatternMatch or None. They
# aren't mutually exclusive — detect_patterns() runs every rule and
# returns every match found, since a ticker can genuinely be forming more
# than one recognizable shape at once (e.g. a triangle nested inside a
# longer cup).

def detect_double_top(df: pd.DataFrame, pivots: list[Pivot]) -> PatternMatch | None:
    highs = [p for p in pivots if p.kind == "high"]
    if len(highs) < 2:
        return None
    p1, p2 = highs[-2], highs[-1]
    if len(df) - 1 - p2.index > MAX_PATTERN_AGE_BARS:
        return None  # newest defining pivot is stale — price has likely already moved on
    if _pct_diff(p1.price, p2.price) > TOLERANCE_PCT:
        return None
    lows_between = [p for p in pivots if p.kind == "low" and p1.index < p.index < p2.index]
    if not lows_between:
        return None
    trough = min(lows_between, key=lambda p: p.price)
    resistance = (p1.price + p2.price) / 2
    if (resistance - trough.price) / resistance * 100 < TOLERANCE_PCT:
        return None  # trough not meaningfully below the two highs — not a real "M" shape
    return PatternMatch(
        pattern_type="Double Top",
        confidence=0.6,
        support_low=round(trough.price, 2),
        resistance=round(resistance, 2),
        hlines=[_hline(resistance, "Resistance", "#ef5350"), _hline(trough.price, "Neckline", "#66bb6a")],
    )


def detect_double_bottom(df: pd.DataFrame, pivots: list[Pivot]) -> PatternMatch | None:
    lows = [p for p in pivots if p.kind == "low"]
    if len(lows) < 2:
        return None
    p1, p2 = lows[-2], lows[-1]
    if len(df) - 1 - p2.index > MAX_PATTERN_AGE_BARS:
        return None  # newest defining pivot is stale — price has likely already moved on
    if _pct_diff(p1.price, p2.price) > TOLERANCE_PCT:
        return None
    highs_between = [p for p in pivots if p.kind == "high" and p1.index < p.index < p2.index]
    if not highs_between:
        return None
    peak = max(highs_between, key=lambda p: p.price)
    support = (p1.price + p2.price) / 2
    if (peak.price - support) / support * 100 < TOLERANCE_PCT:
        return None  # peak not meaningfully above the two lows — not a real "W" shape
    return PatternMatch(
        pattern_type="Double Bottom",
        confidence=0.6,
        support_low=round(support, 2),
        resistance=round(peak.price, 2),
        hlines=[_hline(support, "Support", "#66bb6a"), _hline(peak.price, "Neckline", "#ef5350")],
    )


def detect_cup_and_handle(df: pd.DataFrame, pivots: list[Pivot]) -> PatternMatch | None:
    highs = [p for p in pivots if p.kind == "high"]
    lows = [p for p in pivots if p.kind == "low"]
    if len(highs) < 2 or not lows:
        return None

    left_rim, right_rim = highs[-2], highs[-1]
    if right_rim.index <= left_rim.index:
        return None
    if _pct_diff(left_rim.price, right_rim.price) > TOLERANCE_PCT * 2:  # rims get a bit more slack than a double top
        return None

    cup_lows = [p for p in lows if left_rim.index < p.index < right_rim.index]
    if not cup_lows:
        return None
    cup_bottom = min(cup_lows, key=lambda p: p.price)

    # Reject a straight V: the bottom should sit roughly in the middle
    # third of the rim-to-rim span, not hugging either rim.
    span = right_rim.index - left_rim.index
    if span < 10:
        return None
    position = (cup_bottom.index - left_rim.index) / span
    if not (0.25 <= position <= 0.75):
        return None

    rim_height = (left_rim.price + right_rim.price) / 2
    cup_depth_pct = (rim_height - cup_bottom.price) / rim_height * 100
    if cup_depth_pct < TOLERANCE_PCT:
        return None  # too shallow to be a real cup

    handle_lows = [p for p in lows if p.index > right_rim.index]
    if not handle_lows:
        return None
    handle_low = handle_lows[0]
    if len(df) - 1 - handle_low.index > MAX_PATTERN_AGE_BARS:
        return None  # handle formed too long ago — price has likely already resolved the setup
    handle_depth_pct = (right_rim.price - handle_low.price) / right_rim.price * 100
    if not (0 < handle_depth_pct < cup_depth_pct * 0.5):
        return None  # handle must be shallower and shorter than the cup itself

    return PatternMatch(
        pattern_type="Cup and Handle",
        confidence=0.55,
        support_low=round(handle_low.price, 2),
        resistance=round(rim_height, 2),
        hlines=[_hline(rim_height, "Resistance (rim)", "#ef5350")],
        zones=[{"y1": round(cup_bottom.price, 2), "y2": round(rim_height, 2), "label": "Cup", "color": "#8b5cf6"}],
    )


def detect_triangle_or_wedge(df: pd.DataFrame, pivots: list[Pivot]) -> PatternMatch | None:
    """One rule covering 5 related patterns, since they're all "fit a
    trendline through the recent highs and another through the recent
    lows, then classify by slope" — Ascending/Descending/Symmetrical
    Triangle, Rising/Falling Wedge."""
    highs = [p for p in pivots if p.kind == "high"][-4:]
    lows = [p for p in pivots if p.kind == "low"][-4:]
    if len(highs) < MIN_TRENDLINE_POINTS or len(lows) < MIN_TRENDLINE_POINTS:
        return None
    most_recent_pivot_index = max(highs[-1].index, lows[-1].index)
    if len(df) - 1 - most_recent_pivot_index > MAX_PATTERN_AGE_BARS:
        return None  # no fresh pivot in a while — these trendlines describe an old range, not now

    high_points = [(p.index, p.price) for p in highs]
    low_points = [(p.index, p.price) for p in lows]
    resistance_line = fit_trendline(high_points)
    support_line = fit_trendline(low_points)
    if resistance_line is None or support_line is None:
        return None
    if resistance_line.r_squared < FIT_QUALITY_MIN or support_line.r_squared < FIT_QUALITY_MIN:
        return None

    avg_price = df["close"].iloc[-min(60, len(df)):].mean()
    res_slope = _slope_pct(resistance_line, avg_price)
    sup_slope = _slope_pct(support_line, avg_price)

    last_index = len(df) - 1
    current_resistance = resistance_line.value_at(last_index)
    current_support = support_line.value_at(last_index)
    if current_support >= current_resistance:
        return None  # lines have already crossed — the pattern's resolved, not still forming

    resistance_flat = abs(res_slope) < FLAT_SLOPE_PCT
    support_flat = abs(sup_slope) < FLAT_SLOPE_PCT

    if resistance_flat and sup_slope > FLAT_SLOPE_PCT:
        pattern_type = "Ascending Triangle"
    elif support_flat and res_slope < -FLAT_SLOPE_PCT:
        pattern_type = "Descending Triangle"
    elif res_slope < -FLAT_SLOPE_PCT and sup_slope > FLAT_SLOPE_PCT:
        pattern_type = "Symmetrical Triangle"
    elif res_slope > FLAT_SLOPE_PCT and sup_slope > FLAT_SLOPE_PCT and sup_slope > res_slope:
        pattern_type = "Rising Wedge"
    elif res_slope < -FLAT_SLOPE_PCT and sup_slope < -FLAT_SLOPE_PCT and res_slope < sup_slope:
        pattern_type = "Falling Wedge"
    else:
        return None

    return PatternMatch(
        pattern_type=pattern_type,
        confidence=round(min(resistance_line.r_squared, support_line.r_squared), 2),
        support_low=round(current_support, 2),
        resistance=round(current_resistance, 2),
        trendlines=[
            _trendline_annotation(df, high_points, resistance_line, "#ef5350"),
            _trendline_annotation(df, low_points, support_line, "#66bb6a"),
        ],
    )


def detect_bull_flag(df: pd.DataFrame, pivots: list[Pivot]) -> PatternMatch | None:
    if len(df) < FLAGPOLE_LOOKBACK + FLAG_LOOKBACK:
        return None

    channel = df.iloc[-FLAG_LOOKBACK:]
    pole = df.iloc[-(FLAGPOLE_LOOKBACK + FLAG_LOOKBACK):-FLAG_LOOKBACK]

    pole_gain_pct = (pole["close"].iloc[-1] - pole["close"].iloc[0]) / pole["close"].iloc[0] * 100
    if pole_gain_pct < FLAGPOLE_MIN_GAIN_PCT:
        return None

    channel_high, channel_low = channel["high"].max(), channel["low"].min()
    channel_range_pct = (channel_high - channel_low) / channel_low * 100
    if channel_range_pct > FLAG_MAX_RANGE_PCT:
        return None

    if channel["close"].iloc[-1] > pole["close"].iloc[-1] * 1.05:
        return None  # already broken out well past the flagpole's high — not "forming" anymore

    return PatternMatch(
        pattern_type="Bull Flag",
        confidence=0.5,
        support_low=round(channel_low, 2),
        resistance=round(channel_high, 2),
        zones=[{"y1": round(channel_low, 2), "y2": round(channel_high, 2), "label": "Flag", "color": "#3b82f6"}],
    )


DETECTORS = (
    detect_double_top,
    detect_double_bottom,
    detect_cup_and_handle,
    detect_triangle_or_wedge,
    detect_bull_flag,
)


def detect_patterns(df: pd.DataFrame) -> list[PatternMatch]:
    """Runs every pattern rule against `df` and returns every match found.
    Not mutually exclusive — a ticker can match zero, one, or several
    patterns in one call."""
    if len(df) < MIN_BARS:
        return []

    pivots = find_pivots(df)
    matches = []
    for detector in DETECTORS:
        result = detector(df, pivots)
        if result:
            matches.append(result)
    return matches
