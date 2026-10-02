"""Persists Smart Wheel V2 positions and per-user config (watchlist, thresholds, WhatsApp)."""
from __future__ import annotations
import json, threading, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_POSITIONS_FILE = Path(__file__).parent.parent / "wheel_v2_positions.json"
_CONFIG_FILE    = Path(__file__).parent.parent / "wheel_v2_config.json"
_lock = threading.Lock()


def _load_pos() -> dict:
    if not _POSITIONS_FILE.exists():
        return {}
    try:
        return json.loads(_POSITIONS_FILE.read_text())
    except Exception:
        return {}


def _save_pos(data: dict) -> None:
    _POSITIONS_FILE.write_text(json.dumps(data, indent=2))


def _load_cfg() -> dict:
    if not _CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(_CONFIG_FILE.read_text())
    except Exception:
        return {}


def _save_cfg(data: dict) -> None:
    _CONFIG_FILE.write_text(json.dumps(data, indent=2))


# ── Positions ─────────────────────────────────────────────────────────────────

def get_positions(username: str) -> list[dict]:
    with _lock:
        data = _load_pos()
    return list(data.get(username, {}).values())


def get_active_position(username: str) -> dict | None:
    for p in get_positions(username):
        if p.get("status") in ("active", "covered_call"):
            return p
    return None


def get_position(username: str, position_id: str) -> dict | None:
    with _lock:
        data = _load_pos()
    return data.get(username, {}).get(position_id)


def save_position(username: str, position: dict) -> str:
    if not position.get("id"):
        position["id"] = str(uuid.uuid4())[:8]
    with _lock:
        data = _load_pos()
        data.setdefault(username, {})[position["id"]] = position
        _save_pos(data)
    return position["id"]


def update_position(username: str, position_id: str, patch: dict) -> bool:
    with _lock:
        data = _load_pos()
        if username not in data or position_id not in data[username]:
            return False
        data[username][position_id].update(patch)
        _save_pos(data)
    return True


# ── Config ────────────────────────────────────────────────────────────────────

_DEFAULT_CONFIG = {
    "watchlist":            [],
    "auto_enter":           False,
    "mtm_amber":            -6000,
    "mtm_red":              -10000,
    "telegram_bot_token":   "",
    "telegram_chat_id":     "",
}


def get_config(username: str) -> dict:
    with _lock:
        data = _load_cfg()
    cfg = dict(_DEFAULT_CONFIG)
    cfg.update(data.get(username, {}))
    return cfg


def save_config(username: str, cfg: dict) -> None:
    with _lock:
        data = _load_cfg()
        existing = dict(_DEFAULT_CONFIG)
        existing.update(data.get(username, {}))
        existing.update(cfg)
        data[username] = existing
        _save_cfg(data)
