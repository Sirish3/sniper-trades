"""Central config: env vars, constants, and the ticker universe.

Universe and ETF lists are loaded from backend/data/*.json, which are
exported from the React app's src/data/*.js files (run
`node backend/data/export_universe.mjs` to refresh) — kept as one source
of truth instead of hand-duplicating tickers in Python.
"""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"


def _load_json(filename: str) -> list[dict]:
    """Loads a JSON ticker list exported from the React app's data files."""
    path = DATA_DIR / filename
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


SP500: list[dict] = _load_json("sp500.json")
NASDAQ100: list[dict] = _load_json("nasdaq100.json")
ETFS_AND_METALS: list[dict] = _load_json("etfs.json")
ALL_ETFS: list[str] = [e["symbol"] for e in ETFS_AND_METALS]

# Default scan universe: the union of S&P 500 + Nasdaq-100 symbols.
_UNIVERSE_MAP = {c["symbol"]: c for c in [*SP500, *NASDAQ100]}
UNIVERSE: list[dict] = list(_UNIVERSE_MAP.values())

# GICS sector -> SPDR sector ETF, ported from src/utils/sectorRegime.js's
# SECTOR_ETF so both apps agree on the mapping.
SECTOR_ETF: dict[str, str] = {
    "Communication Services": "XLC",
    "Consumer Discretionary": "XLY",
    "Consumer Staples": "XLP",
    "Energy": "XLE",
    "Financials": "XLF",
    "Health Care": "XLV",
    "Industrials": "XLI",
    "Information Technology": "XLK",
    "Materials": "XLB",
    "Real Estate": "XLRE",
    "Utilities": "XLU",
}

# A small set of tickers always included in the scan regardless of index
# membership (e.g. tickers you personally watch closely). Empty by default
# — add symbols as plain strings.
PERMANENT_WATCHLIST: list[str] = []

# ── Strategy constants ──────────────────────────────────────────────────
ATR_MULT = 2.5
VOL_MIN = 1.5
PORTFOLIO_SIZE = float(os.environ.get("PORTFOLIO_SIZE", "100000"))
RISK_PCT = 0.015

# ── FOMC decision dates ──────────────────────────────────────────────────
# IMPORTANT: these must be the actual FOMC *decision* day (second day of
# each two-day meeting), kept current from the Fed's official calendar:
# https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
# This list is intentionally left for you to fill in/verify — guessing
# wrong dates here would silently disable or fail to disable entry
# signals on the wrong days, which is worse than an empty list that's
# obviously incomplete. Format: 'YYYY-MM-DD'.
FOMC_DATES: list[str] = []

# ── Database ──────────────────────────────────────────────────────────────
# `.env`/.env.example declare DATABASE_URL= with a blank value (meant to
# be optional) — os.environ.get(key, default) only falls back when the
# key is *absent*, not when it's present-but-empty, so a blank .env line
# would otherwise resolve to "" and break create_engine(). `or` handles both.
DATABASE_URL = os.environ.get("DATABASE_URL") or f"sqlite:///{BASE_DIR / 'data' / 'scheduler.db'}"

# ── Alerts (Resend HTTP API) ──────────────────────────────────────────────
# Twilio SMS was tried first and dropped: the only number on the account
# was toll-free and required Toll-Free Verification (carrier-side
# delivery failure, error 30032) before it could deliver anything — a
# multi-day-to-multi-week review process.
# Gmail SMTP was tried second and dropped: Render blocks outbound SMTP
# (ports 25/465/587) on all plans as an anti-spam measure, so smtplib
# connections fail with "[Errno 101] Network is unreachable" no matter
# how correct the credentials are — confirmed live via Render's logs.
# Resend's HTTP API (port 443, never blocked) replaces it.
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
# Resend's shared sandbox sender — only deliverable to the email that
# owns the Resend account unless/until a custom domain is verified there.
# `or`, not get(key, default) — same present-but-empty gotcha as
# DATABASE_URL above: a blank RESEND_FROM_EMAIL= in Render's dashboard
# resolves to "" (not absent), which would send an invalid "from" address.
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL") or "onboarding@resend.dev"
ALERT_TO_EMAIL = os.environ.get("ALERT_TO_EMAIL", "")

# ── Scheduler ─────────────────────────────────────────────────────────────
TIMEZONE = "US/Eastern"
