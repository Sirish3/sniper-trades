"""Trend Template (Stage 2) filter and a simplified VCP (volatility
contraction pattern) detector.

ASSUMPTION FLAGGED — RS ratio formula: the spec says RS = "ticker's trailing
63-day return divided by SPY's trailing return over the same period." Taken
completely literally (return / return), that formula's sign flips in a
confusing way whenever SPY's trailing return is negative (a token that's
merely less-bad than SPY would come out with a NEGATIVE ratio, ranking
below a token that fell alongside SPY). This module instead uses the
standard "relative strength line" ratio, (1 + ticker_return) / (1 +
spy_return), which is monotonic in the same direction regardless of SPY's
sign — a stronger ticker always ranks higher. The percentile-ranking step
("0-100 scale, like IBD's RS rating") is unchanged from the spec.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from indicators import atr, avg_volume, pct_off_52w_high, sma, sma_trending_up, trailing_return, week52_high, week52_low

RS_LOOKBACK_DAYS = 63
VCP_LOOKBACK_DAYS = 50  # ~10 trading weeks
SWING_WINDOW = 3        # a bar must be the local high/low within +/- this many bars to count as a swing point


@dataclass
class TrendTemplateResult:
    passed: bool
    close: float
    sma50: float
    sma150: float
    sma200: float
    week52_high: float
    week52_low: float
    pct_off_high: float
    pct_above_low: float
    rs_score: float
    reasons_failed: list = field(default_factory=list)


def compute_rs_ratios(closes_by_symbol: dict, spy_closes: pd.Series) -> dict:
    """Raw (unranked) RS ratio per symbol — see module docstring for the
    formula choice. Returns {symbol: ratio}; symbols with insufficient
    history are omitted."""
    spy_return = trailing_return(spy_closes, RS_LOOKBACK_DAYS)
    if spy_return is None:
        return {}

    ratios = {}
    for symbol, closes in closes_by_symbol.items():
        ticker_return = trailing_return(closes, RS_LOOKBACK_DAYS)
        if ticker_return is None:
            continue
        ratios[symbol] = (1 + ticker_return) / (1 + spy_return)
    return ratios


def rs_percentile_scores(rs_ratios: dict) -> dict:
    """Ranks raw RS ratios into a 0-100 percentile score across the
    universe — the IBD-style "RS Rating" scale the spec asks for."""
    if not rs_ratios:
        return {}
    series = pd.Series(rs_ratios)
    return (series.rank(pct=True) * 100).to_dict()


def check_trend_template(df: pd.DataFrame, rs_score: float | None) -> TrendTemplateResult:
    """Evaluates the 5 Trend Template conditions against one ticker's daily
    bars. `rs_score` is precomputed across the universe (see
    rs_percentile_scores) and passed in, since a single ticker can't rank
    itself in isolation."""
    reasons_failed = []

    sma50_series = sma(df["c"], 50)
    sma150_series = sma(df["c"], 150)
    sma200_series = sma(df["c"], 200)

    close = df["c"].iloc[-1]
    s50 = sma50_series.iloc[-1]
    s150 = sma150_series.iloc[-1]
    s200 = sma200_series.iloc[-1]
    high = week52_high(df)
    low = week52_low(df)
    off_high = pct_off_52w_high(close, high)
    above_low = (close - low) / low * 100
    rs = rs_score if rs_score is not None else 0.0

    if pd.isna(s50) or pd.isna(s150) or pd.isna(s200):
        reasons_failed.append("Not enough history for SMA50/150/200")
    elif not (close > s50 > s150 > s200):
        reasons_failed.append("Close > SMA50 > SMA150 > SMA200 fails")

    if not sma_trending_up(sma200_series, lookback=20):
        reasons_failed.append("SMA200 not trending up over last 20 days")

    if off_high > 25:
        reasons_failed.append(f"{off_high:.1f}% off 52w high (needs <= 25%)")

    if above_low < 30:
        reasons_failed.append(f"Only {above_low:.1f}% above 52w low (needs >= 30%)")

    if rs < 70:
        reasons_failed.append(f"RS score {rs:.0f} (needs >= 70)")

    return TrendTemplateResult(
        passed=len(reasons_failed) == 0,
        close=close, sma50=s50, sma150=s150, sma200=s200,
        week52_high=high, week52_low=low,
        pct_off_high=off_high, pct_above_low=above_low,
        rs_score=rs, reasons_failed=reasons_failed,
    )


def _find_swing_points(df: pd.DataFrame, window: int = SWING_WINDOW) -> tuple[list[int], list[int]]:
    """Local extrema: bar `i` counts as a swing high if it's the max High
    within [i-window, i+window], and symmetrically for swing lows. Returns
    positional indices into `df`, not dates."""
    highs, lows = df["h"], df["l"]
    n = len(df)
    swing_highs, swing_lows = [], []
    for i in range(window, n - window):
        window_slice_h = highs.iloc[i - window:i + window + 1]
        if highs.iloc[i] == window_slice_h.max():
            swing_highs.append(i)
        window_slice_l = lows.iloc[i - window:i + window + 1]
        if lows.iloc[i] == window_slice_l.min():
            swing_lows.append(i)
    return swing_highs, swing_lows


@dataclass
class VCPResult:
    detected: bool
    pivot: float | None = None
    legs: list = field(default_factory=list)  # [{"pct_range": ..., "avg_volume": ..., "peak_idx": ..., "trough_idx": ...}, ...]
    reason: str = ""


def detect_vcp(df: pd.DataFrame) -> VCPResult:
    """Simplified VCP: finds swing highs/lows in the trailing
    VCP_LOOKBACK_DAYS window, pairs each swing high with the next swing low
    into a "pullback leg" (peak-to-trough), and checks the last 3 legs are
    both (a) contracting in percentage range and (b) declining in average
    volume relative to the base's overall average volume.

    This is a heuristic simplification of Minervini-style VCP detection,
    not a rigorous implementation — real VCP analysis also weighs base
    length, number of contractions (2-5 is typical), and shakeout
    structure, none of which this function attempts to model.
    """
    recent = df.tail(VCP_LOOKBACK_DAYS)
    if len(recent) < VCP_LOOKBACK_DAYS:
        return VCPResult(detected=False, reason="Not enough history for a VCP window")

    recent = recent.reset_index(drop=True)
    swing_highs, swing_lows = _find_swing_points(recent)

    if len(swing_highs) < 3 or len(swing_lows) < 3:
        return VCPResult(detected=False, reason="Not enough swing points in the lookback window")

    # Pair each swing high with the next swing low that follows it, forming
    # peak-to-trough "legs" in chronological order.
    legs = []
    for peak_idx in swing_highs:
        following_lows = [low_idx for low_idx in swing_lows if low_idx > peak_idx]
        if not following_lows:
            continue
        trough_idx = min(following_lows)
        peak_price = recent["h"].iloc[peak_idx]
        trough_price = recent["l"].iloc[trough_idx]
        pct_range = (peak_price - trough_price) / peak_price * 100
        leg_volume = recent["v"].iloc[peak_idx:trough_idx + 1].mean()
        legs.append({
            "peak_idx": peak_idx, "trough_idx": trough_idx,
            "peak_price": peak_price, "trough_price": trough_price,
            "pct_range": pct_range, "avg_volume": leg_volume,
        })

    if len(legs) < 3:
        return VCPResult(detected=False, reason="Fewer than 3 pullback legs identified")

    last3 = legs[-3:]
    base_avg_volume = recent["v"].mean()

    contracting = last3[0]["pct_range"] > last3[1]["pct_range"] > last3[2]["pct_range"]
    volume_declining = (
        last3[0]["avg_volume"] > last3[1]["avg_volume"] > last3[2]["avg_volume"]
        and all(leg["avg_volume"] < base_avg_volume for leg in last3)
    )

    if not contracting:
        return VCPResult(detected=False, legs=last3, reason="Pullback ranges are not contracting")
    if not volume_declining:
        return VCPResult(detected=False, legs=last3, reason="Volume not declining through the pullbacks")

    pivot = last3[-1]["peak_price"]
    return VCPResult(detected=True, pivot=pivot, legs=last3, reason="")
