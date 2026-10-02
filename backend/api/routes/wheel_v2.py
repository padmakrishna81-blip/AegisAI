"""Smart Wheel V2 API routes."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any

from api.routes.auth import get_current_user

router  = APIRouter()
_pool   = ThreadPoolExecutor(max_workers=4)


async def _run(fn):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_pool, fn)


# ── Config / watchlist ────────────────────────────────────────────────────────

class ConfigInput(BaseModel):
    watchlist:            list[str] = []
    auto_enter:           bool      = False
    mtm_amber:            int       = -6000
    mtm_red:              int       = -10000
    telegram_bot_token:   str       = ""
    telegram_chat_id:     str       = ""


@router.get("/wheel-v2/config")
async def get_config(user=Depends(get_current_user)):
    from data.wheel_positions import get_config as _gc
    return _gc(user["username"])


@router.post("/wheel-v2/config")
async def save_config(body: ConfigInput, user=Depends(get_current_user)):
    from data.wheel_positions import save_config as _sc
    _sc(user["username"], body.dict())
    return {"saved": True}


# ── Assessment ────────────────────────────────────────────────────────────────

@router.post("/wheel-v2/assess")
async def assess(user=Depends(get_current_user)):
    from data.wheel_positions import get_config
    from ai.wheel_v2_agent import pick_best_stock
    cfg       = get_config(user["username"])
    watchlist = cfg.get("watchlist", [])
    if not watchlist:
        return JSONResponse({"error": "Watchlist is empty. Add stocks in Settings."}, status_code=400)
    best, all_results = await _run(lambda: pick_best_stock(watchlist))
    return {"best": best, "all": all_results}


# ── Capital estimate ──────────────────────────────────────────────────────────

class CapitalInput(BaseModel):
    symbol:    str
    ce_strike: float
    pe_strike: float
    lot_size:  int
    iv:        float
    dte:       int


@router.post("/wheel-v2/capital")
async def capital_estimate(body: CapitalInput, user=Depends(get_current_user)):
    from ai.wheel_v2_agent import estimate_capital, _get_cmp
    from data.broker_creds import get_session
    cmp = await _run(lambda: _get_cmp(body.symbol))
    if not cmp:
        return JSONResponse({"error": "Cannot fetch price"}, status_code=400)
    cap = estimate_capital(body.symbol, cmp, body.lot_size, body.iv, body.dte,
                           body.ce_strike, body.pe_strike)
    # Check available funds if broker connected
    balance = None
    try:
        from brokers import get_broker
        session = get_session(user["username"], "angelone")
        if session:
            funds  = get_broker("angelone", session, f"{user['username']}:angelone").get_funds()
            balance = funds.get("available_cash")
    except Exception:
        pass
    return {"cmp": cmp, "capital": cap, "available_balance": balance,
            "sufficient": (balance or 0) >= cap["total_required"]}


# ── Enter position ────────────────────────────────────────────────────────────

class EnterInput(BaseModel):
    symbol:        str
    expiry:        str
    ce_strike:     float
    ce_premium:    float
    pe_strike:     float
    pe_premium:    float
    lot_size:      int
    lots:          int   = 1
    auto_trade:    bool  = False
    broker:        str   = "angelone"


@router.post("/wheel-v2/enter")
async def enter_position(body: EnterInput, user=Depends(get_current_user)):
    from data.wheel_positions import get_active_position, save_position, get_positions
    from ai.wheel_v2_agent import _get_cmp, _days_to_expiry, PHASE1_PCT
    from datetime import datetime, timezone

    cmp = await _run(lambda: _get_cmp(body.symbol))
    if not cmp:
        return JSONResponse({"error": "Cannot fetch CMP for entry"}, status_code=400)

    net_premium  = body.ce_premium + body.pe_premium
    pe_be        = round(body.pe_strike - net_premium, 2)
    ce_be        = round(body.ce_strike + net_premium, 2)
    shares_qty   = int(body.lot_size * body.lots * PHASE1_PCT)

    # Count existing active positions for warning (not a block)
    active_count = sum(
        1 for p in get_positions(user["username"])
        if p.get("status") in ("active", "covered_call")
    )

    pos = {
        "username":           user["username"],
        "stock":              body.symbol.upper(),
        "expiry":             body.expiry,
        "dte_at_entry":       _days_to_expiry(body.expiry),
        "lot_size":           body.lot_size * body.lots,
        "ce_strike":          body.ce_strike,
        "ce_premium_sold":    body.ce_premium,
        "pe_strike":          body.pe_strike,
        "pe_premium_sold":    body.pe_premium,
        "net_premium":        round(net_premium, 2),
        "pe_be":              pe_be,
        "ce_be":              ce_be,
        "shares_phase1":      shares_qty,
        "shares_phase2":      0,
        "shares_avg_price":   cmp,
        "current_cmp":        cmp,
        "current_mtm":        0,
        "mtm_status":         "green",
        "phase":              "strangle",
        "status":             "active",
        "auto_trade":         body.auto_trade,
        "broker":             body.broker,
        "entered_at":         datetime.now(timezone.utc).isoformat(),
        "closed_at":          None,
        "alerts":             [],
        "ce_order_id":        None,
        "pe_order_id":        None,
        "share_order_ids":    [],
    }

    # Paper entry — broker execution to be added in next iteration
    pos_id = save_position(user["username"], pos)
    return {
        "position_id": pos_id,
        "pe_be": pe_be,
        "ce_be": ce_be,
        "shares_bought": shares_qty,
        "message": "WHEEL position opened (paper)",
        "warning": f"Running {active_count + 1} concurrent WHEELs — ensure sufficient margin" if active_count > 0 else None,
    }


# ── Positions ─────────────────────────────────────────────────────────────────

@router.get("/wheel-v2/positions")
async def list_positions(user=Depends(get_current_user)):
    from data.wheel_positions import get_positions
    return {"positions": get_positions(user["username"])}


@router.get("/wheel-v2/position/{position_id}")
async def get_one(position_id: str, user=Depends(get_current_user)):
    from data.wheel_positions import get_position
    pos = get_position(user["username"], position_id)
    if not pos:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return pos


# ── Manual monitor trigger ────────────────────────────────────────────────────

@router.post("/wheel-v2/monitor")
async def manual_monitor(user=Depends(get_current_user)):
    from ai.wheel_v2_agent import monitor_all
    results = await _run(lambda: monitor_all(user["username"]))
    return {"checked": len(results), "results": results}


# ── Actions: PE exit, close all ───────────────────────────────────────────────

class ActionInput(BaseModel):
    action: str   # "exit_pe" | "close_all" | "close_ce"


@router.post("/wheel-v2/action/{position_id}")
async def execute_action(position_id: str, body: ActionInput, user=Depends(get_current_user)):
    from data.wheel_positions import get_position, update_position
    from ai.wheel_v2_agent import _get_cmp, PHASE2_PCT
    from datetime import datetime, timezone

    pos = get_position(user["username"], position_id)
    if not pos:
        return JSONResponse({"error": "Position not found"}, status_code=404)

    cmp = await _run(lambda: _get_cmp(pos["stock"]))
    if not cmp:
        return JSONResponse({"error": "Cannot fetch CMP"}, status_code=400)

    action = body.action

    if action == "exit_pe":
        # Exit short PE + buy phase2 shares — transition to covered call
        if pos.get("phase") != "strangle":
            return JSONResponse({"error": "PE already exited"}, status_code=400)
        from ai.wheel_v2_agent import _get_option_price
        pe_live = await _run(lambda: _get_option_price(
            pos["stock"], pos["pe_strike"], pos["expiry"], "PE"))
        pe_live = pe_live or pos["pe_premium_sold"] * 1.5

        shares2   = int(pos["lot_size"] * PHASE2_PCT)
        old_qty   = pos["shares_phase1"]
        old_avg   = pos["shares_avg_price"]
        new_avg   = round((old_qty * old_avg + shares2 * cmp) / (old_qty + shares2), 2)
        pe_pnl    = round((pos["pe_premium_sold"] - pe_live) * pos["lot_size"], 2)

        update_position(user["username"], position_id, {
            "phase":           "covered_call",
            "shares_phase2":   shares2,
            "shares_avg_price": new_avg,
            "pe_exit_price":   pe_live,
            "pe_exit_pnl":     pe_pnl,
            "pe_exit_time":    datetime.now(timezone.utc).isoformat(),
        })
        return {"action": "exit_pe", "pe_bought_back_at": pe_live,
                "pe_pnl": pe_pnl, "new_shares": shares2, "new_avg_price": new_avg}

    elif action == "close_all":
        # Close CE + PE (if open) + sell all shares
        from ai.wheel_v2_agent import _get_option_price, calculate_mtm
        mtm = await _run(lambda: calculate_mtm(pos, cmp))
        total_pnl = mtm.get("total_mtm", 0)
        update_position(user["username"], position_id, {
            "status":     "closed_profit" if total_pnl > 0 else "closed_loss",
            "closed_at":  datetime.now(timezone.utc).isoformat(),
            "final_pnl":  total_pnl,
            "close_cmp":  cmp,
        })
        return {"action": "close_all", "final_pnl": total_pnl, "cmp": cmp}

    return JSONResponse({"error": f"Unknown action: {action}"}, status_code=400)


# ── Alerts ────────────────────────────────────────────────────────────────────

@router.get("/wheel-v2/alerts")
async def get_alerts(unread_only: bool = False, user=Depends(get_current_user)):
    from services.notify import get_alerts as _ga, unread_count
    return {"alerts": _ga(unread_only), "unread": unread_count()}


@router.post("/wheel-v2/alerts/read/{alert_id}")
async def mark_alert_read(alert_id: int, user=Depends(get_current_user)):
    from services.notify import mark_read
    mark_read(alert_id)
    return {"read": alert_id}


# ── WhatsApp test ─────────────────────────────────────────────────────────────

@router.post("/wheel-v2/test-telegram")
async def test_telegram(user=Depends(get_current_user)):
    from data.wheel_positions import get_config
    from services.notify import send_telegram
    cfg       = get_config(user["username"])
    bot_token = cfg.get("telegram_bot_token") or ""
    chat_id   = cfg.get("telegram_chat_id") or ""
    if not bot_token or not chat_id:
        return JSONResponse({"error": "Configure Bot Token + Chat ID in Settings first"}, status_code=400)
    ok = await _run(lambda: send_telegram(bot_token, chat_id,
        "✅ <b>AegisAI WHEEL</b> — Telegram notifications are working!"))
    return {"sent": ok}
