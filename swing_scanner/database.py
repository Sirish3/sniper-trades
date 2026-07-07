"""SQLAlchemy engine/session setup for swing_scanner's own tables (currently
just chart_setups — see chart_setups.py). Separate from backend/database.py
(the execution scheduler's DB) and users_api/database.py, since each Python
service in this repo owns its own engine/session rather than importing a
shared Base across process/deploy boundaries. Points at the same Neon
Postgres instance via this directory's own .env (DATABASE_URL).
"""
from __future__ import annotations

import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set — copy .env.example to .env and fill it in")


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, pool_pre_ping=True)  # Neon can drop idle connections; ping before reuse instead of erroring
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    """Creates all tables if they don't already exist. Safe to call repeatedly."""
    Base.metadata.create_all(engine)
