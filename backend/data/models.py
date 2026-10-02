"""
SQLAlchemy ORM models — all persistent data for AegisAI.

Design philosophy:
- JSONB/JSON columns for complex nested data (easy migration from JSON files)
- Typed scalar columns for anything we query/filter on
- UUID primary keys throughout (safe for future distributed systems)
- All tables have created_at + updated_at
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean, Column, DateTime, Float, Integer,
    String, Text, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import relationship

from data.db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


# ── Users ──────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id               = Column(String(36), primary_key=True, default=_uuid)
    username         = Column(String(50), unique=True, nullable=False, index=True)
    email            = Column(String(255), unique=True, nullable=False, index=True)
    full_name        = Column(String(255), nullable=False, default="")
    hashed_password  = Column(String(255), nullable=False)
    role             = Column(String(20), nullable=False, default="paper_trader")
    # paper_trader | live_trader | admin | viewer
    is_active        = Column(Boolean, default=True, nullable=False)
    email_verified   = Column(Boolean, default=False, nullable=False)
    trial_ends_at    = Column(DateTime(timezone=True), nullable=True)
    stripe_customer  = Column(String(100), nullable=True)       # for future billing
    last_login_at    = Column(DateTime(timezone=True), nullable=True)
    created_at       = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at       = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    # Relationships
    campaigns        = relationship("Campaign", back_populates="user", cascade="all, delete-orphan")
    wheel_positions  = relationship("WheelPosition", back_populates="user", cascade="all, delete-orphan")
    wheel_config     = relationship("WheelConfig", back_populates="user", uselist=False,
                                    cascade="all, delete-orphan")
    paper_trades     = relationship("PaperTrade", back_populates="user", cascade="all, delete-orphan")
    broker_sessions  = relationship("BrokerSession", back_populates="user", cascade="all, delete-orphan")


# ── Stock Trader Campaigns ─────────────────────────────────────────────────────

class Campaign(Base):
    __tablename__ = "campaigns"

    id               = Column(String(36), primary_key=True, default=_uuid)
    user_id          = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name             = Column(String(255), nullable=False)
    broker           = Column(String(50), default="angelone")
    reserved_fund    = Column(Float, default=0)
    auto_trade       = Column(Boolean, default=False)
    status           = Column(String(20), default="active")   # active | paused | completed
    entry_condition  = Column(JSON, default=dict)             # {"type": "market_open"}
    chunk_config     = Column(JSON, default=dict)             # {"chunks": [...]}
    exit_config      = Column(JSON, default=dict)             # {"profit_target_pct": 2.0}
    split_config     = Column(JSON, default=dict)             # {"stocks_pct": 60, "etfs_pct": 40}
    created_at       = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at       = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    user             = relationship("User", back_populates="campaigns")
    stocks           = relationship("CampaignStock", back_populates="campaign",
                                    cascade="all, delete-orphan")


class CampaignStock(Base):
    __tablename__ = "campaign_stocks"

    id               = Column(String(36), primary_key=True, default=_uuid)
    campaign_id      = Column(String(36), ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    symbol           = Column(String(20), nullable=False)
    display          = Column(String(100), default="")
    sector           = Column(String(100), default="")
    cap_type         = Column(String(20), default="")
    allocation_pct   = Column(Float, default=0)
    conviction       = Column(String(10), default="MEDIUM")    # HIGH | MEDIUM | LOW
    justification    = Column(Text, default="")
    asset_type       = Column(String(10), default="stock")     # stock | etf
    status           = Column(String(30), default="watching")
    # watching | chunk1_placed | chunk2_placed | trailing_sl | exited | error
    chunk1_qty       = Column(Integer, default=0)
    chunk1_price     = Column(Float, default=0)
    chunk1_date      = Column(String(30), nullable=True)
    chunk2_qty       = Column(Integer, default=0)
    chunk2_price     = Column(Float, default=0)
    avg_price        = Column(Float, default=0)
    total_qty        = Column(Integer, default=0)
    sl_price         = Column(Float, default=0)
    current_price    = Column(Float, default=0)
    pnl              = Column(Float, default=0)
    pnl_pct          = Column(Float, default=0)
    extras           = Column(JSON, default=dict)    # broker order IDs, error messages, etc.
    updated_at       = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    campaign         = relationship("Campaign", back_populates="stocks")

    __table_args__ = (Index("ix_campaign_stocks_campaign_id", "campaign_id"),)


# ── Smart Wheel V2 Positions ───────────────────────────────────────────────────

class WheelPosition(Base):
    __tablename__ = "wheel_positions"

    id               = Column(String(36), primary_key=True, default=_uuid)
    user_id          = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    stock            = Column(String(20), nullable=False)
    expiry           = Column(String(20), nullable=False)
    dte_at_entry     = Column(Integer, default=0)
    lot_size         = Column(Integer, default=0)
    ce_strike        = Column(Float, default=0)
    ce_premium_sold  = Column(Float, default=0)
    pe_strike        = Column(Float, default=0)
    pe_premium_sold  = Column(Float, default=0)
    net_premium      = Column(Float, default=0)
    pe_be            = Column(Float, default=0)
    ce_be            = Column(Float, default=0)
    shares_phase1    = Column(Integer, default=0)
    shares_phase2    = Column(Integer, default=0)
    shares_avg_price = Column(Float, default=0)
    current_cmp      = Column(Float, default=0)
    current_mtm      = Column(Float, default=0)
    mtm_status       = Column(String(10), default="green")   # green | amber | red
    phase            = Column(String(20), default="strangle") # strangle | covered_call
    status           = Column(String(20), default="active")
    # active | covered_call | closed_profit | closed_loss
    auto_trade       = Column(Boolean, default=False)
    broker           = Column(String(20), default="angelone")
    extras           = Column(JSON, default=dict)
    entered_at       = Column(DateTime(timezone=True), default=_now)
    closed_at        = Column(DateTime(timezone=True), nullable=True)

    user             = relationship("User", back_populates="wheel_positions")

    __table_args__ = (Index("ix_wheel_positions_user_status", "user_id", "status"),)


# ── Smart Wheel V2 Config ──────────────────────────────────────────────────────

class WheelConfig(Base):
    __tablename__ = "wheel_configs"

    id                   = Column(String(36), primary_key=True, default=_uuid)
    user_id              = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"),
                                  nullable=False, unique=True)
    watchlist            = Column(JSON, default=list)
    auto_enter           = Column(Boolean, default=False)
    mtm_amber            = Column(Integer, default=-6000)
    mtm_red              = Column(Integer, default=-10000)
    telegram_bot_token   = Column(String(255), default="")
    telegram_chat_id     = Column(String(100), default="")
    updated_at           = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    user                 = relationship("User", back_populates="wheel_config")


# ── Paper Trades (Wheel paper positions) ──────────────────────────────────────

class PaperTrade(Base):
    __tablename__ = "paper_trades"

    id               = Column(String(36), primary_key=True, default=_uuid)
    user_id          = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    strategy         = Column(String(30), default="wheel")    # wheel | covered_call | strangle
    symbol           = Column(String(20), nullable=False)
    status           = Column(String(20), default="open")     # open | closed
    data             = Column(JSON, default=dict)              # full trade snapshot
    pnl              = Column(Float, default=0)
    created_at       = Column(DateTime(timezone=True), default=_now)
    closed_at        = Column(DateTime(timezone=True), nullable=True)

    user             = relationship("User", back_populates="paper_trades")

    __table_args__ = (Index("ix_paper_trades_user_status", "user_id", "status"),)


# ── Broker Sessions (encrypted credentials) ───────────────────────────────────

class BrokerSession(Base):
    __tablename__ = "broker_sessions"

    id               = Column(String(36), primary_key=True, default=_uuid)
    user_id          = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    broker           = Column(String(50), nullable=False)      # angelone | kotak
    credentials      = Column(JSON, default=dict)              # encrypted at rest in prod
    session_token    = Column(Text, nullable=True)
    expires_at       = Column(DateTime(timezone=True), nullable=True)
    created_at       = Column(DateTime(timezone=True), default=_now)
    updated_at       = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    user             = relationship("User", back_populates="broker_sessions")

    __table_args__ = (
        UniqueConstraint("user_id", "broker", name="uq_broker_sessions_user_broker"),
        Index("ix_broker_sessions_user_id", "user_id"),
    )
