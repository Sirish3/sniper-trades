# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Not one app — a React/Vite frontend plus **three independently-deployed Python
backends**, each with its own dependencies, its own `.env`, and (mostly) its
own Postgres tables in one shared Neon instance. There is no shared code
between the Python services; each owns its own `database.py` /
SQLAlchemy `Base` rather than importing across service boundaries, because
they deploy and scale independently.

| Piece | Path | Deploys to | Purpose |
|---|---|---|---|
| Frontend | `src/` | Cloudflare Pages (`stockpilot.cc`) | React app, all tabs |
| Swing scanner API | `swing_scanner/` | Render (`sniper-trades`) | Scanner, Economic Calendar, Earnings, Chart Patterns |
| Execution scheduler | `backend/` | Render (`sniper-trades-scheduler`) | 52w-high breakout scans + email alerts, 3x/day cron |
| Users API | `users_api/` | not deployed anywhere yet | Bare FastAPI CRUD prototype, **no auth**, unrelated to the rest |
| Legacy, don't touch without asking | `server/`, `sp500_scanner/` | not deployed | Orphaned Node scanner backend and an earlier standalone Python CLI scanner, both superseded |

## Commands

**Frontend** (repo root):
```bash
npm run dev            # Vite dev server only
npm run dev:swing      # swing_scanner/api.py only (Windows venv path hardcoded)
npm run dev:all        # both, concurrently — needed for Scanner/Economic Calendar/Earnings/Chart Patterns tabs to work locally
npm run build
npm run lint
npm test               # vitest run — all tests, once
npx vitest run src/utils/indicators.test.js   # a single test file
```

