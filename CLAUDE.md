# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Not one app — a React/Vite frontend plus **three independently-deployed Python
backends**, each with its own dependencies and its own `.env`. There is no
shared code between the Python services; the ones that touch Postgres (in
one shared Neon instance) own their own `database.py` / SQLAlchemy `Base`
rather than importing across service boundaries, because they deploy and
scale independently. `swing_scanner/` currently has no database of its own —
see the table below.

| Piece | Path | Deploys to | Purpose |
|---|---|---|---|
| Frontend | `src/` | Cloudflare Pages (`stockpilot.cc`) | React app, all tabs |
| Swing scanner API | `swing_scanner/` | Render (`sniper-trades`) | Economic Calendar tab; also a standalone Streamlit scanner UI (not deployed) |
| Execution scheduler | `backend/` | Render (`sniper-trades-scheduler`) | 52w-high breakout scans + email alerts, 3x/day cron |
| Users API | `users_api/` | not deployed anywhere yet | Bare FastAPI CRUD prototype, **no auth**, unrelated to the rest |
| Legacy, don't touch without asking | `server/`, `sp500_scanner/` | not deployed | Orphaned Node scanner backend and an earlier standalone Python CLI scanner, both superseded |

## Commands

**Frontend** (repo root):
```bash
npm run dev            # Vite dev server only
npm run dev:swing      # swing_scanner/api.py only (Windows venv path hardcoded)
npm run dev:all        # both, concurrently — needed for the Economic Calendar tab to work locally
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
python api.py                 # Flask API, backs the React Economic Calendar tab
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
- `VITE_SWING_SCANNER_API_URL` — used by `EconomicCalendar.jsx`. Falls
  back to the dev-only proxy path
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
mark. Not currently rendered by any tab (its last caller, the Chart
Patterns feature, was removed) but kept in the tree as the reusable
candlestick building block for whatever needs one next. Accepts an
`annotations` prop for support zones / resistance lines / trendlines from
a `chart_annotations`-shaped JSON blob, drawn with
`ReferenceArea`/`ReferenceLine`/sparse-`Line`-with-`connectNulls` — the
Y-axis domain must explicitly include annotation values, since it doesn't
auto-expand past the candle high/low range on its own.

## swing_scanner/ architecture

Streamlit `app.py` and Flask `api.py` used to be two frontends sharing one
scan engine (`pipeline.py`); now only `app.py` calls it — `api.py` lost its
last `pipeline.py`-backed route (`/api/scan`, the React "Scanner" tab) and
today only serves `/health` and `/api/economic-calendar`. `pipeline.py`,
`screener.py`, `levels.py`, and the rest of the scan engine are still live
code (Streamlit + `test_pipeline.py` use them), just not reachable from the
React app anymore. `api.py` is a flat single-file Flask app — no
blueprints, no app factory — new routes go directly on the module-level
`app`.

- `data.py` — the only Alpaca REST wrapper in this service (raw `requests`
  calls, no SDK), with disk caching (`.cache/`, per-symbol-per-day parquet
  for bars, daily JSON for the tradable universe). `get_daily_bars()`
  promises to return `None` rather than raise on any failure (bad ticker,
  network error, **or missing/invalid Alpaca credentials**) — if you touch
  this function, preserve that contract, since callers have no try/except
  of their own and an uncaught exception here becomes a raw Flask 500
  instead of a clean 404.
- CORS is manual (`ALLOWED_ORIGINS` set + `after_request` hook), not
  `flask-cors` — matches `backend/app.py`'s pattern. Add new origins there
  if a new frontend domain needs to call this API.
- No Postgres/SQLAlchemy dependency in this service — the one feature that
  needed it (Chart Patterns / `chart_setups` table, plus its
  `database.py`, `pattern_scan.py`, `pattern_detector.py`, and the 4:30pm
  ET `scheduler.py` cron that populated it) was removed. Don't reintroduce
  `DATABASE_URL` here without a real reason; `render.yaml`'s
  `sniper-trades` service no longer declares it.

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
  (backend) Render services need **separate** `ALPACA_*` env vars — they
  don't inherit from each other, and neither inherits from Cloudflare's
  `VITE_ALPACA_*`. (`swing_scanner` no longer uses `DATABASE_URL` at all;
  only the `backend`/execution-scheduler service still needs Postgres.)

## Legacy code — ask before touching

`server/` (Node scanner backend) and `sp500_scanner/` (standalone Python
CLI scanner) are both superseded and not deployed anywhere. They're left
in the tree deliberately; don't refactor, delete, or "clean up" either
without checking first.
