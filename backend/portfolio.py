"""Position lifecycle: stop/time/trim checks, trailing-stop updates, closes,
and end-of-day snapshots. Every read of "today's price" goes through
yfinance fast_info/history with a try/except — a single ticker failing
never aborts the whole pass.
"""
from __future__ import annotations

import logging
from datetime import datetime

import pandas_market_calendars as mcal
import pytz
import yfinance as yf

from config import ATR_MULT, PORTFOLIO_SIZE
from database import Position, Trade, PortfolioSnapshot, get_session, utcnow
from indicators import atr
from utils import yf_symbol

logger = logging.getLogger(__name__)

ET = pytz.timezone("US/Eastern")
NYSE = mcal.get_calendar("NYSE")
TIME_STOP_DAYS = 10


def _days_since(dt: datetime | None) -> int:
    """Calendar days between `dt` and now — robust to SQLite round-tripping
    a DateTime column back as naive even when it was written timezone-aware.
    """
    if dt is None:
        return 0
    now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.utcnow()
    return max((now - dt).days, 0)


def create_position_from_signal(sig: dict, plan: dict, grade: str, signal_id: int | None = None) -> int:
    """Auto-creates an OPEN position the moment a BUY alert is sent,
    assuming a fill at the calculated entry price and full share size —
    chosen explicitly over a manual fill-confirmation step. This will
    drift from reality whenever the real fill price/size differs, or the
    trade is skipped entirely; there is no reconciliation step.
    """
    with get_session() as session:
        position = Position(
            ticker=sig["ticker"],
            signal_id=signal_id,
            grade=grade,
            sector_etf=sig.get("sector_etf"),
            entry_price=plan["entry"],
            shares=plan["shares"],
            original_shares=plan["shares"],
            current_stop=plan["stop"],
            atr_multiplier=ATR_MULT,
            trim1_price=plan["trim1"],
            trim2_price=plan["trim2"],
        )
        session.add(position)
        session.flush()
        position_id = position.id
        session.add(Trade(position_id=position_id, ticker=sig["ticker"], action="ENTRY", price=plan["entry"], shares=plan["shares"]))

    logger.info("Position auto-created: %s entry=%.2f shares=%d", sig["ticker"], plan["entry"], plan["shares"])
    return position_id


def create_manual_position(ticker: str, entry_price: float, shares: int, entry_date: datetime | None = None,
                            grade: str | None = None, sector_etf: str | None = None) -> int:
    """Creates an OPEN Position for a stock you already hold and are
    tracking manually — not found by this scheduler's own breakout scan.

    Stop/trim levels are derived the same way calculate_trade_plan() derives
    them for scan-found signals (entry - ATR_MULT*ATR, floored at 8% risk;
    1.5R/2.5R trims), but using YOUR given shares rather than deriving share
    count from a risk budget. Once created, this row is indistinguishable
    from a scan-found position to check_stops/check_trim_targets/
    update_trailing_stops/check_time_stops — those are already generic over
    any OPEN Position, so the existing 2PM/3:50PM scheduled jobs pick it up
    and email trim/stop alerts with no further wiring needed.
    """
    df = fetch_bars_for_ticker(ticker, period="3mo")
    if df is None or len(df) < 20:
        raise ValueError(f"Could not fetch enough price history for {ticker}")

    atr14 = float(atr(df, 14).iloc[-1])
    stop = max(entry_price - ATR_MULT * atr14, entry_price * 0.92)
    stop_dist = entry_price - stop
    if stop_dist <= 0:
        raise ValueError("No positive stop distance for this entry price")

    trim1 = entry_price + 1.5 * stop_dist
    trim2 = entry_price + 2.5 * stop_dist

    with get_session() as session:
        position = Position(
            ticker=ticker,
            signal_id=None,
            grade=grade,
            sector_etf=sector_etf,
            entry_price=entry_price,
            entry_date=entry_date or utcnow(),
            shares=shares,
            original_shares=shares,
            current_stop=stop,
            atr_multiplier=ATR_MULT,
            trim1_price=trim1,
            trim2_price=trim2,
        )
        session.add(position)
        session.flush()
        position_id = position.id
        session.add(Trade(position_id=position_id, ticker=ticker, action="ENTRY", price=entry_price, shares=shares))

    logger.info("Manual position created: %s entry=%.2f shares=%d stop=%.2f", ticker, entry_price, shares, stop)
    return position_id


