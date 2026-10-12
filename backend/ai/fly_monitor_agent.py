"""
Custom Fly position monitor agent.

Runs as a background daemon thread. Every 60 s it:
  1. Fetches current LTPs for all active fly positions (Angel One → jugaad fallback).
  2. Calculates MTM P&L and % of max-credit captured.
  3. Auto-exits if 50% of target is captured.
  4. Sends a Telegram progress alert when MTM gain > 2% of position value;
     runs an AI trend check to decide HOLD or EXIT.
  5. Sends a warning alert when unrealised loss exceeds 150% of premium collected.
"""

import logging
import time
from datetime import datetime

import yfinance as yf

from data.fly_positions import get_all_active, update_position
from services.notify import send_telegram

logger = logging.getLogger("aegisai")

_CHECK_INTERVAL = 60        # seconds between full scan cycles
_ALERT_COOLDOWN = 300       # seconds between repeat progress alerts (same position)
_last_alert: dict[str, float] = {}   # position_id → last alert epoch


# ── LTP helpers ──────────────────────────────────────────────────────────────

def _fetch_ltps(pos: dict, username: str) -> tuple[float, float]:
    """Return (pe_ltp, ce_ltp). Tries Angel One first, then jugaad."""
    # Angel One
    try:
        from brokers.angel_one import AngelOneClient
        from data.broker_creds import get_session
        session = get_session(username, "angelone")
        if session:
            client = AngelOneClient(session, cache_key=f"{username}:angelone")
            pe = client.get_option_ltp(pos["symbol"], pos["expiry"], pos["sell_pe"]["strike"], "PE")
            ce = client.get_option_ltp(pos["symbol"], pos["expiry"], pos["sell_ce"]["strike"], "CE")
            if pe and pe > 0 and ce and ce > 0:
                return float(pe), float(ce)
    except Exception as e:
        logger.debug("fly monitor: Angel One LTP failed: %s", e)

    # jugaad fallback
    try:
        from ai.fly_strategy import _fetch_full_chain
        from datetime import date
        chain = _fetch_full_chain(pos["symbol"])
        exp_data = chain.get(pos["expiry"], {})
        if exp_data:
            puts  = sorted(exp_data.get("puts",  []), key=lambda x: abs(x["strike"] - pos["sell_pe"]["strike"]))
            calls = sorted(exp_data.get("calls", []), key=lambda x: abs(x["strike"] - pos["sell_ce"]["strike"]))
            if puts and calls:
                pe = puts[0].get("mid") or puts[0].get("ltp", 0)
                ce = calls[0].get("mid") or calls[0].get("ltp", 0)
                if pe > 0 and ce > 0:
                    return float(pe), float(ce)
    except Exception as e:
        logger.debug("fly monitor: jugaad LTP failed: %s", e)

    return 0.0, 0.0


def _spot_price(symbol: str) -> float:
    try:
        hist = yf.Ticker(symbol + ".NS").history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass
    return 0.0


# ── AI trend check ────────────────────────────────────────────────────────────

def _ai_hold_or_exit(pos: dict, current_spot: float, mtm_pnl: float) -> str:
    """Returns 'hold' or 'exit'. Defaults to 'hold' if LLM unavailable."""
    try:
        from ai.llm_client import call_llm, is_configured
        if not is_configured():
            return "hold"
        entry_spot = pos.get("spot_at_entry", current_spot)
        spot_move_pct = (current_spot - entry_spot) / entry_spot * 100 if entry_spot else 0
        prompt = (
            f"Naked fly position: SELL {pos['symbol']} PE@{pos['sell_pe']['strike']} + CE@{pos['sell_ce']['strike']}\n"
            f"Expiry: {pos['expiry']}  Entry spot: ₹{entry_spot:.1f}  Current spot: ₹{current_spot:.1f} ({spot_move_pct:+.1f}%)\n"
            f"MTM P&L: ₹{mtm_pnl:,.0f}  (positive = profit for seller)\n"
            f"Based on spot trend and momentum, should we HOLD or EXIT?\n"
            f"Respond with exactly: HOLD or EXIT"
        )
        resp = call_llm(prompt, system="Options risk manager. One word only: HOLD or EXIT.", max_tokens=10)
        if "EXIT" in resp.upper():
            return "exit"
    except Exception:
        pass
    return "hold"


# ── Order close helper ────────────────────────────────────────────────────────

def _close_position(pos: dict, username: str, reason: str) -> bool:
    """Buy back both legs to close. Returns True if both orders placed."""
    try:
        from brokers.angel_one import AngelOneClient
        from data.broker_creds import get_session
        session = get_session(username, "angelone")
        if not session:
            logger.warning("fly monitor: no broker session for %s — cannot auto-close", username)
            return False
        client = AngelOneClient(session, cache_key=f"{username}:angelone")
        lots = pos.get("lots", 1)
        lot_size = pos["lot_size"]
        client.place_nfo_order(pos["symbol"], pos["expiry"], pos["sell_pe"]["strike"], "PE", "BUY", lots, lot_size)
        client.place_nfo_order(pos["symbol"], pos["expiry"], pos["sell_ce"]["strike"], "CE", "BUY", lots, lot_size)
        update_position(username, pos["id"], {
            "status":    "exited",
            "exit_reason": reason,
            "exited_at": datetime.utcnow().isoformat(),
        })
        return True
    except Exception as e:
        logger.error("fly monitor: failed to close position %s: %s", pos.get("id"), e)
        return False


