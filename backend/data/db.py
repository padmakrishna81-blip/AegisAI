"""
Database engine + session factory.

Uses SQLite by default (zero infrastructure, file-based).
Set DATABASE_URL env var to switch to PostgreSQL:
  DATABASE_URL=postgresql+psycopg2://user:pass@host/aegisai

The ORM layer is identical for both — just change the connection string.
"""
from __future__ import annotations
import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# ── Connection string ──────────────────────────────────────────────────────────
_default_db = str(Path(__file__).parent.parent / "aegisai.db")
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{_default_db}")

# SQLite: check_same_thread=False needed for FastAPI's threading model
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=True,    # verify connection before use (important for prod)
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency — yields a database session and closes it after use."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables if they don't exist. Called at app startup."""
    from data.models import Base as ModelBase  # noqa: F401 — triggers model registration
    ModelBase.metadata.create_all(bind=engine)
