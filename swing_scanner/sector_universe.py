"""S&P 500 / Nasdaq 100 ticker -> GICS sector lookup, for fair_value.py's
sector-peer benchmarking. Mirrors backend/config.py's exact pattern:
data/*.json is a static export of the React app's src/data/sp500.js /
nasdaq100.js (see backend/data/export_universe.mjs, which now writes here
too) — a snapshot refreshed by rerunning that script, not a live fetch.
Each Python service in this repo keeps its own copy rather than reading
across service directories, since they deploy as separate Docker builds
with separate root contexts (swing_scanner's build would never see
backend/data/ at all).

Sector labels are the real GICS strings Wikipedia's table uses, confirmed
live: "Health Care" (two words, not "Healthcare"), "Information
Technology" (not "Technology"), "Real Estate" (not "Real Estate/REITs").
"""
from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"


def _load_json(filename: str) -> list[dict]:
    path = DATA_DIR / filename
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


SP500: list[dict] = _load_json("sp500.json")
NASDAQ100: list[dict] = _load_json("nasdaq100.json")

# Union by symbol (a stock can be in both indices) — sector lookup only
# needs one entry per symbol, first one wins (S&P 500 checked first).
_BY_SYMBOL: dict[str, dict] = {c["symbol"]: c for c in [*NASDAQ100, *SP500]}


def get_sector(ticker: str) -> str | None:
    entry = _BY_SYMBOL.get(ticker.upper())
    return entry["sector"] if entry else None


def get_sector_peers(sector: str, exclude: str | None = None) -> list[str]:
    """Every S&P 500 / Nasdaq 100 constituent in `sector`, excluding
    `exclude` (typically the target ticker itself) if given."""
    exclude = exclude.upper() if exclude else None
    return [
        symbol for symbol, entry in _BY_SYMBOL.items()
        if entry["sector"] == sector and symbol != exclude
    ]
