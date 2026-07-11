"""Minimal Finnhub REST wrapper — swing_scanner's first Finnhub
integration (everything else in this repo that calls Finnhub does it
browser-side via VITE_FINNHUB_API_KEY, see src/utils/finnhubApi.js; this
is a separate server-side key, FINNHUB_API_KEY, since each service in
this repo owns its own copy of third-party credentials rather than
sharing one across deploy contexts — see CLAUDE.md).

Only wraps the endpoints fair_value.py actually needs. `/stock/price-target`
is deliberately not here — confirmed live (2026-07) that it 403s
("You don't have access to this resource") on the free tier, so there's
nothing to wrap.
"""
from __future__ import annotations

import os

import requests
from dotenv import load_dotenv

load_dotenv()

FINNHUB_URL = "https://finnhub.io/api/v1"


def _api_key() -> str | None:
    return os.environ.get("FINNHUB_API_KEY")


def _get(path: str, params: dict) -> dict | list | None:
    """Returns None on a missing key, a non-200 response, or a network
    error — callers treat None as "unavailable," never raise past this
    point (same "never blocks the whole feature" contract as data.py's
    Alpaca wrapper)."""
    key = _api_key()
    if not key:
        return None
    try:
        response = requests.get(f"{FINNHUB_URL}{path}", params={**params, "token": key}, timeout=15)
    except requests.RequestException:
        return None
    if not response.ok:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def get_financials_reported(symbol: str, freq: str = "annual") -> list[dict]:
    """Full income statement / balance sheet / cash flow statement per
    filing (10-K/10-Q), most recent first. `freq` is "annual" or
    "quarterly". Real SEC EDGAR XBRL data — confirmed live to cover both
    large caps (16 years of AAPL 10-Ks) and thin-coverage names (48
    quarterly filings for SATS, a ticker with otherwise poor earnings-
    calendar coverage — see earnings_calendar.py). Each filing's
    `report` dict has `bs`/`ic`/`cf` lists of {concept, label, unit, value}
    — match on `concept` (a standardized XBRL tag), not `label` (free text
    that varies per filer — confirmed live, e.g. one SATS line item's
    "label" was a full legal definition sentence, not a line-item name).
    Returns [] on any failure, never raises.
    """
    data = _get("/stock/financials-reported", {"symbol": symbol, "freq": freq})
    if not isinstance(data, dict):
        return []
    filings = data.get("data")
    return filings if isinstance(filings, list) else []


def get_recommendation_trend(symbol: str) -> list[dict]:
    """Analyst buy/hold/sell counts per month, most recent first — a
    sentiment signal, not a price. Each entry:
    {symbol, period, strongBuy, buy, hold, sell, strongSell}."""
    data = _get("/stock/recommendation", {"symbol": symbol})
    return data if isinstance(data, list) else []


def get_basic_financials(symbol: str) -> dict:
    """Finnhub's precomputed ratios/metrics (PEG, market cap, 52w high/
    low, beta, margins, etc.) — the browser-side app already reads 3
    fields out of the equivalent call (getFundamentals() in
    finnhubApi.js); this reads the same endpoint server-side for the
    rest of the payload fair_value.py wants. Returns {} on failure."""
    data = _get("/stock/metric", {"symbol": symbol, "metric": "all"})
    if not isinstance(data, dict):
        return {}
    metric = data.get("metric")
    return metric if isinstance(metric, dict) else {}
