"""Thread-safe JSON store for AI-generated trades (ai_trades.json)."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_FILE = Path(__file__).parent.parent / "ai_trades.json"
_lock = threading.Lock()


def _load() -> list[dict]:
    if not _FILE.exists():
        return []
    try:
        return json.loads(_FILE.read_text())
    except Exception:
        return []


def _save(trades: list[dict]) -> None:
    _FILE.write_text(json.dumps(trades, indent=2))


def save_trade(trade: dict) -> dict:
    """Insert a new trade record. Assigns id + entered_at if missing. Returns saved record."""
    with _lock:
        trades = _load()
        trade = {
            "id":           trade.get("id") or str(uuid.uuid4()),
            "entered_at":   trade.get("entered_at") or datetime.now(timezone.utc).isoformat(),
            "status":       trade.get("status", "active"),
            **trade,
        }
        trades.append(trade)
        _save(trades)
    return trade


def list_trades(username: str = "", status: str = "active") -> list[dict]:
    """Return trades filtered by username and status. Empty username → all users."""
    with _lock:
        trades = _load()
    result = []
    for t in trades:
        if username and t.get("username") != username:
            continue
        if status and t.get("status") != status:
            continue
        result.append(t)
    return sorted(result, key=lambda x: x.get("entered_at", ""), reverse=True)


def get_trade(trade_id: str) -> dict | None:
    with _lock:
        trades = _load()
    return next((t for t in trades if t.get("id") == trade_id), None)


def update_trade(trade_id: str, updates: dict) -> dict | None:
    """Merge updates into existing trade. Returns updated record or None."""
    with _lock:
        trades = _load()
        for i, t in enumerate(trades):
            if t.get("id") == trade_id:
                trades[i] = {**t, **updates, "id": trade_id}
                _save(trades)
                return trades[i]
    return None


def close_trade(trade_id: str, close_note: str = "") -> dict | None:
    """Mark a trade as closed."""
    updates: dict[str, Any] = {
        "status":    "closed",
        "closed_at": datetime.now(timezone.utc).isoformat(),
    }
    if close_note:
        updates["close_note"] = close_note
    return update_trade(trade_id, updates)
