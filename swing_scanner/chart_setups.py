"""Manually-curated "Chart Patterns" setups (see api.py's /api/setups
routes). A human — not any pattern-detection code — picks the ticker,
pattern_type, and price levels via the admin form in the React app;
Claude only drafts the description text as an editing assist.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Float, Text, DateTime, select, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, SessionLocal

STATUSES = {"draft", "published", "archived"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ChartSetup(Base):
    __tablename__ = "chart_setups"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticker: Mapped[str] = mapped_column(String(10), index=True)
    pattern_type: Mapped[str] = mapped_column(String(50), index=True)
    support_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    support_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    resistance: Mapped[float | None] = mapped_column(Float, nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    # {"trendlines": [...], "zones": [...], "hlines": [...]} — see ChartSetupAdmin.jsx
    chart_annotations: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(10), default="draft", index=True)
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "ticker": self.ticker,
            "patternType": self.pattern_type,
            "supportLow": self.support_low,
            "supportHigh": self.support_high,
            "resistance": self.resistance,
            "description": self.description,
            "chartAnnotations": self.chart_annotations or {},
            "status": self.status,
            "createdBy": self.created_by,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


def list_setups(status: str | None = "published", pattern_type: str | None = None) -> list[dict]:
    with SessionLocal() as session:
        stmt = select(ChartSetup).order_by(ChartSetup.updated_at.desc())
        if status:
            stmt = stmt.where(ChartSetup.status == status)
        if pattern_type:
            stmt = stmt.where(ChartSetup.pattern_type == pattern_type)
        return [row.to_dict() for row in session.scalars(stmt)]


def get_setup(setup_id: str) -> dict | None:
    with SessionLocal() as session:
        row = session.get(ChartSetup, setup_id)
        return row.to_dict() if row else None


def pattern_counts(status: str | None = "published") -> list[dict]:
    with SessionLocal() as session:
        stmt = select(ChartSetup.pattern_type, func.count()).group_by(ChartSetup.pattern_type)
        if status:
            stmt = stmt.where(ChartSetup.status == status)
        rows = session.execute(stmt).all()
        return [{"patternType": pattern_type, "count": count} for pattern_type, count in rows]


def create_setup(data: dict, created_by: str | None = None) -> dict:
    with SessionLocal() as session:
        row = ChartSetup(
            ticker=data["ticker"].upper(),
            pattern_type=data["patternType"],
            support_low=data.get("supportLow"),
            support_high=data.get("supportHigh"),
            resistance=data.get("resistance"),
            description=data.get("description", ""),
            chart_annotations=data.get("chartAnnotations") or {},
            status=data.get("status", "draft"),
            created_by=created_by,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.to_dict()


def update_setup(setup_id: str, data: dict) -> dict | None:
    with SessionLocal() as session:
        row = session.get(ChartSetup, setup_id)
        if row is None:
            return None

        field_map = {
            "ticker": "ticker",
            "patternType": "pattern_type",
            "supportLow": "support_low",
            "supportHigh": "support_high",
            "resistance": "resistance",
            "description": "description",
            "chartAnnotations": "chart_annotations",
            "status": "status",
        }
        for json_key, column in field_map.items():
            if json_key in data:
                value = data[json_key]
                if column == "ticker" and value:
                    value = value.upper()
                setattr(row, column, value)

        session.commit()
        session.refresh(row)
        return row.to_dict()


def delete_setup(setup_id: str) -> bool:
    with SessionLocal() as session:
        row = session.get(ChartSetup, setup_id)
        if row is None:
            return False
        session.delete(row)
        session.commit()
        return True
