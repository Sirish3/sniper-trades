"""One-off manual test: runs the same logic as run_entry_scan() and
run_retest_scan() in scheduler.py, but skips the is_market_open() guard
specifically so it can be tested outside market hours. Every other guard
(regime, FOMC day, grade, earnings, dedup) stays active — this is a real
scan against live data, not a fake/mocked test. Real BUY alerts will be
sent and real positions auto-created if anything genuinely qualifies.

Usage: python manual_test_scan.py
"""
import logging
import time

from alerts import is_duplicate, send_alert
from config import PORTFOLIO_SIZE
from portfolio import check_trim_targets, create_position_from_signal, execute_trim
from scanner import compute_etf_heat, scan_breakouts, scan_retests
from signals import calculate_trade_plan, classify, save_signal
from utils import earnings_within_days, is_fomc_day, market_regime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

MAX_ENTRY_ALERTS = 3
MAX_RETEST_ALERTS = 2


def main() -> None:
    started = time.monotonic()
    logger.info("=== MANUAL TEST SCAN (market-hours guard skipped) ===")

    regime = market_regime()
    logger.info("Regime: %s", regime)
    if regime == "RISK_OFF":
        logger.info("RISK_OFF — no buy signals would be sent right now")
        return
    if is_fomc_day():
        logger.info("FOMC day — no new entries would be sent right now")
        return

    logger.info("Computing sector ETF heat...")
    etf_cache = compute_etf_heat()
    logger.info("ETF heat: %s", etf_cache)

    logger.info("Scanning for breakouts (this scans the full ~600-ticker universe, may take a few minutes)...")
    signals = scan_breakouts(intraday=True, etf_cache=etf_cache, regime=regime)
    logger.info("Breakout candidates found: %d", len(signals))

    sent = 0
    for sig in signals:
        if sent >= MAX_ENTRY_ALERTS:
            break
        grade = classify(sig)
        logger.info("Candidate %s: grade=%s vol_ratio=%.2f rsi=%.1f", sig["ticker"], grade, sig.get("vol_ratio", 0), sig.get("rsi", 0))
        if grade not in ("A+", "A"):
            continue
        if is_duplicate(sig["ticker"], "BUY"):
            logger.info("%s: duplicate within 24h, skipping", sig["ticker"])
            continue
        if earnings_within_days(sig["ticker"], 7):
            logger.info("%s: earnings within 7 days, skipping", sig["ticker"])
            continue

        plan = calculate_trade_plan(sig, portfolio_size=PORTFOLIO_SIZE, regime=regime)
        if not plan.get("viable"):
            logger.info("%s: trade plan not viable, skipping", sig["ticker"])
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
        logger.info("BUY ALERT SENT: %s grade=%s entry=%.2f", sig["ticker"], grade, plan["entry"])

    logger.info("Entry-style pass complete: %d candidates, %d alerts sent", len(signals), sent)

    logger.info("Scanning for retests...")
    retests = scan_retests()
    logger.info("Retest candidates found: %d", len(retests))

    retest_sent = 0
    for sig in retests:
        if retest_sent >= MAX_RETEST_ALERTS:
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
        retest_sent += 1
        logger.info("RETEST ALERT SENT: %s grade=%s", sig["ticker"], grade)

    logger.info("Retest pass complete: %d candidates, %d alerts sent", len(retests), retest_sent)

    trims = check_trim_targets()
    for trim in trims:
        if is_duplicate(trim["ticker"], trim["action"]):
            continue
        send_alert(trim["action"], trim)
        execute_trim(trim["position_id"], trim["action"])
        logger.info("TRIM ALERT SENT: %s %s", trim["ticker"], trim["action"])

    logger.info(
        "=== MANUAL TEST SCAN COMPLETE in %.1fs: %d BUY, %d BUY_RETEST, %d TRIM alerts sent ===",
        time.monotonic() - started, sent, retest_sent, len(trims),
    )


if __name__ == "__main__":
    main()
