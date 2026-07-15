"""
Next-session price range predictions.

Architecture:
  - IV-based 1SD statistical range (Black-Scholes)
  - Adjusted by: global factors (GIFT Nifty gap, S&P500, VIX, Crude),
    stock health scores, RSI extremes, MACD direction, ATR
  - LLM adds a 1-line commentary when configured
  - Only computed during non-market hours (after 15:30 IST, before 09:15 IST)
  - Stored in predictions.json with actual close filled next day
  - Accuracy tracked: HIT (inside range) / NEAR (within 0.5% outside) / MISS
"""

import json
import math
import os
import threading
from datetime import datetime, date, time as dtime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from api.utils import clean_for_json

router = APIRouter()

_DATA_DIR   = os.path.join(os.path.dirname(__file__), "..", "..")
_PRED_FILE  = os.path.join(_DATA_DIR, "predictions.json")
_pred_lock  = threading.Lock()

IST = timezone(timedelta(hours=5, minutes=30))
MARKET_OPEN  = dtime(9, 15)
MARKET_CLOSE = dtime(15, 30)

BENCHMARK_SYMBOLS = {
    "^NSEI":  "NIFTY 50",
    "^NSEBANK": "Bank Nifty",
    "^BSESN":  "Sensex",
}


# ─── Persistence helpers ──────────────────────────────────────────────────────

