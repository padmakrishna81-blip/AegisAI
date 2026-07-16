"""Recommendation engine — combines all 6 scoring engines into a final verdict."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from data.market_data import get_info, safe_get
from engines import company_health, technical_strength, growth_trend
from engines import sector_strength, business_events, macro_environment
from ai.explainer import generate_verdict


def calculate_full(symbol: str) -> dict:
    """Run all 6 engines concurrently and synthesize results."""
    results = {}

    def run(name, fn, *args):
        try:
            return name, fn(*args)
        except Exception as e:
            return name, {"score": 50, "error": str(e)[:200]}

    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {
            executor.submit(run, "company_health", company_health.calculate, symbol): "company_health",
            executor.submit(run, "technical", technical_strength.calculate, symbol): "technical",
            executor.submit(run, "growth_trend", growth_trend.calculate, symbol): "growth_trend",
            executor.submit(run, "sector", sector_strength.calculate, symbol): "sector",
            executor.submit(run, "business_events", business_events.calculate, symbol): "business_events",
            executor.submit(run, "macro", macro_environment.calculate, symbol): "macro",
        }
        for future in as_completed(futures):
            name, result = future.result()
            results[name] = result

    # Extract scores
    ch = results.get("company_health", {}).get("score", 50)
    gt = results.get("growth_trend", {}).get("score", 50)
    tech = results.get("technical", {}).get("score", 50)
    sec = results.get("sector", {}).get("score", 50)
    be = results.get("business_events", {}).get("score", 50)
    macro = results.get("macro", {}).get("score", 50)
    market_mode = results.get("macro", {}).get("market_mode", "NEUTRAL")

    # Final weighted score
    overall = round(ch * 0.30 + gt * 0.25 + tech * 0.20 + sec * 0.10 + be * 0.10 + macro * 0.05)
    overall = min(100, max(0, overall))

    info = get_info(symbol)
    company_name = safe_get(info, "longName", default=symbol) or symbol

    # Use fast_info for price/52W — bypasses the stale 15-min cache
    import yfinance as _yf
    try:
        _fi = _yf.Ticker(symbol).fast_info
        current_price = float(getattr(_fi, "last_price", None) or getattr(_fi, "regular_market_price", None) or 0)
        high_52w = float(getattr(_fi, "year_high", None) or 0) or None
        low_52w  = float(getattr(_fi, "year_low",  None) or 0) or None
        prev_close_val = float(getattr(_fi, "previous_close", None) or 0) or None
    except Exception:
        current_price = 0
        high_52w = low_52w = prev_close_val = None

    # Fallback to .info for anything fast_info didn't provide
    if not current_price:
        current_price = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=0) or 0
    if not high_52w:
        high_52w = safe_get(info, "fiftyTwoWeekHigh", default=None)
    if not low_52w:
        low_52w  = safe_get(info, "fiftyTwoWeekLow",  default=None)
    if not prev_close_val:
        prev_close_val = safe_get(info, "previousClose", default=None) or safe_get(info, "regularMarketPreviousClose", default=None)

    scores_for_verdict = {
        "overall": overall,
        "company_health": ch,
        "growth_trend": gt,
        "technical": tech,
        "sector": sec,
        "business_events": be,
        "macro": macro,
        "current_price": current_price,
    }

    verdict = generate_verdict(symbol, company_name, scores_for_verdict)

    # Determine recommendation label
    if overall >= 80:
        recommendation = "BUY"
    elif overall >= 65:
        recommendation = "HOLD"
    else:
        recommendation = "SELL"

    # One-line reason
    reason = _get_reason(ch, gt, tech, sec, be)

    return {
        "symbol": symbol,
        "company_name": company_name,
        "current_price": float(current_price) if current_price else 0,
        "prev_close": float(prev_close_val) if prev_close_val else None,
        "high_52w": float(high_52w) if high_52w is not None else None,
        "low_52w":  float(low_52w)  if low_52w  is not None else None,
        "overall_score": overall,
        "recommendation": recommendation,
        "market_mode": market_mode,
        "reason": reason,
        "verdict": verdict,
        "scores": {
            "company_health": ch,
            "growth_trend": gt,
            "technical_strength": tech,
            "sector_strength": sec,
            "business_events": be,
            "macro_environment": macro,
        },
        "breakdowns": {
            "company_health": results.get("company_health", {}).get("breakdown", {}),
            "growth_trend": results.get("growth_trend", {}).get("breakdown", {}),
            "technical_strength": results.get("technical", {}).get("breakdown", {}),
            "sector_strength": results.get("sector", {}).get("breakdown", {}),
            "business_events": results.get("business_events", {}).get("breakdown", {}),
            "macro_environment": results.get("macro", {}).get("breakdown", {}),
        },
        "technical_indicators": results.get("technical", {}).get("indicators", {}),
        "entry_range": results.get("technical", {}).get("entry_range", {}),
        "recent_news": results.get("business_events", {}).get("recent_news", []),
    }


def _get_reason(ch, gt, tech, sec, be) -> str:
    parts = []
    if ch >= 80:
        parts.append("strong fundamentals")
    elif ch < 55:
        parts.append("weak fundamentals")

    if tech >= 75:
        parts.append("good technical entry")
    elif tech < 45:
        parts.append("poor technical setup")

    if gt >= 75:
        parts.append("positive growth outlook")

    if sec >= 80:
        parts.append("sector tailwinds")

    if not parts:
        return "Mixed signals — monitor closely"
    return ", ".join(parts).capitalize()


def get_market_mode(macro_score: int) -> str:
    if macro_score >= 90:
        return "STRONG BULL"
    elif macro_score >= 80:
        return "BULLISH"
    elif macro_score >= 70:
        return "NEUTRAL"
    elif macro_score >= 60:
        return "DEFENSIVE"
    return "CAPITAL PRESERVATION"
