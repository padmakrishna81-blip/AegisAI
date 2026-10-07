"""Stock Trader API routes — AI-driven equity auto-trading."""
from __future__ import annotations
import asyncio
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.routes.auth import get_current_user
from auth.auth_utils import require_role

router = APIRouter()


async def _in_thread(fn):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn)


def _clean_nan(obj):
    import math
    if isinstance(obj, dict):
        return {k: _clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_nan(v) for v in obj]
    if isinstance(obj, float) and math.isnan(obj):
        return None
    return obj


# ── Pydantic models ───────────────────────────────────────────────────────────

class StockItem(BaseModel):
    symbol: str
    display: str = ""
    sector: str = ""
    cap_type: str = ""
    allocation_pct: float
    justification: str = ""
    conviction: str = "MEDIUM"
    asset_type: str = "stock"   # "stock" | "etf"


class CampaignCreate(BaseModel):
    name: str
    broker: str = "angelone"
    reserved_fund: float
    auto_trade: bool = False
    entry_condition: dict = {"type": "manual"}
    chunk_config: dict = {}
    exit_config: dict = {}
    split_config: dict = {}     # {} = 100% stocks; {"stocks_pct": 50, "etfs_pct": 50}
    stocks: list[StockItem]


class CampaignPatch(BaseModel):
    auto_trade: bool | None = None
    entry_condition: dict | None = None
    reserved_fund: float | None = None
    manual_trigger: bool | None = None
    status: str | None = None
    name: str | None = None
    chunk_config: dict | None = None
    exit_config: dict | None = None


class ScreenRequest(BaseModel):
    chips: list[str] = []


# ── Broker balance check ──────────────────────────────────────────────────────

@router.get("/stock-trader/broker-balance")
async def broker_balance_check(broker: str = "angelone", user=Depends(require_role('live_trader'))):
    """Check available balance — live_trader role required."""
    try:
        from ai.trade_agent import get_broker_balance
        result = await _in_thread(lambda: get_broker_balance(user["username"], broker))
        return result
    except Exception as e:
        return JSONResponse({"connected": False, "error": str(e)}, status_code=200)


# ── AI Stock Picks ────────────────────────────────────────────────────────────

@router.get("/stock-trader/picks")
async def get_picks(user=Depends(get_current_user)):
    try:
        from ai.stock_picker import get_ai_picks
        result = await _in_thread(get_ai_picks)
        return JSONResponse(_clean_nan(result))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/stock-trader/picks/refresh")
async def refresh_picks(user=Depends(get_current_user)):
    try:
        from ai.stock_picker import get_ai_picks
        result = await _in_thread(lambda: get_ai_picks(force_refresh=True))
        return JSONResponse(_clean_nan(result))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── AI ETF Picks ──────────────────────────────────────────────────────────────

@router.get("/stock-trader/etf-picks")
async def get_etf_picks_route(user=Depends(get_current_user)):
    try:
        from ai.etf_screener import get_etf_picks
        result = await _in_thread(get_etf_picks)
        return JSONResponse(_clean_nan(result))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/stock-trader/etf-picks/refresh")
async def refresh_etf_picks(user=Depends(get_current_user)):
    try:
        from ai.etf_screener import get_etf_picks
        result = await _in_thread(lambda: get_etf_picks(force_refresh=True))
        return JSONResponse(_clean_nan(result))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Rule-based Stock Screener ─────────────────────────────────────────────────

@router.post("/stock-trader/screen")
async def screen_stocks(body: ScreenRequest, user=Depends(get_current_user)):
    try:
        from ai.stock_picker import screen_by_chips
        result = await _in_thread(lambda: screen_by_chips(body.chips))
        return JSONResponse(_clean_nan(result))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Campaigns ─────────────────────────────────────────────────────────────────

