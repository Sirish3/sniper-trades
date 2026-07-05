"""Live data for the screener: price/change/volume via Alpaca (batched
multi-symbol requests), market cap + trailing P/E via Finnhub's
basic-financials endpoint — no yfinance/Yahoo Finance anywhere in this
service. Finnhub is already used elsewhere in this repo for fundamentals
(see src/utils/finnhubApi.js::getFundamentals, same /stock/metric
endpoint), so this mirrors an already-established, official (not scraped)
data source rather than introducing a new one.

Finnhub's free tier is 60 requests/min. This module reuses the daily DB
cache (db.py) so a symbol is only fetched once per day, plus a circuit
breaker that trips on the first 429 and short-circuits every other symbol
in the batch to "unknown" for a cooldown window instead of hammering an
endpoint that's already rate-limiting us.
"""
from __future__ import annotations

import logging
import os
import time

import pandas as pd
import requests
from dotenv import load_dotenv

from db import get_cached_fundamentals, upsert_fundamentals

load_dotenv()

logger = logging.getLogger(__name__)

DATA_URL = os.environ.get("ALPACA_DATA_URL", "https://data.alpaca.markets/v2/stocks")
BATCH_SIZE = 200

FINNHUB_URL = "https://finnhub.io/api/v1"
FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY")
RATE_LIMIT_COOLDOWN_SECONDS = 60
REQUEST_DELAY_SECONDS = 1.1  # free tier is 60/min — stay just under 1 req/sec

_rate_limited_until = 0.0


def _headers() -> dict:
    key_id = os.environ.get("ALPACA_KEY_ID")
    secret = os.environ.get("ALPACA_SECRET_KEY")
    if not key_id or not secret:
        raise RuntimeError("Missing Alpaca credentials — set ALPACA_KEY_ID/ALPACA_SECRET_KEY in stock_screener/.env")
    return {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}


def fetch_price_snapshot(symbols: list[str]) -> dict[str, dict]:
    """{symbol: {price, changePct, volume}} from the last 2 daily bars per
    symbol, fetched in batches via Alpaca's multi-symbol bars endpoint —
    raw (not dividend-adjusted) since this is "what's it trading at right
    now," not a historical return series."""
    result: dict[str, dict] = {}
    end = pd.Timestamp.today()
    start = end - pd.Timedelta(days=10)  # buffer for weekends/holidays — only need the last 2 bars

    for i in range(0, len(symbols), BATCH_SIZE):
        batch = symbols[i:i + BATCH_SIZE]
        page_token = None
        while True:
            params = {
                "symbols": ",".join(batch),
                "timeframe": "1Day",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
                "limit": 1000,
                "feed": "iex",
                "adjustment": "raw",
            }
            if page_token:
                params["page_token"] = page_token

            try:
                response = requests.get(f"{DATA_URL}/bars", headers=_headers(), params=params, timeout=30)
            except requests.RequestException:
                break
            if not response.ok:
                break
            data = response.json()

            for symbol, bars in (data.get("bars") or {}).items():
                if not bars:
                    continue
                last = bars[-1]
                prev = bars[-2] if len(bars) >= 2 else last
                price = last["c"]
                prev_close = prev["c"]
                result[symbol] = {
                    "price": price,
                    "changePct": (price / prev_close - 1) * 100 if prev_close else None,
                    "volume": last["v"],
                }

            page_token = data.get("next_page_token")
            if not page_token:
                break

    return result


def _rate_limit_active() -> bool:
    return time.time() < _rate_limited_until


def _trip_rate_limit_breaker(symbol: str) -> None:
    global _rate_limited_until
    _rate_limited_until = time.time() + RATE_LIMIT_COOLDOWN_SECONDS
    logger.error(
        "Finnhub rate-limited us while fetching %s — backing off for %ds, every other "
        "symbol in this batch will short-circuit to unknown fundamentals until then.",
        symbol, RATE_LIMIT_COOLDOWN_SECONDS,
    )


def _fetch_fundamentals_one(symbol: str) -> dict:
    empty = {"market_cap": None, "pe_ratio": None}
    if not FINNHUB_KEY or _rate_limit_active():
        return empty
    try:
        response = requests.get(
            f"{FINNHUB_URL}/stock/metric",
            params={"symbol": symbol, "metric": "all", "token": FINNHUB_KEY},
            timeout=15,
        )
        if response.status_code == 429:
            _trip_rate_limit_breaker(symbol)
            return empty
        if not response.ok:
            return empty

        metric = response.json().get("metric") or {}
        market_cap = metric.get("marketCapitalization")
        # Finnhub reports market cap in millions of USD.
        market_cap = market_cap * 1e6 if isinstance(market_cap, (int, float)) else None
        pe_ratio = metric.get("peTTM")
        pe_ratio = pe_ratio if isinstance(pe_ratio, (int, float)) else None
        return {"market_cap": market_cap, "pe_ratio": pe_ratio}
    except requests.RequestException:
        logger.warning("Finnhub fundamentals fetch failed for %s", symbol, exc_info=True)
        return empty


def fetch_fundamentals(symbols: list[str]) -> dict[str, dict]:
    """Market cap + P/E per symbol, cached in the DB for the current
    calendar day — only symbols missing today's cache entry actually hit
    Finnhub. A full universe's first scan of the day is slow (hundreds of
    individual requests, ~1/sec to respect the free-tier rate limit);
    every scan after that, same day, is instant."""
    cached = get_cached_fundamentals(symbols)
    missing = [s for s in symbols if s not in cached]

    for symbol in missing:
        if _rate_limit_active():
            break
        time.sleep(REQUEST_DELAY_SECONDS)  # stay under Finnhub's 60/min free-tier limit
        result = _fetch_fundamentals_one(symbol)
        upsert_fundamentals(symbol, result["market_cap"], result["pe_ratio"])
        cached[symbol] = result

    return cached
