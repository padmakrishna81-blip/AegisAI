"""ETF and Index technical analysis endpoint — with direct ETF trading symbols."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from data.market_data import get_index_history, get_info, safe_get
from api.utils import clean_for_json
import pandas as pd

router = APIRouter()

# ─── Direct ETF catalog (tradeable on NSE, with Yahoo Finance symbols) ────────
# These are the actual ETF units you can BUY/SELL on NSE like a stock
ETF_CATALOG = [
    # Broad Market
    {"symbol": "NIFTYBEES.NS",   "name": "Nippon Nifty BeES",          "category": "Broad Market", "tracks": "NIFTY 50",         "aum_cr": 9800,  "expense": 0.04},
    {"symbol": "JUNIORBEES.NS",  "name": "Nippon Junior BeES",         "category": "Broad Market", "tracks": "NIFTY Next 50",    "aum_cr": 1200,  "expense": 0.19},
    {"symbol": "SETFNIF50.NS",   "name": "SBI Nifty 50 ETF",           "category": "Broad Market", "tracks": "NIFTY 50",         "aum_cr": 3200,  "expense": 0.07},
    {"symbol": "MOM100.NS",      "name": "Motilal Oswal Nasdaq 100",    "category": "Global",       "tracks": "NASDAQ 100",       "aum_cr": 4100,  "expense": 0.53},
    {"symbol": "HNGSNGBEES.NS",  "name": "Nippon Hang Seng BeES",      "category": "Global",       "tracks": "Hang Seng",        "aum_cr": 220,   "expense": 0.87},
    # Sector
    {"symbol": "BANKBEES.NS",    "name": "Nippon Bank BeES",           "category": "Sector",       "tracks": "NIFTY Bank",       "aum_cr": 7200,  "expense": 0.19},
    {"symbol": "ICICIB22.NS",    "name": "ICICI Pru Nifty Bank ETF",   "category": "Sector",       "tracks": "NIFTY Bank",       "aum_cr": 1800,  "expense": 0.17},
    {"symbol": "ITBEES.NS",      "name": "Nippon IT BeES",             "category": "Sector",       "tracks": "NIFTY IT",         "aum_cr": 2100,  "expense": 0.19},
    {"symbol": "PHARMABEES.NS",  "name": "Nippon Pharma BeES",         "category": "Sector",       "tracks": "NIFTY Pharma",     "aum_cr": 890,   "expense": 0.55},
    {"symbol": "AUTOBEES.NS",    "name": "Nippon Auto BeES",           "category": "Sector",       "tracks": "NIFTY Auto",       "aum_cr": 310,   "expense": 0.60},
    {"symbol": "SHARIABEES.NS",  "name": "Nippon Shariah BeES",        "category": "Sector",       "tracks": "Nifty50 Shariah",  "aum_cr": 78,    "expense": 0.49},
    # Midcap / Smallcap
    {"symbol": "MAFANG.NS",      "name": "Mirae FANG+ ETF",            "category": "Global",       "tracks": "NYSE FANG+",       "aum_cr": 1900,  "expense": 0.57},
    # HDFCNIFETF.NS and NETFIT.NS delisted on Yahoo Finance — removed
    {"symbol": "GOLDBEES.NS",    "name": "Nippon Gold BeES",           "category": "Commodity",    "tracks": "Gold Price",       "aum_cr": 8700,  "expense": 0.82},
]

# ─── Index catalog (benchmarks — NOT directly tradeable as single units) ──────
INDICES_CATALOG = [
    {"symbol": "^NSEI",                "name": "NIFTY 50",           "category": "Broad Market", "etf": "NIFTYBEES.NS"},
    {"symbol": "^NSEMDCP50",           "name": "NIFTY Midcap 50",    "category": "Broad Market", "etf": None},
    {"symbol": "^NSMIDCP",             "name": "NIFTY Smallcap 100", "category": "Broad Market", "etf": None},
    {"symbol": "^NSEBANK",             "name": "NIFTY Bank",          "category": "Sector",       "etf": "BANKBEES.NS"},
    {"symbol": "^CNXIT",               "name": "NIFTY IT",            "category": "Sector",       "etf": "ITBEES.NS"},
    {"symbol": "^CNXPHARMA",           "name": "NIFTY Pharma",        "category": "Sector",       "etf": "PHARMABEES.NS"},
    {"symbol": "^CNXAUTO",             "name": "NIFTY Auto",          "category": "Sector",       "etf": "AUTOBEES.NS"},
    {"symbol": "^CNXFMCG",             "name": "NIFTY FMCG",         "category": "Sector",       "etf": None},
    {"symbol": "^CNXMETAL",            "name": "NIFTY Metal",         "category": "Sector",       "etf": None},
    {"symbol": "^CNXENERGY",           "name": "NIFTY Energy",        "category": "Sector",       "etf": None},
    {"symbol": "NIFTY_FIN_SERVICE.NS", "name": "NIFTY Fin Services",  "category": "Sector",       "etf": None},
]


def _compute_technicals(hist: pd.DataFrame, symbol: str = "", use_live_prev_close: bool = False) -> dict:
    if hist.empty or len(hist) < 20:
        return {}
    # Drop rows with NaN close (can happen for today's partial data)
    hist = hist.dropna(subset=["Close"])
    if len(hist) < 20:
        return {}
    close = hist["Close"]
    sma20 = float(close.rolling(20).mean().iloc[-1])
    sma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
    sma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
    curr = float(close.iloc[-1])

    # Only fetch live prev_close for single-symbol predict endpoint, not bulk list
    prev_close = None
    if use_live_prev_close and symbol:
        try:
            import yfinance as yf
            fi = yf.Ticker(symbol).fast_info
            pc = getattr(fi, "previous_close", None)
            if pc and float(pc) > 0:
                prev_close = float(pc)
        except Exception:
            pass
    if prev_close is None:
        prev_close = float(close.iloc[-2]) if len(close) >= 2 else None

    change_inr = round(curr - prev_close, 2) if prev_close else None
    change_pct = round((curr / prev_close - 1) * 100, 2) if prev_close else None

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta).clip(lower=0).rolling(14).mean()
    rsi_raw = loss.iloc[-1]
    rsi = float(100 - (100 / (1 + gain.iloc[-1] / rsi_raw))) if rsi_raw else 50.0

    ema12 = close.ewm(span=12).mean()
    ema26 = close.ewm(span=26).mean()
    macd = float((ema12 - ema26).iloc[-1])
    signal_line = float((ema12 - ema26).ewm(span=9).mean().iloc[-1])

    above_200dma = bool(sma200 and curr > sma200)
    above_50dma = bool(sma50 and curr > sma50)

    if sma200 and curr > sma200:
        trend = "Strong Uptrend" if (sma50 and curr > sma50) else "Uptrend"
    elif sma200 and curr < sma200:
        trend = "Downtrend"
    else:
        trend = "Sideways"

    def period_return(days: int):
        if len(close) < days:
            return None
        return round((float(close.iloc[-1]) / float(close.iloc[-days]) - 1) * 100, 2)

    return {
        "current": round(curr, 2),
        "prev_close": round(prev_close, 2) if prev_close else None,
        "change_inr": change_inr,
        "change_pct": change_pct,
        "sma20": round(sma20, 2),
        "sma50": round(sma50, 2) if sma50 else None,
        "sma200": round(sma200, 2) if sma200 else None,
        "rsi": round(rsi, 1),
        "macd": round(macd, 4),
        "macd_signal": round(signal_line, 4),
        "trend": trend,
        "above_200dma": above_200dma,
        "above_50dma": above_50dma,
        "returns": {
            "1w": period_return(5),
            "1m": period_return(21),
            "3m": period_return(63),
            "6m": period_return(126),
            "1y": period_return(252),
        },
        "52w_high": round(float(close.rolling(252).max().iloc[-1]), 2) if len(close) >= 252 else round(float(close.max()), 2),
        "52w_low":  round(float(close.rolling(252).min().iloc[-1]), 2) if len(close) >= 252 else round(float(close.min()), 2),
        "pct_from_52w_high": round((curr / (float(close.rolling(252).max().iloc[-1]) if len(close) >= 252 else float(close.max())) - 1) * 100, 2),
    }


def _score_from_tech(tech: dict) -> int:
    if not tech:
        return 50
    score = 50
    if tech.get("above_200dma"): score += 15
    if tech.get("above_50dma"): score += 10
    rsi = tech.get("rsi", 50)
    if 45 <= rsi <= 65: score += 10
    elif rsi > 70: score -= 5
    elif rsi < 30: score -= 5
    if (tech.get("macd") or 0) > (tech.get("macd_signal") or 0): score += 10
    ret_1m = (tech.get("returns") or {}).get("1m") or 0
    if ret_1m > 3: score += 5
    elif ret_1m < -3: score -= 5
    return max(0, min(100, score))


def _signal_from_score_and_tech(score: int, tech: dict) -> str:
    """Derive signal ensuring it is consistent with trend direction."""
    trend = tech.get("trend", "Sideways")
    if trend == "Downtrend":
        # Never show BUY when clearly in a downtrend (below 200DMA)
        return "HOLD" if score >= 50 else "AVOID"
    return "BUY" if score >= 70 else "HOLD" if score >= 50 else "AVOID"


def _ai_justify_etf(name: str, symbol: str, tech: dict, score: int, signal: str) -> str:
    """Generate an AI justification for the trend and signal. Falls back to rule-based."""
    from ai.llm_client import call_llm, is_configured
    trend = tech.get("trend", "Sideways")
    rsi = tech.get("rsi", 50)
    above_200 = tech.get("above_200dma", False)
    above_50 = tech.get("above_50dma", False)
    macd_bull = (tech.get("macd") or 0) > (tech.get("macd_signal") or 0)
    ret_1m = (tech.get("returns") or {}).get("1m")
    ret_1y = (tech.get("returns") or {}).get("1y")

    if is_configured():
        prompt = (
            f"You are an Indian market technical analyst. Provide a concise 2-3 sentence justification "
            f"for the following signal on {name} ({symbol}):\n"
            f"Signal: {signal} | Trend: {trend} | Score: {score}/100\n"
            f"RSI: {rsi} | Above 200DMA: {above_200} | Above 50DMA: {above_50} | "
            f"MACD: {'Bullish' if macd_bull else 'Bearish'} crossover | "
            f"1M Return: {ret_1m}% | 1Y Return: {ret_1y}%\n\n"
            f"Explain WHY this signal makes sense given the technicals. "
            f"If signal and trend appear contradictory, clarify. Be direct, under 60 words."
        )
        try:
            return call_llm(prompt, max_tokens=120).strip()
        except Exception:
            pass

    # Rule-based fallback
    parts = []
    if trend == "Downtrend":
        parts.append(f"{name} is trading below its 200-day moving average, indicating a medium-term downtrend.")
    elif trend == "Strong Uptrend":
        parts.append(f"{name} is above both its 50-day and 200-day moving averages, confirming a strong uptrend.")
    else:
        parts.append(f"{name} is in an {trend.lower()} based on moving average positioning.")
    if rsi > 70:
        parts.append(f"RSI at {rsi:.0f} signals overbought conditions — caution advised.")
    elif rsi < 30:
        parts.append(f"RSI at {rsi:.0f} signals oversold conditions — potential bounce zone.")
    else:
        parts.append(f"RSI at {rsi:.0f} is in neutral territory.")
    parts.append(f"MACD shows a {'bullish' if macd_bull else 'bearish'} crossover, supporting the {signal} signal.")
    return " ".join(parts)


# ─── API endpoints ─────────────────────────────────────────────────────────────

@router.get("/etf/list")
async def list_etfs():
    """Return full ETF catalog + index catalog."""
    return JSONResponse(content={"etfs": ETF_CATALOG, "indices": INDICES_CATALOG})


@router.get("/etf/overview")
async def etf_overview():
    """Score + technicals for all ETFs and indices combined."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    all_items = [
        {**e, "type": "etf"} for e in ETF_CATALOG
    ] + [
        {**i, "type": "index"} for i in INDICES_CATALOG
    ]

    def _analyze_one(item):
        sym = item["symbol"]
        try:
            hist = get_index_history(sym, period="1y")
            tech = _compute_technicals(hist, sym)
            score = _score_from_tech(tech)
            curr = tech.get("current", 0)
            ret_1m = (tech.get("returns") or {}).get("1m")
            ret_1y = (tech.get("returns") or {}).get("1y")
            return {
                "symbol": sym,
                "name": item["name"],
                "category": item["category"],
                "type": item["type"],
                "tracks": item.get("tracks"),
                "etf_symbol": item.get("etf"),
                "aum_cr": item.get("aum_cr"),
                "expense": item.get("expense"),
                "score": score,
                "current": curr,
                "prev_close": tech.get("prev_close"),
                "change_inr": tech.get("change_inr"),
                "change_pct": tech.get("change_pct"),
                "trend": tech.get("trend", "Unknown"),
                "rsi": tech.get("rsi"),
                "above_200dma": tech.get("above_200dma", False),
                "return_1m": ret_1m,
                "return_1y": ret_1y,
                "pct_from_52w_high": tech.get("pct_from_52w_high"),
                "signal": _signal_from_score_and_tech(score, tech),
            }
        except Exception as e:
            return {"symbol": sym, "name": item["name"], "type": item["type"],
                    "category": item["category"], "error": str(e)[:100]}

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=10)
    tasks = [loop.run_in_executor(executor, _analyze_one, item) for item in all_items]
    results = await asyncio.gather(*tasks)

    # Sort ETFs by score desc
    etf_results = sorted([r for r in results if r.get("type") == "etf"], key=lambda x: x.get("score", 0), reverse=True)
    idx_results = sorted([r for r in results if r.get("type") == "index"], key=lambda x: x.get("score", 0), reverse=True)

    return JSONResponse(content=clean_for_json({
        "etfs": etf_results,
        "indices": idx_results,
    }))


