"""Portfolio CRUD endpoints."""

import json
import os
import uuid
from fastapi import APIRouter, HTTPException
from api.models.portfolio import Holding, HoldingInput, Portfolio, MonthlyIncomeUpdate
from data.market_data import get_info, safe_get

router = APIRouter()

PORTFOLIO_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "portfolio_data.json")

# In-memory state
_portfolio: dict = {
    "holdings": {},
    "cash_available": 0,
    "monthly_income_target": 0,
    "monthly_income_achieved": 0,
}


def _load():
    global _portfolio
    if os.path.exists(PORTFOLIO_FILE):
        try:
            with open(PORTFOLIO_FILE) as f:
                _portfolio = json.load(f)
        except Exception:
            pass


def _save():
    try:
        with open(PORTFOLIO_FILE, "w") as f:
            json.dump(_portfolio, f, indent=2)
    except Exception:
        pass


_load()


@router.get("/portfolio")
async def get_portfolio():
    holdings_list = []
    total_value = 0
    total_invested = 0

    for h_id, h in _portfolio.get("holdings", {}).items():
        sym = h["symbol"]
        info = get_info(sym)
        current = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=0) or 0
        company_name = safe_get(info, "longName", default=sym) or sym
        avg = h.get("avg_price", 0)
        qty = h.get("quantity", 0)
        invested = avg * qty
        curr_val = current * qty
        pnl = curr_val - invested
        pnl_pct = (pnl / invested * 100) if invested else 0

        holdings_list.append({
            "id": h_id,
            "symbol": sym,
            "company_name": company_name,
            "quantity": qty,
            "avg_price": avg,
            "current_price": round(current, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2),
            "covered_call_eligible": qty >= 100,
        })
        total_value += curr_val
        total_invested += invested

    total_pnl = total_value - total_invested
    total_pnl_pct = (total_pnl / total_invested * 100) if total_invested else 0

    return {
        "holdings": holdings_list,
        "total_value": round(total_value, 2),
        "total_invested": round(total_invested, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl_pct, 2),
        "cash_available": _portfolio.get("cash_available", 0),
        "monthly_income_target": _portfolio.get("monthly_income_target", 0),
        "monthly_income_achieved": _portfolio.get("monthly_income_achieved", 0),
    }


@router.post("/portfolio/holding")
async def add_holding(holding: HoldingInput):
    h_id = str(uuid.uuid4())
    _portfolio.setdefault("holdings", {})[h_id] = {
        "symbol": holding.symbol.upper().strip(),
        "quantity": holding.quantity,
        "avg_price": holding.avg_price,
    }
    _save()
    return {"id": h_id, "message": "Holding added"}


@router.delete("/portfolio/holding/{holding_id}")
async def delete_holding(holding_id: str):
    if holding_id not in _portfolio.get("holdings", {}):
        raise HTTPException(status_code=404, detail="Holding not found")
    del _portfolio["holdings"][holding_id]
    _save()
    return {"message": "Holding removed"}


@router.put("/portfolio/holding/{holding_id}")
async def update_holding(holding_id: str, holding: HoldingInput):
    if holding_id not in _portfolio.get("holdings", {}):
        raise HTTPException(status_code=404, detail="Holding not found")
    _portfolio["holdings"][holding_id] = {
        "symbol": holding.symbol.upper().strip(),
        "quantity": holding.quantity,
        "avg_price": holding.avg_price,
    }
    _save()
    return {"message": "Holding updated"}


@router.post("/portfolio/income")
async def update_monthly_income(update: MonthlyIncomeUpdate):
    _portfolio["monthly_income_achieved"] = update.amount
    _save()
    return {"message": "Income updated"}


@router.post("/portfolio/target")
async def set_income_target(update: MonthlyIncomeUpdate):
    _portfolio["monthly_income_target"] = update.amount
    _save()
    return {"message": "Target updated"}


@router.post("/portfolio/cash")
async def set_portfolio_cash(update: MonthlyIncomeUpdate):
    """Set available cash (for paper portfolio tracking)."""
    _portfolio["cash_available"] = update.amount
    _save()
    return {"message": "Cash updated", "cash_available": update.amount}
