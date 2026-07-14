"""AI advisor endpoints."""

import time
import threading
from fastapi import APIRouter
from ai.explainer import generate_verdict, generate_score_explanation, generate_morning_briefing
from engines.recommendation import calculate_full
from api.routes.portfolio import _portfolio
from data.market_data import get_info, safe_get, normalize_symbol

router = APIRouter()

# ── Briefing cache — recomputed at most once every 30 minutes ─────────────────
_briefing_cache: dict = {}
_briefing_ts: float = 0.0
_briefing_lock = threading.Lock()
_BRIEFING_TTL = 1800  # 30 minutes


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
            from ai.llm_client import call_llm
            test = call_llm("ping", max_tokens=3)
            if test.startswith("[LLM"):
                ai_error = test

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
    """Generate AI morning briefing — cached for 30 min to avoid blocking the home page."""
    global _briefing_cache, _briefing_ts

    # Return cached result if still fresh
    with _briefing_lock:
        if _briefing_cache and (time.time() - _briefing_ts) < _BRIEFING_TTL:
            return _briefing_cache

    # Build fresh briefing — macro only (no full stock analysis on every load)
    from engines.macro_environment import calculate as calc_macro
    macro_result = calc_macro()
    market_mode = macro_result.get("market_mode", "NEUTRAL")

    holdings = []
    for h_id, h in _portfolio.get("holdings", {}).items():
        holdings.append({"symbol": h["symbol"], "quantity": h["quantity"]})

    result = generate_morning_briefing(holdings, [], market_mode)

    with _briefing_lock:
        _briefing_cache = result
        _briefing_ts = time.time()

    return result
