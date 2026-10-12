"""JSON-backed store for active Custom Fly positions."""

import json
import os
import threading

_LOCK = threading.Lock()
_PATH = os.path.join(os.path.dirname(__file__), "..", "fly_positions.json")


def _load() -> dict:
    try:
        with open(_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(data: dict) -> None:
    with open(_PATH, "w") as f:
        json.dump(data, f, indent=2, default=str)


def get_positions(username: str) -> list:
    with _LOCK:
        data = _load()
        return data.get(username, {}).get("positions", [])


def add_position(username: str, position: dict) -> None:
    with _LOCK:
        data = _load()
        user_data = data.setdefault(username, {"positions": []})
        user_data["positions"].append(position)
        _save(data)


def update_position(username: str, position_id: str, updates: dict) -> bool:
    with _LOCK:
        data = _load()
        positions = data.get(username, {}).get("positions", [])
        for p in positions:
            if p["id"] == position_id:
                p.update(updates)
                _save(data)
                return True
        return False


def get_all_active() -> list:
    """Return all active positions across all users (for the monitor thread)."""
    with _LOCK:
        data = _load()
        result = []
        for username, user_data in data.items():
            for p in user_data.get("positions", []):
                if p.get("status") == "active":
                    result.append({**p, "_username": username})
        return result
