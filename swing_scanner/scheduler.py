"""Daily chart-pattern detection job. Separate from backend/scheduler.py —
a different service, different Render deploy, different database (see
CLAUDE.md's architecture notes on why each Python service owns its own
DB). swing_scanner had no background scheduler before this; api.py starts
it in-process at import time, same pattern backend/app.py already uses
for its own scheduler.

Safe under this service's gunicorn config (--workers 1, see Dockerfile /
Render's Start Command) — same single-worker constraint backend/'s
scheduler already documents, for the same reason: a second worker process
would run this job twice.
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from pattern_scan import run_pattern_scan

logger = logging.getLogger(__name__)


def run_daily_pattern_scan() -> None:
    logger.info("Starting daily pattern scan")
    try:
        summary = run_pattern_scan()
        logger.info(
            "Pattern scan complete: %d tickers scanned, %d rows created/updated, %d skipped, %d Claude call(s)",
            len(summary["detectedPerTicker"]), len(summary["rows"]), summary["skipped"], summary["claudeCalls"],
        )
    except Exception:
        logger.exception("Daily pattern scan failed")


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="America/New_York")
    # 4:30 PM ET — after market close (4:00 PM) and after backend/'s 3:50 PM
    # exit scan. Daily-bar patterns don't need same-day intraday timing the
    # way backend/scheduler.py's 10am/2pm/3:50pm jobs do (those react to
    # live price action; this only needs that day's confirmed close, which
    # isn't final until the market closes) — flagging this as a deliberate
    # difference from the existing job times, not an oversight.
    scheduler.add_job(run_daily_pattern_scan, CronTrigger(day_of_week="mon-fri", hour=16, minute=30), id="pattern_scan")
    return scheduler


def start_scheduler() -> BackgroundScheduler:
    scheduler = build_scheduler()
    scheduler.start()
    logger.info("swing_scanner scheduler started — pattern scan job active (4:30 PM ET Mon-Fri)")
    return scheduler
