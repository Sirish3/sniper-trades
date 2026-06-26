"""The 3 scheduled jobs: entry scan, retest+trim scan, exit+stop scan.

Uses BackgroundScheduler rather than the originally-specified
BlockingScheduler — a deliberate change, not an oversight. This module is
imported by app.py so the scheduler runs inside the same process as the
status website, and BlockingScheduler.start() never returns, which would
prevent Flask from ever serving a request. Run standalone (no web
process) via `python scheduler.py`, which keeps the process alive itself.
"""
from __future__ import annotations

import logging
import time

from apscheduler.events import EVENT_JOB_ERROR
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from alerts import is_duplicate, send_alert
from config import PORTFOLIO_SIZE, TIMEZONE
from database import init_db, mark_pending_close
from portfolio import (
    check_stops,
    check_time_stops,
    check_trim_targets,
    create_position_from_signal,
    execute_trim,
    save_portfolio_snapshot,
    update_trailing_stops,
)
from scanner import compute_etf_heat, scan_breakouts, scan_retests
from signals import calculate_trade_plan, classify, save_signal, validate_close_signals
from utils import earnings_within_days, is_fomc_day, is_market_open, market_regime, validate_email_config

logger = logging.getLogger(__name__)

MAX_ENTRY_ALERTS = 3
MAX_RETEST_ALERTS = 2


def run_entry_scan() -> None:
    """10:00 AM ET Mon-Fri — 52W-high breakouts; BUY alerts for A+/A only."""
    started = time.monotonic()
    logger.info("Starting run_entry_scan")

    if not is_market_open():
        return

    regime = market_regime()
    if regime == "RISK_OFF":
        logger.info("RISK_OFF — no buy signals today")
        return
    if is_fomc_day():
        logger.info("FOMC day — no new entries")
        return

    etf_cache = compute_etf_heat()
    signals = scan_breakouts(intraday=True, etf_cache=etf_cache, regime=regime)

    sent = 0
    last_grade = None
    for sig in signals:
        if sent >= MAX_ENTRY_ALERTS:
            break
        grade = classify(sig)
        last_grade = grade
        if grade not in ("A+", "A"):
            continue
        if is_duplicate(sig["ticker"], "BUY"):
            continue
        if earnings_within_days(sig["ticker"], 7):
            continue

        plan = calculate_trade_plan(sig, portfolio_size=PORTFOLIO_SIZE, regime=regime)
        if not plan.get("viable"):
            continue

        if regime == "RISK_NEUTRAL":
            plan["shares"] = plan["shares"] // 2
            plan["position_dollar"] = plan["shares"] * sig["price"]
            plan["risk_dollar"] = plan["risk_dollar"] / 2

        sig["signal_type"] = "BUY"
        signal_id = save_signal(sig, plan, grade)
        send_alert("BUY", sig, plan, grade)
        create_position_from_signal(sig, plan, grade, signal_id=signal_id)
        sent += 1

    logger.info("Entry scan complete: %d signals found, %d alerts sent, grade=%s", len(signals), sent, last_grade)
    logger.info("Completed run_entry_scan in %.1fs", time.monotonic() - started)


def run_retest_scan() -> None:
    """2:00 PM ET Mon-Fri — retest BUY setups, plus trim-target checks."""
    started = time.monotonic()
    logger.info("Starting run_retest_scan")

    if not is_market_open():
        return

    retests = scan_retests()
    sent = 0
    for sig in retests:
        if sent >= MAX_RETEST_ALERTS:
            break
        grade = classify(sig)
        if grade not in ("A+", "A"):
            continue
        if is_duplicate(sig["ticker"], "BUY_RETEST"):
            continue
        if earnings_within_days(sig["ticker"], 7):
            continue

        plan = calculate_trade_plan(sig, PORTFOLIO_SIZE)
        if not plan.get("viable"):
            continue

        sig["signal_type"] = "BUY_RETEST"
        signal_id = save_signal(sig, plan, grade)
        send_alert("BUY_RETEST", sig, plan, grade)
        create_position_from_signal(sig, plan, grade, signal_id=signal_id)
        sent += 1

    trims = check_trim_targets()
    for trim in trims:
        if is_duplicate(trim["ticker"], trim["action"]):
            continue
        send_alert(trim["action"], trim)
        execute_trim(trim["position_id"], trim["action"])
        logger.info("TRIM: %s %s at %.2f", trim["ticker"], trim["action"], trim["current_price"])

    logger.info("Retest scan: %d buy alerts, %d trim alerts", sent, len(trims))
    logger.info("Completed run_retest_scan in %.1fs", time.monotonic() - started)


