"""Custom Fly Strategy API routes."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from api.routes.auth import get_current_user
from ai.fly_strategy import scan_consolidating, rank_safety, get_naked_fly, get_chain_expiries, _SCAN_CACHE, _SCAN_CACHE_TTL

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=4)


@router.get("/fly/scan")
async def fly_scan(
    days: int = Query(default=10, ge=3, le=30),
    user=Depends(get_current_user),
):
    """Scan Nifty 50 for consolidating stocks and rank by safety."""
    loop = asyncio.get_running_loop()

    def _run():
        stocks = scan_consolidating(days)
        stocks = rank_safety(stocks)
        return stocks

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


@router.get("/fly/expiries/{symbol}")
async def fly_expiries(
    symbol: str,
    user=Depends(get_current_user),
):
    """Return available option expiries for a symbol."""
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    loop = asyncio.get_running_loop()
    try:
        expiries = await loop.run_in_executor(_executor, lambda: get_chain_expiries(clean))
        if not expiries:
            return JSONResponse({"error": f"No option chain found for {clean}"}, status_code=400)
        return {"symbol": clean, "expiries": expiries}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/fly/setup/{symbol}")
async def fly_setup(
    symbol: str,
    expiry: str | None = Query(default=None),
    user=Depends(get_current_user),
):
    """Get naked fly (premium-matched short CE + short PE) setup for a symbol and expiry."""
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    username = user.get("username") if user else None
    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            _executor, lambda: get_naked_fly(clean, expiry=expiry, username=username)
        )
        if result.get("error"):
            return JSONResponse({"error": result["error"]}, status_code=400)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
