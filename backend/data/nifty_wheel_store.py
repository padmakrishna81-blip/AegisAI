"""Persists NIFTY Wheel + NIFTYBEES accumulation strategy state per user."""
from __future__ import annotations
import json, threading, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_STATE_FILE = Path(__file__).parent.parent / "nifty_wheel_state.json"
_lock = threading.Lock()

TOTAL_CYCLES = 4
NIFTYBEES_BUY1 = 1000   # units per first tranche
NIFTYBEES_BUY2 = 600    # units per second tranche


def _empty_cycles() -> list[dict]:
    return [
        {
            "cycle_num": i,
            "status": "pending",
            "buy1_qty": 0, "buy1_price": None, "buy1_date": None, "buy1_order_id": None,
            "buy2_qty": 0, "buy2_price": None, "buy2_date": None, "buy2_order_id": None,
            "started_at": None, "completed_at": None,
        }
        for i in range(1, TOTAL_CYCLES + 1)
    ]


def _empty_state() -> dict:
    return {
        "phase": 1,
        "niftybees_total_units": 0,
        "niftybees_avg_price": 0.0,
        "cycles": _empty_cycles(),
        "option_positions": [],
        "direction_history": [],
    }


def _load() -> dict:
    if not _STATE_FILE.exists():
        return {}
    try:
        return json.loads(_STATE_FILE.read_text())
    except Exception:
        return {}


def _save(data: dict) -> None:
    _STATE_FILE.write_text(json.dumps(data, indent=2))


def get_state(username: str) -> dict:
    with _lock:
        data = _load()
    state = data.get(username)
    if state is None:
        return _empty_state()
    full = _empty_state()
    full.update(state)
    return full


def save_state(username: str, state: dict) -> None:
    with _lock:
        data = _load()
        data[username] = state
        _save(data)


def add_option_position(username: str, pos: dict) -> str:
    pos_id = str(uuid.uuid4())[:8]
    pos["id"] = pos_id
    pos.setdefault("entered_at", datetime.now(timezone.utc).isoformat())
    pos.setdefault("status", "active")
    with _lock:
        data = _load()
        state = data.get(username, _empty_state())
        state["option_positions"].append(pos)
        data[username] = state
        _save(data)
    return pos_id


def delete_option_position(username: str, pos_id: str) -> bool:
    """Hard-delete a position (record-only — no broker order)."""
    with _lock:
        data = _load()
        state = data.get(username)
        if not state:
            return False
        before = len(state["option_positions"])
        state["option_positions"] = [p for p in state["option_positions"] if p.get("id") != pos_id]
        if len(state["option_positions"]) < before:
            data[username] = state
            _save(data)
            return True
    return False


def update_option_position(username: str, pos_id: str, patch: dict) -> bool:
    with _lock:
        data = _load()
        state = data.get(username)
        if not state:
            return False
        for p in state["option_positions"]:
            if p.get("id") == pos_id:
                p.update(patch)
                data[username] = state
                _save(data)
                return True
    return False


def add_direction_entry(username: str, entry: dict) -> None:
    with _lock:
        data = _load()
        state = data.get(username, _empty_state())
        state["direction_history"].append(entry)
        state["direction_history"] = state["direction_history"][-90:]
        data[username] = state
        _save(data)


def update_cycle(username: str, cycle_num: int, patch: dict) -> bool:
    with _lock:
        data = _load()
        state = data.get(username, _empty_state())
        for cyc in state["cycles"]:
            if cyc["cycle_num"] == cycle_num:
                cyc.update(patch)
                data[username] = state
                _save(data)
                return True
    return False


def recalc_etf_totals(username: str) -> None:
    """Recompute total units and avg price from cycle data."""
    with _lock:
        data = _load()
        state = data.get(username, _empty_state())
        total_qty = 0
        total_cost = 0.0
        for cyc in state["cycles"]:
            for field, price_field in [("buy1_qty", "buy1_price"), ("buy2_qty", "buy2_price")]:
                qty = cyc.get(field) or 0
                price = cyc.get(price_field) or 0.0
                if qty and price:
                    total_qty += qty
                    total_cost += qty * price
        state["niftybees_total_units"] = total_qty
        state["niftybees_avg_price"] = round(total_cost / total_qty, 4) if total_qty else 0.0
        if total_qty >= TOTAL_CYCLES * (NIFTYBEES_BUY1 + NIFTYBEES_BUY2):
            state["phase"] = 2
        data[username] = state
        _save(data)
