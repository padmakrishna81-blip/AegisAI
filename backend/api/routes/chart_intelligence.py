"""Chart Intelligence REST endpoints."""

from __future__ import annotations
import asyncio
import math
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.routes.auth import get_current_user

router = APIRouter()


async def _in_thread(fn):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn)


def _clean(obj: Any) -> Any:
    """Recursively convert numpy types and strip NaN/Inf."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    try:
        import numpy as np
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            v = float(obj)
            return None if (math.isnan(v) or math.isinf(v)) else v
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return [_clean(x) for x in obj.tolist()]
    except ImportError:
        pass
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj


# ── Pydantic models ───────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    symbol:         str
    market:         str = "NSE"        # US | NSE
    timeframe:      str = "daily"      # 15m | 1h | 4h | daily | weekly | monthly
    lookback:       str = "1y"         # 3mo | 6mo | 1y | 3y | 5y
    channel_method: str = "structural" # structural | regression


# ── GET /chart/symbols ────────────────────────────────────────────────────────

@router.get("/chart/symbols")
async def search_symbols(
    q: str = Query("", min_length=0),
    market: str = Query("NSE"),
    user=Depends(get_current_user),
):
    """
    For NSE: proxies to the existing NSE search.
    For US: validates the symbol via yfinance and returns basic info.
    """
    if not q.strip():
        return JSONResponse([])

    if market == "US":
        def _validate():
            import yfinance as yf
            sym = q.strip().upper()
            try:
                info = yf.Ticker(sym).info or {}
                name = info.get("longName") or info.get("shortName") or sym
                return [{"symbol": sym, "name": name, "type": "US"}] if info else []
            except Exception:
                return []
        results = await _in_thread(_validate)
        return JSONResponse(results)

    # NSE — use yfinance validation (frontend uses NseStockSearch component for NSE autocomplete)
    def _nse_validate():
        import yfinance as yf
        sym = q.strip().upper()
        yfm = sym if (sym.startswith("^") or "." in sym) else sym + ".NS"
        try:
            info = yf.Ticker(yfm).info or {}
            name = info.get("longName") or info.get("shortName") or sym
            return [{"symbol": sym, "name": name, "type": "NSE"}] if info.get("regularMarketPrice") or info.get("currentPrice") or info.get("previousClose") else []
        except Exception:
            return []

    results = await _in_thread(_nse_validate)
    return JSONResponse(results)


# ── POST /chart/analyze ───────────────────────────────────────────────────────

@router.post("/chart/analyze")
async def analyze_chart(body: AnalyzeRequest, user=Depends(get_current_user)):
    """
    Full chart analysis pipeline:
      fetch OHLCV → detect swings → trendlines → channels → S/R → indicators → rules → assessment
    Returns all data needed for the frontend chart + analysis panel.
    """
    try:
        from ai.chart_intelligence import generate_analysis

        result = await _in_thread(lambda: generate_analysis(
            symbol=body.symbol.strip().upper(),
            market=body.market,
            timeframe=body.timeframe,
            lookback=body.lookback,
            channel_method=body.channel_method,
        ))

        if "error" in result:
            return JSONResponse({"error": result["error"]}, status_code=400)

        return JSONResponse(_clean(result))

    except Exception as e:
        import traceback
        return JSONResponse({"error": str(e), "detail": traceback.format_exc()}, status_code=500)
