# Swing Trading Scanner

Trend Template (Stage 2) + simplified VCP (volatility contraction pattern)
detection, powered directly by Alpaca's REST API — no yfinance, no email
alerts, no order placement. Screener/watchlist only.

Also includes an Economic Calendar and an Earnings Calendar (Finviz-backed,
via `finvizfinance`), both as standalone modules and as extra Streamlit
tabs — see "Economic Calendar / Earnings" below.

## Setup

```bash
cd swing_scanner
python -m venv venv
venv\Scripts\activate        # Windows; `source venv/bin/activate` on Mac/Linux
pip install -r requirements.txt
```

`.env` already has this project's Alpaca keys copied in (see `.env.example`
for the format) — no extra setup needed unless you're moving this
elsewhere.

## Run it

Two frontends share the same scan logic (`pipeline.py`):

**Streamlit (standalone)**

```bash
streamlit run app.py
```

Sidebar has a position-sizing calculator; the main panel has the **Run
Scan** button. Check **"Use 20-ticker test subset"** (on by default) for a
fast pipeline smoke test — uncheck it to scan the full NYSE+NASDAQ
universe, which is much slower (thousands of tickers) and more likely to
hit Alpaca's rate limit (handled with retry/backoff, but still slow).

Click any row in the results table to see that ticker's chart (candles +
SMA50/150/200 + entry/stop lines for confirmed VCP setups).

**React tab ("Scanner")**

```bash
python api.py    # Flask API on :8003, proxied by Vite's /swing-scanner-api rule
```

Then `npm run dev` in the repo root and open the "Scanner" tab — same
Run Scan button, table, filters, and click-a-row chart (Recharts line
chart with SMA overlays + entry/stop reference lines, not candles — this
repo's other tabs use the same line-chart convention rather than a
candlestick library). Position sizing is computed client-side in JS
(trivial arithmetic — `POST /api/position-size` also exists on the Flask
side for parity, but the React tab doesn't call it).

## CLI smoke test

`test_pipeline.py` runs the same pipeline against the 20-ticker subset
without Streamlit, for quick debugging:

```bash
python test_pipeline.py
```

`economic_calendar.py` and `earnings_calendar.py` are also runnable
directly for a quick console-output check without touching Streamlit:

```bash
python economic_calendar.py
python earnings_calendar.py
```

## Economic Calendar / Earnings

Two extra Streamlit tabs, backed by two new standalone modules:

- **Economic Calendar** (`economic_calendar.py`) — merges a live Finviz
  scrape (current week, with actual/forecast/previous values) with
  `known_events.py`'s static schedule of confirmed BLS/Fed release dates,
  so the combined view reaches "this week + next week" even though
  Finviz's own page only shows the week in progress. Filterable by impact
  (High/Medium/Low) and date range; `get_high_impact_dates()` is what the
  scanner (`pipeline.py`) checks before flagging a new breakout.
- **Earnings** (`earnings_calendar.py`) — per-ticker next earnings date,
  before/after-market flag, next-quarter EPS estimate, and prior quarter's
  actual EPS, for the current scan results or a session-only tracking
  list you type in. Flags anything reporting within the next 10 trading
  days — `get_earnings_risk_tickers()` is the same check `pipeline.py`
  uses for the "Earnings before exit" tag.

**Confirmed live, not hypothetical:** `finvizfinance`'s own `Calendar`
class and `finvizfinance.quote`'s `ticker_fundament()` are both broken
against Finviz's current pages (the calendar page redesigned itself into
a client-side-rendered SPA with no `<table class="calendar">` left to
parse; the quote page's parser crashes on an unrelated container before
it ever reaches the fundamentals table). Both modules bypass those
methods and parse the pages' own embedded JSON / still-server-rendered
snapshot table directly instead — see the docstrings in each file for
specifics. This is exactly the kind of breakage an unofficial scraper is
expected to hit eventually; if Finviz changes its markup again, both
modules degrade to their documented fallback (static schedule only /
per-ticker error rows) rather than crashing the scan.

A confirmed-working new VCP breakout is never suppressed by either
calendar check — only tagged (`Caution Tags` column) so the user decides.

## Code structure

- `data.py` — Alpaca REST wrapper: tradable universe (with daily caching),
  single-symbol and multi-symbol daily bars (with per-day parquet caching).
- `indicators.py` — SMA, ATR (Wilder), 52w high/low, average volume,
  trailing return. Pure functions, no I/O.
- `screener.py` — the 5-condition Trend Template filter, RS score
  (percentile-ranked across the universe), and simplified VCP detection.
- `levels.py` — entry/stop/target calculations, plus the position-sizing
  helper used by both frontends.
- `pipeline.py` — the actual scan orchestration (fetch → RS rank → Trend
  Template → VCP → levels), framework-independent so both UIs call the
  same code.
- `app.py` — Streamlit UI (Scanner / Economic Calendar / Earnings tabs).
- `api.py` — Flask API for the React "Scanner" tab
  (`src/components/SwingScanner.jsx` in the main repo).
- `economic_calendar.py` — Finviz live scrape + `known_events.py` static
  merge, filtering, and `get_high_impact_dates()`.
- `known_events.py` — static list of confirmed BLS/Fed release dates;
  update manually as new dates are published.
- `earnings_calendar.py` — per-ticker earnings pull + risk flagging.

## Known assumptions — flagged for verification

1. **RS ratio formula (`screener.py`)** — the spec says "trailing 63-day
   return divided by SPY's trailing return." Taken completely literally
   that flips sign confusingly whenever SPY's return is negative, so this
   uses the standard relative-strength-line ratio instead:
   `(1 + ticker_return) / (1 + spy_return)`. Percentile ranking (0-100,
   IBD-style) is unchanged from the spec.
2. **ATR smoothing** — Wilder's (alpha = 1/period), the standard ATR
   definition, since the spec didn't specify a smoothing method.
3. **"Current price"** — the latest daily bar's close, not a separate
   real-time quote fetch. Standard for an EOD swing scanner and consistent
   with how "current price" is treated everywhere else in this repo.
4. **VCP detection is a simplification**, as the spec itself requests —
   swing highs/lows via local-extrema windows, paired into peak-to-trough
   legs, checked for contracting range + declining volume over the last 3
   legs. Real VCP analysis also weighs base length, contraction count
   (2-5 typical), and shakeout structure; none of that is modeled here.
5. **Daily bar caching is per-calendar-day**, not per-session — if you run
   the scanner mid-session and again after close on the same day, the
   second run reuses the first run's (partial) daily bar for today rather
   than refetching. Delete `.cache/` or pass `use_cache=False` to force a
   refresh.
