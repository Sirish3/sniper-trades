"""Pure, independently-testable technical indicator functions. Each takes a
plain pandas Series/DataFrame and returns a Series/scalar — no I/O, no
Alpaca-specific knowledge, so these can be unit tested against hand-computed
examples without any network access.
"""
from __future__ import annotations

import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    """Simple moving average."""
    return series.rolling(window=window, min_periods=window).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average, standard alpha = 2/(period+1)."""
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI (alpha = 1/period, same smoothing convention as atr()
    above) — not the more common span=period EMA some libraries use, which
    is a different (faster-reacting) average."""
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, float("nan"))
    return 100 - (100 / (1 + rs))


def sma_trending_up(sma_series: pd.Series, lookback: int = 20) -> bool:
    """True if the SMA today is higher than it was `lookback` bars ago —
    Trend Template condition #2 (SMA200 rising, not just "above")."""
    if len(sma_series) <= lookback or pd.isna(sma_series.iloc[-1]) or pd.isna(sma_series.iloc[-1 - lookback]):
        return False
    return sma_series.iloc[-1] > sma_series.iloc[-1 - lookback]


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range, Wilder's smoothing (alpha = 1/period) — the
    standard ATR definition Wilder himself specified, and what most
    charting platforms mean by "ATR" unless stated otherwise."""
    high, low, close = df["h"], df["l"], df["c"]
    prev_close = close.shift(1)
    true_range = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return true_range.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def week52_high(df: pd.DataFrame, window: int = 252) -> float:
    """52-week high — uses the intraday High, not the close, since that's
    what "52-week high" conventionally means. Falls back to however much
    history is available if there isn't a full year yet."""
    return df["h"].tail(window).max()


def week52_low(df: pd.DataFrame, window: int = 252) -> float:
    """52-week low — uses the intraday Low, same convention as week52_high."""
    return df["l"].tail(window).min()


def avg_volume(series: pd.Series, window: int = 50) -> pd.Series:
    """Rolling average volume."""
    return series.rolling(window=window, min_periods=window).mean()


def trailing_return(series: pd.Series, window: int) -> float | None:
    """Total return over the trailing `window` trading days:
    price[t] / price[t-window] - 1 — not a moving average of daily returns.
    Returns None if there isn't enough history."""
    if len(series) <= window:
        return None
    return series.iloc[-1] / series.iloc[-1 - window] - 1


def pct_off_52w_high(price: float, high: float) -> float:
    """How far below the 52-week high `price` currently is, as a percent
    (0 = at the high, 25 = 25% below it)."""
    return (high - price) / high * 100
