"""Market Brain REST endpoints."""

from __future__ import annotations
import asyncio
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.routes.auth import get_current_user

router = APIRouter()


async def _in_thread(fn):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn)


# ── Pydantic models ───────────────────────────────────────────────────────────

class PlanRequest(BaseModel):
    strategy_type: str = "IRON_FLY"   # IRON_FLY | IRON_CONDOR
    lots: int = 1
    symbol: str = "NIFTY"             # NIFTY | BANKNIFTY (override AI pick)


class EnterRequest(BaseModel):
    plan: dict[str, Any]
    broker: str = "angelone"
    auto_exit: bool = False


class ExitRequest(BaseModel):
    broker: str = "angelone"


# ── GET /market-brain/assess ──────────────────────────────────────────────────

@router.get("/market-brain/assess")
async def assess(user=Depends(get_current_user)):
    """Gather market data + AI assessment + OI analysis. Cached 30 min."""
    try:
        import json, math
        from ai.market_brain import gather_market_data, assess_market, get_oi_analysis, get_monthly_expiry
        market_data = await _in_thread(gather_market_data)
        assessment  = await _in_thread(lambda: assess_market(market_data))
        underlying  = assessment.get("underlying", "NIFTY")
        expiry, _   = await _in_thread(lambda: get_monthly_expiry(underlying))
        oi_analysis = await _in_thread(lambda: get_oi_analysis(underlying, expiry))
        payload = {
            "market_data": market_data,
            "assessment":  assessment,
            "oi_analysis": oi_analysis,
        }
        # FastAPI's default encoder can't handle float('nan') — sanitize first
        clean = json.loads(json.dumps(payload, default=lambda v: None if isinstance(v, float) and math.isnan(v) else v))
        return JSONResponse(clean)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── POST /market-brain/plan ───────────────────────────────────────────────────

@router.post("/market-brain/plan")
async def plan(body: PlanRequest, user=Depends(get_current_user)):
    """Calculate Iron Fly or Iron Condor strike plan for the given symbol."""
    try:
        from ai.market_brain import plan_iron_fly, plan_iron_condor
        sym = body.symbol.upper()
        if body.strategy_type == "IRON_FLY":
            result = await _in_thread(lambda: plan_iron_fly(sym, body.lots))
        elif body.strategy_type == "IRON_CONDOR":
            result = await _in_thread(lambda: plan_iron_condor(sym, body.lots))
        else:
            return JSONResponse({"error": f"Unknown strategy_type: {body.strategy_type}"}, status_code=400)

        if "error" in result:
            return JSONResponse({"error": result["error"]}, status_code=400)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── POST /market-brain/enter ──────────────────────────────────────────────────

@router.post("/market-brain/enter")
async def enter_trade(body: EnterRequest, user=Depends(get_current_user)):
    """
    Place all 4 legs of the planned trade via the connected broker.
    Saves the trade to ai_trades.json.
    """
    from data.broker_creds import get_session
    from brokers import get_broker
    from data.ai_trades import save_trade

    plan = body.plan
    broker_name = body.broker
    session = get_session(user["username"], broker_name)
    if not session:
        return JSONResponse(
            {"error": f"Not connected to {broker_name}. Please connect first."},
            status_code=400,
        )

    legs       = plan.get("legs", [])
    symbol     = plan.get("symbol", "NIFTY")
    expiry     = plan.get("expiry", "")
    lot_size   = plan.get("lot_size", 25)
    lots       = plan.get("lots", 1)
    qty        = plan.get("qty") or lots * lot_size
    net_credit = plan.get("net_credit", 0.0)

    # Build option symbols for NFO
    def _option_symbol(sym: str, expiry_str: str, strike: float, opt_type: str) -> str:
        """Build Angel One NFO trading symbol e.g. NIFTY27NOV2524500CE."""
        try:
            from datetime import datetime
            for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
                try:
                    dt = datetime.strptime(expiry_str, fmt)
                    dd  = dt.strftime("%d")
                    mon = dt.strftime("%b").upper()[:3]
                    yy  = dt.strftime("%y")
                    return f"{sym}{dd}{mon}{yy}{int(strike)}{opt_type}"
                except ValueError:
                    pass
        except Exception:
            pass
        return f"{sym}{int(strike)}{opt_type}"

    bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
    order_results = []
    errors = []

    for leg in legs:
        side      = "SELL" if leg["role"] == "short" else "BUY"
        tsymbol   = _option_symbol(symbol, expiry, leg["strike"], leg["option_type"])
        params = {
            "symbol":     tsymbol,
            "token":      leg.get("token", ""),
            "exchange":   leg.get("exchange", "NFO"),
            "side":       side,
            "qty":        qty,
            "price":      0,
            "order_type": "MARKET",
            "product":    "CARRYFORWARD",
        }
        try:
            result = await _in_thread(lambda p=params: get_broker(bn, sess, ck).place_order(p))
            order_results.append({**result, "leg": leg})
        except Exception as e:
            errors.append(f"{side} {tsymbol}: {e}")

    if errors and not order_results:
        return JSONResponse({"error": "; ".join(errors)}, status_code=400)

    # Save trade to persistent store
    trade = {
        "strategy_type":   plan.get("strategy", "IRON_FLY"),
        "symbol":          symbol,
        "expiry":          expiry,
        "dte_at_entry":    plan.get("dte", 0),
        "lots":            lots,
        "lot_size":        lot_size,
        "qty":             qty,
        "atm_at_entry":    plan.get("atm", 0),
        "spot_at_entry":   plan.get("spot", 0),
        "legs":            legs,
        "entry_credit":    net_credit,
        "max_profit":      plan.get("max_profit", 0),
        "max_loss":        plan.get("max_loss", 0),
        "breakevens":      plan.get("breakevens", []),
        "exit_targets":    plan.get("exit_targets", {}),
        "auto_exit":       body.auto_exit,
        "broker":          broker_name,
        "username":        user["username"],
        "order_ids":       [r.get("order_id") for r in order_results if r.get("order_id")],
    }
    saved = save_trade(trade)

    return {
        "trade_id":      saved["id"],
        "orders":        order_results,
        "errors":        errors,
        "trade":         saved,
        "message": f"Entered {plan.get('strategy', 'IRON_FLY')} on {symbol} — {len(order_results)}/{len(legs)} legs placed",
    }