@router.get("/etf/analyze/{symbol:path}")
async def analyze_etf(symbol: str):
    """Full technical analysis of an ETF or index symbol."""
    # Find in catalog
    entry = next((e for e in ETF_CATALOG + INDICES_CATALOG if e["symbol"] == symbol), None)
    if not entry:
        entry = {"symbol": symbol, "name": symbol, "category": "Custom", "etf": None}

    hist = get_index_history(symbol, period="1y")
    if hist.empty:
        raise HTTPException(status_code=404, detail=f"No data found for {symbol}")

    tech = _compute_technicals(hist, symbol)
    score = _score_from_tech(tech)
    signal = _signal_from_score_and_tech(score, tech)
    name = entry.get("name", symbol)
    ai_justification = _ai_justify_etf(name, symbol, tech, score, signal)

    hist_3m = get_index_history(symbol, period="3mo")
    chart_data = []
    if not hist_3m.empty:
        for dt, row in hist_3m.iterrows():
            chart_data.append({
                "date": str(dt.date()),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"]) if row["Volume"] else 0,
            })

    # Live price from info for ETFs
    info = get_info(symbol)
    live_price = safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or tech.get("current", 0)
    company_name = safe_get(info, "longName") or name

    return JSONResponse(content=clean_for_json({
        "symbol": symbol,
        "name": name,
        "company_name": company_name,
        "category": entry.get("category"),
        "type": "etf" if symbol in [e["symbol"] for e in ETF_CATALOG] else "index",
        "tracks": entry.get("tracks"),
        "etf_symbol": entry.get("etf"),
        "aum_cr": entry.get("aum_cr"),
        "expense": entry.get("expense"),
        "score": score,
        "current_price": round(float(live_price), 2) if live_price else 0,
        "technicals": tech,
        "chart_data": chart_data[-60:],
        "signal": signal,
        "ai_justification": ai_justification,
    }))


