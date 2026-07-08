"""Alpaca REST wrapper for the swing scanner. Talks to Alpaca directly via
`requests` (no alpaca-py/alpaca-trade-api SDK dependency) — the same raw
endpoints the React app's src/utils/marketData.js already uses, just from
Python. Every network call is cached to disk under .cache/ so re-running a
scan on the same day doesn't re-hit Alpaca for data that can't have changed.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv()

ASSETS_URL = os.environ.get("ALPACA_BASE_URL", "https://paper-api.alpaca.markets") + "/v2/assets"
DATA_URL = os.environ.get("ALPACA_DATA_URL", "https://data.alpaca.markets/v2/stocks")
CACHE_DIR = Path(__file__).parent / ".cache"
BARS_CACHE_DIR = CACHE_DIR / "bars"

# Alpaca's multi-symbol bars endpoint has a practical URL-length limit —
# batching keeps each request well under it.
MULTI_SYMBOL_BATCH_SIZE = 200

ALLOWED_EXCHANGES = {"NYSE", "NASDAQ"}


def _headers() -> dict:
    key_id = os.environ.get("ALPACA_KEY_ID")
    secret = os.environ.get("ALPACA_SECRET_KEY")
    if not key_id or not secret:
        raise RuntimeError(
            "Missing Alpaca credentials — set ALPACA_KEY_ID and ALPACA_SECRET_KEY "
            "in swing_scanner/.env (see .env.example)."
        )
    return {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}


def _get_with_retry(url: str, params: dict | None = None, max_retries: int = 4) -> requests.Response:
    """GETs `url`, retrying with exponential backoff on 429 (rate limit) and
    5xx (transient server errors) — a full-universe scan makes enough
    requests that hitting Alpaca's rate limit at least once is normal, not
    exceptional."""
    delay = 1.0
    for attempt in range(max_retries):
        try:
            response = requests.get(url, headers=_headers(), params=params, timeout=30)
        except requests.RequestException as exc:
            if attempt == max_retries - 1:
                raise
            time.sleep(delay)
            delay *= 2
            continue

        if response.status_code == 429 or response.status_code >= 500:
            if attempt == max_retries - 1:
                response.raise_for_status()
            retry_after = response.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after else delay)
            delay *= 2
            continue

        return response

    raise RuntimeError(f"Exhausted retries fetching {url}")


def _today_str() -> str:
    return pd.Timestamp.today().strftime("%Y-%m-%d")


def get_raw_asset_list(force_refresh: bool = False) -> list[dict]:
    """All active, tradable NYSE/NASDAQ US-equity assets from Alpaca's
    /v2/assets endpoint — the cheap, one-call step before any price/volume
    filtering. Cached once per day."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"assets_{_today_str()}.json"

    if not force_refresh and cache_file.exists():
        return json.loads(cache_file.read_text())

    response = _get_with_retry(ASSETS_URL, params={"status": "active", "asset_class": "us_equity"})
    response.raise_for_status()
    assets = response.json()

    filtered = [
        a for a in assets
        if a.get("tradable") and a.get("exchange") in ALLOWED_EXCHANGES
    ]
    cache_file.write_text(json.dumps(filtered))
    return filtered


def get_multi_symbol_bars(symbols: list[str], lookback_days: int = 30, feed: str = "iex") -> dict[str, pd.DataFrame]:
    """Batched daily bars for many symbols in a handful of requests (Alpaca's
    /v2/stocks/bars multi-symbol endpoint) — used for the universe
    price/dollar-volume filter, which only needs a short lookback and would
    be needlessly slow one-symbol-at-a-time across thousands of tickers."""
    end = pd.Timestamp.today()
    start = end - pd.Timedelta(days=lookback_days * 2)  # buffer for weekends/holidays

    result: dict[str, pd.DataFrame] = {}
    for i in range(0, len(symbols), MULTI_SYMBOL_BATCH_SIZE):
        batch = symbols[i:i + MULTI_SYMBOL_BATCH_SIZE]
        page_token = None
        while True:
            params = {
                "symbols": ",".join(batch),
                "timeframe": "1Day",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
                "limit": 1000,
                "feed": feed,
                "adjustment": "all",
            }
            if page_token:
                params["page_token"] = page_token

            response = _get_with_retry(f"{DATA_URL}/bars", params=params)
            if not response.ok:
                break  # skip this batch on a hard failure rather than aborting the whole scan
            data = response.json()

            for symbol, bars in (data.get("bars") or {}).items():
                if not bars:
                    continue
                df = pd.DataFrame(bars)
                df["t"] = pd.to_datetime(df["t"])
                df = df.set_index("t").rename(columns={"o": "o", "h": "h", "l": "l", "c": "c", "v": "v"})
                result[symbol] = pd.concat([result[symbol], df]) if symbol in result else df

            page_token = data.get("next_page_token")
            if not page_token:
                break

    return result


