"""Thread-safe JSON store for AI Stock Trader campaigns and trade logs."""
from __future__ import annotations
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

_STORE_PATH = Path(__file__).parent.parent / "stock_trader.json"
_lock = threading.Lock()

_EMPTY: dict = {"campaigns": {}, "trade_logs": {}, "monthly_reports": {}}


def _load() -> dict:
    try:
        if _STORE_PATH.exists():
            return json.loads(_STORE_PATH.read_text())
    except Exception:
        pass
    return {"campaigns": {}, "trade_logs": {}, "monthly_reports": {}}


def _save(data: dict) -> None:
    _STORE_PATH.write_text(json.dumps(data, indent=2, default=str))


# ── Campaigns ─────────────────────────────────────────────────────────────────

def create_campaign(campaign: dict) -> dict:
    with _lock:
        data = _load()
        cid = str(uuid.uuid4())[:8]
        campaign = {**campaign, "id": cid, "created_at": datetime.now(timezone.utc).isoformat()}
        data["campaigns"][cid] = campaign
        _save(data)
        return campaign


def get_campaign(cid: str) -> dict | None:
    with _lock:
        return _load()["campaigns"].get(cid)


def list_campaigns(username: str) -> list[dict]:
    with _lock:
        data = _load()
        return [c for c in data["campaigns"].values() if c.get("username") == username]


def update_campaign(cid: str, updates: dict) -> dict | None:
    with _lock:
        data = _load()
        if cid not in data["campaigns"]:
            return None
        data["campaigns"][cid].update(updates)
        data["campaigns"][cid]["updated_at"] = datetime.now(timezone.utc).isoformat()
        _save(data)
        return data["campaigns"][cid]


def delete_campaign(cid: str) -> bool:
    with _lock:
        data = _load()
        if cid not in data["campaigns"]:
            return False
        del data["campaigns"][cid]
        data.get("trade_logs", {}).pop(cid, None)
        _save(data)
        return True


# ── Trade log ─────────────────────────────────────────────────────────────────

def log_trade(cid: str, entry: dict) -> None:
    with _lock:
        data = _load()
        data.setdefault("trade_logs", {}).setdefault(cid, [])
        data["trade_logs"][cid].append({
            **entry,
            "logged_at": datetime.now(timezone.utc).isoformat(),
        })
        _save(data)


def get_trade_log(cid: str) -> list[dict]:
    with _lock:
        return _load().get("trade_logs", {}).get(cid, [])


# ── Monthly reports ───────────────────────────────────────────────────────────

def save_monthly_report(username: str, year_month: str, report: dict) -> None:
    with _lock:
        data = _load()
        data.setdefault("monthly_reports", {}).setdefault(username, {})[year_month] = {
            **report,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        _save(data)


def get_monthly_report(username: str, year_month: str) -> dict | None:
    with _lock:
        return _load().get("monthly_reports", {}).get(username, {}).get(year_month)


def list_monthly_reports(username: str) -> list[dict]:
    with _lock:
        reports = _load().get("monthly_reports", {}).get(username, {})
        return [{"year_month": k, **v} for k, v in sorted(reports.items(), reverse=True)]