def run_exit_scan() -> None:
    """3:50 PM ET Mon-Fri — ATR/time stops, trailing-stop updates, close
    validation of this morning's signals, end-of-day snapshot.
    """
    started = time.monotonic()
    logger.info("Starting run_exit_scan")

    if not is_market_open():
        return

    stop_hits = check_stops()
    for pos in stop_hits:
        send_alert("SELL_STOP", pos)
        mark_pending_close(pos["position_id"], "ATR_STOP")
        logger.info("STOP: %s pnl=%.1f%%", pos["ticker"], pos["pnl_pct"])

    stop_hit_ids = {p["position_id"] for p in stop_hits}
    time_hits = check_time_stops()
    for pos in time_hits:
        if pos["position_id"] in stop_hit_ids:
            continue
        send_alert("SELL_TIME", pos)
        mark_pending_close(pos["position_id"], "TIME_STOP")
        logger.info("TIME STOP: %s %dd no progress", pos["ticker"], pos["days_held"])

    closed_ids = list(stop_hit_ids) + [p["position_id"] for p in time_hits if p["position_id"] not in stop_hit_ids]
    update_trailing_stops(exclude_ids=closed_ids)

    cancelled = validate_close_signals()
    for sig in cancelled:
        send_alert("CANCEL", sig)
        logger.info("CANCELLED: %s failed to close above pivot", sig["ticker"])

    save_portfolio_snapshot()

    logger.info(
        "Exit scan complete: %d stops hit, %d time stops, %d signals cancelled",
        len(stop_hits), len(time_hits), len(cancelled),
    )
    logger.info("Completed run_exit_scan in %.1fs", time.monotonic() - started)


def on_job_error(event) -> None:
    """APScheduler error listener — logs and alerts on any job exception."""
    logger.error("Job %s failed: %s", event.job_id, event.exception)
    send_alert("ERROR", {"job": event.job_id, "error": str(event.exception)})


def build_scheduler() -> BackgroundScheduler:
    """Builds (but does not start) the scheduler with its 3 jobs wired up."""
    scheduler = BackgroundScheduler(timezone=TIMEZONE)
    scheduler.add_job(run_entry_scan, CronTrigger(day_of_week="mon-fri", hour=10, minute=0), id="entry_scan")
    scheduler.add_job(run_retest_scan, CronTrigger(day_of_week="mon-fri", hour=14, minute=0), id="retest_scan")
    scheduler.add_job(run_exit_scan, CronTrigger(day_of_week="mon-fri", hour=15, minute=50), id="exit_scan")
    scheduler.add_listener(on_job_error, EVENT_JOB_ERROR)
    return scheduler


def start_scheduler() -> BackgroundScheduler:
    """Initializes the DB and starts the scheduler. Idempotent-ish: call
    once at process startup (app.py guards against calling it twice under
    Flask's dev-server reloader).
    """
    init_db()

    if not validate_email_config():
        logger.error("Email not configured — alerts disabled")
        logger.error("Check .env file for EMAIL_ADDRESS/EMAIL_APP_PASSWORD/ALERT_TO_EMAIL")
        # Continue running — just no email will be sent.

    scheduler = build_scheduler()
    scheduler.start()
    logger.info("Scheduler started — 3 jobs active")
    logger.info("  10:00 AM -> entry scan (BUY)")
    logger.info("  2:00 PM  -> retest + trim scan")
    logger.info("  3:50 PM  -> exit + stop scan")
    return scheduler


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    _scheduler = start_scheduler()
    try:
        while True:
            time.sleep(60)
    except (KeyboardInterrupt, SystemExit):
        _scheduler.shutdown()
