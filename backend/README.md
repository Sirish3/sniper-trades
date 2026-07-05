# Execution Scheduler

A standalone Flask + APScheduler service: scans for 52-week-high breakouts
and retests, tracks positions, and sends email alerts on three fixed times
(10:00 AM / 2:00 PM / 3:50 PM ET, Mon-Fri). This is a **separate project**
from the `sniper-trades` React app — it has its own database and does not
read or write the React app's `localStorage` positions.

## What this does NOT do

It does not place real brokerage orders. It scans, decides, tracks
positions in its own database, and sends you an email. You still place any
real trade yourself. The one automated thing that *does* happen without a
human step: the moment a BUY alert is sent, a position is auto-created in
the database assuming you filled at the calculated entry price and full
share size (your explicit choice — see "Design choices" below). If you
don't actually take the trade, you'll need to manually delete that
position row, or it'll keep getting checked for stops/trims.

## Design choices made while building this

The original spec had two real bugs, fixed here (not silently — flagged
in code comments at the fix sites too):

1. **`market_regime()`'s SMA window.** The spec said "fetch 50-day and
   200-day SMA from the last 60 days of closes" — you cannot compute a
   200-day average from 60 days of data. Fixed by fetching ~14 months of
   history instead.
2. **`run_entry_scan`'s RISK_NEUTRAL sizing** was specified to happen both
   inside `calculate_trade_plan()` *and* again as an explicit halving step
   right after — that would have quartered position size, not halved it.
   `calculate_trade_plan()` now ignores `regime` for sizing; the one
   explicit halving step in `run_entry_scan` is the only place it happens.

Other decisions made from your answers when this was scoped:

- **Alerts**: email via Resend's HTTP API. Twilio SMS was tried first and
  dropped — the only number on the Twilio account was toll-free and
  required Toll-Free Verification (a multi-day-to-multi-week carrier
  compliance review) before any message would actually deliver; the API
  call succeeded but the carrier silently dropped the message
  (error 30032), confirmed by checking real delivery status via the
  Twilio API, not just the create-call response. Gmail SMTP was tried
  second and dropped — Render blocks outbound SMTP (ports 25/465/587) on
  all plans as an anti-spam measure, so `smtplib` connections failed with
  `[Errno 101] Network is unreachable` regardless of credentials,
  confirmed live via Render's logs. Resend's API runs over HTTPS (port
  443), which is never blocked. Get a key at
  https://resend.com/api-keys. Put real credentials in `.env` (see
  `.env.example`) — never paste them into a chat with anyone, including an
  AI assistant.
- **Position creation**: fully automatic at the calculated entry price
  (no fill-confirmation step). This is the riskier of the two options
  discussed — it will silently drift from reality if your real fill price
  or size differs, or if you don't take a trade at all.
- **`FOMC_DATES` in `config.py` is empty.** I don't have reliably current
  2026 FOMC decision dates memorized, and guessing wrong here is worse
  than leaving it obviously empty. Fill it in from
  https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm before
  relying on the FOMC-day guard.
- **Scheduler class**: `BackgroundScheduler`, not `BlockingScheduler` as
  originally specified — needed so the scheduler can run inside the same
  process as the Flask status page. `python scheduler.py` standalone
  (no web process) still works and keeps itself alive.

## Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env       # then fill in real values
node data/export_universe.mjs   # (re)generates data/sp500.json etc. from the React app
```

`data/export_universe.mjs` reads `../src/data/sp500.js` etc. from the
React app — run it again any time those files change (e.g. after using
the app's "Refresh" buttons and manually folding new tickers back into
the static files).

## Running locally

```bash
python app.py          # Flask status page at http://localhost:8000, scheduler running in-process
# or, scheduler only, no web page:
python scheduler.py
```

## Verification

Run from inside `backend/`, with the venv active:

```bash
python -c "from utils import is_market_open, market_regime; print('Market open:', is_market_open()); print('Regime:', market_regime()); print('utils OK')"
python -c "from portfolio import check_stops, check_time_stops, check_trim_targets, update_trailing_stops; print('portfolio OK')"
python -c "from scheduler import run_entry_scan, run_retest_scan, run_exit_scan; print('scheduler OK')"
python -c "from apscheduler.schedulers.blocking import BlockingScheduler; import scheduler; print('APScheduler wired OK'); print('Jobs: 3')"
```

All 4 have been run live (Python 3.12 via a `backend/venv`) and pass.
`market_regime()` and the scanners depend on yfinance reaching Yahoo
Finance — if `yfinance==0.2.36` (an earlier pin) is installed instead of
`yfinance>=1.4.1`, every fetch fails with a JSON-decode error against
Yahoo's current backend; upgrade if you hit that.

## Deploying (cheapest viable option)

I can't create cloud accounts or deploy on your behalf — only write
code/config that's ready to deploy. Two free-tier-friendly options as of
my knowledge, but **check current pricing/limits before signing up,
since free-tier policies change often**:

- **Fly.io** — small persistent VM + volume. Good fit since this needs to
  run continuously (a scheduler that goes to sleep on inactivity, like
  most "free web service" tiers, will simply miss its 10/2/3:50 triggers).
  Use the included `Dockerfile`.
- **Render.com** — their free *Web Service* tier spins down after 15 min
  idle, which breaks an always-on scheduler; you'd want their cheap paid
  "Starter" tier instead if you go this route.

Either way: **one worker process only** (enforced in the `Dockerfile`'s
`gunicorn --workers 1`). The DB is Postgres only (`DATABASE_URL`, a free
Neon instance) — required, no local SQLite fallback, which also means
splitting the website and scheduler into separate services later needs no
database migration (both would already point at the same network DB).

## Files

| File | Purpose |
|---|---|
| `config.py` | Env vars, constants, ticker universe (loaded from `data/*.json`) |
| `database.py` | SQLAlchemy models + session helper |
| `indicators.py` | EMA/ATR/RSI/MACD/ADX |
| `utils.py` | Market-open check, regime, FOMC day, earnings-within-days |
| `scanner.py` | Breakout/retest scans, sector ETF heat |
| `signals.py` | Grading, trade-plan sizing, signal persistence, close-validation |
| `alerts.py` | Resend HTTP API email + alert formatting + dedup |
| `portfolio.py` | Position lifecycle: stops, trims, trailing stop, close, snapshot |
| `scheduler.py` | The 3 cron jobs |
| `app.py` | Flask status page; starts the scheduler |
