"""Per-user broker credential store — broker_creds.json."""

from __future__ import annotations
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_FILE = Path(__file__).parent.parent / "broker_creds.json"
_lock = threading.Lock()


def _load() -> dict[str, Any]:
    if not _FILE.exists():
        return {}
    try:
        return json.loads(_FILE.read_text())
    except Exception:
        return {}


def _save(data: dict) -> None:
    _FILE.write_text(json.dumps(data, indent=2))


# ── Credential CRUD ──────────────────────────────────────────────────────────

def load_creds(username: str) -> dict:
    """Return {angelone: {...}, kotak: {...}} for the user (minus session sub-key)."""
    with _lock:
        data = _load()
        user_data = data.get(username, {})
        # Strip session tokens from public view
        result: dict[str, Any] = {}
        for broker, bdata in user_data.items():
            public = {k: v for k, v in bdata.items() if k != "session"}
            # Mask secrets in the response
            if "password" in public:
                public["password"] = "••••••••" if public["password"] else ""
            if "mpin" in public:
                public["mpin"] = "••••••••" if public["mpin"] else ""
            if "totp_secret" in public:
                public["totp_secret"] = "••••••••" if public["totp_secret"] else ""
            if "consumer_secret" in public:
                public["consumer_secret"] = "••••••••" if public["consumer_secret"] else ""
            if "api_key" in public:
                public["api_key"] = "••••••••" if public["api_key"] else ""
            result[broker] = public
        return result


def get_raw_creds(username: str, broker: str) -> dict:
    """Return raw (unmasked) credentials for use in broker connect."""
    with _lock:
        data = _load()
        bdata = data.get(username, {}).get(broker, {})
        return {k: v for k, v in bdata.items() if k != "session"}


def save_creds(username: str, broker: str, creds: dict) -> None:
    """Upsert broker credentials for a user. Preserves existing session if present."""
    with _lock:
        data = _load()
        data.setdefault(username, {}).setdefault(broker, {})
        existing_session = data[username][broker].get("session")
        data[username][broker].update(creds)
        if existing_session:
            data[username][broker]["session"] = existing_session
        _save(data)


def delete_creds(username: str, broker: str) -> None:
    """Remove all credentials (including session) for a user+broker."""
    with _lock:
        data = _load()
        if username in data and broker in data[username]:
            del data[username][broker]
            if not data[username]:
                del data[username]
            _save(data)


# ── Session management ────────────────────────────────────────────────────────

def get_session(username: str, broker: str) -> dict | None:
    """Return session dict if present and not expired, else None."""
    with _lock:
        data = _load()
        session = data.get(username, {}).get(broker, {}).get("session")
    if not session:
        return None
    expires_at = session.get("expires_at")
    if expires_at:
        try:
            exp = datetime.fromisoformat(expires_at)
            if datetime.now(timezone.utc) >= exp:
                return None
        except Exception:
            pass
    return session


def save_session(username: str, broker: str, session: dict) -> None:
    with _lock:
        data = _load()
        data.setdefault(username, {}).setdefault(broker, {})
        data[username][broker]["session"] = session
        _save(data)


def clear_session(username: str, broker: str) -> None:
    with _lock:
        data = _load()
        if username in data and broker in data[username]:
            data[username][broker].pop("session", None)
            _save(data)


# ── Status helpers ────────────────────────────────────────────────────────────

def get_status(username: str) -> dict:
    """Return {angelone: {connected, configured, expires_at}, kotak: {...}}."""
    with _lock:
        data = _load()
        user_data = data.get(username, {})

    result: dict[str, Any] = {}
    for broker in ("angelone", "kotak"):
        bdata   = user_data.get(broker, {})
        session = bdata.get("session")
        configured = bool(bdata and any(v for k, v in bdata.items() if k != "session"))
        connected  = False
        expires_at = None
        if session:
            exp_str = session.get("expires_at")
            if exp_str:
                try:
                    exp = datetime.fromisoformat(exp_str)
                    if datetime.now(timezone.utc) < exp:
                        connected  = True
                        expires_at = exp_str
                except Exception:
                    pass
        result[broker] = {
            "configured": configured,
            "connected":  connected,
            "expires_at": expires_at,
        }
    return result
