"""Discover endpoints — scan indices and compare stocks."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from api.utils import clean_for_json
from data.indices import INDEX_GROUPS, normalize_symbol
from data.market_data import get_info, safe_get
from engines.recommendation import calculate_full
from engines import company_health, technical_strength

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=10)


@router.get("/discover/indices")
async def list_indices():
    """List all available indices."""
    return {
        "indices": [
            {"key": k, "name": k.replace("_", " ").title(), "count": len(v)}
            for k, v in INDEX_GROUPS.items()
        ]
    }


@router.get("/discover/scan")
async def scan_stocks(
    index: str = Query("nifty50"),
    top_n: int = Query(10, ge=1, le=50),
    min_score: int = Query(0, ge=0, le=100),
    strategy: str = Query("all"),  # all | swing | covered_call
):
    """Scan stocks in an index and rank by overall score."""
    symbols = INDEX_GROUPS.get(index)
    if not symbols:
        raise HTTPException(status_code=404, detail=f"Index '{index}' not found")

    symbols_to_scan = symbols[:min(top_n, len(symbols))]

    loop = asyncio.get_running_loop()

    def analyze_one(sym):
        try:
            result = calculate_full(sym)
            return {
                "symbol": sym,
                "company_name": result.get("company_name", sym),
                "current_price": result.get("current_price", 0),
                "overall_score": result.get("overall_score", 0),
                "recommendation": result.get("recommendation", "HOLD"),
                "reason": result.get("reason", ""),
                "scores": result.get("scores", {}),
            }
        except Exception as e:
            return {
                "symbol": sym,
                "company_name": sym,
                "current_price": 0,
                "overall_score": 0,
                "recommendation": "N/A",
                "reason": f"Error: {str(e)[:100]}",
                "scores": {},
            }

    futures = [loop.run_in_executor(_executor, analyze_one, sym) for sym in symbols_to_scan]
    results = await asyncio.gather(*futures)

    filtered = [r for r in results if r["overall_score"] >= min_score]
    sorted_results = sorted(filtered, key=lambda x: x["overall_score"], reverse=True)

    for i, r in enumerate(sorted_results):
        r["rank"] = i + 1

    return JSONResponse(content=clean_for_json({"index": index, "total": len(sorted_results), "results": sorted_results}))


@router.get("/discover/compare")
async def compare_stocks(symbols: str = Query(..., description="Comma-separated symbols")):
    """Compare up to 5 stocks side by side."""
    sym_list = [normalize_symbol(s.strip()) for s in symbols.split(",")][:5]
    if len(sym_list) < 2:
        raise HTTPException(status_code=400, detail="Provide at least 2 symbols")

    loop = asyncio.get_running_loop()

    def analyze_one(sym):
        try:
            return calculate_full(sym)
        except Exception as e:
            return {"symbol": sym, "overall_score": 0, "error": str(e)[:100]}

    futures = [loop.run_in_executor(_executor, analyze_one, sym) for sym in sym_list]
    results = await asyncio.gather(*futures)

    # AI comparison summary
    from ai.llm_client import call_llm, is_configured
    ai_summary = ""
    if is_configured():
        summary_lines = []
        for r in results:
            summary_lines.append(
                f"{r.get('company_name', r.get('symbol', ''))} (score: {r.get('overall_score', 0)}, "
                f"rec: {r.get('recommendation', 'N/A')})"
            )
        prompt = (
            f"Compare these Indian stocks for an investor: {'; '.join(summary_lines)}. "
            f"In 2-3 sentences, tell me which is the best opportunity and why."
        )
        try:
            ai_summary = call_llm(prompt, max_tokens=200)
        except Exception:
            ai_summary = ""

    return JSONResponse(content=clean_for_json({
        "symbols": sym_list,
        "results": results,
        "ai_summary": ai_summary,
    }))
