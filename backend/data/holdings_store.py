import json
import threading
import uuid
from datetime import datetime
from pathlib import Path

_FILE = Path(__file__).parent.parent / "holdings_data.json"
_lock = threading.Lock()


def _default() -> dict:
    return {
        "account_holders": ["Self", "Mother", "HUF"],
        "holdings": [],
    }


def _load_unlocked() -> dict:
    if not _FILE.exists():
        return _default()
    try:
        return json.loads(_FILE.read_text())
    except Exception:
        return _default()


def _save(data: dict) -> None:
    _FILE.write_text(json.dumps(data, indent=2))


def load() -> dict:
    with _lock:
        return _load_unlocked()


def get_account_holders() -> list[str]:
    with _lock:
        return _load_unlocked().get("account_holders", ["Self", "Mother", "HUF"])


def set_account_holders(holders: list[str]) -> dict:
    with _lock:
        data = _load_unlocked()
        data["account_holders"] = holders
        _save(data)
        return data


def add(entry: dict) -> dict:
    with _lock:
        data = _load_unlocked()
        entry["id"] = str(uuid.uuid4())
        entry["added_at"] = datetime.utcnow().isoformat()
        data["holdings"].append(entry)
        _save(data)
        return data


def update(holding_id: str, patch: dict) -> dict | None:
    with _lock:
        data = _load_unlocked()
        for i, h in enumerate(data["holdings"]):
            if h["id"] == holding_id:
                # Preserve immutable fields
                patch.pop("id", None)
                patch.pop("added_at", None)
                data["holdings"][i] = {**h, **patch}
                _save(data)
                return data
        return None


def remove(holding_id: str) -> bool:
    with _lock:
        data = _load_unlocked()
        before = len(data["holdings"])
        data["holdings"] = [h for h in data["holdings"] if h["id"] != holding_id]
        if len(data["holdings"]) < before:
            _save(data)
            return True
        return False


def bulk_add(entries: list[dict]) -> tuple[dict, int]:
    with _lock:
        data = _load_unlocked()
        count = 0
        for entry in entries:
            entry["id"] = str(uuid.uuid4())
            entry["added_at"] = datetime.utcnow().isoformat()
            data["holdings"].append(entry)
            count += 1
        _save(data)
        return data, count
