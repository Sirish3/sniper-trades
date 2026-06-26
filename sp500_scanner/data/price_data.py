"""Fetches OHLCV price history for S&P 500 tickers via yfinance."""

import time

import pandas as pd
import yfinance as yf

PERIOD = "6mo"
INTERVAL = "1d"
MIN_BARS = 60
FETCH_DELAY = 0.05
RATE_LIMIT_WAIT = 5


def _clean(df):
    """Flatten and normalize a single-ticker frame to lowercase OHLCV columns.

    Returns None if the data is missing, empty, or shorter than MIN_BARS.
    """
    if df is None or df.empty:
        return None

    if isinstance(df.columns, pd.MultiIndex):
        df = df.droplevel(1, axis=1)

    df = df.rename(columns=str.lower)
    df = df.dropna()

    if len(df) < MIN_BARS:
        return None

    return df


def fetch_one(symbol, retried=False):
    """Fetch OHLCV history for a single ticker.

    Retries once after RATE_LIMIT_WAIT seconds if the request fails or
    returns insufficient data. Returns None if the ticker has no usable data.
    """
    try:
        df = yf.download(symbol, period=PERIOD, interval=INTERVAL, progress=False, auto_adjust=True)
    except Exception:
        df = None

    cleaned = _clean(df)
    if cleaned is None and not retried:
        time.sleep(RATE_LIMIT_WAIT)
        return fetch_one(symbol, retried=True)

    return cleaned


def fetch_all(symbols):
    """Fetch OHLCV history for many tickers, batched for speed.

    Returns {symbol: DataFrame}. Symbols with no usable data (fetch failure
    or fewer than MIN_BARS rows) are simply absent from the result — callers
    should treat a missing symbol as "skip, insufficient history".
    """
    try:
        batch = yf.download(symbols, period=PERIOD, interval=INTERVAL, progress=False, group_by="ticker", auto_adjust=True)
    except Exception:
        batch = None

    result = {}

    if batch is not None and not batch.empty and isinstance(batch.columns, pd.MultiIndex):
        for symbol in symbols:
            try:
                df = batch[symbol]
            except KeyError:
                continue
            cleaned = _clean(df)
            if cleaned is not None:
                result[symbol] = cleaned

    # Fall back to individual downloads for anything the batch didn't cover
    # (including everything, if the batch download failed outright).
    for symbol in symbols:
        if symbol in result:
            continue
        df = fetch_one(symbol)
        if df is not None:
            result[symbol] = df
        time.sleep(FETCH_DELAY)

    return result
