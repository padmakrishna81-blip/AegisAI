"""Persistent store for monitored multi-leg strategies."""

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_FILE = Path(__file__).parent.parent / "strategy_monitor.json"
_lock = threading.Lock()


def _load_unlocked() -> list[dict]:
    if not _FILE.exists():
        return []
    try:
        data = json.loads(_FILE.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save(strategies: list[dict]) -> None:
    _FILE.write_text(json.dumps(strategies, indent=2))


def load_strategies() -> list[dict]:
    with _lock:
        return _load_unlocked()


def save_strategy(s: dict) -> str:
    """Upsert a strategy by id (create new if id is empty/missing). Returns the id."""
    with _lock:
        strategies = _load_unlocked()
        sid = s.get("id", "").strip()
        now = datetime.now(timezone.utc).isoformat()

        if sid:
            for i, existing in enumerate(strategies):
                if existing.get("id") == sid:
                    strategies[i] = {**existing, **s, "updated_at": now}
                    _save(strategies)
                    return sid
        # New entry
        sid = str(uuid.uuid4())
        new_entry: dict[str, Any] = {
            "id":           sid,
            "name":         s.get("name", "Untitled Strategy"),
            "legs":         s.get("legs", []),
            "auto_execute": s.get("auto_execute", False),
            "saved_at":     now,
            "updated_at":   now,
            "last_checked": None,
            "last_alert":   None,
        }
        strategies.append(new_entry)
        _save(strategies)
        return sid


def delete_strategy(sid: str) -> bool:
    with _lock:
        strategies = _load_unlocked()
        new_list = [s for s in strategies if s.get("id") != sid]
        if len(new_list) == len(strategies):
            return False
        _save(new_list)
        return True


def update_last_alert(sid: str, alert: dict) -> None:
    with _lock:
        strategies = _load_unlocked()
        now = datetime.now(timezone.utc).isoformat()
        for s in strategies:
            if s.get("id") == sid:
                s["last_checked"] = now
                s["last_alert"]   = alert
                break
        _save(strategies)


def run_monitor_checks(strategy_id: str = "") -> list[dict]:
    """
    Run strategy_review on all saved strategies (or one specific id).
    Updates last_alert in place. Returns the review results.
    If strategy has auto_execute=True and action is close_all, orders are placed.
    """
    from ai.wheel_agent import strategy_review

    strategies = load_strategies()
    results = []
    for s in strategies:
        if strategy_id and s.get("id") != strategy_id:
            continue
        legs = s.get("legs", [])
        if not legs:
            continue
        try:
            alert = strategy_review(legs, strategy_name=s.get("name", ""))
            update_last_alert(s["id"], alert)
            results.append({"id": s["id"], "name": s["name"], "alert": alert})

            # Auto-execute if enabled and action warrants it
            if s.get("auto_execute") and alert.get("overall_action") in ("close_all", "close"):
                _auto_execute(s, alert)
        except Exception as e:
            results.append({"id": s["id"], "name": s["name"], "error": str(e)})
    return results


def _auto_execute(strategy: dict, result: dict, username: str = "admin") -> None:
    """Place market orders for legs flagged close/close_all. Silently skips on any error."""
    try:
        from data.broker_creds import get_session
        from brokers import get_broker
    except Exception:
        return

    for leg_action in result.get("leg_actions", []):
        if leg_action.get("action") not in ("close", "close_all"):
            continue
        leg = next((l for l in strategy.get("legs", []) if l.get("id") == leg_action.get("id")), None)
        if not leg:
            continue
        side = "BUY" if leg.get("is_short") else "SELL"
        qty  = (leg.get("lots", 1) * leg.get("lot_size", 1)) or int(leg.get("qty", 1))
        sym  = leg.get("symbol", "")
        for broker_name in ("angelone", "kotak"):
            session = get_session(username, broker_name)
            if not session:
                continue
            try:
                broker = get_broker(broker_name, session)
                order_result = broker.place_order({
                    "symbol":     sym,
                    "exchange":   "NSE",
                    "side":       side,
                    "qty":        qty,
                    "order_type": "MARKET",
                    "product":    "DELIVERY",
                })
                print(f"[monitor] auto-executed {side} {qty} {sym} via {broker_name}: "
                      f"{order_result.get('order_id', '?')}")
                break
            except Exception as e:
                print(f"[monitor] auto-execute failed for {sym} via {broker_name}: {e}")


def get_alert_count() -> int:
    """Count strategies whose last_alert recommends a non-hold action."""
    strategies = load_strategies()
    count = 0
    for s in strategies:
        alert = s.get("last_alert")
        if alert and alert.get("overall_action", "hold") != "hold":
            count += 1
    return count
