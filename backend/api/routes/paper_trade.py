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
                                       "company_name": trade["company_name"], "live": live,
                                       "trade_type": trade.get("trade_type", "EQUITY")}
                symbol_agg[sym]["total_qty"] += qty
                symbol_agg[sym]["total_cost"] += cost
                symbol_agg[sym]["live"] = live
                # Upgrade trade_type if any holding is CC/Wheel
                if trade.get("trade_type") in ("COVERED_CALL", "WHEEL"):
                    symbol_agg[sym]["trade_type"] = trade["trade_type"]

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

        # WHEEL trades in PUT phase have no stock chunks — skip from positions list
        # They should only appear in cc_positions (Options tab)
        trade_type  = trade.get("trade_type", "EQUITY")
        wheel_phase = trade.get("wheel_phase")
        if trade_type == "WHEEL" and wheel_phase == "PUT":
            continue   # show in Options tab only, not in Active Trades

        positions.append({
            "trade_id": trade["trade_id"],
            "symbol": sym,
            "company_name": trade["company_name"],
            "status": trade["status"],
            "trade_type": trade_type,
            "wheel_phase": wheel_phase,
            "has_any_fill": has_any_fill,
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
                    is_cc_chunk = trade.get("trade_type") in ("COVERED_CALL", "WHEEL")
                    chunk_details_for_holding.append({
                        "trade_id": trade["trade_id"],
                        "chunk_no": c["chunk_no"],
                        "buy_price": round(bp, 2),
                        "exit_price": None if is_cc_chunk else round(ep, 2),
                        "quantity": qty,
                        "profit_pct": None if is_cc_chunk else c["profit_pct"],
                        "cost": round(qty * bp, 2),
                        "target_value": None if is_cc_chunk else round(qty * ep, 2),
                        "current_value": round(qty * live, 2) if live else 0,
                        "unrealised_pnl": round((live - bp) * qty, 2) if live else 0,
                        "buy_time": c.get("buy_time"),
                    })

        # Target value: MTM-based if set, otherwise sum of individual chunk exit values
        # For CC/Wheel trades the exit_price is a 999× sentinel — use premium income instead
        holding_trade_type = agg.get("trade_type", "EQUITY")
        if mtm_target_inr is not None:
            target_value = round(total_cost + mtm_target_inr, 2)
            target_pnl = mtm_target_inr
            target_label = f"MTM ₹{mtm_target_inr:+,.0f}"
        elif mtm_target_pct is not None:
            target_pnl = round(total_cost * mtm_target_pct / 100, 2)
            target_value = round(total_cost + target_pnl, 2)
            target_label = f"MTM {mtm_target_pct:+.1f}%"
        elif holding_trade_type in ("COVERED_CALL", "WHEEL"):
            # Stock target = cost basis (manual exit strategy); P&L comes from option premium
            cc_premium_income = 0.0
            for trade in trades:
                if trade["symbol"] != sym:
                    continue
                tt = trade.get("trade_type")
                if tt == "COVERED_CALL":
                    opt = trade.get("cc_option") or {}
                    cc_premium_income += float(opt.get("premium_income") or 0)
                elif tt == "WHEEL":
                    cc_premium_income += float((trade.get("put_option") or {}).get("premium_income") or 0)
                    cc_premium_income += float((trade.get("cc_option") or {}).get("premium_income") or 0)
            target_value = round(total_cost + cc_premium_income, 2)
            target_pnl = round(cc_premium_income, 2)
            target_label = f"Premium income ₹{cc_premium_income:,.0f}"
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
            "trade_type": agg.get("trade_type", "EQUITY"),
        })

    # ── CC Positions (options metadata from covered call + wheel trades) ────────
    # ── Fetch live option premiums for OPEN options ──────────────────────────
    open_opts: list[dict] = []
    for t in trades:
        tt = t.get("trade_type", "EQUITY")
        if tt == "COVERED_CALL":
            opt = t.get("cc_option", {})
            if opt and opt.get("status") == "OPEN":
                open_opts.append({**opt, "_opt_type": "CE"})
        elif tt == "WHEEL":
            wheel_phase_tmp = t.get("wheel_phase", "PUT")
            if wheel_phase_tmp == "PUT":
                opt = t.get("put_option", {})
                if opt and opt.get("status") == "OPEN":
                    open_opts.append({**opt, "_opt_type": "PE"})
            else:
                opt = t.get("cc_option", {})
                if opt and opt.get("status") == "OPEN":
                    open_opts.append({**opt, "_opt_type": "CE"})
    # Build live premium map: option_symbol -> current_ltp
    live_option_prices: dict[str, float | None] = {}
    if open_opts:
        try:
            from jugaad_data.nse import NSELive
            nse = NSELive()
            import time as _time
            # Group by underlying+expiry to avoid duplicate calls
            seen_chains: set[tuple] = set()
            for opt in open_opts:
                underlying = opt.get("underlying", "").replace(".NS", "")
                expiry     = opt.get("expiry", "")
                strike     = opt.get("strike", 0)
                sym_key    = opt.get("option_symbol", "")
                key = (underlying, expiry)
                if key in seen_chains:
                    continue
                seen_chains.add(key)
                try:
                    data = nse.equities_option_chain(underlying, expiry=expiry)
                    rows = data.get("filtered", {}).get("data", []) or data.get("records", {}).get("data", [])
                    for r in rows:
                        s = r.get("strikePrice", 0)
                        # Match CE options
                        ce_ltp = (r.get("CE") or {}).get("lastPrice", 0)
                        # Match PE options
                        pe_ltp = (r.get("PE") or {}).get("lastPrice", 0)
                        for o2 in open_opts:
                            if o2.get("underlying","").replace(".NS","") == underlying and abs(float(s or 0) - float(o2.get("strike",0) or 0)) < 0.1:
                                ltp = pe_ltp if o2.get("_opt_type") == "PE" else ce_ltp
                                live_option_prices[o2.get("option_symbol", "")] = float(ltp) if ltp else None
                    _time.sleep(0.08)
                except Exception:
                    pass
        except Exception:
            pass

    # ── Build CC positions with live MTM (includes WHEEL trades) ──────────────
    cc_positions = []
    for trade in trades:
        trade_type = trade.get("trade_type", "EQUITY")

        # Determine which option field to use
        if trade_type == "COVERED_CALL":
            opt = trade.get("cc_option", {})
            position_type = "CE"   # short call
        elif trade_type == "WHEEL":
            wheel_phase = trade.get("wheel_phase", "PUT")
            if wheel_phase == "PUT":
                opt = trade.get("put_option", {})
                position_type = "PE"   # short put
            else:
                # WHEEL in CC phase — use cc_option
                opt = trade.get("cc_option", {})
                position_type = "CE"
        else:
            continue

        if not opt:
            continue
        chunks = trade.get("chunks", [])

        # MTM calculation for OPEN positions
        current_ltp  = live_option_prices.get(opt.get("option_symbol", "")) if opt.get("status") == "OPEN" else None
        lots         = opt.get("lots", 1)
        lot_size     = opt.get("lot_size", 1)
        sell_premium = opt.get("sell_premium", 0)
        prem_income  = opt.get("premium_income", 0)

        option_mtm_inr   = None
        option_mtm_pct   = None
        buy_back_cost    = None
        if current_ltp is not None and sell_premium:
            buy_back_cost  = round(current_ltp * lots * lot_size, 2)
            option_mtm_inr = round(prem_income - buy_back_cost, 2)
            option_mtm_pct = round((sell_premium - current_ltp) / sell_premium * 100, 1)

        cc_positions.append({
            "trade_id":           trade["trade_id"],
            "symbol":             trade["symbol"],
            "company_name":       trade["company_name"],
            "trade_status":       trade["status"],
            "option_symbol":      opt.get("option_symbol", ""),
            "strike":             opt.get("strike"),
            "expiry":             opt.get("expiry", ""),
            "sell_premium":       sell_premium,
            "premium_income":     prem_income,
            "lots":               lots,
            "lot_size":           lot_size,
            "option_status":      opt.get("status", "OPEN"),
            "option_pnl":         opt.get("option_pnl"),
            "close_premium":      opt.get("close_premium"),
            "opened_at":          opt.get("opened_at"),
            "closed_at":          opt.get("closed_at"),
            # Trade metadata
            "trade_type":         trade_type,
            "position_type":      position_type,   # "CE" or "PE"
            "wheel_phase":        trade.get("wheel_phase"),
            # Live MTM fields
            "current_ltp":        current_ltp,
            "buy_back_cost":      buy_back_cost,
            "option_mtm_inr":     option_mtm_inr,
            "option_mtm_pct":     option_mtm_pct,
            # Stock chunk statuses (only relevant when in CC phase)
            "phase1_status":      next((c["status"] for c in chunks if c["chunk_no"] == 1), "N/A" if not chunks else "WAITING"),
            "phase2_status":      next((c["status"] for c in chunks if c["chunk_no"] == 2), "N/A" if not chunks else "WAITING"),
            "phase1_buy_price":   next((c.get("buy_price") for c in chunks if c["chunk_no"] == 1), None),
            "phase2_buy_price":   next((c.get("buy_price") for c in chunks if c["chunk_no"] == 2), None),
        })

    option_mtm_total = sum(
        p["option_mtm_inr"] for p in cc_positions
        if p.get("option_mtm_inr") is not None
    )

    return JSONResponse(content=clean_for_json({
        "virtual_cash": cash,
        "total_invested": round(total_invested, 2),
        "unrealised_pnl": round(unrealised_pnl, 2),
        "option_mtm_total": round(option_mtm_total, 2),
        "realised_pnl": round(realised_pnl, 2),
        "total_pnl": round(unrealised_pnl + option_mtm_total + realised_pnl, 2),
        "portfolio_value": round(cash + total_invested + unrealised_pnl + option_mtm_total, 2),
        "active_trade_count": sum(1 for t in trades if t["status"] == "ACTIVE"),
        "holdings": holdings,
        "positions": positions,
        "cc_positions": cc_positions,
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
    try:
        trade = pt.create_trade(
            symbol=sym,
            company_name=company_name,
            total_allocation=body.total_allocation,
            chunks=chunks_input,
            notes=body.notes,
            mtm_target_pct=body.mtm_target_pct,
            mtm_target_inr=body.mtm_target_inr,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
    try:
        return JSONResponse(content=clean_for_json(pt.cancel_trade(trade_id)))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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


# ─── Covered Call endpoints ────────────────────────────────────────────────────

class CreateCcTradeInput(BaseModel):
    symbol:             str
    company_name:       str = ""
    lots:               int = 1
    lot_size:           int = 1000
    phase1_qty:         int
    phase1_limit:       float
    phase2_qty:         int
    phase2_limit:       float
    phase2_trigger:     float
    strike:             float
    expiry:             str
    sell_premium:       float
    premium_income:     float
    avg_pct:            float = 3.0
    notes:              str = ""


@router.post("/paper/covered-call")
async def create_cc_trade(body: CreateCcTradeInput):
    """Create a Covered Call paper trade (stock + short CE metadata)."""
    from data.market_data import get_info, safe_get, normalize_symbol
    sym = normalize_symbol(body.symbol)
    company_name = body.company_name
    if not company_name:
        info = get_info(sym)
        company_name = safe_get(info, "longName", default=None) or safe_get(info, "shortName", default=body.symbol) or body.symbol

    try:
        trade = pt.create_covered_call_trade(
            symbol=sym,
            company_name=company_name,
            phase1_qty=body.phase1_qty,
            phase1_limit=body.phase1_limit,
            phase2_qty=body.phase2_qty,
            phase2_limit=body.phase2_limit,
            phase2_trigger=body.phase2_trigger,
            strike=body.strike,
            expiry=body.expiry,
            sell_premium=body.sell_premium,
            premium_income=body.premium_income,
            lots=body.lots,
            lot_size=body.lot_size,
            avg_pct=body.avg_pct,
            notes=body.notes,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content=clean_for_json({
        "message": f"Covered Call trade created for {sym}",
        "trade_id": trade["trade_id"],
        "trade": trade,
    }))


class CloseCcOptionInput(BaseModel):
    close_premium: float


@router.post("/paper/cc-option/{trade_id}/close")
async def close_cc_option(trade_id: str, body: CloseCcOptionInput):
    """Buy back the short option (CE or PE) to close the position."""
    try:
        trade = pt.close_cc_option(trade_id, body.close_premium)
        tt = trade.get("trade_type")
        wp = trade.get("wheel_phase")
        opt = trade.get("put_option") if (tt == "WHEEL" and wp == "PUT") else trade.get("cc_option", {})
        return JSONResponse(content=clean_for_json({
            "message": "Option position closed",
            "trade_id": trade_id,
            "option_pnl": (opt or {}).get("option_pnl"),
        }))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/cc-option/{trade_id}/expire")
async def expire_cc_option(trade_id: str):
    """Mark the option as expired worthless — full premium is P&L."""
    try:
        trade = pt.expire_cc_option(trade_id)
        # Determine which option field was updated (CC vs Wheel PUT)
        tt = trade.get("trade_type")
        wp = trade.get("wheel_phase")
        opt = trade.get("put_option") if (tt == "WHEEL" and wp == "PUT") else trade.get("cc_option", {})
        return JSONResponse(content=clean_for_json({
            "message": "Option expired worthless — full premium kept",
            "trade_id": trade_id,
            "option_pnl": (opt or {}).get("option_pnl"),
        }))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))



# ─── Wheel Strategy endpoints ──────────────────────────────────────────────────

class CreateWheelTradeInput(BaseModel):
    symbol:                 str
    company_name:           str = ""
    lots:                   int = 1
    lot_size:               int = 1000
    put_strike:             float
    put_expiry:             str
    put_premium:            float
    put_premium_income:     float
    planned_call_strike:    float
    planned_call_expiry:    str
    planned_call_premium:   float
    assignment_limit:       float   # effective buy price = put_strike - put_premium
    phase2_pct:             float = 3.0
    notes:                  str = ""


@router.post("/paper/wheel")
async def create_wheel_trade(body: CreateWheelTradeInput):
    """Create a Wheel Strategy paper trade (CSP phase 1)."""
    from data.market_data import get_info, safe_get, normalize_symbol
    sym = normalize_symbol(body.symbol)
    company_name = body.company_name
    if not company_name:
        info = get_info(sym)
        company_name = safe_get(info, "longName", default=None) or safe_get(info, "shortName", default=body.symbol) or body.symbol

    try:
        trade = pt.create_wheel_trade(
            symbol=sym, company_name=company_name,
            put_strike=body.put_strike, put_expiry=body.put_expiry,
            put_premium=body.put_premium, put_premium_income=body.put_premium_income,
            lots=body.lots, lot_size=body.lot_size,
            planned_call_strike=body.planned_call_strike,
            planned_call_expiry=body.planned_call_expiry,
            planned_call_premium=body.planned_call_premium,
            assignment_limit=body.assignment_limit,
            phase2_pct=body.phase2_pct, notes=body.notes,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content=clean_for_json({
        "message": f"Wheel trade created for {sym}",
        "trade_id": trade["trade_id"], "trade": trade,
    }))


class AssignPutInput(BaseModel):
    call_strike:   float
    call_expiry:   str
    call_premium:  float


@router.post("/paper/wheel/{trade_id}/assign-put")
async def wheel_assign_put(trade_id: str, body: AssignPutInput):
    """Trigger PUT assignment → switch to Covered Call phase."""
    try:
        trade = pt.wheel_assign_put(trade_id, body.call_strike, body.call_expiry, body.call_premium)
        return JSONResponse(content=clean_for_json({"message": "Put assigned — CC phase started", "trade": trade}))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/wheel/{trade_id}/expire-put")
async def wheel_expire_put(trade_id: str):
    """Put expires worthless → keep premium, reset for next spin."""
    try:
        trade = pt.wheel_expire_put(trade_id)
        return JSONResponse(content=clean_for_json({
            "message": "Put expired — full premium kept. Sell another put to spin the wheel.",
            "total_realised_pnl": trade["total_realised_pnl"],
        }))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/wheel/{trade_id}/cancel-put")
async def cancel_wheel_put(trade_id: str):
    """Cancel a WHEEL trade while still in PUT phase (no assignment yet). Refunds margin."""
    try:
        trade = pt.cancel_wheel_put(trade_id)
        return JSONResponse(content=clean_for_json({
            "message": "Wheel PUT cancelled — margin refunded.",
            "trade_id": trade_id,
        }))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/paper/wheel/{trade_id}")
async def delete_wheel_trade(trade_id: str):
    """Permanently delete a CANCELLED wheel trade (PUT phase only)."""
    try:
        pt.delete_trade(trade_id)
        return JSONResponse(content={"message": f"Wheel trade {trade_id} deleted"})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── Wheel Plan endpoint (proper live put strikes from NSE) ────────────────────

@router.get("/paper/wheel/plan/{symbol}")
async def get_wheel_plan(
    symbol:          str,
    lots:            int   = 1,
    avg_pct:         float = 3.0,
    expiry:          str   = "",
    strike_override: float = 0,
):
    """
    Generate a Wheel Strategy plan using REAL NSE put strikes.
    Fetches live put chain, picks best delta-targeted put strike,
    and suggests adjacent real strikes — no invented strikes.
    """
    import asyncio, math
    from concurrent.futures import ThreadPoolExecutor
    from data.market_data import get_info, safe_get, normalize_symbol
    from api.routes.covered_calls import _pick_best_expiry

    sym  = normalize_symbol(symbol)
    bare = sym.replace(".NS", "")

    def ncdf(x): return (1 + math.erf(x / math.sqrt(2))) / 2
    def npdf(x): return math.exp(-x * x / 2) / math.sqrt(2 * math.pi)

    def put_greeks(spot, strike, iv_pct, days, rf=0.065):
        T = days / 365; s = iv_pct / 100
        if T <= 0 or s <= 0 or spot <= 0 or strike <= 0: return {}
        d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
        d2 = d1 - s * math.sqrt(T)
        return {
            "delta": round(ncdf(d1) - 1, 3),      # PUT delta is negative
            "theta": round((-(spot*npdf(d1)*s)/(2*math.sqrt(T)) + rf*strike*math.exp(-rf*T)*ncdf(-d2))/365, 2),
            "vega":  round(spot * npdf(d1) * math.sqrt(T) / 100, 2),
        }

    def _do_plan():
        from jugaad_data.nse import NSELive
        import time as _t

        nse  = NSELive()
        spot_raw = nse.equities_option_chain(bare).get("records", {}).get("underlyingValue", 0)
        spot = float(spot_raw) if spot_raw else 0
        if spot <= 0:
            info = get_info(sym)
            spot = float(safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or 0)
        if spot <= 0:
            raise ValueError(f"Could not get live price for {bare}")

        company_name = safe_get(get_info(sym), "longName") or bare
        lot_size = pt.get_all_trades  # won't call this — get from cc_strategy
        from api.routes.cc_strategy import _get_lot_size, _bs_greeks
        lot_size = _get_lot_size(sym)

        # Find best expiry (24-50 days)
        expiry_dates = nse.equities_option_chain(bare).get("records", {}).get("expiryDates", [])
        selected_expiry = expiry if expiry and expiry in expiry_dates else _pick_best_expiry(expiry_dates)
        if not selected_expiry:
            selected_expiry = expiry_dates[0] if expiry_dates else ""

        days_to_expiry = 0
        if selected_expiry:
            from datetime import datetime, date as date_cls
            for fmt_s in ["%d-%b-%Y", "%d-%m-%Y"]:
                try:
                    exp_dt = datetime.strptime(selected_expiry, fmt_s).date()
                    days_to_expiry = (exp_dt - date_cls.today()).days
                    break
                except Exception: pass

        # Fetch put chain for selected expiry
        _t.sleep(0.1)
        chain_data = nse.equities_option_chain(bare, expiry=selected_expiry)
        rows = chain_data.get("filtered", {}).get("data", []) or chain_data.get("records", {}).get("data", [])

        # Collect ALL OTM puts (strike < spot) with real LTP and OI
        otm_puts = []
        for r in rows:
            pe     = r.get("PE", {})
            strike = float(r.get("strikePrice") or pe.get("strikePrice") or 0)
            ltp    = float(pe.get("lastPrice") or 0)
            oi     = int(pe.get("openInterest") or 0)
            iv     = float(pe.get("impliedVolatility") or 0)
            if strike <= 0 or ltp <= 0 or oi < 1:   # must have actual traded premium
                continue
            # Only OTM puts for wheel (we want to sell at a price BELOW current spot)
            # Note: strike can be above or below spot — we want ITM puts (puts where strike < spot = OTM in terms of assignment risk)
            g = put_greeks(spot, strike, iv, days_to_expiry or 44)
            pct_otm = round((strike / spot - 1) * 100, 1)  # negative = below spot
            otm_puts.append({
                "strike":  strike, "ltp": ltp, "oi": oi, "iv": iv,
                "pct_otm": pct_otm, **g,
            })
        otm_puts.sort(key=lambda x: x["strike"])

        if not otm_puts:
            # All strikes either have no volume or the chain is empty
            # Try previous expiry
            prev_expiry = expiry_dates[0] if expiry_dates and selected_expiry != expiry_dates[0] else None
            if prev_expiry:
                _t.sleep(0.1)
                chain_data2 = nse.equities_option_chain(bare, expiry=prev_expiry)
                rows2 = chain_data2.get("filtered", {}).get("data", []) or chain_data2.get("records", {}).get("data", [])
                for r in rows2:
                    pe = r.get("PE", {})
                    strike = float(r.get("strikePrice") or pe.get("strikePrice") or 0)
                    ltp = float(pe.get("lastPrice") or 0)
                    oi  = int(pe.get("openInterest") or 0)
                    iv  = float(pe.get("impliedVolatility") or 0)
                    if strike <= 0 or ltp <= 0 or oi < 1: continue
                    g = put_greeks(spot, strike, iv, days_to_expiry or 44)
                    otm_puts.append({"strike": strike, "ltp": ltp, "oi": oi, "iv": iv,
                                     "pct_otm": round((strike/spot-1)*100,1), **g})
                otm_puts.sort(key=lambda x: x["strike"])
                if otm_puts:
                    selected_expiry = prev_expiry

        if not otm_puts:
            raise ValueError(f"No liquid put options found for {bare} on any available expiry")

        # Find best put: ideal = 8-12% OTM (delta ~0.20-0.30) for safer wheel
        # Primary criterion: OTM% between 8-12%, secondary: delta closest to -0.25
        target_delta  = -0.25   # 25% assignment probability — safer for wheel
        target_otm_pct = -10.0  # 10% below spot

        # First try to find strike 8-12% OTM with decent OI
        best_put = None; best_diff = 999.0
        for p in otm_puts:
            otm_pct = p["pct_otm"]   # negative = below spot
            d = p.get("delta", 0)
            # Prefer 8-12% OTM range; score by closeness to -10% AND delta -0.25
            otm_score  = abs(otm_pct - target_otm_pct)
            delta_score = abs(d - target_delta)
            combined = otm_score * 0.6 + delta_score * 20  # weight OTM% more
            if combined < best_diff and p["oi"] >= 1:
                best_diff = combined; best_put = p

        # If nothing in 8-12% range, fall back to closest to delta -0.25
        if not best_put:
            best_diff = 999.0
            for p in otm_puts:
                diff = abs(p.get("delta", 0) - target_delta)
                if diff < best_diff and p["oi"] >= 1:
                    best_diff = diff; best_put = p

        if strike_override > 0:
            # User selected a specific strike — use it if it exists in the real chain
            override_put = next((p for p in otm_puts if abs(p["strike"] - strike_override) < 0.1), None)
            if override_put:
                best_put = override_put

        if not best_put:
            raise ValueError("No suitable put strike found with adequate liquidity")

        # Adjacent strikes (real ones from chain, sorted by strike)
        chosen_idx = next((i for i, p in enumerate(otm_puts) if abs(p["strike"] - best_put["strike"]) < 0.1), 0)
        adj_range  = sorted(set(range(max(0, chosen_idx-2), min(len(otm_puts), chosen_idx+3))))
        adjacent   = [
            {**otm_puts[i], "is_recommended": i == chosen_idx}
            for i in adj_range
        ]

        # Effective buy price = put_strike - put_premium/share
        put_strike  = best_put["strike"]
        put_premium = best_put["ltp"]
        effective_buy = round(put_strike - put_premium, 2)
        premium_income = round(put_premium * lots * lot_size, 2)
        margin_est = round(put_strike * lot_size * lots * 0.12, 2)

        # Also compute a planned CC after assignment using existing CC logic
        from api.routes.cc_strategy import _find_delta_target_strike, _bs_greeks as _call_greeks, _price_range
        _t.sleep(0.1)
        cc_chain = nse.equities_option_chain(bare, expiry=expiry_dates[1] if len(expiry_dates) > 1 else selected_expiry)
        cc_rows_raw = cc_chain.get("filtered", {}).get("data", []) or cc_chain.get("records", {}).get("data", [])
        cc_strikes = [{"strike": float(r.get("strikePrice") or r.get("CE",{}).get("strikePrice",0)),
                       "ce": {"ltp": float(r.get("CE",{}).get("lastPrice",0)),
                              "iv": float(r.get("CE",{}).get("impliedVolatility",0)),
                              "oi": int(r.get("CE",{}).get("openInterest",0))}}
                      for r in cc_rows_raw]
        cc_expiry = expiry_dates[1] if len(expiry_dates) > 1 else selected_expiry
        best_cc = _find_delta_target_strike(cc_strikes, spot, days_to_expiry + 30, target_delta=0.225, min_oi=1)

        planned_call_strike  = best_cc["strike"] if best_cc else round(spot * 1.06 / 5) * 5
        planned_call_premium = best_cc["ltp"]    if best_cc else round(spot * 0.02, 1)

        # IV for price range
        atm_iv = next((p["iv"] for p in otm_puts if abs(p["strike"] - spot) == min(abs(p2["strike"]-spot) for p2 in otm_puts)), best_put["iv"])
        pr = _price_range(spot, atm_iv, days_to_expiry or 44)

        # Scenario probabilities using Black-Scholes
        p_put_expires  = round((1 - abs(best_put.get("delta", 0.30))) * 100, 1)
        p_assigned_full = round(abs(best_put.get("delta", 0.30)) * 100, 1)

        return clean_for_json({
            "symbol": bare, "name": company_name,
            "cmp": round(spot, 2), "lot_size": lot_size, "lots": lots,
            "high_52w": float(safe_get(get_info(sym), "fiftyTwoWeekHigh") or spot),
            "low_52w":  float(safe_get(get_info(sym), "fiftyTwoWeekLow")  or spot),
            "atm_iv": round(atm_iv, 1),
            # PUT leg
            "put_strike":          put_strike,
            "put_expiry":          selected_expiry,
            "put_days_to_expiry":  days_to_expiry,
            "put_premium_live":    round(put_premium, 2),
            "put_premium_income":  int(premium_income),
            "put_delta":           best_put.get("delta"),
            "put_theta":           best_put.get("theta"),
            "put_vega":            best_put.get("vega"),
            "put_oi":              best_put["oi"],
            "effective_buy":       effective_buy,
            "margin_required":     int(margin_est),
            # Planned CC
            "planned_call_strike":  planned_call_strike,
            "planned_call_expiry":  cc_expiry,
            "planned_call_premium": round(planned_call_premium, 2),
            # Adjacent PUT strikes (REAL from NSE)
            "adjacent_strikes": adjacent,
            "all_available_puts": [{"strike":p["strike"],"ltp":p["ltp"],"oi":p["oi"],"delta":p.get("delta"),"pct_otm":p["pct_otm"]} for p in otm_puts],
            # Scenarios
            "scenarios": {
                "put_expires_worthless": {
                    "probability": p_put_expires,
                    "income": int(premium_income),
                    "action": f"Keep ₹{int(premium_income):,} premium. Sell another put for next expiry.",
                },
                "assigned_stock_rises": {
                    "probability": round(p_assigned_full * 0.6, 1),
                    "income": int(premium_income),
                    "effective_buy": effective_buy,
                    "action": f"Own {bare} at ₹{effective_buy}. Sell CC at ₹{planned_call_strike}. Stock rises → called away at profit.",
                },
                "assigned_stock_flat": {
                    "probability": round(p_assigned_full * 0.25, 1),
                    "income": int(premium_income),
                    "effective_buy": effective_buy,
                    "action": f"Own {bare} at ₹{effective_buy}. Keep selling CCs each month to reduce cost basis.",
                },
                "assigned_stock_falls": {
                    "probability": round(p_assigned_full * 0.15, 1),
                    "probable_loss": int(round((effective_buy - spot * 0.88) * lot_size * lots, 0)),
                    "action": "Own stock at discount. Keep selling CCs. Premium income offsets paper loss over time.",
                },
            },
            "price_range": {**pr, "days_to_expiry": days_to_expiry},
            "expiry_note": f"Recommended expiry: {selected_expiry} ({days_to_expiry} days). Only real NSE strikes shown.",
        })

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        result = await loop.run_in_executor(executor, _do_plan)
        return JSONResponse(content=result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/paper/admin/reload")
async def admin_reload():
    """Force reload in-memory state from disk (admin use only)."""
    pt._load()
    return JSONResponse(content={"message": "State reloaded from disk", "trades": len(pt._state.get("trades", {}))})