def _load_predictions() -> dict:
    if os.path.exists(_PRED_FILE):
        try:
            with open(_PRED_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {"predictions": {}}


def _save_predictions(data: dict) -> None:
    with open(_PRED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def _pred_key(symbol: str, session_date: str) -> str:
    return f"{symbol.upper()}::{session_date}"


# ─── Market hours gate ────────────────────────────────────────────────────────

def _is_market_hours() -> bool:
    """True if current IST time is within market hours 09:15–15:30."""
    now_ist = datetime.now(IST).time()
    return MARKET_OPEN <= now_ist <= MARKET_CLOSE


def _next_trading_date() -> str:
    """Returns the next trading session date (skips weekends)."""
    d = date.today()
    now_ist = datetime.now(IST)
    # If before market close today, next session is today; after close it's tomorrow
    if now_ist.time() < MARKET_CLOSE:
        pass
    else:
        d = d + timedelta(days=1)
    # Skip weekends
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.isoformat()


# ─── Global factors fetch ─────────────────────────────────────────────────────

def _fetch_global_factors() -> dict:
    """Fetch GIFT Nifty gap, S&P 500 change, VIX, Crude oil."""
    import requests
    factors = {
        "gift_nifty_gap":  None,
        "sp500_chg_pct":   None,
        "vix":             None,
        "crude_chg_pct":   None,
        "global_bias":     "neutral",  # bullish / bearish / neutral
    }
    try:
        import yfinance as yf
        # S&P 500
        sp = yf.Ticker("^GSPC").fast_info
        sp_price = getattr(sp, "last_price", None)
        sp_prev  = getattr(sp, "previous_close", None)
        if sp_price and sp_prev and sp_prev > 0:
            factors["sp500_chg_pct"] = round((sp_price / sp_prev - 1) * 100, 2)

        # VIX
        vix = yf.Ticker("^VIX").fast_info
        factors["vix"] = getattr(vix, "last_price", None)

        # Crude oil
        cl = yf.Ticker("CL=F").fast_info
        cl_price = getattr(cl, "last_price", None)
        cl_prev  = getattr(cl, "previous_close", None)
        if cl_price and cl_prev and cl_prev > 0:
            factors["crude_chg_pct"] = round((cl_price / cl_prev - 1) * 100, 2)
    except Exception:
        pass

    # GIFT Nifty — scrape equitypandit
    try:
        import re
        r = requests.get("https://www.equitypandit.com/giftnifty/",
                         headers={"User-Agent": "Mozilla/5.0"}, timeout=8)
        text = r.text
        chg_m = re.search(r"gift_Nifty_Live_Change[^>]+>([^<]+)", text)
        if chg_m:
            cm = re.search(r"([+-]?[\d,.]+)\s*\(([+-]?[\d,.]+)%\)", chg_m.group(1))
            if cm:
                factors["gift_nifty_gap"] = float(cm.group(1).replace(",", ""))
    except Exception:
        pass

    # Derive global bias score (-3 to +3)
    bias = 0
    if factors["sp500_chg_pct"] is not None:
        if factors["sp500_chg_pct"] > 0.5:   bias += 1
        elif factors["sp500_chg_pct"] < -0.5: bias -= 1
        if factors["sp500_chg_pct"] > 1.5:   bias += 1
        elif factors["sp500_chg_pct"] < -1.5: bias -= 1
    if factors["vix"] is not None:
        if factors["vix"] > 25:  bias -= 1
        if factors["vix"] > 35:  bias -= 1
    if factors["crude_chg_pct"] is not None:
        if factors["crude_chg_pct"] > 2:   bias -= 1  # high crude = bad for India
        elif factors["crude_chg_pct"] < -2: bias += 0.5
    if factors["gift_nifty_gap"] is not None:
        if factors["gift_nifty_gap"] > 50:    bias += 1
        elif factors["gift_nifty_gap"] < -50: bias -= 1

    factors["global_bias_score"] = round(bias, 1)
    if bias >= 1.5:    factors["global_bias"] = "bullish"
    elif bias <= -1.5: factors["global_bias"] = "bearish"
    else:              factors["global_bias"] = "neutral"

    return factors


# ─── High-impact news keywords ───────────────────────────────────────────────

_HIGH_IMPACT_BEARISH = [
    "war", "invasion", "missile", "attack", "bomb", "nuclear", "sanctions",
    "default", "bankruptcy", "fraud", "scam", "probe", "arrested", "raid",
    "crash", "collapse", "delisted", "writeoff", "penalty",
    "downgrade", "recall", "shut down", "sebi notice",
    "money laundering", "ed notice", "cbi notice", "tax evasion", "loss warning",
    "profit warning", "revenue miss", "earnings miss", "guidance cut",
    "geopolitical", "conflict", "tension", "escalation", "terror attack",
    "resigned", "sacked", "suspended trading",
]

_HIGH_IMPACT_BULLISH = [
    "record profit", "beat estimates", "earnings beat", "revenue beat",
    "major order", "major contract", "acquisition", "buyback", "dividend",
    "rating upgrade", "target raised", "fda approval", "government contract",
    "strategic partnership", "ceasefire", "peace deal",
    "rate cut", "stimulus", "policy support",
]

def _scan_news_impact(news: list[dict]) -> dict:
    """
    Scan recent news for high-impact keywords.
    Uses multi-word phrases to avoid false matches (e.g. 'ban' in 'bankers').
    Returns: {bearish_alerts, bullish_alerts, news_bias_score, top_alert}
    """
    import re
    bearish_alerts = []
    bullish_alerts = []
    combined_text = " ".join(
        (n.get("title", "") + " " + n.get("summary", "")).lower()
        for n in news[:10]
    )

    for kw in _HIGH_IMPACT_BEARISH:
        # Use word-boundary match for short single words to avoid false positives
        pattern = (r'\b' + re.escape(kw) + r'\b') if len(kw.split()) == 1 else re.escape(kw)
        if re.search(pattern, combined_text):
            for n in news[:10]:
                t = (n.get("title", "") + " " + n.get("summary", "")).lower()
                if re.search(pattern, t):
                    bearish_alerts.append({
                        "keyword": kw,
                        "headline": n.get("title", ""),
                    })
                    break

    for kw in _HIGH_IMPACT_BULLISH:
        pattern = (r'\b' + re.escape(kw) + r'\b') if len(kw.split()) == 1 else re.escape(kw)
        if re.search(pattern, combined_text):
            for n in news[:10]:
                t = (n.get("title", "") + " " + n.get("summary", "")).lower()
                if re.search(pattern, t):
                    bullish_alerts.append({
                        "keyword": kw,
                        "headline": n.get("title", ""),
                    })
                    break

    # Deduplicate by headline
    seen = set()
    bearish_alerts = [a for a in bearish_alerts if not (a["headline"] in seen or seen.add(a["headline"]))]
    seen = set()
    bullish_alerts = [a for a in bullish_alerts if not (a["headline"] in seen or seen.add(a["headline"]))]

    # Score: each bearish alert = -0.3, each bullish = +0.2 (bearish weighted more)
    news_bias_score = len(bullish_alerts) * 0.2 - len(bearish_alerts) * 0.3
    news_bias_score = max(-1.0, min(1.0, news_bias_score))

    top_alert = None
    if bearish_alerts:
        top_alert = {"type": "bearish", "headline": bearish_alerts[0]["headline"], "keyword": bearish_alerts[0]["keyword"]}
    elif bullish_alerts:
        top_alert = {"type": "bullish", "headline": bullish_alerts[0]["headline"], "keyword": bullish_alerts[0]["keyword"]}

    return {
        "bearish_alerts": bearish_alerts[:3],
        "bullish_alerts": bullish_alerts[:3],
        "news_bias_score": round(news_bias_score, 2),
        "top_alert": top_alert,
    }


# ─── Core prediction math ─────────────────────────────────────────────────────

def _compute_prediction(
    symbol: str,
    scores: dict,
    tech_indicators: dict,
    atm_iv: Optional[float],
    current_price: float,
    global_factors: dict,
    recent_news: Optional[list] = None,
) -> dict:
    """
    Build a prediction dict with low/base/high for next session.

    Range method:
      1. IV-based 1-day 1SD move = price × (IV/100) × sqrt(1/252)
      2. Bias = weighted sum of: overall score, RSI extremes,
                MACD direction, global_bias_score, ATR%, news impact
      3. Base = current_price × (1 + bias_shift)
      4. Low  = base - 1SD_adjusted
      5. High = base + 1SD_adjusted
    """
    if current_price <= 0:
        return {}

    iv = atm_iv or 30.0  # fallback 30% if IV unavailable

    # 1-day 1SD move in price terms
    one_sd = current_price * (iv / 100) * math.sqrt(1 / 252)

    # ── Bias calculation ─────────────────────────────────────────────────────
    bias_pct = 0.0

    # Score-based bias (overall 0-100 → -0.5% to +0.5%)
    overall = scores.get("overall", 50)
    bias_pct += (overall - 50) / 100 * 0.5

    # RSI extremes
    rsi = tech_indicators.get("rsi")
    if rsi is not None:
        if rsi > 75:   bias_pct -= 0.15   # overbought → likely pullback
        elif rsi < 30: bias_pct += 0.15   # oversold → likely bounce
        elif rsi > 60: bias_pct += 0.05
        elif rsi < 45: bias_pct -= 0.05

    # MACD direction
    macd = tech_indicators.get("macd")
    if macd is not None:
        bias_pct += 0.05 if macd > 0 else -0.05

    # Global factors
    gb = global_factors.get("global_bias_score", 0)
    bias_pct += gb * 0.08  # each bias point → 0.08% price shift

    # GIFT Nifty gap (only for Indian stocks/indices)
    gift_gap = global_factors.get("gift_nifty_gap")
    if gift_gap is not None and not symbol.startswith("^GSPC"):
        # Gap of ±100 pts → ±0.1% adjustment
        bias_pct += (gift_gap / 1000) * 0.1

    # News impact — scan headlines for high-impact events
    news_impact = _scan_news_impact(recent_news or [])
    news_bias_score = news_impact.get("news_bias_score", 0)
    bias_pct += news_bias_score * 0.3  # high-impact news can shift bias up to ±0.3%
    # Widen range if there are bearish alerts (uncertainty increases)
    bearish_alert_count = len(news_impact.get("bearish_alerts", []))
    bullish_alert_count = len(news_impact.get("bullish_alerts", []))

    # ATR% — wider ATR → widen the range; also widen on news alerts
    atr_pct = tech_indicators.get("atr_pct", 1.5)
    range_multiplier = max(0.8, min(2.0, atr_pct / 1.5 + bearish_alert_count * 0.15))

    # ── Build range ──────────────────────────────────────────────────────────
    adjusted_sd = one_sd * range_multiplier
    base = round(current_price * (1 + bias_pct / 100), 2)
    low  = round(base - adjusted_sd, 2)
    high = round(base + adjusted_sd, 2)

    # Confidence 0-100 based on number of agreeing signals
    signals_bullish = sum([
        bias_pct > 0.1,
        (rsi or 50) < 60,
        (macd or 0) > 0,
        global_factors.get("global_bias") == "bullish",
        bullish_alert_count > 0,
    ])
    signals_bearish = sum([
        bias_pct < -0.1,
        (rsi or 50) > 65,
        (macd or 0) < 0,
        global_factors.get("global_bias") == "bearish",
        bearish_alert_count > 0,
    ])
    signal_agreement = abs(signals_bullish - signals_bearish)
    confidence = min(85, 50 + signal_agreement * 10)

    direction = "bullish" if bias_pct > 0.05 else "bearish" if bias_pct < -0.05 else "neutral"

    # ── Plain-English summary ─────────────────────────────────────────────────
    range_pct = round((adjusted_sd / current_price) * 100 * 2, 1)  # full range as % of price
    cmp_vs_base = round(current_price - base, 1)
    cmp_position = (
        "already at the predicted base" if abs(cmp_vs_base) < adjusted_sd * 0.1
        else f"₹{abs(cmp_vs_base):.0f} {'below' if cmp_vs_base < 0 else 'above'} the predicted base"
    )

    # Direction sentence
    if direction == "bullish":
        dir_sentence = f"All signals lean {'strongly' if confidence >= 70 else 'mildly'} bullish."
    elif direction == "bearish":
        dir_sentence = f"Signals lean {'strongly' if confidence >= 70 else 'mildly'} bearish — caution advised."
    else:
        dir_sentence = "Signals are mixed — no strong directional call."

    # Key driver
    drivers = []
    if (rsi or 50) > 70:
        drivers.append("RSI is overbought — pullback risk")
    elif (rsi or 50) < 35:
        drivers.append("RSI is oversold — bounce likely")
    if (macd or 0) > 0:
        drivers.append("MACD momentum is positive")
    else:
        drivers.append("MACD momentum is negative")
    if (gift_gap or 0) > 50:
        drivers.append(f"GIFT Nifty gap of +{gift_gap:.0f} pts suggests a positive open")
    elif (gift_gap or 0) < -50:
        drivers.append(f"GIFT Nifty gap of {gift_gap:.0f} pts signals a weak open")
    if (global_factors.get("vix") or 20) > 25:
        drivers.append("elevated VIX signals market anxiety")
    if (global_factors.get("crude_chg_pct") or 0) > 2:
        drivers.append("rising crude is a headwind for India")
    elif (global_factors.get("crude_chg_pct") or 0) < -2:
        drivers.append("falling crude is positive for India")
    if (global_factors.get("sp500_chg_pct") or 0) > 1:
        drivers.append("strong US markets provide global tailwind")
    elif (global_factors.get("sp500_chg_pct") or 0) < -1:
        drivers.append("weak US markets are a headwind")

    driver_sentence = f"{drivers[0][0].upper() + drivers[0][1:]}." if drivers else ""

    # Range tightness
    if range_pct < 2:
        volatility_note = f"The range is tight ({range_pct}%), meaning low expected volatility for the session."
    elif range_pct > 4:
        volatility_note = f"The range is wide ({range_pct}%), reflecting elevated volatility expectations."
    else:
        volatility_note = f"The range spans {range_pct}% — moderate volatility expected."

    # ── News alert sentences ──────────────────────────────────────────────────
    news_sentences = []
    top_alert = news_impact.get("top_alert")
    if top_alert:
        h = top_alert["headline"][:80] + ("…" if len(top_alert["headline"]) > 80 else "")
        if top_alert["type"] == "bearish":
            news_sentences.append(f"⚠ High-impact news: \"{h}\" — this may cause sharp downside volatility.")
        else:
            news_sentences.append(f"✦ Positive news: \"{h}\" — could provide upside catalyst.")
    # Extra bearish alerts beyond the top one
    for alert in news_impact.get("bearish_alerts", [])[1:2]:
        h = alert["headline"][:70] + "…"
        news_sentences.append(f"⚠ Also watch: \"{h}\"")

    news_paragraph = " ".join(news_sentences)

    plain_english = (
        f"{dir_sentence} "
        f"CMP ₹{current_price:,.1f} is {cmp_position}. "
        f"Upside target ₹{high:,.0f}, downside support ₹{low:,.0f}. "
        f"{driver_sentence} "
        f"{volatility_note}"
        + (f" {news_paragraph}" if news_paragraph else "")
    ).strip()

    return {
        "low":           low,
        "base":          base,
        "high":          high,
        "current_price": current_price,
        "bias_pct":      round(bias_pct, 3),
        "direction":     direction,
        "confidence":    confidence,
        "iv_used":       round(iv, 1),
        "one_sd_pts":    round(adjusted_sd, 2),
        "plain_english": plain_english,
        "news_alerts":   news_impact.get("bearish_alerts", []) + news_impact.get("bullish_alerts", []),
        "factors": {
            "overall_score":     overall,
            "rsi":               round(rsi, 1) if rsi else None,
            "macd_direction":    "bullish" if (macd or 0) > 0 else "bearish",
            "global_bias":       global_factors.get("global_bias"),
            "gift_nifty_gap":    gift_gap,
            "sp500_chg_pct":     global_factors.get("sp500_chg_pct"),
            "vix":               global_factors.get("vix"),
            "crude_chg_pct":     global_factors.get("crude_chg_pct"),
        },
    }


def _get_llm_commentary(symbol: str, company_name: str, pred: dict) -> Optional[str]:
    """1-line LLM commentary on the prediction."""
    try:
        from ai.llm_client import call_llm, is_configured
        if not is_configured():
            return None
        p = pred
        prompt = (
            f"For {company_name} ({symbol}), next session prediction:\n"
            f"  Bias: {p['direction']} ({p['bias_pct']:+.2f}%)\n"
            f"  Range: ₹{p['low']} – ₹{p['high']} (base ₹{p['base']})\n"
            f"  Key factors: Overall score {p['factors']['overall_score']}/100, "
            f"RSI {p['factors']['rsi']}, Global {p['factors']['global_bias']}, "
            f"GIFT Nifty gap {p['factors']['gift_nifty_gap']}\n\n"
            f"Write ONE short sentence (max 15 words) explaining the key driver for this prediction. "
            f"Be specific. No preamble."
        )
        return call_llm(prompt, system="You are a concise stock analyst.", max_tokens=60)
    except Exception:
        return None


# ─── Accuracy filling (called at end of trading day) ─────────────────────────

def fill_actuals(session_date: str) -> int:
    """
    Fill actual close prices for all predictions made for session_date.
    Returns count of predictions updated.
    """
    import yfinance as yf
    with _pred_lock:
        data = _load_predictions()
        preds = data.get("predictions", {})
        updated = 0
        for key, pred in preds.items():
            if pred.get("session_date") != session_date:
                continue
            if pred.get("actual_close") is not None:
                continue
            sym = pred["symbol"]
            try:
                t = yf.Ticker(sym)
                hist = t.history(period="2d")
                if hist.empty:
                    continue
                actual_close = float(hist["Close"].iloc[-1])
                pred["actual_close"] = round(actual_close, 2)

                low  = pred["range"]["low"]
                high = pred["range"]["high"]
                pct_dev = abs(actual_close - pred["range"]["base"]) / pred["range"]["base"] * 100

                if low <= actual_close <= high:
                    pred["accuracy"] = "HIT"
                elif pct_dev <= (pred["range"]["base"] * 0.005 / pred["range"]["base"] * 100 + 0.5):
                    pred["accuracy"] = "NEAR"
                else:
                    pred["accuracy"] = "MISS"
                updated += 1
            except Exception:
                pass
        _save_predictions(data)
    return updated


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/predict/{symbol}")
async def predict_next_session(symbol: str, force: bool = Query(default=False)):
    """
    Generate next-session price range prediction for a stock or index.
    During market hours returns the cached prediction (if exists) or a warning.
    force=true bypasses the market-hours gate (for testing).
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from data.market_data import normalize_symbol, get_info, safe_get
    from engines.recommendation import calculate_full
    from engines.technical_strength import calculate as calc_tech

    sym = normalize_symbol(symbol)
    session_date = _next_trading_date()
    key = _pred_key(sym, session_date)

    # Check cache first (don't recompute if already done for this session)
    with _pred_lock:
        data = _load_predictions()
        existing = data["predictions"].get(key)

    if existing and not force:
        return JSONResponse(content=clean_for_json(existing))

    # Market-hours gate
    if _is_market_hours() and not force:
        return JSONResponse(content={
            "symbol": sym,
            "session_date": session_date,
            "market_hours": True,
            "message": "Predictions are generated outside market hours (before 9:15 AM or after 3:30 PM IST). Check back after market close.",
        })

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=3)

    def build():
        # Full analysis for scores + tech indicators
        result  = calculate_full(sym)
        scores  = {
            "overall":        result.get("overall_score", 50),
            "company_health": result["scores"].get("company_health", 50),
            "technical":      result["scores"].get("technical_strength", 50),
            "growth":         result["scores"].get("growth_trend", 50),
            "macro":          result["scores"].get("macro_environment", 50),
        }
        tech_ind = result.get("technical_indicators") or {}
        current_price = float(result.get("current_price") or 0)
        company_name  = result.get("company_name") or sym

        # Recent news from business_events engine (already fetched inside calculate_full)
        recent_news = result.get("recent_news") or []

        # ATM IV from NSE
        atm_iv = None
        try:
            from api.routes.cc_strategy import _get_atm_iv
            bare = sym.replace(".NS", "").replace("^", "")
            atm_iv = _get_atm_iv(bare)
        except Exception:
            pass

        # Global factors
        gf = _fetch_global_factors()

        # Core prediction — pass news so it affects bias + plain English
        pred_range = _compute_prediction(sym, scores, tech_ind, atm_iv, current_price, gf, recent_news)
        if not pred_range:
            return None

        # LLM commentary
        commentary = _get_llm_commentary(sym, company_name, pred_range)

        record = {
            "symbol":         sym,
            "company_name":   company_name,
            "session_date":   session_date,
            "predicted_at":   datetime.now(IST).isoformat(),
            "range":          pred_range,
            "commentary":     commentary,
            "actual_close":   None,
            "accuracy":       None,
            "market_hours":   False,
        }

        with _pred_lock:
            data = _load_predictions()
            data["predictions"][key] = record
            _save_predictions(data)

        return record

    record = await loop.run_in_executor(executor, build)
    if not record:
        raise HTTPException(status_code=500, detail="Could not compute prediction")

    return JSONResponse(content=clean_for_json(record))


@router.get("/predict/benchmarks/all")
async def predict_benchmarks():
    """Generate next-session predictions for NIFTY 50, Bank Nifty, Sensex."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_event_loop()

    async def get_one(sym):
        from fastapi.testclient import TestClient
        # Re-use the same prediction logic
        return await predict_next_session(sym)

    results = await asyncio.gather(*[predict_next_session(s) for s in BENCHMARK_SYMBOLS], return_exceptions=True)
    out = []
    for sym, r in zip(BENCHMARK_SYMBOLS, results):
        if isinstance(r, Exception):
            out.append({"symbol": sym, "error": str(r)[:60]})
        else:
            try:
                out.append(r.body and json.loads(r.body))
            except Exception:
                pass
    return JSONResponse(content=clean_for_json({"benchmarks": out}))


@router.get("/predict/history/{symbol}")
async def prediction_history(symbol: str, days: int = Query(default=30, le=90)):
    """Return prediction history + accuracy for a symbol."""
    from data.market_data import normalize_symbol
    sym = normalize_symbol(symbol)
    with _pred_lock:
        data = _load_predictions()
    preds = [v for v in data["predictions"].values() if v["symbol"] == sym]
    preds.sort(key=lambda x: x["session_date"], reverse=True)
    preds = preds[:days]

    total   = len([p for p in preds if p.get("accuracy")])
    hits    = len([p for p in preds if p.get("accuracy") == "HIT"])
    nears   = len([p for p in preds if p.get("accuracy") == "NEAR"])
    misses  = len([p for p in preds if p.get("accuracy") == "MISS"])
    hit_rate = round((hits + nears) / total * 100, 1) if total else None

    return JSONResponse(content=clean_for_json({
        "symbol":    sym,
        "total_evaluated": total,
        "hit_rate_pct":    hit_rate,
        "hits":    hits,
        "nears":   nears,
        "misses":  misses,
        "predictions": preds,
    }))


@router.get("/predict/accuracy/all")
async def accuracy_summary():
    """Overall accuracy summary across all tracked symbols."""
    with _pred_lock:
        data = _load_predictions()
    preds = [v for v in data["predictions"].values() if v.get("accuracy")]
    by_sym: dict[str, dict] = {}
    for p in preds:
        s = p["symbol"]
        if s not in by_sym:
            by_sym[s] = {"symbol": s, "name": p.get("company_name", s),
                         "total": 0, "hits": 0, "nears": 0, "misses": 0}
        by_sym[s]["total"] += 1
        acc = p["accuracy"]
        if acc == "HIT":   by_sym[s]["hits"]   += 1
        elif acc == "NEAR": by_sym[s]["nears"]  += 1
        else:              by_sym[s]["misses"] += 1

    rows = []
    for row in by_sym.values():
        t = row["total"]
        row["hit_rate_pct"] = round((row["hits"] + row["nears"]) / t * 100, 1) if t else None
        rows.append(row)
    rows.sort(key=lambda x: (x["hit_rate_pct"] or 0), reverse=True)

    total_all = sum(r["total"] for r in rows)
    hits_all  = sum(r["hits"]  for r in rows)
    nears_all = sum(r["nears"] for r in rows)
    overall_rate = round((hits_all + nears_all) / total_all * 100, 1) if total_all else None

    return JSONResponse(content=clean_for_json({
        "overall_hit_rate_pct": overall_rate,
        "total_predictions":    total_all,
        "by_symbol":            rows,
    }))


@router.post("/predict/fill-actuals")
async def trigger_fill_actuals(session_date: str = Query(default="")):
    """Fill actual close prices for a past session (call after 15:45 IST)."""
    if not session_date:
        session_date = date.today().isoformat()
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_event_loop()
    count = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1),
                                       fill_actuals, session_date)
    return JSONResponse(content={"updated": count, "session_date": session_date})
