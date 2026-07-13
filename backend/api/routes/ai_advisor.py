"""AI advisor endpoints."""

from fastapi import APIRouter
from ai.explainer import generate_verdict, generate_score_explanation, generate_morning_briefing
from engines.recommendation import calculate_full
from api.routes.portfolio import _portfolio
from data.market_data import get_info, safe_get, normalize_symbol

router = APIRouter()


@router.get("/ai/explain/{symbol}")
async def explain_stock(symbol: str):
    """Get AI explanation and verdict for a stock."""
    sym = normalize_symbol(symbol)
    result = calculate_full(sym)

    # Fetch prev close + day change
    info       = get_info(sym)
    cmp        = safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or result.get("current_price", 0)
    prev_close = safe_get(info, "previousClose") or safe_get(info, "regularMarketPreviousClose")
    change_inr = round(float(cmp) - float(prev_close), 2) if cmp and prev_close else None
    change_pct = round((float(cmp) / float(prev_close) - 1) * 100, 2) if cmp and prev_close and float(prev_close) > 0 else None

    # Check if AI produced an error message (quota exceeded etc.)
    verdict = result.get("verdict", {})
    ai_error = None
    if verdict and not verdict.get("ai_powered", False):
        from ai.llm_client import is_configured, get_provider
        if is_configured():
            # AI is configured but verdict is rule-based — means LLM call failed
            # Run a quick check to surface the error
            from ai.llm_client import call_llm
            test = call_llm("ping", max_tokens=3)
            if test.startswith("[LLM"):
                ai_error = test  # e.g. "[LLM quota exceeded: ...]"

    return {
        "symbol":       sym,
        "company_name": result.get("company_name", sym),
        "verdict":      verdict,
        "overall_score":result.get("overall_score", 0),
        "scores":       result.get("scores", {}),
        "current_price":round(float(cmp), 2) if cmp else 0,
        "prev_close":   round(float(prev_close), 2) if prev_close else None,
        "change_inr":   change_inr,
        "change_pct":   change_pct,
        "ai_error":     ai_error,
    }


@router.get("/ai/briefing")
async def morning_briefing():
    """Generate AI morning briefing."""
    from engines.macro_environment import calculate as calc_macro
    macro_result = calc_macro()
    market_mode = macro_result.get("market_mode", "NEUTRAL")

    # Get portfolio
    holdings = []
    for h_id, h in _portfolio.get("holdings", {}).items():
        holdings.append({"symbol": h["symbol"], "quantity": h["quantity"]})

    # Get top opportunities (quick analysis of first 5 Nifty50 stocks)
    from data.indices import NIFTY50
    from engines.recommendation import calculate_full
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=5)

    async def quick_analyze(sym):
        return await loop.run_in_executor(executor, calculate_full, sym)

    try:
        top_symbols = NIFTY50[:5]
        tasks = [quick_analyze(sym) for sym in top_symbols]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        top_opps = []
        for r in results:
            if isinstance(r, dict) and r.get("overall_score", 0) >= 70:
                top_opps.append({
                    "symbol": r.get("symbol", ""),
                    "overall_score": r.get("overall_score", 0),
                    "recommendation": r.get("recommendation", "HOLD"),
                    "reason": r.get("reason", ""),
                })
        top_opps.sort(key=lambda x: x["overall_score"], reverse=True)
    except Exception:
        top_opps = []

    return generate_morning_briefing(holdings, top_opps, market_mode)
