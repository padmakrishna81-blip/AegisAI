"""Wheel Strategy AI Agent endpoints."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any
from fastapi.responses import JSONResponse

router = APIRouter()


# ─── Scout ────────────────────────────────────────────────────────────────────

class ScoutInput(BaseModel):
    candidates: list[dict[str, Any]]


@router.post("/wheel/agent/scout")
async def wheel_scout(body: ScoutInput):
    if not body.candidates:
        return JSONResponse({"error": "No candidates provided"}, status_code=400)
    from ai.wheel_agent import scout
    return scout(body.candidates)


# ─── Plan ─────────────────────────────────────────────────────────────────────

class PlanInput(BaseModel):
    symbol: str
    lots: int = 1
    expiry: str = ""


@router.post("/wheel/agent/plan")
async def wheel_plan(body: PlanInput):
    if not body.symbol:
        return JSONResponse({"error": "symbol is required"}, status_code=400)
    from ai.wheel_agent import plan
    result = plan(symbol=body.symbol, lots=body.lots, expiry=body.expiry)
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


# ─── Review ───────────────────────────────────────────────────────────────────

class ReviewInput(BaseModel):
    symbol: str
    type: str
    strike: float
    expiry: str
    sell_price: float
    lots: int = 1
    lot_size: int = 1
    avg_cost: float = 0.0


@router.post("/wheel/agent/review")
async def wheel_review(body: ReviewInput):
    if not body.symbol or not body.expiry:
        return JSONResponse({"error": "symbol and expiry are required"}, status_code=400)
    from ai.wheel_agent import review
    result = review(body.dict())
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


# ─── Strategy Review ──────────────────────────────────────────────────────────

class StrategyReviewInput(BaseModel):
    legs: list[dict[str, Any]]
    strategy_name: str = ""


@router.post("/wheel/agent/strategy-review")
async def strategy_review_endpoint(body: StrategyReviewInput):
    if not body.legs:
        return JSONResponse({"error": "No legs provided"}, status_code=400)
    from ai.wheel_agent import strategy_review
    result = strategy_review(body.legs, strategy_name=body.strategy_name)
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


# ─── Monitor: Save ────────────────────────────────────────────────────────────

class MonitorSaveInput(BaseModel):
    name: str
    legs: list[dict[str, Any]]
    id: str = ""


@router.post("/wheel/agent/monitor/save")
async def monitor_save(body: MonitorSaveInput):
    from data.strategy_monitor import save_strategy
    sid = save_strategy({"id": body.id, "name": body.name, "legs": body.legs})
    return {"id": sid, "name": body.name, "message": "Strategy saved to monitor"}


# ─── Monitor: List ────────────────────────────────────────────────────────────

@router.get("/wheel/agent/monitor/list")
async def monitor_list():
    from data.strategy_monitor import load_strategies
    return {"strategies": load_strategies()}


# ─── Monitor: Check ───────────────────────────────────────────────────────────

class MonitorCheckInput(BaseModel):
    id: str = ""   # empty = check all


@router.post("/wheel/agent/monitor/check")
async def monitor_check(body: MonitorCheckInput):
    from data.strategy_monitor import run_monitor_checks
    results = run_monitor_checks(strategy_id=body.id)
    return {"checked": len(results), "results": results}


# ─── Monitor: Delete ──────────────────────────────────────────────────────────

@router.delete("/wheel/agent/monitor/{strategy_id}")
async def monitor_delete(strategy_id: str):
    from data.strategy_monitor import delete_strategy
    ok = delete_strategy(strategy_id)
    if not ok:
        return JSONResponse({"error": "Strategy not found"}, status_code=404)
    return {"deleted": strategy_id}


# ─── Monitor: Alert count ─────────────────────────────────────────────────────

@router.get("/wheel/agent/monitor/alerts")
async def monitor_alerts():
    from data.strategy_monitor import load_strategies, get_alert_count
    strategies = load_strategies()
    count = get_alert_count()
    active = [
        {"id": s["id"], "name": s["name"], "action": s["last_alert"]["overall_action"],
         "pnl": s["last_alert"].get("total_pnl", 0), "last_checked": s.get("last_checked")}
        for s in strategies
        if s.get("last_alert") and s["last_alert"].get("overall_action", "hold") != "hold"
    ]
    return {"count": count, "strategies": active}