# ── GET /market-brain/trades ──────────────────────────────────────────────────

@router.get("/market-brain/trades")
async def list_trades(user=Depends(get_current_user)):
    """Return active trades with live P&L calculations."""
    from data.ai_trades import list_trades as _list
    from ai.market_brain import calculate_current_pnl

    trades = _list(username=user["username"], status="active")

    enriched = []
    for t in trades:
        pnl_data = await _in_thread(lambda trade=t: calculate_current_pnl(trade))
        enriched.append({**t, "live": pnl_data})

    return {"trades": enriched}


# ── POST /market-brain/exit/{trade_id} ───────────────────────────────────────

@router.post("/market-brain/exit/{trade_id}")
async def exit_trade(trade_id: str, body: ExitRequest, user=Depends(get_current_user)):
    """Close all legs of a trade with MARKET orders and mark trade as closed."""
    from data.ai_trades import get_trade, close_trade
    from data.broker_creds import get_session
    from brokers import get_broker
    from ai.market_brain import calculate_current_pnl

    trade = get_trade(trade_id)
    if not trade:
        return JSONResponse({"error": "Trade not found"}, status_code=404)
    if trade.get("username") != user["username"]:
        return JSONResponse({"error": "Access denied"}, status_code=403)
    if trade.get("status") == "closed":
        return JSONResponse({"error": "Trade already closed"}, status_code=400)

    broker_name = body.broker or trade.get("broker", "angelone")
    session = get_session(user["username"], broker_name)
    if not session:
        return JSONResponse(
            {"error": f"Not connected to {broker_name}. Please connect first."},
            status_code=400,
        )

    legs     = trade.get("legs", [])
    symbol   = trade.get("symbol", "NIFTY")
    expiry   = trade.get("expiry", "")
    qty      = trade.get("qty") or (trade.get("lots", 1) * trade.get("lot_size", 25))
    bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"

    def _option_symbol(sym: str, exp: str, strike: float, opt_type: str) -> str:
        try:
            from datetime import datetime
            for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
                try:
                    dt = datetime.strptime(exp, fmt)
                    return f"{sym}{dt.strftime('%d')}{dt.strftime('%b').upper()[:3]}{dt.strftime('%y')}{int(strike)}{opt_type}"
                except ValueError:
                    pass
        except Exception:
            pass
        return f"{sym}{int(strike)}{opt_type}"

    order_results = []
    errors = []

    for leg in legs:
        close_side = "BUY" if leg["role"] == "short" else "SELL"
        tsymbol = _option_symbol(symbol, expiry, leg["strike"], leg["option_type"])
        params = {
            "symbol":     tsymbol,
            "token":      leg.get("token", ""),
            "exchange":   leg.get("exchange", "NFO"),
            "side":       close_side,
            "qty":        qty,
            "price":      0,
            "order_type": "MARKET",
            "product":    "CARRYFORWARD",
        }
        try:
            result = await _in_thread(lambda p=params: get_broker(bn, sess, ck).place_order(p))
            order_results.append({**result, "leg": leg})
        except Exception as e:
            errors.append(f"{close_side} {tsymbol}: {e}")

    # Compute final P&L before closing
    try:
        pnl_data = await _in_thread(lambda: calculate_current_pnl(trade))
        final_pnl = pnl_data.get("pnl_total", 0)
    except Exception:
        final_pnl = 0

    note = f"Closed by user. Final P&L: ₹{final_pnl:,.0f}"
    closed = close_trade(trade_id, note)

    return {
        "closed":    True,
        "trade_id":  trade_id,
        "final_pnl": final_pnl,
        "orders":    order_results,
        "errors":    errors,
        "message": f"Closed {trade.get('strategy_type', '')} — {len(order_results)}/{len(legs)} legs closed",
    }


# ── POST /market-brain/toggle-auto-exit/{trade_id} ────────────────────────────

@router.post("/market-brain/toggle-auto-exit/{trade_id}")
async def toggle_auto_exit(trade_id: str, user=Depends(get_current_user)):
    """Flip the auto_exit flag for a trade."""
    from data.ai_trades import get_trade, update_trade

    trade = get_trade(trade_id)
    if not trade:
        return JSONResponse({"error": "Trade not found"}, status_code=404)
    if trade.get("username") != user["username"]:
        return JSONResponse({"error": "Access denied"}, status_code=403)

    new_val = not trade.get("auto_exit", False)
    updated = update_trade(trade_id, {"auto_exit": new_val})
    return {"trade_id": trade_id, "auto_exit": new_val}
