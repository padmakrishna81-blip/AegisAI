"""NIFTY Wheel + NIFTYBEES Accumulation API routes."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.routes.auth import get_current_user

router = APIRouter()
_pool  = ThreadPoolExecutor(max_workers=4)


async def _run(fn):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_pool, fn)


def _clean(obj: Any) -> Any:
    """Remove numpy types / NaN for JSON serialisation."""
    try:
        from main import convert_numpy
        return convert_numpy(obj)
    except Exception:
        return obj


# ── State ─────────────────────────────────────────────────────────────────────

@router.get("/nifty-wheel/state")
async def get_state(user=Depends(get_current_user)):
    from data.nifty_wheel_store import get_state as _gs
    return _clean(_gs(user["username"]))


# ── Direction analysis ────────────────────────────────────────────────────────

@router.get("/nifty-wheel/direction")
async def get_direction(user=Depends(get_current_user)):
    """Run direction scoring and persist to history."""
    from ai.nifty_wheel_agent import assess_direction
    from data.nifty_wheel_store import add_direction_entry, get_state, save_state

    result = await _run(assess_direction)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=500)

    # Persist to direction_history
    entry = {
        "date":          datetime.now(timezone.utc).date().isoformat(),
        "nifty_spot":    result.get("nifty_spot", 0.0),
        "up_prob":       result.get("up_prob", 0),
        "down_prob":     result.get("down_prob", 0),
        "sideways_prob": result.get("sideways_prob", 0),
        "direction":     result.get("direction", "SIDEWAYS"),
        "bullish_score": result.get("bullish_score", 50),
        "key_signals": {
            "pcr":          result.get("signals", {}).get("oi", {}).get("pcr"),
            "max_pain":     result.get("signals", {}).get("oi", {}).get("max_pain"),
            "rsi":          result.get("signals", {}).get("technical", {}).get("rsi"),
            "macd":         result.get("signals", {}).get("technical", {}).get("macd"),
            "vix":          result.get("vix"),
            "tech_summary": result.get("signals", {}).get("technical", {}).get("summary"),
            "oi_summary":   result.get("signals", {}).get("oi", {}).get("summary"),
            "macro_summary":result.get("signals", {}).get("macro", {}).get("summary"),
        },
        "actual_direction": None,
    }
    add_direction_entry(user["username"], entry)

    return _clean(result)


# ── Expiries ──────────────────────────────────────────────────────────────────

@router.get("/nifty-wheel/expiries")
async def get_expiries(user=Depends(get_current_user)):
    from ai.nifty_wheel_agent import get_expiries as _ge
    expiries = await _run(_ge)
    return _clean(expiries)


# ── Option chain (delta-filtered) ────────────────────────────────────────────

@router.get("/nifty-wheel/option-chain")
async def get_option_chain(
    direction: str = "UP",
    expiry: str = "",
    user=Depends(get_current_user),
):
    if not expiry:
        return JSONResponse({"error": "expiry parameter is required"}, status_code=400)
    from ai.nifty_wheel_agent import get_strike_recommendations
    result = await _run(lambda: get_strike_recommendations(direction.upper(), expiry))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return _clean(result)


# ── Monitor (MTM on active positions) ────────────────────────────────────────

@router.get("/nifty-wheel/monitor")
async def monitor_positions(user=Depends(get_current_user)):
    from data.nifty_wheel_store import get_state as _gs
    from ai.nifty_wheel_agent import get_position_mtm

    state = _gs(user["username"])
    active = [p for p in state.get("option_positions", []) if p.get("status") == "active"]
    if not active:
        return {"positions": [], "total_pnl": 0.0}

    mtm_list = await _run(lambda: [get_position_mtm(p) for p in active])
    total_pnl = sum(m.get("pnl", 0) for m in mtm_list if "error" not in m)

    return _clean({"positions": mtm_list, "total_pnl": round(total_pnl, 2)})


# ── Margin ────────────────────────────────────────────────────────────────────

@router.get("/nifty-wheel/margin")
async def get_margin(user=Depends(get_current_user)):
    from data.broker_creds import get_session, auto_reconnect
    from brokers.angel_one import AngelOneClient

    session = get_session(user["username"], "angelone")
    if not session:
        session = auto_reconnect(user["username"], "angelone")
    if not session:
        return {"connected": False, "available_cash": None}

    def _fetch():
        client = AngelOneClient(session, cache_key=f"{user['username']}:angelone")
        return client.get_funds()

    try:
        funds = await _run(_fetch)
        # Known bug: Angel One returns available_cash not net_available
        cash = funds.get("available_cash") or funds.get("net_available") or 0.0
        return _clean({"connected": True, "available_cash": float(cash), "raw": funds})
    except Exception as e:
        return {"connected": True, "available_cash": None, "error": str(e)}


# ── Place option sell ─────────────────────────────────────────────────────────

class OptionSellInput(BaseModel):
    direction:    str
    type:         str           # PE or CE
    strike:       float
    expiry:       str
    lots:         int = 1
    limit_price:  Optional[float] = None
    use_broker:   bool = True


@router.post("/nifty-wheel/option-positions")
async def add_option_position(body: OptionSellInput, user=Depends(get_current_user)):
    from ai.nifty_wheel_agent import NIFTY_LOT, get_strike_recommendations
    from data.nifty_wheel_store import add_option_position as _add
    from data.broker_creds import get_session, auto_reconnect

    pos = {
        "direction":    body.direction.upper(),
        "type":         body.type.upper(),
        "strike":       body.strike,
        "expiry":       body.expiry,
        "lots":         body.lots,
        "lot_size":     NIFTY_LOT,
        "status":       "pending",
        "broker_order_id": None,
        "broker_error": None,
    }

    # Get current LTP as reference
    try:
        chain_data = await _run(lambda: get_strike_recommendations(body.direction.upper(), body.expiry))
        for s in chain_data.get("strikes", []):
            if abs(s["strike"] - body.strike) < 0.01 and s["type"] == body.type.upper():
                pos["premium_sold"] = body.limit_price or s.get("ltp", 0.0)
                break
        if "premium_sold" not in pos:
            pos["premium_sold"] = body.limit_price or 0.0
    except Exception:
        pos["premium_sold"] = body.limit_price or 0.0

    broker_result: dict = {}
    if body.use_broker:
        session = get_session(user["username"], "angelone")
        if not session:
            session = auto_reconnect(user["username"], "angelone")
        if session:
            from brokers.angel_one import AngelOneClient
            symbol = f"NIFTY {int(body.strike)} {body.type.upper()}"

            def _place():
                client = AngelOneClient(session, cache_key=f"{user['username']}:angelone")
                return client.place_order(
                    symbol=symbol,
                    qty=body.lots * NIFTY_LOT,
                    side="SELL",
                    order_type="LIMIT" if body.limit_price else "MARKET",
                    price=body.limit_price,
                    exchange="NFO",
                    product="CARRYFORWARD",
                    expiry=body.expiry,
                    strike=body.strike,
                    option_type=body.type.upper(),
                )

            try:
                order_res = await _run(_place)
                if isinstance(order_res, dict):
                    pos["broker_order_id"] = order_res.get("order_id")
                    if order_res.get("error"):
                        pos["broker_error"] = order_res["error"]
                elif isinstance(order_res, str):
                    pos["broker_order_id"] = order_res
            except Exception as ex:
                broker_result["error"] = str(ex)
                pos["broker_error"] = str(ex)
        else:
            pos["broker_error"] = "Broker not connected"

    # Limit orders stay "pending" until broker confirms fill.
    # Market orders are assumed filled immediately.
    pos["status"] = "pending" if body.limit_price else "active"
    pos_id = _add(user["username"], pos)

    resp: dict = {"ok": True, "id": pos_id, "position": pos}
    if pos.get("broker_order_id"):
        resp["broker_order_id"] = pos["broker_order_id"]
    if pos.get("broker_error"):
        resp["broker_error"] = pos["broker_error"]
    return _clean(resp)


# ── Mark pending limit order as filled ───────────────────────────────────────

class MarkFilledInput(BaseModel):
    filled_price: Optional[float] = None   # actual fill price; falls back to limit_price


@router.post("/nifty-wheel/option-positions/{pos_id}/mark-filled")
async def mark_position_filled(
    pos_id: str,
    body: MarkFilledInput,
    user=Depends(get_current_user),
):
    from data.nifty_wheel_store import get_state, update_option_position

    state = get_state(user["username"])
    pos   = next((p for p in state.get("option_positions", []) if p.get("id") == pos_id), None)
    if not pos:
        return JSONResponse({"error": "Position not found"}, status_code=404)
    if pos.get("status") != "pending":
        return JSONResponse({"error": "Position is not pending"}, status_code=400)

    patch: dict = {"status": "active"}
    if body.filled_price:
        patch["premium_sold"] = body.filled_price
    return _clean({"ok": bool(update_option_position(user["username"], pos_id, patch))})


# ── Delete record-only position (no trace) ───────────────────────────────────

@router.delete("/nifty-wheel/option-positions/{pos_id}")
async def delete_option_position(pos_id: str, user=Depends(get_current_user)):
    from data.nifty_wheel_store import get_state, delete_option_position as _del

    state = get_state(user["username"])
    pos   = next((p for p in state.get("option_positions", []) if p.get("id") == pos_id), None)
    if not pos:
        return JSONResponse({"error": "Position not found"}, status_code=404)
    if pos.get("broker_order_id"):
        return JSONResponse({"error": "Cannot delete a broker-placed position. Use Exit instead."}, status_code=400)
    ok = _del(user["username"], pos_id)
    return {"ok": ok}


# ── Exit option position ──────────────────────────────────────────────────────

class OptionExitInput(BaseModel):
    exit_price:  Optional[float] = None
    use_broker:  bool = True


@router.post("/nifty-wheel/option-positions/{pos_id}/exit")
async def exit_option_position(
    pos_id: str,
    body: OptionExitInput,
    user=Depends(get_current_user),
):
    from data.nifty_wheel_store import get_state, update_option_position
    from data.broker_creds import get_session, auto_reconnect

    state = get_state(user["username"])
    pos   = next((p for p in state.get("option_positions", []) if p.get("id") == pos_id), None)
    if not pos:
        return JSONResponse({"error": "Position not found"}, status_code=404)
    if pos.get("status") != "active":
        return JSONResponse({"error": "Position is not active"}, status_code=400)

    exit_price    = body.exit_price or 0.0
    broker_result = {}

    if body.use_broker:
        session = get_session(user["username"], "angelone")
        if not session:
            session = auto_reconnect(user["username"], "angelone")
        if session:
            from brokers.angel_one import AngelOneClient
            symbol  = f"NIFTY {int(pos['strike'])} {pos['type'].upper()}"
            lots    = int(pos.get("lots", 1))
            lot_sz  = int(pos.get("lot_size", 75))

            def _place_exit():
                client = AngelOneClient(session, cache_key=f"{user['username']}:angelone")
                return client.place_order(
                    symbol=symbol,
                    qty=lots * lot_sz,
                    side="BUY",
                    order_type="MARKET",
                    exchange="NFO",
                    product="CARRYFORWARD",
                    expiry=pos.get("expiry"),
                    strike=pos["strike"],
                    option_type=pos["type"].upper(),
                )

            try:
                order_res = await _run(_place_exit)
                if isinstance(order_res, dict):
                    broker_result["order_id"] = order_res.get("order_id")
                    if order_res.get("error"):
                        broker_result["error"] = order_res["error"]
                elif isinstance(order_res, str):
                    broker_result["order_id"] = order_res
            except Exception as ex:
                broker_result["error"] = str(ex)
        else:
            broker_result["error"] = "Broker not connected"

    sold_price = float(pos.get("premium_sold", 0))
    pnl        = (sold_price - exit_price) * int(pos.get("lot_size", 75)) * int(pos.get("lots", 1)) if exit_price else None

    patch = {
        "status":         "exited",
        "exited_at":      datetime.now(timezone.utc).isoformat(),
        "exit_price":     exit_price or None,
        "pnl":            round(pnl, 2) if pnl is not None else None,
        "exit_order_id":  broker_result.get("order_id"),
        "broker_error":   broker_result.get("error"),
    }
    update_option_position(user["username"], pos_id, patch)

    resp = {"ok": True, "id": pos_id, **patch}
    if broker_result.get("order_id"):
        resp["broker_order_id"] = broker_result["order_id"]
    if broker_result.get("error"):
        resp["broker_error"] = broker_result["error"]
    return _clean(resp)


# ── ETF buy ───────────────────────────────────────────────────────────────────

class EtfBuyInput(BaseModel):
    cycle_num:   int
    tranche:     int        # 1 or 2
    qty:         int
    price:       Optional[float] = None
    use_broker:  bool = True


@router.post("/nifty-wheel/etf/buy")
async def buy_niftybees(body: EtfBuyInput, user=Depends(get_current_user)):
    from data.nifty_wheel_store import update_cycle, recalc_etf_totals, get_state
    from data.broker_creds import get_session, auto_reconnect

    if body.tranche not in (1, 2):
        return JSONResponse({"error": "tranche must be 1 or 2"}, status_code=400)

    broker_order_id = None
    broker_error    = None

    if body.use_broker:
        session = get_session(user["username"], "angelone")
        if not session:
            session = auto_reconnect(user["username"], "angelone")
        if session:
            from brokers.angel_one import AngelOneClient

            def _place_etf():
                client = AngelOneClient(session, cache_key=f"{user['username']}:angelone")
                return client.place_order(
                    symbol="NIFTYBEES",
                    qty=body.qty,
                    side="BUY",
                    order_type="LIMIT" if body.price else "MARKET",
                    price=body.price,
                    exchange="NSE",
                    product="DELIVERY",
                    asset_type="etf",
                )

            try:
                order_res = await _run(_place_etf)
                if isinstance(order_res, dict):
                    broker_order_id = order_res.get("order_id")
                    broker_error    = order_res.get("error")
                elif isinstance(order_res, str):
                    broker_order_id = order_res
            except Exception as ex:
                broker_error = str(ex)
        else:
            broker_error = "Broker not connected"

    field_prefix = "buy1" if body.tranche == 1 else "buy2"
    patch = {
        f"{field_prefix}_qty":      body.qty,
        f"{field_prefix}_price":    body.price,
        f"{field_prefix}_date":     datetime.now(timezone.utc).date().isoformat(),
        f"{field_prefix}_order_id": broker_order_id,
    }
    # Mark cycle active if buy1
    state = get_state(user["username"])
    for cyc in state.get("cycles", []):
        if cyc["cycle_num"] == body.cycle_num:
            if cyc.get("status") == "pending":
                patch["status"] = "active"
                patch["started_at"] = datetime.now(timezone.utc).isoformat()
            # Mark completed if both tranches done
            current_buy1 = cyc.get("buy1_qty", 0) or 0
            current_buy2 = cyc.get("buy2_qty", 0) or 0
            will_buy1 = body.qty if body.tranche == 1 else current_buy1
            will_buy2 = body.qty if body.tranche == 2 else current_buy2
            if will_buy1 > 0 and will_buy2 > 0:
                patch["status"] = "completed"
                patch["completed_at"] = datetime.now(timezone.utc).isoformat()
            break

    update_cycle(user["username"], body.cycle_num, patch)
    recalc_etf_totals(user["username"])

    resp = {"ok": True, "cycle_num": body.cycle_num, "tranche": body.tranche, "qty": body.qty}
    if broker_order_id:
        resp["broker_order_id"] = broker_order_id
    if broker_error:
        resp["broker_error"] = broker_error
    return _clean(resp)


# ── History ───────────────────────────────────────────────────────────────────

@router.get("/nifty-wheel/history")
async def get_history(user=Depends(get_current_user)):
    from data.nifty_wheel_store import get_state as _gs
    state   = _gs(user["username"])
    history = state.get("direction_history", [])

    correct = sum(
        1 for h in history
        if h.get("actual_direction") and h.get("direction") == h.get("actual_direction")
    )
    graded  = sum(1 for h in history if h.get("actual_direction"))
    accuracy = round(correct / graded * 100, 1) if graded else None

    return _clean({
        "history":  list(reversed(history)),
        "accuracy": accuracy,
        "graded":   graded,
        "correct":  correct,
    })


# ── Price history chart ───────────────────────────────────────────────────────

@router.get("/nifty-wheel/price-history")
async def get_price_history(user=Depends(get_current_user)):
    """Return last 15 trading sessions of NIFTY 50 and NIFTYBEES close prices."""

    def _fetch():
        import yfinance as yf
        nifty    = yf.Ticker("^NSEI").history(period="1mo")
        niftybees = yf.Ticker("NIFTYBEES.NS").history(period="1mo")

        nifty     = nifty.tail(15)
        niftybees = niftybees.tail(15)

        rows = []
        for dt, row in nifty.iterrows():
            date_str = dt.strftime("%d %b")
            nbs_close = None
            if date_str in {d.strftime("%d %b") for d, _ in niftybees.iterrows()}:
                # try to match by date
                pass
            rows.append({
                "date":     date_str,
                "nifty":    round(float(row["Close"]), 2),
                "niftybees": None,
            })

        # merge niftybees
        nb_map = {dt.strftime("%d %b"): round(float(r["Close"]), 2)
                  for dt, r in niftybees.iterrows()}
        for row in rows:
            row["niftybees"] = nb_map.get(row["date"])

        # daily change for NIFTY and NIFTYBEES (points + pct)
        for i, row in enumerate(rows):
            if i == 0:
                row["nifty_chg"]        = 0.0
                row["nifty_pts_chg"]    = 0.0
                row["niftybees_chg"]    = 0.0
                row["niftybees_pts_chg"] = 0.0
            else:
                prev_n  = rows[i-1]["nifty"]
                prev_nb = rows[i-1]["niftybees"]
                n       = row["nifty"]
                nb      = row["niftybees"]
                row["nifty_pts_chg"] = round(n - prev_n, 2) if prev_n else 0.0
                row["nifty_chg"]     = round((n - prev_n) / prev_n * 100, 2) if prev_n else 0.0
                row["niftybees_pts_chg"] = round(nb - prev_nb, 2) if (nb and prev_nb) else None
                row["niftybees_chg"]     = round((nb - prev_nb) / prev_nb * 100, 2) if (nb and prev_nb) else None

        # percentage return from first day (single-scale chart)
        base_nifty = rows[0]["nifty"] if rows else 0
        base_nb    = next((r["niftybees"] for r in rows if r["niftybees"]), None)
        for row in rows:
            row["nifty_pct"]    = round((row["nifty"] / base_nifty - 1) * 100, 2) if base_nifty else 0.0
            row["niftybees_pct"] = round((row["niftybees"] / base_nb - 1) * 100, 2) if (base_nb and row["niftybees"]) else None

        return rows

    result = await _run(_fetch)
    return _clean(result)
