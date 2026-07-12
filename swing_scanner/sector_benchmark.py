"""Sector-peer multiple benchmarking for fair_value.py's Method A
(sector-relative fair value). Scrapes Finviz's snapshot table for every
constituent in a sector (sector_universe.py) and computes the median of
each multiple across that peer group — median, not mean, since multiples
are right-skewed and a couple of extreme outliers (a 300x P/E name) would
distort a mean badly.

Caches the RAW per-peer values (not the final median) to disk, keyed by
sector, with a daily TTL — same caching convention as
earnings_calendar.py/economic_calendar.py. Caching raw values rather than
a precomputed median matters: multiple different tickers in the same
sector each need the median EXCLUDING THEMSELVES specifically, and
excluding one ticker out of a group and recomputing a median is a cheap
in-memory filter+sort over already-fetched data — it doesn't require a
second scrape.

Confirmed live: the largest S&P 500 + Nasdaq 100 sector (Information
Technology, ~80 constituents after the two indices are unioned) takes
60-80+ seconds to scrape in full at the same 0.75s/request pacing
earnings_calendar.py already uses to stay polite to Finviz — which blows
straight through Render's ~30s request timeout on a cold cache (confirmed
live: a real 500 at exactly 30.4s). Peer scraping is capped to
MAX_PEERS_TO_SCRAPE per sector for this reason, not for Finviz-politeness
— a full sector isn't actually reachable within one request's time
budget, however many peers this app is theoretically entitled to scrape.
That capped cost is paid once per sector per cache TTL, not once per
ticker lookup.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from statistics import median

from finviz_snapshot import fetch_snapshot
from sector_universe import get_sector_peers

CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR_SECTORS = CACHE_DIR / "sector_benchmarks"
CACHE_TTL_SECONDS = 20 * 60 * 60  # ~daily, matches earnings_calendar.py — multiples don't move intraday enough to matter
REQUEST_DELAY_SECONDS = 0.75      # same Finviz-politeness pacing as earnings_calendar.py

MIN_PEERS_FOR_CONFIDENCE = 8  # below this (after excluding missing-data peers), flag LOW_CONFIDENCE_PEER_GROUP
MAX_PEERS_TO_SCRAPE = 10      # confirmed live: a full-sector cold scrape (Information Technology, 81 peers)
                               # took 60-80s, but Render's request timeout is a hard 30s (confirmed live via a
                               # real 500 at exactly 30.4s). Also confirmed live that per-peer scrape cost runs
                               # closer to ~1.7s (network + REQUEST_DELAY_SECONDS), not the ~0.85s a first pass
                               # assumed — 15 peers alone ate 25.4s, leaving no room for the rest of the
                               # request (Alpaca + Finnhub + the target ticker's own Finviz fetch). 10 peers
                               # (~17s scrape) leaves real headroom while staying just above
                               # MIN_PEERS_FOR_CONFIDENCE even if one or two fail to scrape.

# Finviz snapshot label -> the numeric field name we compute medians for.
MULTIPLE_FIELDS = {
    "P/E": "peTrailing",
    "P/B": "priceToBook",
    "P/S": "priceToSales",
    "P/FCF": "priceToFcf",
    "EV/EBITDA": "evToEbitda",
    "ROE": "roe",
}


def _num(value: str) -> float | None:
    if not value or value in ("-", "N/A"):
        return None
    try:
        return float(value.replace("%", "").replace(",", ""))
    except ValueError:
        return None


def _cache_file(sector: str) -> Path:
    safe_name = sector.replace(" ", "_").replace("/", "-")
    return CACHE_DIR_SECTORS / f"{safe_name}.json"


def _load_cached(sector: str) -> list[dict] | None:
    path = _cache_file(sector)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("cached_at", 0) > CACHE_TTL_SECONDS:
        return None
    return payload["peers"]


def _save_cache(sector: str, peers: list[dict]) -> None:
    CACHE_DIR_SECTORS.mkdir(parents=True, exist_ok=True)
    _cache_file(sector).write_text(json.dumps({"cached_at": time.time(), "peers": peers}))


def _fetch_sector_raw(sector: str) -> list[dict]:
    """Every constituent's raw multiples for `sector`, freshly scraped.
    One bad peer (fetch failure, missing fields) doesn't drop it from the
    list — it's kept with whatever fields did resolve, None for the rest,
    so it can still contribute to multiples it does have data for."""
    tickers = get_sector_peers(sector)[:MAX_PEERS_TO_SCRAPE]
    peers = []
    for i, ticker in enumerate(tickers):
        if i > 0:
            time.sleep(REQUEST_DELAY_SECONDS)
        snapshot = fetch_snapshot(ticker)
        peers.append({
            "symbol": ticker,
            **{field: _num(snapshot.get(label, "")) for label, field in MULTIPLE_FIELDS.items()},
        })
    return peers


def get_sector_peer_data(sector: str, force_refresh: bool = False) -> list[dict]:
    """Raw per-peer multiples for every constituent of `sector`, cached
    ~daily. Callers filter out the target ticker and any peer missing the
    specific field they need before computing a median — see
    compute_sector_medians below."""
    if not force_refresh:
        cached = _load_cached(sector)
        if cached is not None:
            return cached

    peers = _fetch_sector_raw(sector)
    _save_cache(sector, peers)
    return peers


def compute_sector_medians(peer_data: list[dict], exclude_ticker: str | None = None) -> dict:
    """Median of each multiple across `peer_data`, excluding
    `exclude_ticker` (the target stock — never a peer of itself) and, per
    multiple, excluding any peer with no usable value for that specific
    field (a peer missing P/B shouldn't count toward P/B's sample size).
    Returns {field: {"median": float | None, "peerCount": int}}."""
    exclude = exclude_ticker.upper() if exclude_ticker else None
    eligible = [p for p in peer_data if p["symbol"] != exclude]

    result = {}
    for field in MULTIPLE_FIELDS.values():
        values = [p[field] for p in eligible if p.get(field) is not None]
        result[field] = {
            "median": round(median(values), 2) if values else None,
            "peerCount": len(values),
        }
    return result
