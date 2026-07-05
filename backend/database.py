"""SQLAlchemy models and session management for the execution scheduler."""
from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from config import DATABASE_URL

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    """Single source of truth for 'now' so every row uses the same clock."""
    return datetime.now(timezone.utc)


class Signal(Base):
    """A BUY/BUY_RETEST candidate that was alerted, before it's a position."""

    __tablename__ = "signals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(10), index=True)
    signal_type: Mapped[str] = mapped_column(String(20))  # BUY | BUY_RETEST
    grade: Mapped[str] = mapped_column(String(4))
    sector_etf: Mapped[str] = mapped_column(String(10), nullable=True)
    entry_price: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float] = mapped_column(Float)
    trim1_price: Mapped[float] = mapped_column(Float)
    trim2_price: Mapped[float] = mapped_column(Float)
    shares: Mapped[int] = mapped_column(Integer)
    position_dollar: Mapped[float] = mapped_column(Float)
    risk_dollar: Mapped[float] = mapped_column(Float)
    vol_ratio: Mapped[float] = mapped_column(Float, nullable=True)
    rsi: Mapped[float] = mapped_column(Float, nullable=True)
    pivot_price: Mapped[float] = mapped_column(Float)  # 52w high used for the breakout check
    status: Mapped[str] = mapped_column(String(20), default="SENT")  # SENT | CANCELLED | ACKNOWLEDGED
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Position(Base):
    """A tracked open (or closed) swing position."""

    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(10), index=True)
    signal_id: Mapped[int] = mapped_column(Integer, nullable=True)
    grade: Mapped[str] = mapped_column(String(4), nullable=True)
    sector_etf: Mapped[str] = mapped_column(String(10), nullable=True)

    entry_price: Mapped[float] = mapped_column(Float)
    entry_date: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    shares: Mapped[int] = mapped_column(Integer)
    original_shares: Mapped[int] = mapped_column(Integer)

    current_stop: Mapped[float] = mapped_column(Float)
    atr_multiplier: Mapped[float] = mapped_column(Float, default=2.5)

    trim1_price: Mapped[float] = mapped_column(Float)
    trim1_executed: Mapped[bool] = mapped_column(Boolean, default=False)
    trim1_executed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)

    trim2_price: Mapped[float] = mapped_column(Float)
    trim2_executed: Mapped[bool] = mapped_column(Boolean, default=False)
    trim2_executed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)

    status: Mapped[str] = mapped_column(String(10), default="OPEN")  # OPEN | CLOSED
    pending_close: Mapped[bool] = mapped_column(Boolean, default=False)
    pending_close_reason: Mapped[str] = mapped_column(String(20), nullable=True)

    close_price: Mapped[float] = mapped_column(Float, nullable=True)
    close_reason: Mapped[str] = mapped_column(String(20), nullable=True)
    closed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class Trade(Base):
    """An executed action against a position — entry, trim, or exit."""

    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    position_id: Mapped[int] = mapped_column(Integer, index=True)
    ticker: Mapped[str] = mapped_column(String(10))
    action: Mapped[str] = mapped_column(String(20))  # ENTRY | TRIM1 | TRIM2 | ATR_STOP | TIME_STOP | ...
    price: Mapped[float] = mapped_column(Float)
    shares: Mapped[int] = mapped_column(Integer, nullable=True)
    pnl_pct: Mapped[float] = mapped_column(Float, nullable=True)
    executed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AlertLog(Base):
    """Every alert sent, for deduplication and audit."""

    __tablename__ = "alerts_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str] = mapped_column(String(10), index=True)
    alert_type: Mapped[str] = mapped_column(String(20), index=True)
    message: Mapped[str] = mapped_column(String(2000))
    position_id: Mapped[int] = mapped_column(Integer, nullable=True)
    signal_id: Mapped[int] = mapped_column(Integer, nullable=True)
    price: Mapped[float] = mapped_column(Float, nullable=True)
    grade: Mapped[str] = mapped_column(String(4), nullable=True)
    delivery_sid: Mapped[str] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="SENT")  # SENT | CANCELLED | ACKNOWLEDGED
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PortfolioSnapshot(Base):
    """One row per end-of-day portfolio state, for tracking performance over time."""

    __tablename__ = "portfolio_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_date: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    open_positions_value: Mapped[float] = mapped_column(Float)
    realized_pnl: Mapped[float] = mapped_column(Float)
    unrealized_pnl: Mapped[float] = mapped_column(Float)
    total_value: Mapped[float] = mapped_column(Float)
    open_positions_count: Mapped[int] = mapped_column(Integer)


engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    """Creates all tables if they don't already exist. Safe to call repeatedly."""
    Base.metadata.create_all(engine)
    logger.info("Database initialized at %s", DATABASE_URL)


@contextmanager
def get_session():
    """Context-managed session: commits on success, rolls back and re-raises on error."""
    session: Session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        logger.exception("DB session rolled back due to an error")
        raise
    finally:
        session.close()


def mark_pending_close(position_id: int, reason: str) -> None:
    """Flags a position for closure tomorrow without closing it yet."""
    with get_session() as session:
        position = session.get(Position, position_id)
        if position is None:
            logger.warning("mark_pending_close: position %s not found", position_id)
            return
        position.pending_close = True
        position.pending_close_reason = reason
        session.add(position)
    logger.info("Position %s marked pending_close (%s)", position_id, reason)
