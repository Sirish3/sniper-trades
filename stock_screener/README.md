# Stock Screener

A Finviz-style screener: pick a universe (S&P 500, Nasdaq 100, or your own
custom list), click Run Screen, get a sortable/filterable table of live
price, change %, volume, market cap, and P/E.

## Setup

```bash
cd stock_screener
python -m venv venv
venv\Scripts\activate        # Windows; `source venv/bin/activate` on Mac/Linux
pip install -r requirements.txt
```

`.env` already has this project's Alpaca + Finnhub keys, plus `DATABASE_URL`
(the same Neon Postgres instance `backend/` uses) copied in — see
`.env.example` for the format. **No local database** — `DATABASE_URL` is
required and there's no SQLite fallback.

## Run it

```bash
python api.py    # Flask API on :8004, proxied by Vite's /stock-screener-api rule
```

Then `npm run dev:all` in the repo root (or `npm run dev:screener` to run
just this service alongside a separately-started `npm run dev`) and open
the "Screener" tab.

## Code structure

- `db.py` — Postgres storage, the same Neon database `backend/` uses
  (`screener_tickers`, one row per symbol per universe, and a daily
  `screener_fundamentals_cache` — prefixed `screener_` to avoid colliding
  with `backend/`'s tables in that same database).
- `universe_sync.py` — the **Refresh** button's actual logic: scrapes
  Wikipedia's live S&P 500 / Nasdaq-100 membership tables via
  `pandas.read_html`, falling back to this repo's existing static
  snapshots (`backend/data/sp500.json` / `nasdaq100.json` — the same files
  the main React app's `src/data/sp500.js` / `nasdaq100.js` export to) if
  the live scrape fails or returns something implausible.
- `data.py` — live price/change/volume via Alpaca's batched multi-symbol
  bars endpoint, and market cap/P/E via **Finnhub's `/stock/metric`
  endpoint** (no yfinance/Yahoo Finance anywhere in this service — Finnhub
  is already used elsewhere in this repo for the same kind of data, see
  `src/utils/finnhubApi.js::getFundamentals`). Cached per symbol per day,
  with a rate-limit circuit breaker (Finnhub's free tier is 60
  requests/min) so one 429 doesn't cascade into stalling the whole screen.
- `api.py` — Flask API: universe listing/refresh, custom-list add/remove,
  and the screen endpoint itself.

## API

- `GET /api/universe/<sp500|nasdaq100|custom>` — current ticker list
  (auto-seeds sp500/nasdaq100 from the static snapshot on first use).
- `POST /api/universe/<sp500|nasdaq100>/refresh` — re-syncs from Wikipedia.
- `POST /api/universe/custom/add` `{symbol}` / `.../remove` `{symbol}`.
- `POST /api/screen` `{universe}` — the actual data pull. **First run of
  the day for a large universe is slow** (hundreds of individual Finnhub
  requests for market cap/P/E, ~1.1s apart to stay under the free tier's
  60/min limit) — S&P 500's 503 tickers cold would take roughly 9-10
  minutes; every run after that, same day, is near-instant (cached).

## Known assumptions

1. **"Current price"** is the latest daily bar's close (raw, not
   dividend-adjusted) from Alpaca — consistent with how every other
   service in this repo treats "current price."
2. **Custom-list entries don't get a sector** unless you provide one (the
   add endpoint accepts an optional `sector` field, but the React UI's
   quick-add box only asks for the ticker) — those rows show "—" in the
   Sector column and won't match a sector filter.
3. **Refresh only touches ticker membership**, not price/fundamental data
   — Run Screen always pulls a fresh snapshot (modulo the daily
   fundamentals cache) regardless of when you last refreshed the list.