def get_daily_bars(symbol: str, lookback_days: int = 400, feed: str = "iex", use_cache: bool = True) -> pd.DataFrame | None:
    """Full daily OHLCV history for one symbol, paginated past Alpaca's
    1000-bars-per-request cap, split+dividend adjusted. Cached per symbol
    per day — returns None (rather than raising) on missing data so one bad
    ticker never aborts a full-universe scan."""
    BARS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = BARS_CACHE_DIR / f"{symbol}_{_today_str()}.parquet"

    if use_cache and cache_file.exists():
        try:
            return pd.read_parquet(cache_file)
        except Exception:
            pass  # fall through and refetch if the cached file is somehow corrupt

    end = pd.Timestamp.today()
    start = end - pd.Timedelta(days=lookback_days)

    bars = []
    page_token = None
    try:
        while True:
            params = {
                "timeframe": "1Day",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
                "limit": 1000,
                "feed": feed,
                "adjustment": "all",
            }
            if page_token:
                params["page_token"] = page_token

            response = _get_with_retry(f"{DATA_URL}/{symbol}/bars", params=params)
            if not response.ok:
                logger.error(
                    "Alpaca returned %s fetching bars for %s: %s",
                    response.status_code, symbol, response.text[:300],
                )
                return None
            data = response.json()
            bars.extend(data.get("bars") or [])
            page_token = data.get("next_page_token")
            if not page_token:
                break
    except requests.RequestException:
        return None
    except RuntimeError:
        # _headers() raises this when ALPACA_KEY_ID/ALPACA_SECRET_KEY aren't
        # set — worth logging loudly (it's a config problem, not a bad
        # ticker) but callers rely on None, never an exception, to turn
        # into a clean 404 instead of a 500.
        logger.error("Alpaca credentials missing or invalid — cannot fetch bars for %s", symbol)
        return None

    if not bars:
        return None

    df = pd.DataFrame(bars)
    df["t"] = pd.to_datetime(df["t"])
    df = df.set_index("t")[["o", "h", "l", "c", "v"]]

    if use_cache:
        df.to_parquet(cache_file)
    return df


def bars_df_to_candles(df: pd.DataFrame, days: int | None = None) -> list[dict]:
    """Converts a get_daily_bars() DataFrame (o/h/l/c/v columns, indexed by
    date) into the {date, open, high, low, close, volume} dict shape both
    api.py's candle routes and pattern_detector.py (via
    from_alpaca_json.py) consume — one conversion, reused everywhere
    instead of each caller re-deriving it."""
    rows = df.tail(days) if days else df
    return [
        {
            "date": date.strftime("%Y-%m-%d"),
            "open": round(float(row["o"]), 2),
            "high": round(float(row["h"]), 2),
            "low": round(float(row["l"]), 2),
            "close": round(float(row["c"]), 2),
            "volume": int(row["v"]),
        }
        for date, row in rows.iterrows()
    ]


def get_tradable_universe(
    min_price: float = 10.0,
    min_dollar_volume: float = 10_000_000.0,
    force_refresh: bool = False,
) -> list[str]:
    """The final scannable universe: active/tradable NYSE+NASDAQ equities,
    price > min_price, 20-day average dollar volume > min_dollar_volume.
    Cached once per day (the whole point is not rebuilding this on every
    scan run within the same trading day)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"universe_{_today_str()}.json"

    if not force_refresh and cache_file.exists():
        return json.loads(cache_file.read_text())

    assets = get_raw_asset_list(force_refresh=force_refresh)
    symbols = [a["symbol"] for a in assets]

    bars_by_symbol = get_multi_symbol_bars(symbols, lookback_days=20)

    qualifying = []
    for symbol, df in bars_by_symbol.items():
        if len(df) < 15:  # not enough recent history to trust the average
            continue
        recent = df.tail(20)
        avg_price = recent["c"].mean()
        avg_dollar_volume = (recent["c"] * recent["v"]).mean()
        if avg_price > min_price and avg_dollar_volume > min_dollar_volume:
            qualifying.append(symbol)

    qualifying.sort()
    cache_file.write_text(json.dumps(qualifying))
    return qualifying
