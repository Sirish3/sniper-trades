"""Alert formatting, deduplication, and delivery via Gmail SMTP.

Twilio SMS was tried first and dropped — see config.py's comment for why
(toll-free verification blocked delivery). Email needs no equivalent
carrier review, so this sends plain-text alert emails instead.
"""
from __future__ import annotations

import logging
import smtplib
import time
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import make_msgid

from config import ALERT_TO_EMAIL, EMAIL_ADDRESS, EMAIL_APP_PASSWORD
from database import AlertLog, get_session
from utils import validate_email_config  # noqa: F401  (re-exported for test_email.py)

logger = logging.getLogger(__name__)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

DEDUP_WINDOW_HOURS = 24
EMAIL_MIN_INTERVAL_SECONDS = 1.0  # spaces out multiple sends in the same scan run

_last_email_at = 0.0


def _as_utc(dt: datetime) -> datetime:
    """Treats a naive datetime (SQLite round-trip) as UTC rather than local time."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def is_duplicate(ticker: str, signal_type: str) -> bool:
    """True if this ticker + signal_type was already alerted in the last 24 hours."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=DEDUP_WINDOW_HOURS)
    with get_session() as session:
        candidates = (
            session.query(AlertLog)
            .filter(AlertLog.ticker == ticker, AlertLog.alert_type == signal_type)
            .all()
        )
        return any(_as_utc(a.sent_at) >= cutoff for a in candidates)


def _rate_limit() -> None:
    """Sleeps just enough to keep sends >= EMAIL_MIN_INTERVAL_SECONDS apart."""
    global _last_email_at
    elapsed = time.monotonic() - _last_email_at
    if elapsed < EMAIL_MIN_INTERVAL_SECONDS:
        time.sleep(EMAIL_MIN_INTERVAL_SECONDS - elapsed)
    _last_email_at = time.monotonic()


def _send_email_raw(subject: str, body: str) -> tuple[bool, str | None]:
    """Sends one alert email via Gmail SMTP; returns (success, message_id).
    Internal — send_email() wraps this for the bool-only public contract,
    send_alert() uses it directly so it can log the real message_id.
    """
    if not EMAIL_ADDRESS or not EMAIL_APP_PASSWORD or not ALERT_TO_EMAIL:
        logger.warning("send_email: EMAIL_ADDRESS/EMAIL_APP_PASSWORD/ALERT_TO_EMAIL not fully set — skipping send")
        return False, None

    _rate_limit()
    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"] = EMAIL_ADDRESS
        msg["To"] = ALERT_TO_EMAIL
        msg["Message-ID"] = make_msgid()

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(EMAIL_ADDRESS, EMAIL_APP_PASSWORD)
            server.sendmail(EMAIL_ADDRESS, [ALERT_TO_EMAIL], msg.as_string())

        logger.info("Email sent: %s", subject)
        return True, msg["Message-ID"]
    except Exception as exc:
        logger.error("Email failed: %s", exc)
        return False, None


def send_email(subject: str, body: str) -> bool:
    """Sends one alert email via Gmail SMTP.

    Reads all credentials from environment variables (via config.py) —
    never hardcodes a credential value. Returns True on success, False on
    failure.
    """
    success, _message_id = _send_email_raw(subject, body)
    return success


def format_buy_alert(sig: dict, plan: dict, grade: str) -> str:
    """BUY alert body."""
    return (
        f"BUY {grade}: {sig['ticker']}\n"
        f"Entry:  ${plan['entry']:.2f}\n"
        f"Stop:   ${plan['stop']:.2f} ({plan['stop_pct']:.1f}% risk)\n"
        f"T1:     ${plan['trim1']:.2f} → sell 25%\n"
        f"T2:     ${plan['trim2']:.2f} → sell 25%\n"
        f"Shares: {plan['shares']} (${plan['position_dollar']:,.0f})\n"
        f"Risk:   ${plan['risk_dollar']:.0f} ({plan['risk_pct']:.1f}%)\n"
        f"Vol:    {sig.get('vol_ratio', 0):.1f}x | RSI: {sig.get('rsi', 0):.0f}"
    )


def format_retest_alert(sig: dict, plan: dict, grade: str) -> str:
    """BUY_RETEST alert body."""
    return (
        f"RETEST {grade}: {sig['ticker']}\n"
        f"Entry:  ${plan['entry']:.2f} (old high = support)\n"
        f"Stop:   ${plan['stop']:.2f} ({plan['stop_pct']:.1f}%)\n"
        f"T1:     ${plan['trim1']:.2f} | T2: ${plan['trim2']:.2f}\n"
        f"Shares: {plan['shares']} | Risk: ${plan['risk_dollar']:.0f}"
    )


def format_sell_stop_alert(pos: dict) -> str:
    """SELL_STOP alert body."""
    return (
        f"STOP HIT: {pos['ticker']}\n"
        f"Close:  ${pos['close']:.2f}\n"
        f"Stop:   ${pos['stop']:.2f}\n"
        f"PnL:    {pos['pnl_pct']:+.1f}%\n"
        f"Held:   {pos['days_held']} days\n"
        "ACTION: Sell at tomorrows open"
    )