def check_stops() -> list[dict]:
    """Finds OPEN positions whose latest daily close has fallen below the
    ATR trailing stop. Uses close only — never an intraday price — so a
    stop is never triggered by a wick that recovers by end of day.
    """
    results: list[dict] = []
    with get_session() as session:
        positions = session.query(Position).filter(Position.status == "OPEN", Position.pending_close == False).all()  # noqa: E712
        for position in positions:
            try:
                close = float(yf.Ticker(yf_symbol(position.ticker)).fast_info["last_price"])
            except Exception as exc:
                logger.warning("check_stops: price fetch failed for %s (%s)", position.ticker, exc)
                continue

            if close < position.current_stop:
                pnl_pct = (close - position.entry_price) / position.entry_price * 100
                days_held = _days_since(position.entry_date)
                result = {
                    "position_id": position.id,
                    "ticker": position.ticker,
                    "entry": position.entry_price,
                    "close": close,
                    "stop": position.current_stop,
                    "pnl_pct": pnl_pct,
                    "days_held": max(days_held, 0),
                    "trim1_hit": position.trim1_executed,
                    "trim2_hit": position.trim2_executed,
                    "reason": "ATR_STOP",
                }
                results.append(result)
                logger.info("STOP HIT: %s close=%.2f stop=%.2f pnl=%.1f%%", position.ticker, close, position.current_stop, pnl_pct)
    return results


def check_time_stops() -> list[dict]:
    """Finds OPEN positions held >= 10 trading days (NYSE calendar, holidays
    excluded) without ever hitting Trim 1 — dead capital, time to exit.
    """
    results: list[dict] = []
    today = datetime.now(ET).date()

    with get_session() as session:
        positions = (
            session.query(Position)
            .filter(Position.status == "OPEN", Position.trim1_executed == False, Position.pending_close == False)  # noqa: E712
            .all()
        )
        for position in positions:
            entry_date = position.entry_date.date() if hasattr(position.entry_date, "date") else position.entry_date
            if entry_date >= today:
                continue

            schedule = NYSE.schedule(start_date=entry_date, end_date=today)
            trading_days_held = max(len(schedule) - 1, 0)  # exclude entry day itself
            if trading_days_held < TIME_STOP_DAYS:
                continue

            try:
                close = float(yf.Ticker(yf_symbol(position.ticker)).fast_info["last_price"])
            except Exception as exc:
                logger.warning("check_time_stops: price fetch failed for %s (%s)", position.ticker, exc)
                continue

            pnl_pct = (close - position.entry_price) / position.entry_price * 100
            results.append({
                "position_id": position.id,
                "ticker": position.ticker,
                "entry": position.entry_price,
                "close": close,
                "stop": position.current_stop,
                "pnl_pct": pnl_pct,
                "days_held": trading_days_held,
                "trim1_hit": position.trim1_executed,
                "trim2_hit": position.trim2_executed,
                "reason": "TIME_STOP",
            })
            logger.info("TIME STOP: %s held %d trading days, no Trim 1", position.ticker, trading_days_held)
    return results


