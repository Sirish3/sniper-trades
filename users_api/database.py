"""SQLAlchemy engine/session setup for this API — separate from
backend/database.py (the Flask scheduler's DB), since that one is wired to
the scheduler's own config.py (portfolio size, email alerts, etc.) which
has nothing to do with this service. Points at the same DATABASE_URL value
(a Neon Postgres instance) via this directory's own .env.
"""
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


engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