def format_sell_time_alert(pos: dict) -> str:
    """SELL_TIME alert body."""
    return (
        f"TIME STOP: {pos['ticker']}\n"
        f"No progress in {pos['days_held']} days\n"
        f"Close:  ${pos['close']:.2f}\n"
        f"Entry:  ${pos['entry']:.2f}\n"
        f"PnL:    {pos['pnl_pct']:+.1f}%\n"
        "ACTION: Sell at tomorrows open"
    )


def format_trim_alert(trim: dict) -> str:
    """TRIM_1/TRIM_2 alert body."""
    label = "TRIM 1" if trim["action"] == "TRIM_1" else "TRIM 2"
    breakeven_note = " (breakeven)" if trim["action"] == "TRIM_1" else ""
    return (
        f"{label}: {trim['ticker']}\n"
        f"Sell {trim['shares_to_sell']} shares NOW\n"
        f"Price:    ${trim['current_price']:.2f}\n"
        f"PnL:      {trim['pnl_pct']:+.1f}%\n"
        f"New stop: ${trim['new_stop']:.2f}{breakeven_note}\n"
        f"Keep:     {trim['shares_remaining']} shares"
    )


def format_cancel_alert(sig: dict) -> str:
    """CANCEL alert body."""
    return (
        f"CANCELLED: {sig['ticker']}\n"
        f"Failed to close above pivot ${sig['pivot']:.2f}\n"
        f"Actual close: ${sig['close']:.2f}\n"
        "Ignore earlier BUY alert"
    )


def format_error_alert(payload: dict) -> str:
    """ERROR alert body."""
    return (
        "SCHEDULER ERROR\n"
        f"Job: {payload.get('job')}\n"
        f"Error: {payload.get('error')}\n"
        "Check logs immediately"
    )


def _subject_for(alert_type: str, data: dict, grade: str | None) -> str:
    ticker = data.get("ticker", "N/A")
    if alert_type == "BUY":
        return f"BUY {grade}: {ticker}"
    if alert_type == "BUY_RETEST":
        return f"RETEST {grade}: {ticker}"
    if alert_type == "SELL_STOP":
        return f"STOP HIT: {ticker}"
    if alert_type == "SELL_TIME":
        return f"TIME STOP: {ticker}"
    if alert_type in ("TRIM_1", "TRIM_2"):
        return f"{'TRIM 1' if alert_type == 'TRIM_1' else 'TRIM 2'}: {ticker}"
    if alert_type == "CANCEL":
        return f"CANCELLED: {ticker}"
    if alert_type == "ERROR":
        return "SCHEDULER ERROR"
    return f"{alert_type}: {ticker}"


def _format_message(alert_type: str, data: dict, plan: dict | None, grade: str | None) -> str:
    if alert_type == "BUY":
        return format_buy_alert(data, plan, grade)
    if alert_type == "BUY_RETEST":
        return format_retest_alert(data, plan, grade)
    if alert_type == "SELL_STOP":
        return format_sell_stop_alert(data)
    if alert_type == "SELL_TIME":
        return format_sell_time_alert(data)
    if alert_type in ("TRIM_1", "TRIM_2"):
        return format_trim_alert(data)
    if alert_type == "CANCEL":
        return format_cancel_alert(data)
    if alert_type == "ERROR":
        return format_error_alert(data)
    return f"{alert_type}: {data}"


def send_alert(alert_type: str, data: dict, plan: dict | None = None, grade: str | None = None) -> None:
    """Central alert dispatcher, called by scheduler.py. Formats the email
    for `alert_type`, sends it, and logs the result to alerts_log. Never
    raises — a failed or misformatted alert should never take down a
    scheduler job.
    """
    try:
        body = _format_message(alert_type, data, plan, grade)
    except Exception as exc:
        logger.error("send_alert: failed to format %s alert (%s)", alert_type, exc)
        body = f"{alert_type} alert (formatting error: {exc})"

    subject = _subject_for(alert_type, data, grade)
    success, message_id = _send_email_raw(subject, body)

    ticker = data.get("ticker", "N/A")
    position_id = data.get("position_id")
    signal_id = data.get("signal_id") or data.get("alert_id")
    price = (plan or {}).get("entry", data.get("close", data.get("current_price", data.get("entry_price", data.get("exit_price")))))

    try:
        with get_session() as session:
            session.add(AlertLog(
                ticker=ticker,
                alert_type=alert_type,
                message=body,
                position_id=position_id,
                signal_id=signal_id,
                price=price,
                grade=grade,
                delivery_sid=message_id,
            ))
    except Exception:
        logger.exception("send_alert: failed to log alert to DB")

    logger.info("Alert sent [%s] %s (email_ok=%s)", alert_type, ticker, success)