@router.post("/stock-trader/campaign")
async def create_campaign_route(body: CampaignCreate, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import create_campaign

        # Validate allocation per asset class: stocks sum to 100, ETFs sum to 100
        stock_allocs = [s.allocation_pct for s in body.stocks if s.asset_type != "etf"]
        etf_allocs   = [s.allocation_pct for s in body.stocks if s.asset_type == "etf"]
        if stock_allocs:
            total = sum(stock_allocs)
            if not (99 <= total <= 101):
                return JSONResponse({"error": f"Stock allocations must sum to 100%. Got {total:.1f}%"}, status_code=400)
        if etf_allocs:
            total = sum(etf_allocs)
            if not (99 <= total <= 101):
                return JSONResponse({"error": f"ETF allocations must sum to 100%. Got {total:.1f}%"}, status_code=400)
        if not stock_allocs and not etf_allocs:
            return JSONResponse({"error": "No stocks or ETFs provided"}, status_code=400)
        # Validate split_config when both classes are present
        split = body.split_config
        if stock_allocs and etf_allocs and split:
            sp, ep = float(split.get("stocks_pct", 0)), float(split.get("etfs_pct", 0))
            if abs(sp + ep - 100) > 1:
                return JSONResponse({"error": f"split_config stocks_pct + etfs_pct must equal 100. Got {sp}+{ep}"}, status_code=400)

        stocks = [
            {
                **s.dict(),
                "status":       "watching",
                "chunk1_qty":   0, "chunk1_price": 0.0,
                "chunk2_qty":   0, "chunk2_price": 0.0,
                "avg_price":    0.0, "total_qty":   0,
                "sl_price":     0.0, "current_price": 0.0,
                "pnl":          0.0, "pnl_pct":      0.0,
            }
            for s in body.stocks
        ]
        campaign = {
            "username":        user["username"],
            "name":            body.name,
            "broker":          body.broker,
            "reserved_fund":   body.reserved_fund,
            "auto_trade":      body.auto_trade,
            "entry_condition": body.entry_condition,
            "chunk_config":    body.chunk_config,
            "exit_config":     body.exit_config,
            "split_config":    body.split_config,
            "stocks":          stocks,
            "status":          "active",
            "cycle":           1,
            "chunk1_deployed": 0,
            "chunk2_deployed": False,
        }
        created = create_campaign(campaign)
        return created
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/campaigns")
async def list_campaigns_route(user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import list_campaigns
        return {"campaigns": list_campaigns(user["username"])}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/campaign/{cid}")
async def get_campaign_route(cid: str, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        return c
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.patch("/stock-trader/campaign/{cid}")
async def patch_campaign_route(cid: str, body: CampaignPatch, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_campaign, update_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        updates = {k: v for k, v in body.dict().items() if v is not None}
        updated = update_campaign(cid, updates)
        return updated
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.delete("/stock-trader/campaign/{cid}")
async def delete_campaign_route(cid: str, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_campaign, delete_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        delete_campaign(cid)
        return {"deleted": cid}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.patch("/stock-trader/campaign/{cid}/stock/{symbol}")
async def patch_stock_in_campaign(cid: str, symbol: str, body: dict, user=Depends(get_current_user)):
    """Update mutable fields on a single stock within a campaign."""
    try:
        from data.stock_trader_store import get_campaign, update_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)

        MUTABLE = {"allocation_pct", "status", "justification", "conviction"}
        updated = False
        for stock in c["stocks"]:
            if stock["symbol"] == symbol:
                for k, v in body.items():
                    if k in MUTABLE:
                        stock[k] = v
                        updated = True
                break

        if not updated:
            return JSONResponse({"error": f"Stock {symbol} not found in campaign"}, status_code=404)

        result = update_campaign(cid, {"stocks": c["stocks"]})
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.delete("/stock-trader/campaign/{cid}/stock/{symbol}")
async def remove_stock_from_campaign(cid: str, symbol: str, user=Depends(get_current_user)):
    """Remove a stock from a campaign. Stops monitoring; does NOT place broker sell orders."""
    try:
        from data.stock_trader_store import get_campaign, update_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)

        original = len(c["stocks"])
        c["stocks"] = [s for s in c["stocks"] if s["symbol"] != symbol]
        if len(c["stocks"]) == original:
            return JSONResponse({"error": f"Stock {symbol} not found"}, status_code=404)

        result = update_campaign(cid, {"stocks": c["stocks"]})
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/stock-trader/campaign/{cid}/stock")
async def add_stock_to_campaign(cid: str, body: StockItem, user=Depends(get_current_user)):
    """Add a new stock or ETF to an existing campaign (starts in 'watching' status)."""
    try:
        from data.stock_trader_store import get_campaign, update_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)

        if any(s["symbol"] == body.symbol for s in c.get("stocks", [])):
            return JSONResponse({"error": f"{body.symbol} is already in this campaign"}, status_code=400)

        new_stock = {
            **body.dict(),
            "status":        "watching",
            "chunk1_qty":    0, "chunk1_price": 0.0,
            "chunk2_qty":    0, "chunk2_price": 0.0,
            "avg_price":     0.0, "total_qty":  0,
            "sl_price":      0.0, "current_price": 0.0,
            "pnl":           0.0, "pnl_pct":    0.0,
        }
        updated_stocks = c.get("stocks", []) + [new_stock]
        result = update_campaign(cid, {"stocks": updated_stocks})
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Trade agent actions ───────────────────────────────────────────────────────

@router.post("/stock-trader/campaign/{cid}/reset-errors")
async def reset_errors_route(cid: str, user=Depends(get_current_user)):
    """Move all error-status stocks back to watching so the agent can retry after broker reconnect."""
    try:
        from data.stock_trader_store import get_campaign
        from ai.trade_agent import reset_campaign_errors
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        result = await _in_thread(lambda: reset_campaign_errors(cid))
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/campaign/{cid}/order-preview")
async def order_preview(cid: str, user=Depends(get_current_user)):
    """Preview chunk-1 order quantities and limit prices without placing orders."""
    try:
        from data.stock_trader_store import get_campaign
        from ai.trade_agent import preview_chunk_orders
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        result = await _in_thread(lambda: preview_chunk_orders(cid))
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/stock-trader/campaign/{cid}/run")
async def run_campaign_cycle(cid: str, user=Depends(require_role('live_trader'))):
    """Execute a live campaign cycle — live_trader role required."""
    try:
        from data.stock_trader_store import get_campaign
        from ai.trade_agent import run_campaign
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        result = await _in_thread(lambda: run_campaign(cid))
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/positions/live")
async def live_positions(user=Depends(get_current_user)):
    """Return all active positions with live prices and freshly computed P&L."""
    try:
        from data.stock_trader_store import list_campaigns
        from ai.trade_agent import _batch_prices

        campaigns = list_campaigns(user["username"])
        positions = []
        symbols_needed: list[str] = []

        for c in campaigns:
            for s in c.get("stocks", []):
                if s.get("status") not in ("watching", "error"):
                    positions.append({**s, "_campaign": c["name"], "_cid": c["id"]})
                    symbols_needed.append(s["symbol"])

        if not positions:
            return {"positions": []}

        prices = await _in_thread(lambda: _batch_prices(list(set(symbols_needed))))

        for p in positions:
            live = prices.get(p["symbol"])
            if live and live > 0:
                qty = p.get("total_qty") or p.get("chunk1_qty") or 0
                avg = float(p.get("avg_price") or 0)
                p["current_price"] = live
                if qty and avg:
                    p["pnl"]     = round((live - avg) * qty, 2)
                    p["pnl_pct"] = round(((live - avg) / avg) * 100, 4)

        return {"positions": _clean_nan(positions)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/campaign/{cid}/fundamentals/{symbol}")
async def get_fundamentals(cid: str, symbol: str, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_campaign
        from ai.trade_agent import check_fundamentals
        c = get_campaign(cid)
        if not c or (c["username"] != user["username"] and user.get("role") != "admin"):
            return JSONResponse({"error": "Not found or access denied"}, status_code=404)
        result = await _in_thread(lambda: check_fundamentals(symbol))
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Trade log ─────────────────────────────────────────────────────────────────

@router.get("/stock-trader/campaign/{cid}/log")
async def get_log(cid: str, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_campaign, get_trade_log
        c = get_campaign(cid)
        if not c:
            return JSONResponse({"error": "Not found"}, status_code=404)
        if c["username"] != user["username"] and user.get("role") != "admin":
            return JSONResponse({"error": "Access denied"}, status_code=403)
        return {"logs": get_trade_log(cid)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Monthly reports ───────────────────────────────────────────────────────────

@router.get("/stock-trader/reports")
async def list_reports(user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import list_monthly_reports
        return {"reports": list_monthly_reports(user["username"])}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/stock-trader/reports/generate")
async def generate_report(user=Depends(get_current_user)):
    try:
        from ai.trade_agent import generate_monthly_report
        report = await _in_thread(lambda: generate_monthly_report(user["username"]))
        return report
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/stock-trader/reports/{year_month}")
async def get_report(year_month: str, user=Depends(get_current_user)):
    try:
        from data.stock_trader_store import get_monthly_report
        report = get_monthly_report(user["username"], year_month)
        if not report:
            return JSONResponse({"error": "Report not found. Generate it first."}, status_code=404)
        return report
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
