"""Analyze endpoint — full 6-engine analysis for a single stock."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from engines.recommendation import calculate_full
from engines import company_health, technical_strength
from data.market_data import get_info, normalize_symbol, safe_get
from api.utils import clean_for_json

router = APIRouter()


@router.get("/analyze/{symbol}")
async def analyze_stock(symbol: str):
    """Full analysis: all 6 engines + AI verdict."""
    sym = normalize_symbol(symbol)
    try:
        result = calculate_full(sym)
        return JSONResponse(content=clean_for_json(result))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/analyze/{symbol}/quick")
async def quick_analyze(symbol: str):
    """Quick analysis: Company Health + Technical only (faster)."""
    sym = normalize_symbol(symbol)
    try:
        info = get_info(sym)
        company_name = safe_get(info, "longName", default=sym) or sym
        current_price = safe_get(info, "currentPrice", default=0) or safe_get(info, "regularMarketPrice", default=0) or 0

        ch_result = company_health.calculate(sym)
        tech_result = technical_strength.calculate(sym)

        ch_score = ch_result.get("score", 50)
        tech_score = tech_result.get("score", 50)
        overall = round(ch_score * 0.6 + tech_score * 0.4)

        return {
            "symbol": sym,
            "company_name": company_name,
            "current_price": current_price,
            "overall_score": overall,
            "company_health": ch_score,
            "technical_strength": tech_score,
            "recommendation": "BUY" if overall >= 75 else "HOLD" if overall >= 55 else "SELL",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