def check_trim_targets() -> list[dict]:
    """Finds OPEN positions whose current price has crossed Trim 1 or Trim
    2. Does NOT write to the DB — that happens in execute_trim() after the
    alert is confirmed sent, per the original design.
    """
    results: list[dict] = []
    with get_session() as session:
        positions = session.query(Position).filter(Position.status == "OPEN", Position.pending_close == False).all()  # noqa: E712
        for position in positions:
            try:
                price = float(yf.Ticker(yf_symbol(position.ticker)).fast_info["last_price"])
            except Exception as exc:
                logger.warning("check_trim_targets: price fetch failed for %s (%s)", position.ticker, exc)
                continue

            trim_shares = max(position.original_shares // 4, 1)
            pnl_pct = (price - position.entry_price) / position.entry_price * 100

            if not position.trim1_executed and price >= position.trim1_price:
                results.append({
                    "position_id": position.id,
                    "ticker": position.ticker,
                    "action": "TRIM_1",
                    "current_price": price,
                    "trim_price": position.trim1_price,
                    "shares_to_sell": trim_shares,
                    "shares_remaining": position.shares - trim_shares,
                    "new_stop": position.entry_price,
                    "pnl_pct": pnl_pct,
                })
            elif position.trim1_executed and not position.trim2_executed and price >= position.trim2_price:
                results.append({
                    "position_id": position.id,
                    "ticker": position.ticker,
                    "action": "TRIM_2",
                    "current_price": price,
                    "trim_price": position.trim2_price,
                    "shares_to_sell": trim_shares,
                    "shares_remaining": position.shares - trim_shares,
                    "new_stop": position.trim1_price,
                    "pnl_pct": pnl_pct,
                })
    return results


def update_trailing_stops(exclude_ids: list[int] | None = None) -> None:
    """End of day: ratchets the ATR trailing stop UP for every OPEN
    position not already being closed today. The stop never moves down.
    """
    exclude = set(exclude_ids or [])
    with get_session() as session:
        positions = session.query(Position).filter(Position.status == "OPEN", Position.pending_close == False).all()  # noqa: E712
        for position in positions:
            if position.id in exclude:
                continue
            try:
                df = yf.Ticker(yf_symbol(position.ticker)).history(period="2mo")
                if df.empty or len(df) < 15:
                    continue
                close = float(df["Close"].iloc[-1])
                atr14 = float(atr(df, 14).iloc[-1])
            except Exception as exc:
                logger.warning("update_trailing_stops: fetch failed for %s (%s)", position.ticker, exc)
                continue

            multiplier = position.atr_multiplier or ATR_MULT
            new_stop = close - atr14 * multiplier

            if position.trim1_executed and new_stop < position.entry_price:
                new_stop = position.entry_price

            if new_stop > position.current_stop:
                old_stop = position.current_stop
                position.current_stop = new_stop
                session.add(position)
                logger.info("Stop updated: %s %.2f -> %.2f", position.ticker, old_stop, new_stop)


def execute_trim(position_id: int, action: str) -> None:
    """Marks Trim 1/Trim 2 executed and ratchets the stop — called after
    the TRIM alert has been sent and confirmed.
    """
    with get_session() as session:
        position = session.get(Position, position_id)
        if position is None:
            logger.warning("execute_trim: position %s not found", position_id)
            return

        trim_shares = max(position.original_shares // 4, 1)
        if action == "TRIM_1":
            position.trim1_executed = True
            position.trim1_executed_at = utcnow()
            position.current_stop = position.entry_price
            position.shares = max(position.shares - trim_shares, 0)
            trade_action, price = "TRIM1", position.trim1_price
        elif action == "TRIM_2":
            position.trim2_executed = True
            position.trim2_executed_at = utcnow()
            position.current_stop = position.trim1_price
            position.shares = max(position.shares - trim_shares, 0)
            trade_action, price = "TRIM2", position.trim2_price
        else:
            logger.warning("execute_trim: unknown action %s", action)
            return

        pnl_pct = (price - position.entry_price) / position.entry_price * 100
        ticker = position.ticker
        session.add(position)
        session.add(Trade(position_id=position.id, ticker=ticker, action=trade_action, price=price, shares=trim_shares, pnl_pct=pnl_pct))

    logger.info("execute_trim: %s %s at %.2f", action, position_id, price)


def close_position(position_id: int, exit_price: float, reason: str) -> None:
    """Marks a position fully CLOSED and logs the final blended P&L."""
    with get_session() as session:
        position = session.get(Position, position_id)
        if position is None:
            logger.warning("close_position: position %s not found", position_id)
            return

        if position.trim1_executed and position.trim2_executed:
            blended = position.trim1_price * 0.25 + position.trim2_price * 0.25 + exit_price * 0.50
        elif position.trim1_executed:
            blended = position.trim1_price * 0.25 + exit_price * 0.75
        else:
            blended = exit_price

        pnl_pct = (blended - position.entry_price) / position.entry_price * 100
        entry_price, ticker = position.entry_price, position.ticker

        position.status = "CLOSED"
        position.closed_at = utcnow()
        position.close_price = exit_price
        position.close_reason = reason
        position.pending_close = False
        session.add(position)
        session.add(Trade(position_id=position.id, ticker=ticker, action=reason, price=exit_price, pnl_pct=pnl_pct))

    logger.info("Position closed: %s entry=%.2f exit=%.2f pnl=%.1f%% reason=%s", ticker, entry_price, exit_price, pnl_pct, reason)


def save_portfolio_snapshot() -> None:
    """End of day: records open value, realized P&L (this month's closed
    trades), and unrealized P&L across all OPEN positions.
    """
    now = datetime.now(ET)
    month_start = ET.localize(datetime(now.year, now.month, 1))

    with get_session() as session:
        open_positions = session.query(Position).filter(Position.status == "OPEN").all()

        open_value = 0.0
        unrealized_pnl_sum = 0.0
        for position in open_positions:
            try:
                price = float(yf.Ticker(yf_symbol(position.ticker)).fast_info["last_price"])
            except Exception as exc:
                logger.warning("save_portfolio_snapshot: price fetch failed for %s (%s) — skipping", position.ticker, exc)
                continue
            open_value += position.shares * price
            unrealized_pnl_sum += (price - position.entry_price) / position.entry_price * 100

        realized_trades = (
            session.query(Trade)
            .filter(Trade.action.in_(["ATR_STOP", "TIME_STOP", "TRIM1", "TRIM2"]))
            .filter(Trade.executed_at >= month_start)
            .all()
        )
        realized_pnl = sum(t.pnl_pct for t in realized_trades if t.pnl_pct is not None)

        session.add(PortfolioSnapshot(
            open_positions_value=open_value,
            realized_pnl=realized_pnl,
            unrealized_pnl=unrealized_pnl_sum,
            total_value=PORTFOLIO_SIZE + open_value,
            open_positions_count=len(open_positions),
        ))

    logger.info(
        "Portfolio snapshot saved: open_value=%.0f realized_pnl=%.1f%% unrealized_pnl=%.1f%%",
        open_value, realized_pnl, unrealized_pnl_sum,
    )


def fetch_bars_for_ticker(ticker: str, period: str = "1y"):
    """Daily OHLCV history for one ticker, or None on failure."""
    try:
        df = yf.Ticker(yf_symbol(ticker)).history(period=period)
        return df if not df.empty else None
    except Exception as exc:
        logger.warning("fetch_bars_for_ticker(%s): %s", ticker, exc)
        return None
