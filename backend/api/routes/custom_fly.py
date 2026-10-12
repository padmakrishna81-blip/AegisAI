"""Custom Fly Strategy API routes."""

import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from api.routes.auth import get_current_user
from ai.fly_strategy import (
    scan_consolidating, rank_safety, get_naked_fly,
    get_chain_expiries, _SCAN_CACHE, _SCAN_CACHE_TTL,
)
from data.fly_positions import add_position, get_positions, update_position

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=4)


# ── Scan ──────────────────────────────────────────────────────────────────────

@router.get("/fly/scan")
async def fly_scan(
    days: int = Query(default=10, ge=3, le=30),
    user=Depends(get_current_user),
):
    loop = asyncio.get_running_loop()

    def _run():
        stocks = scan_consolidating(days)
        return rank_safety(stocks)

    try:
        stocks = await loop.run_in_executor(_executor, _run)
        cache_entry = _SCAN_CACHE.get(str(days))
        cached_at = None
        if cache_entry:
            age_s = int(datetime.utcnow().timestamp() - cache_entry["ts"])
            cached_at = f"{age_s}s ago"
        return {
            "stocks": stocks,
            "days": days,
            "total": len(stocks),
            "consolidating_count": sum(1 for s in stocks if s.get("consolidating")),
            "cached_at": cached_at,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Expiries ──────────────────────────────────────────────────────────────────

@router.get("/fly/expiries/{symbol}")
async def fly_expiries(symbol: str, user=Depends(get_current_user)):
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    loop = asyncio.get_running_loop()
    try:
        expiries = await loop.run_in_executor(_executor, lambda: get_chain_expiries(clean))
        if not expiries:
            return JSONResponse({"error": f"No option chain found for {clean}"}, status_code=400)
        return {"symbol": clean, "expiries": expiries}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Setup (supports manual strike override + refresh) ────────────────────────

@router.get("/fly/setup/{symbol}")
async def fly_setup(
    symbol: str,
    expiry: str | None = Query(default=None),
    pe_strike: float | None = Query(default=None),
    ce_strike: float | None = Query(default=None),
    refresh: bool = Query(default=False),
    user=Depends(get_current_user),
):
    """
    Get naked fly setup for a symbol and expiry.
    pe_strike / ce_strike: override auto-selection.
    refresh=true: bypass cached LTPs, force fresh prices.
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    username = user.get("username") if user else None
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            _executor,
            lambda: get_naked_fly(
                clean,
                expiry=expiry,
                username=username,
                pe_strike_override=pe_strike,
                ce_strike_override=ce_strike,
                force_refresh=refresh,
            ),
        )
        if result.get("error"):
            return JSONResponse({"error": result["error"]}, status_code=400)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Place order ───────────────────────────────────────────────────────────────

@router.post("/fly/order")
async def fly_order(body: dict, user=Depends(get_current_user)):
    """
    Place both legs of a naked fly (sell PE + sell CE) via Angel One.
    Body: { symbol, expiry, sell_pe: {strike, premium}, sell_ce: {strike, premium},
            lot_size, lots, spot_at_entry, net_credit_total, dte }
    """
    username = user.get("username")
    loop = asyncio.get_running_loop()

    def _place():
        from data.broker_creds import get_session
        from brokers.angel_one import AngelOneClient

        session = get_session(username, "angelone")
        if not session:
            raise RuntimeError("No Angel One session — connect broker first")

        client = AngelOneClient(session, cache_key=f"{username}:angelone")
        symbol   = body["symbol"]
        expiry   = body["expiry"]
        lots     = int(body.get("lots", 1))
        lot_size = int(body["lot_size"])

        pe_order = client.place_nfo_order(
            symbol=symbol, expiry_str=expiry,
            strike=float(body["sell_pe"]["strike"]), opt_type="PE",
            side="SELL", lots=lots, lot_size=lot_size,
        )
        ce_order = client.place_nfo_order(
            symbol=symbol, expiry_str=expiry,
            strike=float(body["sell_ce"]["strike"]), opt_type="CE",
            side="SELL", lots=lots, lot_size=lot_size,
        )

        position = {
            "id":              str(uuid.uuid4()),
            "symbol":          symbol,
            "expiry":          expiry,
            "lot_size":        lot_size,
            "lots":            lots,
            "dte_at_entry":    int(body.get("dte", 30)),
            "spot_at_entry":   float(body.get("spot_at_entry", 0)),
            "sell_pe": {
                "strike":        float(body["sell_pe"]["strike"]),
                "entry_premium": float(body["sell_pe"]["premium"]),
                "order_id":      pe_order.get("order_id", ""),
            },
            "sell_ce": {
                "strike":        float(body["sell_ce"]["strike"]),
                "entry_premium": float(body["sell_ce"]["premium"]),
                "order_id":      ce_order.get("order_id", ""),
            },
            "net_credit_total": float(body.get("net_credit_total", 0)),
            "entered_at":       datetime.utcnow().isoformat(),
            "status":           "active",
            "current_pe_ltp":   float(body["sell_pe"]["premium"]),
            "current_ce_ltp":   float(body["sell_ce"]["premium"]),
            "mtm_pnl":          0.0,
            "pct_of_target":    0.0,
            "mtm_pct_of_position": 0.0,
            "last_checked":     datetime.utcnow().isoformat(),
            "mtm_history":      [],
            "exit_reason":      None,
            "exited_at":        None,
        }
        add_position(username, position)
        return {"position": position, "pe_order": pe_order, "ce_order": ce_order}

    try:
        result = await loop.run_in_executor(_executor, _place)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── List positions ────────────────────────────────────────────────────────────

@router.get("/fly/positions")
async def fly_positions(user=Depends(get_current_user)):
    username = user.get("username")
    try:
        positions = get_positions(username)
        return {"positions": positions}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Manual close ──────────────────────────────────────────────────────────────

@router.post("/fly/position/{position_id}/close")
async def fly_close(position_id: str, user=Depends(get_current_user)):
    username = user.get("username")
    loop = asyncio.get_running_loop()

    def _close():
        positions = get_positions(username)
        pos = next((p for p in positions if p["id"] == position_id), None)
        if not pos:
            raise ValueError("Position not found")
        if pos.get("status") == "exited":
            raise ValueError("Position already exited")

        from data.broker_creds import get_session
        from brokers.angel_one import AngelOneClient
        session = get_session(username, "angelone")
        if not session:
            raise RuntimeError("No Angel One session — connect broker first")

        client = AngelOneClient(session, cache_key=f"{username}:angelone")
        lots     = pos.get("lots", 1)
        lot_size = pos["lot_size"]
        pe_order = client.place_nfo_order(
            pos["symbol"], pos["expiry"],
            pos["sell_pe"]["strike"], "PE", "BUY", lots, lot_size,
        )
        ce_order = client.place_nfo_order(
            pos["symbol"], pos["expiry"],
            pos["sell_ce"]["strike"], "CE", "BUY", lots, lot_size,
        )
        update_position(username, position_id, {
            "status":    "exited",
            "exit_reason": "Manual close",
            "exited_at": datetime.utcnow().isoformat(),
        })
        return {"pe_order": pe_order, "ce_order": ce_order}

    try:
        result = await loop.run_in_executor(_executor, _close)
        return result
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
