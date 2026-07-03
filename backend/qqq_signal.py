"""QQQ EMA-10 daily signal: price > EMA-10 → hold TQQQ, else → hold SQQQ.

Three scheduled emails per weekday (all CST/CDT):
  9:00 AM  — Morning brief (yesterday's confirmed close — act at open)
  2:30 PM  — Pre-close advisory (30 min before close — early warning)
  4:15 PM  — Final confirmed close signal (authoritative — act tomorrow)

State is saved only at 4:15 PM (the confirmed close) so SWITCH detection
is based on real closing prices, not intraday prices.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import yfinance as yf

logger = logging.getLogger(__name__)

STATE_FILE = Path(__file__).parent / "data" / "qqq_state.json"

TIMING_LABELS = {
    "morning":  "9:00 AM CST — Morning Brief (based on yesterday's close)",
    "preclose": "2:30 PM CST — Pre-Close Advisory (intraday reading, may change)",
    "close":    "4:15 PM CST — Final Signal (confirmed close price)",
}

TIMING_CONTEXT = {
    "morning":  (
        "This is yesterday's CONFIRMED close signal.\n"
        "If you haven't acted yet, this is what you should be holding now.\n"
        "Act at market open or shortly after."
    ),
    "preclose": (
        "This is an INTRADAY reading 30 minutes before close.\n"
        "The signal may shift slightly by the final close.\n"
        "Watch for a potential switch — act before 3 PM CST if you prefer to avoid the final minutes."
    ),
    "close":    (
        "This is the AUTHORITATIVE signal based on today's confirmed closing price.\n"
        "This determines what you should hold TOMORROW.\n"
        "If a SWITCH is shown: place your order before tomorrow's open."
    ),
}


def get_qqq_signal() -> dict:
    """Fetch 3 months of QQQ daily bars, compute EMA-10, return signal dict."""
    hist = yf.Ticker("QQQ").history(period="3mo")["Close"]
    if hist.empty:
        raise RuntimeError("No QQQ data from yfinance")
    price = float(hist.iloc[-1])
    ema10 = float(hist.ewm(span=10, adjust=False).mean().iloc[-1])
    state = "TQQQ" if price > ema10 else "SQQQ"
    idx   = hist.index[-1]
    date  = f"{idx.strftime('%B')} {idx.day} {idx.year}"  # "July 2 2026" (cross-platform)
    return {"state": state, "price": price, "ema10": ema10, "date": date}


def load_previous_state() -> str | None:
    """Return the last saved confirmed-close state, or None on first run."""
    if not STATE_FILE.exists():
        return None
    try:
        with open(STATE_FILE) as f:
            return json.load(f).get("state")
    except Exception as exc:
        logger.warning("Could not read QQQ state file: %s", exc)
        return None


def save_state(state: str) -> None:
    """Persist today's confirmed-close state for tomorrow's comparison."""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump({"state": state}, f)
    except Exception as exc:
        logger.warning("Could not save QQQ state: %s", exc)


def build_qqq_email(signal: dict, prev_state: str | None, timing: str = "close") -> tuple[str, str]:
    """Return (subject, body) for the given timing context."""
    curr   = signal["state"]
    price  = signal["price"]
    ema10  = signal["ema10"]
    date   = signal["date"]
    bull   = curr == "TQQQ"
    trend  = "BULLISH" if bull else "BEARISH"
    vs_ema = f"price {'above' if bull else 'below'} EMA 10"

    # Only the 4:15 PM (close) job can detect a true SWITCH based on confirmed prices
    if prev_state is None:
        action_line = f"INITIAL SIGNAL — enter {curr} (100% portfolio)"
        subject     = f"QQQ {timing.upper()}: {curr} — {trend}"
    elif timing != "close":
        # Morning and pre-close: show current reading, no SWITCH declaration
        stayed = prev_state == curr
        action_line = (
            f"HOLDING {curr} — no change from yesterday's close"
            if stayed else
            f"INTRADAY SIGNAL DIFFERS — was {prev_state}, now reading {curr} (wait for close to confirm)"
        )
        subject = f"QQQ {timing.upper()}: {curr} ({trend})"
    elif prev_state == curr:
        action_line = f"STAY — remain in {curr}, no action needed"
        subject     = f"QQQ: STAY {curr}"
    else:
        action_line = f"SWITCH — SELL 100% {prev_state}  →  BUY 100% {curr}"
        subject     = f"QQQ SWITCH: SELL {prev_state} → BUY {curr}"

    body = (
        f"QQQ EMA-10 Signal — {date}\n"
        f"{TIMING_LABELS[timing]}\n"
        f"{'-' * 40}\n"
        f"QQQ Price : ${price:.2f}\n"
        f"EMA 10    : ${ema10:.2f}\n"
        f"Signal    : {trend} ({vs_ema})\n"
        f"Hold      : {curr}\n"
        f"\n"
        f"ACTION: {action_line}\n"
        f"\n"
        f"{TIMING_CONTEXT[timing]}\n"
    )

    if timing == "close" and prev_state and prev_state != curr:
        body += (
            f"\n"
            f"  → SELL 100% of {prev_state}\n"
            f"  → BUY  100% into {curr}\n"
        )

    body += (
        f"\n{'-' * 40}\n"
        f"Yesterday (close): {prev_state or 'n/a'}\n"
        f"Today             : {curr}\n"
    )

    return subject, body
