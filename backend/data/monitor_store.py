"""Monitor store — server-side persistence for the Monitor tab."""

import json, os, threading
from datetime import datetime

_FILE = os.path.join(os.path.dirname(__file__), "..", "monitor_data.json")
_lock = threading.Lock()


def _load_unlocked() -> dict:
    if not os.path.exists(_FILE):
        return {"indian": [], "global": []}
    try:
        with open(_FILE) as f:
            return json.load(f)
    except Exception:
        return {"indian": [], "global": []}


def load() -> dict:
    with _lock:
        return _load_unlocked()


def _save(data: dict) -> None:
    with open(_FILE, "w") as f:
        json.dump(data, f, indent=2)


def add_stock(section: str, entry: dict) -> dict:
    with _lock:
        data = _load_unlocked()
        stocks = data.get(section, [])
        if any(s["symbol"] == entry["symbol"] for s in stocks):
            return data
        entry.setdefault("added_at", datetime.utcnow().isoformat())
        entry.setdefault("kpi_labels", [])
        entry.setdefault("quarters", {})
        stocks.append(entry)
        data[section] = stocks
        _save(data)
        return data


def remove_stock(section: str, symbol: str) -> dict:
    with _lock:
        data = _load_unlocked()
        data[section] = [s for s in data.get(section, []) if s["symbol"] != symbol]
        _save(data)
        return data


def upsert_quarter(section: str, symbol: str, quarter: str, patch: dict) -> dict:
    with _lock:
        data = _load_unlocked()
        for stock in data.get(section, []):
            if stock["symbol"] == symbol:
                if quarter not in stock["quarters"]:
                    stock["quarters"][quarter] = {}
                stock["quarters"][quarter].update(patch)
                break
        _save(data)
        return data


def update_kpi_labels(section: str, symbol: str, labels: list) -> dict:
    with _lock:
        data = _load_unlocked()
        for stock in data.get(section, []):
            if stock["symbol"] == symbol:
                stock["kpi_labels"] = labels
                break
        _save(data)
        return data