# ── Per-position check ────────────────────────────────────────────────────────

def _check_position(pos: dict, username: str) -> None:
    pe_ltp, ce_ltp = _fetch_ltps(pos, username)
    if pe_ltp <= 0 or ce_ltp <= 0:
        return  # no prices — skip

    lot_size = pos["lot_size"]
    lots     = pos.get("lots", 1)
    total_qty = lot_size * lots

    entry_credit = float(pos["net_credit_total"])          # ₹ collected at entry
    current_cost = (pe_ltp + ce_ltp) * total_qty          # ₹ to close now
    mtm_pnl      = round(entry_credit - current_cost, 2)  # +ve = profit
    pct_of_target = round(mtm_pnl / entry_credit * 100, 1) if entry_credit > 0 else 0.0

    spot_ref  = float(pos.get("spot_at_entry") or 1)
    pos_value = spot_ref * total_qty
    mtm_pct_of_position = round(mtm_pnl / pos_value * 100, 2) if pos_value > 0 else 0.0

    # Persist updated MTM
    history = (pos.get("mtm_history") or [])[-49:]
    history.append({
        "ts": datetime.utcnow().isoformat(),
        "pe_ltp": pe_ltp, "ce_ltp": ce_ltp,
        "mtm_pnl": mtm_pnl, "pct_of_target": pct_of_target,
    })
    update_position(username, pos["id"], {
        "current_pe_ltp":       pe_ltp,
        "current_ce_ltp":       ce_ltp,
        "mtm_pnl":              mtm_pnl,
        "pct_of_target":        pct_of_target,
        "mtm_pct_of_position":  mtm_pct_of_position,
        "last_checked":         datetime.utcnow().isoformat(),
        "mtm_history":          history,
    })

    sym = pos["symbol"]
    pos_id = pos["id"]

    # ── Rule 1: 50% of max credit captured → exit immediately ─────────────────
    if pct_of_target >= 50.0 and mtm_pnl > 0:
        closed = _close_position(pos, username, f"50% target: ₹{mtm_pnl:,.0f}")
        msg = (
            f"✅ *Fly {sym} — 50% TARGET HIT*\n"
            f"Captured ₹{mtm_pnl:,.0f} ({pct_of_target:.0f}% of max credit)\n"
            f"PE: ₹{pe_ltp:.2f} (entry ₹{pos['sell_pe']['entry_premium']:.2f})\n"
            f"CE: ₹{ce_ltp:.2f} (entry ₹{pos['sell_ce']['entry_premium']:.2f})\n"
            + ("🔒 Position closed." if closed else "⚠️ Auto-close failed — close manually.")
        )
        send_telegram(msg, username=username)
        return

    # ── Rule 2: MTM gain > 2% of position value → AI trend check ──────────────
    now = time.time()
    cooldown_ok = (now - _last_alert.get(pos_id, 0)) > _ALERT_COOLDOWN
    if mtm_pct_of_position >= 2.0 and cooldown_ok:
        _last_alert[pos_id] = now
        current_spot = _spot_price(sym)
        decision = _ai_hold_or_exit(pos, current_spot, mtm_pnl)
        if decision == "exit":
            closed = _close_position(pos, username, f"AI exit at {mtm_pct_of_position:.1f}% gain")
            msg = (
                f"🚪 *Fly {sym} — AI EXIT*\n"
                f"MTM: ₹{mtm_pnl:,.0f} (+{mtm_pct_of_position:.1f}% of position)\n"
                f"AI flagged unfavorable trend.\n"
                + ("🔒 Position closed." if closed else "⚠️ Auto-close failed — close manually.")
            )
        else:
            msg = (
                f"📈 *Fly {sym} — Progress +{mtm_pct_of_position:.1f}%*\n"
                f"MTM: ₹{mtm_pnl:,.0f}  ({pct_of_target:.0f}% of target)\n"
                f"AI: HOLD — trend looks favorable.\n"
                f"PE: ₹{pe_ltp:.2f} | CE: ₹{ce_ltp:.2f}"
            )
        send_telegram(msg, username=username)
        return

    # ── Rule 3: Unrealised loss > 150% of credit → warn ───────────────────────
    if mtm_pnl < -entry_credit * 1.5 and cooldown_ok:
        _last_alert[pos_id] = now
        msg = (
            f"⚠️ *Fly {sym} — LARGE LOSS WARNING*\n"
            f"MTM: ₹{mtm_pnl:,.0f} (loss > 150% of premium collected)\n"
            f"PE: ₹{pe_ltp:.2f} | CE: ₹{ce_ltp:.2f}\n"
            f"Consider manual exit."
        )
        send_telegram(msg, username=username)


# ── Main loop ─────────────────────────────────────────────────────────────────

def monitor_loop() -> None:
    logger.info("Fly monitor agent started")
    while True:
        try:
            for pos in get_all_active():
                username = pos.pop("_username", "")
                try:
                    _check_position(pos, username)
                except Exception as e:
                    logger.error("fly monitor: error checking %s: %s", pos.get("id"), e)
        except Exception as e:
            logger.error("fly monitor loop error: %s", e)
        time.sleep(_CHECK_INTERVAL)
