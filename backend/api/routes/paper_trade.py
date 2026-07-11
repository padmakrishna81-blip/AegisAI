"""Paper Trade API routes."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from api.utils import clean_for_json
from engines import paper_trade as pt
from data.market_data import get_info, safe_get, normalize_symbol

router = APIRouter()


# ─── Request models ───────────────────────────────────────────────────────────

class ChunkInput(BaseModel):
    chunk_no: int
    allocation_pct: float
    entry_price: float
    profit_pct: float


class CreateTradeInput(BaseModel):
    symbol: str
    total_allocation: float
    chunks: list[ChunkInput]
    notes: str = ""
    mtm_target_pct: Optional[float] = None   # set at creation time — overrides chunk-level exits
    mtm_target_inr: Optional[float] = None


class UpdateChunksInput(BaseModel):
    chunks: list[ChunkInput]


class MtmTargetInput(BaseModel):
    mtm_pct: Optional[float] = None   # e.g. 8.5 = exit at +8.5% MTM, -5 = stop at -5%
    mtm_inr: Optional[float] = None   # e.g. 8000 = exit at +₹8000 MTM, -3000 = stop at -₹3000


class SetCashInput(BaseModel):
    amount: float


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/paper/summary")
async def get_summary():
    """Portfolio-level summary with per-symbol aggregated holdings."""
    trades = pt.get_all_trades()
    cash = pt.get_virtual_cash()

    total_invested = 0.0
    unrealised_pnl = 0.0
    realised_pnl = 0.0

    # Collect FRESH live prices (bypass cache) for active/paused trades
    active_symbols = list({t["symbol"] for t in trades if t["status"] in ("ACTIVE", "PAUSED")})
    live_prices: dict[str, float] = {}
    for sym in active_symbols:
        try:
            import yfinance as yf
            fast = yf.Ticker(sym).fast_info
            p = getattr(fast, "last_price", None) or getattr(fast, "regular_market_price", None)
            if p and float(p) > 0:
                live_prices[sym] = float(p)
                continue
        except Exception:
            pass
        # Fallback to cached info
        try:
            info = get_info(sym)
            p = safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or 0
            if p:
                live_prices[sym] = float(p)
        except Exception:
            pass

    # ── Per-symbol aggregation (across all trades for that symbol) ────────────
    # symbol -> {total_qty, total_cost, live_price}
    symbol_agg: dict[str, dict] = {}

    positions = []
    for trade in trades:
        sym = trade["symbol"]
        live = live_prices.get(sym, 0)
        trade_invested = 0.0
        trade_unrealised = 0.0
        chunks_detail = []

        for chunk in trade["chunks"]:
            status = chunk["status"]
            qty = chunk["quantity"]
            buy_price = chunk.get("buy_price")

            if status == "BOUGHT" and buy_price:
                cost = qty * buy_price
                trade_invested += cost
                if live > 0:
                    trade_unrealised += (live - buy_price) * qty
                # Aggregate by symbol — only BOUGHT chunks count as holdings
                if sym not in symbol_agg:
                    symbol_agg[sym] = {"total_qty": 0, "total_cost": 0.0,
                                       "company_name": trade["company_name"], "live": live}
                symbol_agg[sym]["total_qty"] += qty
                symbol_agg[sym]["total_cost"] += cost
                symbol_agg[sym]["live"] = live

            elif status == "SOLD":
                realised_pnl += chunk.get("realised_pnl") or 0

            # Compute distance-to-entry for WAITING chunks (how far CMP is from trigger)
            dist_to_entry = None
            dist_to_entry_pct = None
            if status == "WAITING" and live > 0:
                dist_to_entry = round(live - chunk["entry_price"], 2)         # positive = CMP above entry (not triggered yet)
                dist_to_entry_pct = round(dist_to_entry / chunk["entry_price"] * 100, 2)

            chunks_detail.append({
                "chunk_no": chunk["chunk_no"],
                "status": status,
                "entry_price": chunk["entry_price"],
                "exit_price": chunk["exit_price"],
                "buy_price": buy_price,
                "sell_price": chunk.get("sell_price"),
                "quantity": qty,
                "allocation_pct": chunk["allocation_pct"],
                "profit_pct": chunk["profit_pct"],
                "realised_pnl": chunk.get("realised_pnl"),
                "unrealised_pnl": round((live - buy_price) * qty, 2)
                    if (status == "BOUGHT" and buy_price and live) else None,
                "cmp": round(live, 2) if live else None,
                "dist_to_entry": dist_to_entry,           # positive = needs to drop, negative = already below (should have triggered)
                "dist_to_entry_pct": dist_to_entry_pct,
            })

        total_invested += trade_invested
        unrealised_pnl += trade_unrealised

        # has_any_fill: at least one chunk is BOUGHT or SOLD
        has_any_fill = any(c["status"] in ("BOUGHT", "SOLD") for c in trade["chunks"])

        positions.append({
            "trade_id": trade["trade_id"],
            "symbol": sym,
            "company_name": trade["company_name"],
            "status": trade["status"],
            "has_any_fill": has_any_fill,          # False = pure trade plan, no executions yet
            "total_allocation": trade["total_allocation"],
            "invested": round(trade_invested, 2),
            "current_value": round(trade_invested + trade_unrealised, 2),
            "unrealised_pnl": round(trade_unrealised, 2),
            "unrealised_pnl_pct": round(trade_unrealised / trade_invested * 100, 2) if trade_invested else 0,
            "realised_pnl": trade.get("total_realised_pnl", 0),
            "live_price": live,
            "mtm_target_pct": trade.get("mtm_target_pct"),
            "mtm_target_inr": trade.get("mtm_target_inr"),
            "chunks": chunks_detail,
        })

    # Build aggregated holdings with target value
    holdings = []
    for sym, agg in symbol_agg.items():
        total_qty = agg["total_qty"]
        total_cost = agg["total_cost"]
        live = agg["live"]
        avg_cost = round(total_cost / total_qty, 2) if total_qty else 0
        current_val = round(total_qty * live, 2) if live else 0
        mtm = round(current_val - total_cost, 2)
        mtm_pct = round(mtm / total_cost * 100, 2) if total_cost else 0

        # Collect bought chunks for this symbol across all trades
        bought_chunks_for_sym = []
        mtm_target_pct = None
        mtm_target_inr = None
        chunk_details_for_holding = []
        for trade in trades:
            if trade["symbol"] != sym:
                continue
            if trade.get("mtm_target_pct") is not None:
                mtm_target_pct = trade["mtm_target_pct"]
            if trade.get("mtm_target_inr") is not None:
                mtm_target_inr = trade["mtm_target_inr"]
            for c in trade["chunks"]:
                if c["status"] == "BOUGHT" and c.get("buy_price"):
                    bought_chunks_for_sym.append(c)
                    bp = c["buy_price"]
                    ep = c["exit_price"]
                    qty = c["quantity"]
                    chunk_details_for_holding.append({
                        "trade_id": trade["trade_id"],
                        "chunk_no": c["chunk_no"],
                        "buy_price": round(bp, 2),
                        "exit_price": round(ep, 2),
                        "quantity": qty,
                        "profit_pct": c["profit_pct"],
                        "cost": round(qty * bp, 2),
                        "target_value": round(qty * ep, 2),
                        "current_value": round(qty * live, 2) if live else 0,
                        "unrealised_pnl": round((live - bp) * qty, 2) if live else 0,
                        "buy_time": c.get("buy_time"),
                    })

        # Target value: MTM-based if set, otherwise sum of individual chunk exit values
        if mtm_target_inr is not None:
            target_value = round(total_cost + mtm_target_inr, 2)
            target_pnl = mtm_target_inr
            target_label = f"MTM ₹{mtm_target_inr:+,.0f}"
        elif mtm_target_pct is not None:
            target_pnl = round(total_cost * mtm_target_pct / 100, 2)
            target_value = round(total_cost + target_pnl, 2)
            target_label = f"MTM {mtm_target_pct:+.1f}%"
        else:
            target_value = sum(c["quantity"] * c["exit_price"] for c in bought_chunks_for_sym)
            target_value = round(target_value, 2)
            target_pnl = round(target_value - total_cost, 2)
            target_label = "Per-chunk exits"

        holdings.append({
            "symbol": sym,
            "company_name": agg["company_name"],
            "total_quantity": total_qty,
            "avg_cost_price": avg_cost,
            "current_market_price": live,
            "total_invested": round(total_cost, 2),
            "current_value": current_val,
            "mtm_inr": mtm,
            "mtm_pct": mtm_pct,
            "target_value": target_value,
            "target_pnl": target_pnl,
            "target_label": target_label,
            "mtm_target_pct": mtm_target_pct,
            "mtm_target_inr": mtm_target_inr,
            "chunk_details": chunk_details_for_holding,
        })

    return JSONResponse(content=clean_for_json({
        "virtual_cash": cash,
        "total_invested": round(total_invested, 2),
        "unrealised_pnl": round(unrealised_pnl, 2),
        "realised_pnl": round(realised_pnl, 2),
        "total_pnl": round(unrealised_pnl + realised_pnl, 2),
        "portfolio_value": round(cash + total_invested + unrealised_pnl, 2),
        "active_trade_count": sum(1 for t in trades if t["status"] == "ACTIVE"),
        "holdings": holdings,       # aggregated per symbol
        "positions": positions,     # per trade detail
    }))


@router.get("/paper/trades")
async def list_trades():
    return JSONResponse(content=clean_for_json({"trades": pt.get_all_trades()}))


@router.get("/paper/trades/{trade_id}")
async def get_trade(trade_id: str):
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content=clean_for_json(trade))


@router.post("/paper/trades")
async def create_trade(body: CreateTradeInput):
    sym = normalize_symbol(body.symbol)
    info = get_info(sym)
    company_name = safe_get(info, "longName") or safe_get(info, "shortName") or sym

    # Validate chunks
    total_pct = sum(c.allocation_pct for c in body.chunks)
    if abs(total_pct - 100) > 0.5:
        raise HTTPException(
            status_code=400,
            detail=f"Chunk allocation_pct must sum to 100. Got {total_pct:.1f}%"
        )
    if len(body.chunks) < 1 or len(body.chunks) > 10:
        raise HTTPException(status_code=400, detail="Must have 1–10 chunks")

    chunks_input = [c.model_dump() for c in body.chunks]
    trade = pt.create_trade(
        symbol=sym,
        company_name=company_name,
        total_allocation=body.total_allocation,
        chunks=chunks_input,
        notes=body.notes,
        mtm_target_pct=body.mtm_target_pct,
        mtm_target_inr=body.mtm_target_inr,
    )
    return JSONResponse(content=clean_for_json(trade))


@router.post("/paper/trades/{trade_id}/start")
async def start_trade(trade_id: str):
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content=clean_for_json(pt.start_trade(trade_id)))


@router.post("/paper/trades/{trade_id}/pause")
async def pause_trade(trade_id: str):
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content=clean_for_json(pt.pause_trade(trade_id)))


@router.post("/paper/trades/{trade_id}/cancel")
async def cancel_trade(trade_id: str):
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content=clean_for_json(pt.cancel_trade(trade_id)))


@router.delete("/paper/trades/{trade_id}")
async def delete_trade(trade_id: str):
    """Delete a CANCELLED trade permanently."""
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    if trade["status"] != "CANCELLED":
        raise HTTPException(status_code=400, detail="Only CANCELLED trades can be deleted. Cancel the trade first.")
    pt.delete_trade(trade_id)
    return JSONResponse(content={"message": f"Trade {trade_id} deleted"})


@router.put("/paper/trades/{trade_id}/chunks")
async def update_chunks(trade_id: str, body: UpdateChunksInput):
    """Update WAITING chunks. BOUGHT/SOLD chunks are ignored."""
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    try:
        updated = pt.update_chunks(trade_id, [c.model_dump() for c in body.chunks])
        return JSONResponse(content=clean_for_json(updated))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/trades/{trade_id}/mtm-target")
async def set_mtm_target(trade_id: str, body: MtmTargetInput):
    """
    Set MTM-level exit target. Overrides individual chunk exits for BOUGHT chunks.
    Pass both null to clear (revert to per-chunk profit_pct exits).
    """
    trade = pt.get_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    try:
        updated = pt.set_mtm_target(trade_id, body.mtm_pct, body.mtm_inr)
        return JSONResponse(content=clean_for_json(updated))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── New action endpoints ─────────────────────────────────────────────────────

class ExitPriceInput(BaseModel):
    exit_price: float


@router.put("/paper/trades/{trade_id}/chunks/{chunk_no}/exit-price")
async def update_exit_price(trade_id: str, chunk_no: int, body: ExitPriceInput):
    """Edit exit (target) price of a BOUGHT or WAITING chunk."""
    try:
        updated = pt.update_chunk_exit_price(trade_id, chunk_no, body.exit_price)
        return JSONResponse(content=clean_for_json(updated))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/trades/{trade_id}/chunks/{chunk_no}/manual-buy")
async def manual_buy_chunk(trade_id: str, chunk_no: int):
    """Immediately buy a WAITING chunk at current CMP."""
    try:
        result = pt.manual_buy_chunk(trade_id, chunk_no)
        return JSONResponse(content=clean_for_json(result))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/trades/{trade_id}/chunks/{chunk_no}/manual-exit")
async def manual_exit_chunk(trade_id: str, chunk_no: int):
    """Exit a single BOUGHT chunk at current CMP."""
    try:
        result = pt.manual_exit_chunk(trade_id, chunk_no)
        return JSONResponse(content=clean_for_json(result))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/trades/{trade_id}/manual-exit-all")
async def manual_exit_all(trade_id: str):
    """Exit ALL BOUGHT chunks in a trade at current CMP."""
    try:
        result = pt.manual_exit_all(trade_id)
        return JSONResponse(content=clean_for_json(result))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/paper/orders")
async def get_orders():
    return JSONResponse(content=clean_for_json({"orders": pt.get_orders()}))


@router.get("/paper/cash")
async def get_cash():
    return JSONResponse(content={"virtual_cash": pt.get_virtual_cash()})


@router.post("/paper/cash")
async def set_cash(body: SetCashInput):
    pt.set_virtual_cash(body.amount)
    return JSONResponse(content={"virtual_cash": body.amount, "message": "Virtual cash updated"})


class AddFundsInput(BaseModel):
    amount: float


@router.post("/paper/cash/add")
async def add_funds(body: AddFundsInput):
    """Add funds to virtual cash (paper trading top-up)."""
    current = pt.get_virtual_cash()
    new_total = max(0.0, current + body.amount)
    pt.set_virtual_cash(new_total)
    return JSONResponse(content={"virtual_cash": new_total, "added": body.amount, "message": f"Funds updated"})