**swing_scanner/** (Flask, port 8003):
```bash
cd swing_scanner
venv\Scripts\activate        # Windows; source venv/bin/activate elsewhere
pip install -r requirements.txt
python api.py                 # Flask API, backs the React tabs above
streamlit run app.py          # standalone Streamlit UI, same pipeline.py
python test_pipeline.py       # CLI smoke test, no Streamlit
```

**backend/** (execution scheduler, Flask + APScheduler, port 8000):
```bash
cd backend
venv\Scripts\activate
pip install -r requirements.txt
python app.py           # status page + in-process scheduler
python scheduler.py     # scheduler only, no web page
node data/export_universe.mjs   # regenerate data/*.json from src/data/*.js after ticker list changes
```

No Python interpreter is on PATH bare — always go through the relevant
service's own `venv\Scripts\python.exe` (e.g.
`backend/venv/Scripts/python.exe`), not a system `python`/`py`.

## Frontend architecture

**No router.** `src/App.jsx` holds one `activeTab` state and switches
between tab components — there is no `react-router-dom` in this repo and no
deep-linking. New pages get added as another tab (and, if admin-only, a
button in `header-actions` that sets `activeTab` to a value not listed in
the visible `tab-nav`), not a new route.

**Two ways JS calls out to Python**, both baked in at Vite **build** time via
`import.meta.env`:
- `VITE_SWING_SCANNER_API_URL` — used by `SwingScanner.jsx`,
  `EconomicCalendar.jsx`, `EarningsCalendar.jsx`, and
  `utils/chartSetupsApi.js`. Falls back to the dev-only proxy path
  `/swing-scanner-api` (see `vite.config.js`) when unset — in production
  this must be set to `https://sniper-trades.onrender.com` or every fetch
  silently gets Cloudflare's SPA fallback HTML back instead of JSON
  (`Unexpected token '<'`).
- `VITE_ALPACA_KEY_ID` / `VITE_ALPACA_SECRET_KEY` — `utils/alpacaApi.js`
  calls `paper-api.alpaca.markets` **directly from the browser**, not
  through either Python service. This is a separate credential pair from
  swing_scanner's own `ALPACA_KEY_ID`/`ALPACA_SECRET_KEY` — regenerating
  one does not update the other.

**Any `VITE_*` env var change requires a real Cloudflare Pages rebuild**,
not just saving the value — Vite inlines these into the JS bundle at build
time. "Retry deployment" on an existing build can reuse that build's
original environment snapshot rather than picking up a newly-changed
value; trigger a fresh deployment (new commit, or an explicit new build)
when in doubt.

**Claude calls** (`src/utils/claudeApi.js`) go directly from the browser to
`api.anthropic.com` with `anthropic-dangerous-direct-browser-access: true`
and a user-supplied API key from `localStorage` (see `ApiKeySettings.jsx`)
— there is no backend proxy for LLM calls. New Claude-calling code should
follow the same pattern (model constant, `x-api-key` header, `extractJson`
for JSON responses) rather than introduce a second calling convention.

**Styling**: single dark theme, CSS custom properties in `src/index.css`
(`--bg`, `--surface`, `--green`, `--red`, `--purple`, etc.), plain CSS in
`src/App.css` (no CSS modules/styled-components/Tailwind). Watch for class
name collisions when reusing existing classes like `.bt-input` — some carry
constraints (e.g. `max-width: 200px`) that silently clip elements reusing
the class for a different purpose; check the existing rule before assuming
a class is layout-neutral.

**Charts**: Recharts only (already a dependency; don't add another
charting lib). Candlesticks are hand-built — `CandlestickChart.jsx` draws
wicks/bodies via a custom `Bar` `shape`, since Recharts has no native OHLC
mark. Annotation overlays (support zones / resistance lines / trendlines)
come from a `chart_annotations` JSON blob and are drawn with
`ReferenceArea`/`ReferenceLine`/sparse-`Line`-with-`connectNulls` — the
Y-axis domain must explicitly include annotation values, since it doesn't
auto-expand past the candle high/low range on its own.

## swing_scanner/ architecture

Two frontends (Streamlit `app.py` and Flask `api.py`) share one scan engine
(`pipeline.py`) so scan logic exists in exactly one place. `api.py` is a
flat single-file Flask app — no blueprints, no app factory — new routes go
directly on the module-level `app`.

- `data.py` — the only Alpaca REST wrapper in this service (raw `requests`
  calls, no SDK), with disk caching (`.cache/`, per-symbol-per-day parquet
  for bars, daily JSON for the tradable universe). `get_daily_bars()`
  promises to return `None` rather than raise on any failure (bad ticker,
  network error, **or missing/invalid Alpaca credentials**) — if you touch
  this function, preserve that contract, since callers have no try/except
  of their own and an uncaught exception here becomes a raw Flask 500
  instead of a clean 404.
- `chart_setups.py` + `database.py` — the `chart_setups` Postgres table
  (SQLAlchemy, this service's own engine/session, `Base.metadata.create_all`
  on startup — no Alembic anywhere in this repo, don't introduce it for
  one table).
- CORS is manual (`ALLOWED_ORIGINS` set + `after_request` hook), not
  `flask-cors` — matches `backend/app.py`'s pattern. Add new origins there
  if a new frontend domain needs to call this API.
- Chart Patterns admin writes (`POST`/`PUT`/`DELETE /api/setups`) are
  **intentionally unauthenticated** — a prior shared-token gate was removed
  as not worth the operational friction for a low-risk internal tool.

## Deployment gotchas (all hit in practice, not hypothetical)

- **`render.yaml` says `runtime: docker` for the `sniper-trades` service,
  but the actual live service on Render has historically run on Render's
  native Python buildpack instead** (manual `Build Command`/`Start Command`
  in the dashboard, no Dockerfile involved at all) — the Blueprint was
  never actually synced onto that manually-created service. Don't trust
  `render.yaml` to describe what's live; check the service's own Settings
  tab. If the Start Command is ever `gunicorn ... app:app`, that's wrong
  for this service — `swing_scanner/app.py` is the *Streamlit* entrypoint,
  not the Flask one; the Flask app is `api:app`.
- Changing a Render service's Root Directory does not necessarily update
  its Port/Build/Start Command to match the new directory's own
  Dockerfile/requirements — check those explicitly after moving a service
  between directories.
- The `sniper-trades` (swing_scanner) and `sniper-trades-scheduler`
  (backend) Render services need **separate** env vars for anything that
  looks shared (`ALPACA_*`, `DATABASE_URL`) — they don't inherit from each
  other, and neither inherits from Cloudflare's `VITE_ALPACA_*`.
- `swing_scanner` didn't require `DATABASE_URL` before `chart_setups` was
  added; it's non-optional now (`database.py` raises at import time if
  unset, crashing the whole service on boot, not just chart-setup routes).

## Legacy code — ask before touching

`server/` (Node scanner backend) and `sp500_scanner/` (standalone Python
CLI scanner) are both superseded and not deployed anywhere. They're left
in the tree deliberately; don't refactor, delete, or "clean up" either
without checking first.
