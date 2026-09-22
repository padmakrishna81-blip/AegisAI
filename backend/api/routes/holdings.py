import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from time import time
from typing import Optional

import yfinance as yf
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from data import holdings_store as store

router = APIRouter()

# ── USD/INR + EUR/INR cache ────────────────────────────────────────────────────
_fx_cache: dict = {
    "USD": {"rate": 83.5, "ts": 0.0},
    "EUR": {"rate": 92.0, "ts": 0.0},
}
_FX_TTL = 15 * 60  # 15 min
_FX_TICKER = {"USD": "USDINR=X", "EUR": "EURINR=X"}
_FX_DEFAULT = {"USD": 83.5, "EUR": 92.0}


def _get_fx(currency: str) -> float:
    entry = _fx_cache.get(currency)
    if entry is None:
        return 1.0
    now = time()
    if now - entry["ts"] < _FX_TTL:
        return entry["rate"]
    try:
        fi = yf.Ticker(_FX_TICKER[currency]).fast_info
        rate = float(getattr(fi, "last_price", 0) or _FX_DEFAULT[currency])
        if rate > 0:
            entry["rate"] = rate
            entry["ts"] = now
    except Exception:
        pass
    return entry["rate"]


def _get_usdinr() -> float:
    return _get_fx("USD")


# ── CMP enrichment ─────────────────────────────────────────────────────────────

def _enrich(holding: dict, rates: dict) -> dict:
    sym = holding.get("symbol", "")
    cmp = prev = 0.0
    try:
        fi = yf.Ticker(sym).fast_info
        cmp = float(getattr(fi, "last_price", 0) or 0)
        prev = float(getattr(fi, "previous_close", 0) or 0)
    except Exception:
        pass

    qty = float(holding.get("qty", 0))
    avg = float(holding.get("avg_cost", 0))
    currency = holding.get("currency", "INR")

    current_value = round(cmp * qty, 2) if cmp else 0.0
    pnl = round((cmp - avg) * qty, 2) if cmp and avg else 0.0
    pnl_pct = round((cmp / avg - 1) * 100, 2) if cmp and avg else 0.0
    day_chg_pct = round((cmp / prev - 1) * 100, 2) if cmp and prev else 0.0

    fx = rates.get(currency, 1.0)
    value_inr = round(current_value * fx, 2) if currency != "INR" else current_value
    cost_inr = round(avg * qty * fx, 2) if currency != "INR" else round(avg * qty, 2)
    pnl_inr = round(value_inr - cost_inr, 2)

    return {
        **holding,
        "cmp": round(cmp, 2),
        "current_value": current_value,
        "value_inr": value_inr,
        "cost_inr": cost_inr,
        "pnl_inr": pnl_inr,
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "day_chg_pct": day_chg_pct,
    }


def _enrich_all(holdings: list[dict]) -> list[dict]:
    rates = {c: _get_fx(c) for c in ("USD", "EUR")}
    enriched = [None] * len(holdings)
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(_enrich, h, rates): i for i, h in enumerate(holdings)}
        for f in as_completed(futs):
            enriched[futs[f]] = f.result()
    return enriched


# ── Pydantic models ────────────────────────────────────────────────────────────

class HoldingBody(BaseModel):
    account_holder: str
    broker: str
    symbol: str
    display_symbol: str
    name: str
    exchange: str
    asset_type: str = "stock"
    qty: float
    avg_cost: float
    currency: str = "INR"
    buy_date: str = ""
    notes: str = ""
    is_esop: bool = False


class BulkImportBody(BaseModel):
    rows: list[dict]


class AccountHoldersBody(BaseModel):
    holders: list[str]


# ── Symbol helpers ─────────────────────────────────────────────────────────────

def _normalize_symbol(display_sym: str, exchange: str) -> str:
    s = display_sym.upper().strip()
    # Strip existing suffixes
    for sfx in (".NS", ".BO", ".DE", ".F", ".BSE"):
        if s.endswith(sfx):
            s = s[: -len(sfx)]
    if exchange in ("NSE",):
        return s + ".NS"
    if exchange in ("BSE",):
        return s + ".BO"
    if exchange in ("XETRA",):
        return s + ".DE"
    if exchange in ("Frankfurt",):
        return s + ".F"
    return s  # NYSE / NASDAQ / EQUATEPLUS — no suffix


# ── Summary helpers ────────────────────────────────────────────────────────────

