"""Notification service: in-app alert ring buffer + Telegram bot (free, reliable)."""
from __future__ import annotations
import urllib.parse, urllib.request
from datetime import datetime, timezone

_alerts: list[dict] = []
_MAX   = 100


def push_alert(level: str, title: str, message: str, recommendation: str = "") -> dict:
    alert = {
        "id":             len(_alerts),
        "level":          level,          # green | amber | red | action
        "title":          title,
        "message":        message,
        "recommendation": recommendation,
        "time":           datetime.now(timezone.utc).isoformat(),
        "read":           False,
    }
    _alerts.append(alert)
    if len(_alerts) > _MAX:
        _alerts.pop(0)
    return alert


def get_alerts(unread_only: bool = False) -> list[dict]:
    return [a for a in reversed(_alerts) if not unread_only or not a["read"]]


def mark_read(alert_id: int) -> None:
    for a in _alerts:
        if a["id"] == alert_id:
            a["read"] = True
            return


def unread_count() -> int:
    return sum(1 for a in _alerts if not a["read"])


def clear_alerts() -> None:
    _alerts.clear()


# ── Telegram bot ──────────────────────────────────────────────────────────────
# One-time setup (2 minutes):
#   1. Open Telegram → search @BotFather → send /newbot → follow prompts → get Bot Token
#   2. Start a chat with your new bot (send it any message)
#   3. Open: https://api.telegram.org/bot<TOKEN>/getUpdates  → find "chat":{"id":...}
#   4. Paste Bot Token + Chat ID into Smart Wheel → Settings

def send_telegram(bot_token: str, chat_id: str, message: str) -> bool:
    """Send Telegram message via Bot API. Completely free, no rate limits for personal use."""
    if not bot_token or not chat_id or not message:
        return False
    try:
        url  = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id":    chat_id,
            "text":       message,
            "parse_mode": "HTML",
        }).encode()
        req = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def notify_wheel(username: str, level: str, symbol: str,
                 mtm: float, cmp: float, recommendation: str,
                 note: str = "") -> None:
    icons = {"green": "🟢", "amber": "🟡", "red": "🔴", "action": "⚡"}
    icon  = icons.get(level, "ℹ️")
    title = f"{icon} WHEEL {symbol}"
    msg   = f"MTM: ₹{mtm:,.0f} | CMP: ₹{cmp:.0f}" + (f" | {note}" if note else "")

    push_alert(level, title, msg, recommendation)

    if level in ("amber", "red", "action"):
        try:
            from data.wheel_positions import get_config
            cfg       = get_config(username)
            bot_token = cfg.get("telegram_bot_token") or ""
            chat_id   = cfg.get("telegram_chat_id") or ""
            if bot_token and chat_id:
                tg = (
                    f"{icon} <b>AegisAI WHEEL — {symbol}</b>\n"
                    f"MTM: ₹{mtm:,.0f} | CMP: ₹{cmp:.0f}\n"
                    f"→ {recommendation}"
                    + (f"\n{note}" if note else "")
                )
                send_telegram(bot_token, chat_id, tg)
        except Exception:
            pass