# ─── Index / ETF prediction ────────────────────────────────────────────────────

@router.get("/etf/predict/{symbol:path}")
async def predict_index(symbol: str):
    """
    Predict near-term trend + range for an index/ETF.
    Uses technicals, volatility, global correlations, and news sentiment.
    Returns 1-day, 2-day, 3-day outlook with probability.
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    entry = next((e for e in ETF_CATALOG + INDICES_CATALOG if e["symbol"] == symbol), None)
    if not entry:
        entry = {"symbol": symbol, "name": symbol, "category": "Custom"}

    def _do_predict():
        hist = get_index_history(symbol, period="1y")
        if hist.empty:
            return {"error": f"No data for {symbol}"}

        tech = _compute_technicals(hist, symbol, use_live_prev_close=True)

        # Volatility: 20-day ATR as % of price
        high = hist["High"]
        low  = hist["Low"]
        tr   = (high - low).rolling(20).mean().iloc[-1]
        atr_pct = round(float(tr) / curr * 100, 2) if curr else 1.0

        # Recent momentum: last 5 days % change
        ret_5d = round((curr / float(close.iloc[-5]) - 1) * 100, 2) if len(close) >= 5 else 0.0

        # Global correlation cue: S&P 500 last close
        try:
            sp500 = get_index_history("^GSPC", period="5d")
            sp_ret = round((float(sp500["Close"].iloc[-1]) / float(sp500["Close"].iloc[-2]) - 1) * 100, 2) if not sp500.empty and len(sp500) >= 2 else 0.0
        except Exception:
            sp_ret = 0.0

        # News sentiment from cached news
        from api.routes.market import _news_cache
        news = _news_cache.get("data") or []
        pos = sum(1 for n in news if n.get("sentiment") == "positive")
        neg = sum(1 for n in news if n.get("sentiment") == "negative")
        news_bias = "positive" if pos > neg else "negative" if neg > pos else "neutral"
        news_score = pos - neg  # +ve = bullish, -ve = bearish

        # Build outlook per day
        trend = tech.get("trend", "Sideways")
        above_200 = tech.get("above_200dma", False)
        rsi = tech.get("rsi", 50)

        # Direction probability based on technicals + news + global
        base_bull = 50
        if above_200:    base_bull += 10
        if ret_5d > 0:   base_bull += 5
        if sp_ret > 0:   base_bull += 7
        if news_score > 0: base_bull += 5
        if news_score < 0: base_bull -= 5
        if rsi > 65:     base_bull -= 5   # overbought
        if rsi < 35:     base_bull += 5   # oversold bounce
        base_bull = max(20, min(80, base_bull))
        base_bear = 100 - base_bull

        def day_range(atr_mult: float):
            move = round(curr * atr_pct / 100 * atr_mult, 0)
            bull_target = round(curr + move, 0)
            bear_target = round(curr - move, 0)
            return {"low": int(bear_target), "high": int(bull_target), "atr_move": int(move)}

        outlooks = [
            {"period": "1 Day",  "bull_pct": base_bull,      "bear_pct": base_bear,      **day_range(0.8)},
            {"period": "2 Days", "bull_pct": max(20, base_bull - 5), "bear_pct": min(80, base_bear + 5), **day_range(1.3)},
            {"period": "3 Days", "bull_pct": max(20, base_bull - 8), "bear_pct": min(80, base_bear + 8), **day_range(1.8)},
        ]

        # Key factors driving the prediction
        factors = []
        if above_200:
            factors.append({"factor": "Above 200 DMA", "impact": "bullish", "detail": f"Price {round((curr/tech['sma200']-1)*100,1) if tech.get('sma200') else ''}% above long-term average"})
        else:
            factors.append({"factor": "Below 200 DMA", "impact": "bearish", "detail": "Medium-term downtrend in place"})
        if sp_ret and abs(sp_ret) > 0.01:
            factors.append({"factor": "S&P 500", "impact": "bullish" if sp_ret > 0 else "bearish",
                            "detail": f"US market {'rose' if sp_ret > 0 else 'fell'} {abs(sp_ret):.2f}% last session"})
        if rsi > 65:
            factors.append({"factor": f"RSI {rsi:.0f}", "impact": "bearish", "detail": "Overbought — pullback risk"})
        elif rsi < 35:
            factors.append({"factor": f"RSI {rsi:.0f}", "impact": "bullish", "detail": "Oversold — bounce possible"})
        else:
            factors.append({"factor": f"RSI {rsi:.0f}", "impact": "neutral", "detail": "Momentum in neutral zone"})
        if news_score != 0:
            factors.append({"factor": "News Sentiment", "impact": news_bias, "detail": f"{pos} positive / {neg} negative headlines in last 3 days"})
        macd_bull = (tech.get("macd") or 0) > (tech.get("macd_signal") or 0)
        factors.append({"factor": "MACD", "impact": "bullish" if macd_bull else "bearish", "detail": f"{'Bullish' if macd_bull else 'Bearish'} crossover"})

        # AI narrative
        narrative = _ai_justify_etf(entry.get("name", symbol), symbol, tech, score, signal)

        return clean_for_json({
            "symbol": symbol,
            "name": entry.get("name", symbol),
            "current": curr,
            "prev_close": tech.get("prev_close"),
            "change_inr": tech.get("change_inr"),
            "change_pct": tech.get("change_pct"),
            "trend": trend,
            "signal": signal,
            "score": score,
            "atr_pct": atr_pct,
            "ret_5d": ret_5d,
            "sp500_last_ret": sp_ret,
            "news_bias": news_bias,
            "outlooks": outlooks,
            "factors": factors,
            "narrative": narrative,
            "note": "GIFT Nifty unavailable on Yahoo Finance — prediction uses technicals, global correlations, and news sentiment",
        })

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    result = await loop.run_in_executor(executor, _do_predict)
    return JSONResponse(content=result)

