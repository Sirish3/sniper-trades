"""Signal grading, trade-plan sizing, and end-of-day signal validation."""
from __future__ import annotations

import logging
import math
from datetime import datetime

import pytz
import yfinance as yf

from config import ATR_MULT, RISK_PCT
from database import Signal, get_session
from utils import utc_to_et, yf_symbol

logger = logging.getLogger(__name__)

ET = pytz.timezone("US/Eastern")


def classify(sig: dict) -> str:
    """A+/A/B/C from volume confirmation, RSI zone, and proximity to the high.

    This is a lightweight proxy (no cross-sectional RS rank or sector heat
    available here) — same honest caveat as the JS backtester's grade.
    """
    score = 0.0
    vol_ratio = sig.get("vol_ratio") or 0
    rsi_value = sig.get("rsi") or 0
    pct_from_high = sig.get("pct_from_high") or -100

    if vol_ratio >= 2.5:
        score += 2.0
    elif vol_ratio >= 1.5:
        score += 1.5
    elif vol_ratio >= 1.2:
        score += 0.5

    if 55 <= rsi_value <= 72:
        score += 1.5
    elif 45 <= rsi_value <= 78:
        score += 0.75

    if pct_from_high >= -1:
        score += 1.5
    elif pct_from_high >= -5:
        score += 1.0

    score += 1.5  # EMA stack assumed aligned at breakout
    score += 1.0  # ADX proxy bonus

    if score >= 8.5:
        return "A+"
    if score >= 7.0:
        return "A"
    if score >= 5.0:
        return "B"
    return "C"


def calculate_trade_plan(sig: dict, portfolio_size: float, regime: str | None = None) -> dict:
    """Entry/stop/trim/sizing plan for a signal at full position size.

    `regime` is accepted (and logged) but NOT applied as a size multiplier
    here — the scheduler's RISK_NEUTRAL halving happens once, explicitly,
    after this call. Applying it here too would silently quarter the size
    instead of halving it.
    """
    entry = float(sig["price"])
    atr_value = float(sig.get("atr") or 0)
    stop = max(entry - ATR_MULT * atr_value, entry * 0.92)
    stop_dist = entry - stop
    if stop_dist <= 0:
        return {"viable": False, "reason": "No positive stop distance"}

    trim1 = entry + 1.5 * stop_dist
    trim2 = entry + 2.5 * stop_dist
    shares = math.floor((portfolio_size * RISK_PCT) / stop_dist)
    position_dollar = shares * entry
    risk_dollar = shares * stop_dist

    logger.info("calculate_trade_plan(%s): regime=%s entry=%.2f stop=%.2f shares=%d", sig.get("ticker"), regime, entry, stop, shares)

    return {
        "viable": shares > 0,
        "entry": entry,
        "stop": stop,
        "stop_pct": stop_dist / entry * 100,
        "trim1": trim1,
        "trim2": trim2,
        "shares": shares,
        "position_dollar": position_dollar,
        "risk_dollar": risk_dollar,
        "risk_pct": (risk_dollar / portfolio_size * 100) if portfolio_size else 0,
    }


def save_signal(sig: dict, plan: dict, grade: str) -> int:
    """Persists a sent BUY/BUY_RETEST signal and returns its row id."""
    with get_session() as session:
        row = Signal(
            ticker=sig["ticker"],
            signal_type=sig.get("signal_type", "BUY"),
            grade=grade,
            sector_etf=sig.get("sector_etf"),
            entry_price=plan["entry"],
            stop_price=plan["stop"],
            trim1_price=plan["trim1"],
            trim2_price=plan["trim2"],
            shares=plan["shares"],
            position_dollar=plan["position_dollar"],
            risk_dollar=plan["risk_dollar"],
            vol_ratio=sig.get("vol_ratio"),
            rsi=sig.get("rsi"),
            pivot_price=sig["pivot"],
        )
        session.add(row)
        session.flush()
        return row.id


def validate_close_signals() -> list[dict]:
    """Checks today's BUY/BUY_RETEST signals against the close; cancels any
    that failed to close above their breakout pivot.
    """
    today_et = datetime.now(ET).date()
    cancelled: list[dict] = []

    with get_session() as session:
        todays_signals = [
            s for s in session.query(Signal)
            .filter(Signal.signal_type.in_(["BUY", "BUY_RETEST"]))
            .filter(Signal.status == "SENT")
            .all()
            if utc_to_et(s.sent_at).date() == today_et
        ]

        for sig in todays_signals:
            try:
                close = float(yf.Ticker(yf_symbol(sig.ticker)).fast_info["last_price"])
            except Exception as exc:
                logger.warning("validate_close_signals: price fetch failed for %s (%s)", sig.ticker, exc)
                continue

            if close < sig.pivot_price:
                sig.status = "CANCELLED"
                session.add(sig)
                cancelled.append({
                    "ticker": sig.ticker,
                    "pivot": sig.pivot_price,
                    "close": close,
                    "alert_id": sig.id,
                })

    logger.info("validate_close_signals: %d of %d signals cancelled", len(cancelled), len(todays_signals))
    return cancelled