def _summary(enriched: list[dict], rates: dict) -> dict:
    total_inr = sum(h.get("value_inr", 0) for h in enriched)
    cost_inr  = sum(h.get("cost_inr",  0) for h in enriched)
    # Exclude ESOP holdings from P&L calculation
    non_esop  = [h for h in enriched if not h.get("is_esop")]
    pnl_inr   = sum(h.get("pnl_inr", 0) for h in non_esop)
    pnl_cost  = sum(h.get("cost_inr", 0) for h in non_esop)
    total_day_change = round(
        sum(
            float(h.get("day_chg_pct", 0)) * float(h.get("value_inr", 0))
            for h in enriched
        ) / max(total_inr, 1),
        2,
    )
    return {
        "total_value_inr":   round(total_inr, 2),
        "total_pnl_inr":     round(pnl_inr, 2),
        "total_pnl_pct":     round(pnl_inr / pnl_cost * 100, 2) if pnl_cost else 0,
        "avg_day_chg_pct":   total_day_change,
        "count":             len(enriched),
        "esop_count":        len(enriched) - len(non_esop),
        "usdinr_rate":       round(rates.get("USD", 83.5), 2),
        "eurinr_rate":       round(rates.get("EUR", 92.0), 2),
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/holdings/account-holders")
async def get_account_holders():
    return JSONResponse({"account_holders": store.get_account_holders()})


@router.put("/holdings/account-holders")
async def update_account_holders(body: AccountHoldersBody):
    if not body.holders:
        raise HTTPException(status_code=400, detail="At least one account holder required")
    store.set_account_holders(body.holders)
    return JSONResponse({"ok": True, "account_holders": body.holders})


@router.get("/holdings/list")
async def list_holdings():
    data = store.load()
    holdings = data.get("holdings", [])
    enriched = _enrich_all(holdings)
    rates = {c: _get_fx(c) for c in ("USD", "EUR")}
    return JSONResponse({
        "account_holders": data.get("account_holders", ["Self", "Mother", "HUF"]),
        "holdings": enriched,
        "summary": _summary(enriched, rates),
    })


@router.post("/holdings/add")
async def add_holding(body: HoldingBody):
    entry = body.dict()
    entry["symbol"] = _normalize_symbol(body.display_symbol, body.exchange)
    data = store.add(entry)
    return JSONResponse({"ok": True, "count": len(data["holdings"])})


@router.put("/holdings/{holding_id}")
async def update_holding(holding_id: str, body: HoldingBody):
    patch = body.dict()
    patch["symbol"] = _normalize_symbol(body.display_symbol, body.exchange)
    data = store.update(holding_id, patch)
    if data is None:
        raise HTTPException(status_code=404, detail="Holding not found")
    return JSONResponse({"ok": True})


@router.delete("/holdings/{holding_id}")
async def delete_holding(holding_id: str):
    ok = store.remove(holding_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Holding not found")
    return JSONResponse({"ok": True})


@router.post("/holdings/bulk-import")
async def bulk_import(body: BulkImportBody):
    entries = []
    errors = []
    for i, row in enumerate(body.rows):
        try:
            exchange = str(row.get("Exchange", row.get("exchange", "NSE"))).strip().upper()
            display_sym = str(row.get("Symbol", row.get("symbol", ""))).strip().upper()
            if not display_sym:
                errors.append(f"Row {i+1}: missing Symbol")
                continue
            entries.append({
                "account_holder": str(row.get("Account Holder", row.get("account_holder", "Self"))).strip(),
                "broker":         str(row.get("Broker", row.get("broker", "Other"))).strip(),
                "symbol":         _normalize_symbol(display_sym, exchange),
                "display_symbol": display_sym,
                "name":           str(row.get("Name", row.get("name", display_sym))).strip(),
                "exchange":       exchange,
                "asset_type":     str(row.get("Asset Type", row.get("asset_type", "stock"))).strip().lower(),
                "qty":            float(str(row.get("Qty", row.get("qty", 0))).replace(",", "") or 0),
                "avg_cost":       float(str(row.get("Avg Cost", row.get("avg_cost", 0))).replace(",", "") or 0),
                "currency":       str(row.get("Currency", row.get("currency", "INR"))).strip().upper(),
                "buy_date":       str(row.get("Buy Date", row.get("buy_date", ""))).strip(),
                "notes":          str(row.get("Notes", row.get("notes", ""))).strip(),
            })
        except Exception as e:
            errors.append(f"Row {i+1}: {e}")

    if not entries:
        raise HTTPException(status_code=400, detail=f"No valid rows. Errors: {errors}")

    _, count = store.bulk_add(entries)
    return JSONResponse({"ok": True, "imported": count, "errors": errors})


@router.get("/holdings/template")
async def download_template():
    csv = (
        "Account Holder,Broker,Symbol,Exchange,Name,Qty,Avg Cost,Currency,Buy Date,Notes\n"
        "Self,ICICI,RELIANCE,NSE,Reliance Industries,10,2800,INR,2026-01-15,\n"
        "Mother,IBKR,ORCL,NYSE,Oracle Corporation,5,120,USD,2025-06-01,\n"
        "HUF,Sharekhan,HDFCBANK,NSE,HDFC Bank,20,1600,INR,,\n"
    )
    return StreamingResponse(
        io.BytesIO(csv.encode()),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=holdings_template.csv"},
    )


