"""Syncs the S&P 500 / Nasdaq 100 membership lists from Wikipedia (the
"Refresh" button's actual job — re-pull current index membership, not just
reload a static snapshot). Falls back to this repo's existing static
ticker files (backend/data/sp500.json, nasdaq100.json — the same files
the main React app uses) if the live scrape fails, so a Wikipedia layout
change or a network hiccup doesn't leave the screener with an empty
universe.
"""
from __future__ import annotations

import json
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
NASDAQ100_URL = "https://en.wikipedia.org/wiki/Nasdaq-100"

# Wikipedia blocks the default python-requests User-Agent on some routes.
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; swing-trade-scanner/1.0)"}

STATIC_FALLBACK = {
    "sp500": Path(__file__).parent.parent / "backend" / "data" / "sp500.json",
    "nasdaq100": Path(__file__).parent.parent / "backend" / "data" / "nasdaq100.json",
}


def _find_ticker_table(tables: list[pd.DataFrame]) -> pd.DataFrame:
    """Wikipedia pages have many tables (infoboxes, footers, etc.) — finds
    the one that actually looks like a ticker list: a column named
    Symbol/Ticker plus a column that looks like a company name."""
    for table in tables:
        cols_lower = [str(c).strip().lower() for c in table.columns]
        has_ticker_col = any(c in ("symbol", "ticker") for c in cols_lower)
        has_name_col = any(c in ("security", "company", "company name") for c in cols_lower)
        if has_ticker_col and has_name_col:
            return table
    raise ValueError("Could not find a ticker/company table on the page")


def _normalize(table: pd.DataFrame) -> list[dict]:
    cols = {str(c).strip().lower(): c for c in table.columns}
    ticker_col = cols.get("symbol") or cols.get("ticker")
    name_col = cols.get("security") or cols.get("company") or cols.get("company name")
    sector_col = next((cols[c] for c in cols if "sector" in c), None)

    tickers = []
    for _, row in table.iterrows():
        symbol = str(row[ticker_col]).strip().upper().replace(".", "-")  # BRK.B -> BRK-B, Alpaca/Yahoo convention
        if not symbol or symbol == "NAN":
            continue
        tickers.append({
            "symbol": symbol,
            "name": str(row[name_col]).strip() if name_col else symbol,
            "sector": str(row[sector_col]).strip() if sector_col else None,
        })
    return tickers


def _scrape(url: str) -> list[dict]:
    response = requests.get(url, headers=HEADERS, timeout=15)
    response.raise_for_status()
    tables = pd.read_html(StringIO(response.text))
    table = _find_ticker_table(tables)
    return _normalize(table)


def load_static_fallback(universe: str) -> list[dict]:
    path = STATIC_FALLBACK[universe]
    data = json.loads(path.read_text())
    return [{"symbol": t["symbol"], "name": t.get("name"), "sector": t.get("sector")} for t in data]


def sync_universe(universe: str) -> tuple[list[dict], str]:
    """Returns (tickers, source) where source is "wikipedia" or "static
    fallback" — the caller (api.py) surfaces this so the UI can tell the
    user when a refresh silently fell back to the stale snapshot."""
    url = {"sp500": SP500_URL, "nasdaq100": NASDAQ100_URL}.get(universe)
    if url is None:
        raise ValueError(f"No live source configured for universe {universe!r}")

    try:
        tickers = _scrape(url)
        if len(tickers) < 50:  # sanity check — a parse that "succeeded" but found the wrong table
            raise ValueError(f"Only parsed {len(tickers)} tickers, suspiciously low — treating as a failed scrape")
        return tickers, "wikipedia"
    except Exception:
        return load_static_fallback(universe), "static fallback"
