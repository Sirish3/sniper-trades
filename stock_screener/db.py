"""Postgres (Neon) storage for the stock screener — ticker universes
(S&P 500, Nasdaq 100, and a user-managed custom list) plus a daily
fundamentals cache (market cap, P/E — slow to fetch, so cached rather
than refetched on every screen).

Uses the SAME Neon database as backend/ (see backend/database.py) — no
local SQLite anywhere in this repo. Tables are prefixed `screener_` to
avoid colliding with backend/'s tables (signals, positions, trades,
alerts_log, portfolio_snapshots, users) living in the same database.
Dates are compared via Postgres's own CURRENT_DATE rather than a
Python-computed date, so the "cached today" check always agrees with the
database server's clock.
"""
from __future__ import annotations

import os

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is required (Postgres/Neon) — set it in stock_screener/.env. No local SQLite fallback."
    )


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def init_db() -> None:
    conn = get_connection()
    with conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS screener_tickers (
                universe TEXT NOT NULL,     -- 'sp500' | 'nasdaq100' | 'custom'
                symbol TEXT NOT NULL,
                name TEXT,
                sector TEXT,
                added_at DATE NOT NULL,
                PRIMARY KEY (universe, symbol)
            );

            CREATE TABLE IF NOT EXISTS screener_fundamentals_cache (
                symbol TEXT PRIMARY KEY,
                market_cap DOUBLE PRECISION,
                pe_ratio DOUBLE PRECISION,
                updated_at DATE NOT NULL   -- refetched once per calendar day
            );
        """)
    conn.close()


def get_universe(universe: str) -> list[dict]:
    conn = get_connection()
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT symbol, name, sector FROM screener_tickers WHERE universe = %s ORDER BY symbol",
            (universe,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def replace_universe(universe: str, tickers: list[dict]) -> int:
    """Wipes and re-inserts an entire universe (used by refresh) — the
    membership list should exactly match the source, including removals,
    not just additions."""
    conn = get_connection()
    with conn, conn.cursor() as cur:
        cur.execute("DELETE FROM screener_tickers WHERE universe = %s", (universe,))
        if tickers:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO screener_tickers (universe, symbol, name, sector, added_at) VALUES %s",
                [(universe, t["symbol"], t.get("name"), t.get("sector")) for t in tickers],
                template="(%s, %s, %s, %s, CURRENT_DATE)",
            )
    conn.close()
    return len(tickers)


def add_custom_ticker(symbol: str, name: str | None, sector: str | None) -> None:
    conn = get_connection()
    with conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO screener_tickers (universe, symbol, name, sector, added_at)
            VALUES ('custom', %s, %s, %s, CURRENT_DATE)
            ON CONFLICT (universe, symbol) DO UPDATE
                SET name = EXCLUDED.name, sector = EXCLUDED.sector, added_at = EXCLUDED.added_at
            """,
            (symbol.upper(), name, sector),
        )
    conn.close()


def remove_custom_ticker(symbol: str) -> None:
    conn = get_connection()
    with conn, conn.cursor() as cur:
        cur.execute("DELETE FROM screener_tickers WHERE universe = 'custom' AND symbol = %s", (symbol.upper(),))
    conn.close()


def get_cached_fundamentals(symbols: list[str]) -> dict[str, dict]:
    """Returns cached fundamentals for `symbols` last updated today (server
    clock) — stale (older than today) or missing entries are simply absent
    from the result, so callers know which symbols still need a live
    fetch."""
    if not symbols:
        return {}
    conn = get_connection()
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT symbol, market_cap, pe_ratio FROM screener_fundamentals_cache "
            "WHERE updated_at = CURRENT_DATE AND symbol = ANY(%s)",
            (symbols,),
        )
        rows = cur.fetchall()
    conn.close()
    return {r["symbol"]: {"market_cap": r["market_cap"], "pe_ratio": r["pe_ratio"]} for r in rows}


def upsert_fundamentals(symbol: str, market_cap: float | None, pe_ratio: float | None) -> None:
    conn = get_connection()
    with conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO screener_fundamentals_cache (symbol, market_cap, pe_ratio, updated_at)
            VALUES (%s, %s, %s, CURRENT_DATE)
            ON CONFLICT (symbol) DO UPDATE
                SET market_cap = EXCLUDED.market_cap, pe_ratio = EXCLUDED.pe_ratio, updated_at = EXCLUDED.updated_at
            """,
            (symbol, market_cap, pe_ratio),
        )
    conn.close()


init_db()
