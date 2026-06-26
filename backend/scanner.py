"""Breakout and retest scanning against the ticker universe."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import yfinance as yf

from config import ALL_ETFS, PERMANENT_WATCHLIST, SECTOR_ETF, UNIVERSE, VOL_MIN
from indicators import atr, rsi
from utils import yf_symbol

logger = logging.getLogger(__name__)

HIGH_LOOKBACK = 252
RSI_MAX_ENTRY = 75
EXTENSION_CAP_PCT = 1.07
RETEST_BAND_PCT = 0.03  # within 3% of the prior high counts as a retest pullback
MAX_WORKERS = 6  # spec cap: never exceed 8 concurrent yfinance requests

_SYMBOL_TO_SECTOR = {c["symbol"]: c.get("sector") for c in UNIVERSE}


def _scan_universe_symbols() -> list[str]:
    symbols = [c["symbol"] for c in UNIVERSE]
    return list(dict.fromkeys([*symbols, *PERMANENT_WATCHLIST]))


def _fetch_history(symbol: str) -> pd.DataFrame | None:
    """One ticker's ~14mo daily OHLCV, or None if unavailable/too short."""
    try:
        df = yf.Ticker(yf_symbol(symbol)).history(period="14mo")
        if len(df) < HIGH_LOOKBACK + 5:
            return None
        return df
    except Exception as exc:
        logger.warning("scanner: history fetch failed for %s (%s)", symbol, exc)
        return None


def compute_etf_heat() -> dict[str, str]:
    """HOT (within 3% of its own 52w high) / WARM (3-8%) / COLD per sector ETF."""
    heat: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_fetch_history, etf): etf for etf in ALL_ETFS}
        for future in as_completed(futures):
            etf = futures[future]
            df = future.result()
            if df is None:
                continue
            closes = df["Close"]
            high_52w = float(closes.tail(HIGH_LOOKBACK).max())
            pct_from_high = (float(closes.iloc[-1]) - high_52w) / high_52w * 100
            if pct_from_high >= -3:
                heat[etf] = "HOT"
            elif pct_from_high >= -8:
                heat[etf] = "WARM"
            else:
                heat[etf] = "COLD"
    return heat


def _evaluate_breakout(symbol: str, df: pd.DataFrame) -> dict | None:
    closes = df["Close"]
    volumes = df["Volume"]
    close = float(closes.iloc[-1])

    prior_high = float(closes.iloc[-HIGH_LOOKBACK - 1 : -1].max())
    if prior_high <= 0:
        return None
    vol_avg50 = float(volumes.tail(50).mean())
    vol_ratio = float(volumes.iloc[-1] / vol_avg50) if vol_avg50 else 0.0
    rsi_value = float(rsi(closes, 14).iloc[-1])
    atr14 = float(atr(df, 14).iloc[-1])

    breakout = close > prior_high
    vol_ok = vol_ratio >= VOL_MIN
    not_overbought = rsi_value <= RSI_MAX_ENTRY
    not_extended = close <= prior_high * EXTENSION_CAP_PCT

    if not (breakout and vol_ok and not_overbought and not_extended):
        return None

    sector = _SYMBOL_TO_SECTOR.get(symbol)
    return {
        "ticker": symbol,
        "price": close,
        "pivot": prior_high,
        "vol_ratio": vol_ratio,
        "rsi": rsi_value,
        "atr": atr14,
        "pct_from_high": (close - prior_high) / prior_high * 100,
        "sector": sector,
        "sector_etf": SECTOR_ETF.get(sector),
    }


def scan_breakouts(intraday: bool = True, etf_cache: dict[str, str] | None = None, regime: str = "RISK_NEUTRAL") -> list[dict]:
    """Scans the universe for fresh 52-week-high breakouts with volume confirmation."""
    symbols = _scan_universe_symbols()
    signals: list[dict] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_fetch_history, s): s for s in symbols}
        for future in as_completed(futures):
            symbol = futures[future]
            df = future.result()
            if df is None:
                continue
            sig = _evaluate_breakout(symbol, df)
            if sig is None:
                continue
            if etf_cache and etf_cache.get(sig.get("sector_etf")) == "COLD":
                continue
            sig["regime"] = regime
            signals.append(sig)

    signals.sort(key=lambda s: s["vol_ratio"], reverse=True)
    logger.info("scan_breakouts: %d candidates from %d symbols", len(signals), len(symbols))
    return signals


def _evaluate_retest(symbol: str, df: pd.DataFrame) -> dict | None:
    closes = df["Close"]
    volumes = df["Volume"]
    close = float(closes.iloc[-1])

    prior_high = float(closes.iloc[-HIGH_LOOKBACK - 1 : -1].max())
    if prior_high <= 0:
        return None

    pct_from_high = (close - prior_high) / prior_high
    broke_out_recently = float(closes.iloc[-30:].max()) > prior_high
    near_pivot = -RETEST_BAND_PCT <= pct_from_high <= 0.01
    vol_avg50 = float(volumes.tail(50).mean())
    light_volume = bool(vol_avg50) and float(volumes.iloc[-1]) < vol_avg50

    if not (broke_out_recently and near_pivot and light_volume):
        return None

    rsi_value = float(rsi(closes, 14).iloc[-1])
    atr14 = float(atr(df, 14).iloc[-1])
    vol_ratio = float(volumes.iloc[-1] / vol_avg50) if vol_avg50 else 0.0
    sector = _SYMBOL_TO_SECTOR.get(symbol)

    return {
        "ticker": symbol,
        "price": close,
        "pivot": prior_high,
        "vol_ratio": vol_ratio,
        "rsi": rsi_value,
        "atr": atr14,
        "pct_from_high": pct_from_high * 100,
        "sector": sector,
        "sector_etf": SECTOR_ETF.get(sector),
    }


def scan_retests() -> list[dict]:
    """Scans for pullbacks to a prior breakout pivot on light volume."""
    symbols = _scan_universe_symbols()
    signals: list[dict] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_fetch_history, s): s for s in symbols}
        for future in as_completed(futures):
            symbol = futures[future]
            df = future.result()
            if df is None:
                continue
            sig = _evaluate_retest(symbol, df)
            if sig is not None:
                signals.append(sig)

    logger.info("scan_retests: %d candidates from %d symbols", len(signals), len(symbols))
    return signals
