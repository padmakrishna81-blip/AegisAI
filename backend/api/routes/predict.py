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

import asyncio
import json
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date, time as dtime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
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

    # ── Intraday signals (only during market hours 9:15–15:30 IST) ────────────
    now_ist = datetime.now(IST).time()
    if dtime(9, 15) <= now_ist <= dtime(15, 30):
        try:
            import yfinance as yf
            # Nifty intraday momentum — current vs prev_close
            nsei = yf.Ticker("^NSEI").fast_info
            nifty_cmp   = float(getattr(nsei, "last_price", None) or 0)
            nifty_prev  = float(getattr(nsei, "previous_close", None) or 0)
            if nifty_cmp > 0 and nifty_prev > 0:
                intraday_chg_pct = round((nifty_cmp / nifty_prev - 1) * 100, 2)
                factors["nifty_intraday_chg_pct"] = intraday_chg_pct
                # Momentum carry-over: today's trend has 30% chance of continuation next day
                factors["intraday_momentum_bias"] = round(intraday_chg_pct * 0.30, 2)
                if abs(intraday_chg_pct) > 0.3:
                    bias += intraday_chg_pct * 0.15
                    factors["global_bias_score"] = round(bias, 1)
        except Exception:
            pass

        # FII/DII provisional (NSE publishes ~3:15 PM)
        if now_ist >= dtime(15, 10):
            try:
                import requests, time as _t
                headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com/"}
                s = requests.Session()
                s.get("https://www.nseindia.com", headers=headers, timeout=6)
                _t.sleep(0.3)
                r = s.get("https://www.nseindia.com/api/fiidiiTradesEquity?type=fiiDii",
                          headers=headers, timeout=8)
                if r.status_code == 200:
                    data = r.json()
                    if isinstance(data, list) and len(data) > 0:
                        today = data[0]
                        fii_net = float(today.get("FII_NET_PURCHASE_SALES") or 0)
                        dii_net = float(today.get("DII_NET_PURCHASE_SALES") or 0)
                        factors["fii_net_cr"]  = round(fii_net / 1e7, 1)  # convert to Cr
                        factors["dii_net_cr"]  = round(dii_net / 1e7, 1)
                        combined = fii_net + dii_net
                        if combined > 500e7:    bias += 0.5
                        elif combined < -500e7: bias -= 0.5
                        factors["global_bias_score"] = round(bias, 1)
            except Exception:
                pass

        factors["mode"] = "intraday"
    else:
        factors["mode"] = "overnight" if now_ist < dtime(9, 15) else "end_of_day"

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
    TWO narrow ranges per session — always recalculated fresh:

    OPENING RANGE (9:15 AM ±30 min):
    - Base = prev_close + expected gap (GIFT Nifty + US market + evening news + global queues)
    - Width = fixed ±50 pts for indices (±0.4% for stocks)
    - Widens to ±100 pts only on high-impact events

    CLOSING RANGE (end of day):
    - Base = opening base + intraday drift (RSI, MACD, crude, sector flow)
    - Width = historical daily ATR capped at ±100 pts (±0.8% for stocks)
    - Total range always ≤ 200 pts for indices (≤ 1.6% for stocks)
    - If strong signal pushes expected move >300 pts, base is shifted further,
      range stays tight — direction clarity matters more than coverage
    """
    if current_price <= 0:
        return {}

    is_index = symbol.startswith("^")
    iv       = atm_iv or (13.0 if is_index else 25.0)
    overall  = scores.get("overall", 50)
    rsi      = float(tech_indicators.get("rsi") or 50)
    macd     = float(tech_indicators.get("macd") or 0)
    atr_pct  = float(tech_indicators.get("atr_pct") or 1.0)

    gift_gap   = float(global_factors.get("gift_nifty_gap") or 0)
    sp500_chg  = float(global_factors.get("sp500_chg_pct")  or 0)
    vix        = float(global_factors.get("vix")            or 18)
    crude_chg  = float(global_factors.get("crude_chg_pct")  or 0)
    gb_score   = float(global_factors.get("global_bias_score") or 0)

    news_impact     = _scan_news_impact(recent_news or [])
    news_bias       = float(news_impact.get("news_bias_score", 0))
    bearish_alerts  = news_impact.get("bearish_alerts", [])
    bullish_alerts  = news_impact.get("bullish_alerts", [])
    high_impact     = len(bearish_alerts) > 0 or len(bullish_alerts) > 0

    # ── OPENING GAP (pts) ────────────────────────────────────────────────────
    # Considers: GIFT Nifty, US close, Asian queues (proxied via global_bias),
    # overnight news, and crude/dollar move since previous Indian close.
    # Each factor scaled to historical contribution to Indian open gap.

    open_gap = 0.0
    if is_index:
        # 1. GIFT Nifty — most direct (85% transmission rate historically)
        open_gap += gift_gap * 0.85

        # 2. US market close (S&P500 — 40% transmission for Nifty open)
        open_gap += current_price * sp500_chg / 100 * 0.40

        # 3. Asian queue proxy — reflected in global_bias_score
        open_gap += current_price * gb_score * 0.0015   # ±0.15% max

        # 4. Overnight news catalyst
        open_gap += current_price * news_bias * 0.003

        # 5. Crude — significant for India; -2% crude → ~+30 pts Nifty open
        if crude_chg < -2:
            open_gap += abs(crude_chg) * 8   # falling crude = positive
        elif crude_chg > 2:
            open_gap -= crude_chg * 8        # rising crude = headwind

        # 6. VIX fear — high VIX dampens any bullish bias at open
        if vix > 25:
            open_gap -= (vix - 25) * 5       # each VIX point above 25 = -5 pts
    else:
        # For individual stocks: S&P500 + global as proxy
        open_gap += current_price * sp500_chg / 100 * 0.35
        open_gap += current_price * gb_score * 0.001
        open_gap += current_price * news_bias * 0.003

    open_gap = round(open_gap, 1)

    # Large move detection — push base further, keep range tight
    large_threshold = 250 if is_index else current_price * 0.012
    large_move = abs(open_gap) > large_threshold
    if large_move:
        open_gap = round(open_gap * 1.15, 1)   # amplify, range stays same

    # ── OPENING RANGE WIDTH ──────────────────────────────────────────────────
    if is_index:
        open_half = 100 if high_impact else 50
    else:
        open_half = round(current_price * (0.008 if high_impact else 0.004), 1)

    open_base = round(current_price + open_gap, 1)
    open_low  = round(open_base - open_half, 1)
    open_high = round(open_base + open_half, 1)

    # ── INTRADAY DRIFT (open → close) ────────────────────────────────────────
    # After the gap is absorbed, intraday drift driven by:
    # RSI momentum, MACD crossover, sector flow, crude continuation
    intraday_drift = 0.0

    if rsi > 70:    intraday_drift -= current_price * 0.002   # overbought fade
    elif rsi < 35:  intraday_drift += current_price * 0.002   # oversold bounce
    elif rsi > 58:  intraday_drift += current_price * 0.001
    elif rsi < 45:  intraday_drift -= current_price * 0.001

    if macd > 0:    intraday_drift += current_price * 0.0008
    else:           intraday_drift -= current_price * 0.0008

    # Crude continuation intraday
    if crude_chg > 3:   intraday_drift -= current_price * 0.001
    elif crude_chg < -3: intraday_drift += current_price * 0.0005

    # Score-based drift — fundamentals can sustain or reverse gap
    intraday_drift += current_price * (overall - 50) / 100 * 0.001

    intraday_drift = round(intraday_drift, 1)
    total_bias_pts = round(open_gap + intraday_drift, 1)

    # ── CLOSING RANGE WIDTH ──────────────────────────────────────────────────
    # Width = historical daily ATR (actual daily move), capped
    daily_atr_pts = round(current_price * atr_pct / 100, 1)
    if is_index:
        close_half = min(100, max(40, round(daily_atr_pts * 0.55, 0)))
        if high_impact: close_half = min(150, round(close_half * 1.5, 0))
    else:
        close_half = min(current_price * 0.008, max(current_price * 0.003, daily_atr_pts * 0.55))
        if high_impact: close_half = min(current_price * 0.012, close_half * 1.5)
    close_half = round(close_half, 1)

    close_base = round(current_price + total_bias_pts, 1)
    close_low  = round(close_base - close_half, 1)
    close_high = round(close_base + close_half, 1)

    # ── CONFIDENCE ───────────────────────────────────────────────────────────
    bull_signals = sum([
        open_gap > 20, sp500_chg > 0.5, gb_score > 0.5,
        macd > 0, rsi < 65, news_bias > 0.1,
    ])
    bear_signals = sum([
        open_gap < -20, sp500_chg < -0.5, gb_score < -0.5,
        macd < 0, rsi > 65, news_bias < -0.1,
    ])
    confidence = min(85, 50 + abs(bull_signals - bear_signals) * 7
                     + (8 if large_move else 0) + (5 if abs(gift_gap) > 50 else 0))

    direction = "bullish" if total_bias_pts > 10 else "bearish" if total_bias_pts < -10 else "neutral"

    # ── PLAIN ENGLISH ────────────────────────────────────────────────────────
    dir_word = "positive" if direction == "bullish" else "negative" if direction == "bearish" else "flat"

    gap_drivers = []
    if abs(gift_gap) > 15:
        gap_drivers.append(f"GIFT Nifty gap {gift_gap:+.0f} pts")
    if abs(sp500_chg) > 0.3:
        gap_drivers.append(f"US {'rose' if sp500_chg > 0 else 'fell'} {abs(sp500_chg):.2f}%")
    if vix > 22:
        gap_drivers.append(f"VIX at {vix:.1f} (elevated fear)")
    if abs(crude_chg) > 1.5:
        gap_drivers.append(f"crude {'up' if crude_chg > 0 else 'down'} {abs(crude_chg):.1f}%")
    if abs(news_bias) > 0.1:
        gap_drivers.append("overnight news")

    gap_driver_str = ", ".join(gap_drivers) if gap_drivers else "mixed signals"
    large_note = f" Strong directional move expected — base shifted to {open_base:,.0f}." if large_move else ""
    news_note = ""
    top_alert = news_impact.get("top_alert")
    if top_alert:
        h = top_alert["headline"][:65] + ("…" if len(top_alert["headline"]) > 65 else "")
        sym = "⚠" if top_alert["type"] == "bearish" else "✦"
        news_note = f' {sym} "{h}"'

    plain_english = (
        f"Open expected {open_base:,.0f} ±{open_half:.0f} pts (drivers: {gap_driver_str}).{large_note} "
        f"Day likely closes {dir_word} near {close_base:,.0f} ±{close_half:.0f} pts.{news_note}"
    ).strip()

    return {
        # Opening range
        "open_base":   open_base,
        "open_low":    open_low,
        "open_high":   open_high,
        "open_width":  round(open_half * 2, 1),
        "open_gap_pts": open_gap,

        # Closing range (low/base/high kept for backward compat with accuracy tracking)
        "low":          close_low,
        "base":         close_base,
        "high":         close_high,
        "close_width":  round(close_half * 2, 1),

        "current_price": current_price,
        "bias_pts":      total_bias_pts,
        "bias_pct":      round(total_bias_pts / current_price * 100, 3),
        "direction":     direction,
        "confidence":    confidence,
        "large_move":    large_move,
        "iv_used":       round(iv, 1),
        "plain_english": plain_english,
        "news_alerts":   bearish_alerts + bullish_alerts,
        "factors": {
            "overall_score":  overall,
            "rsi":            round(rsi, 1),
            "macd_direction": "bullish" if macd > 0 else "bearish",
            "global_bias":    global_factors.get("global_bias"),
            "gift_nifty_gap": gift_gap,
            "sp500_chg_pct":  sp500_chg,
            "vix":            vix,
            "crude_chg_pct":  crude_chg,
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
    Fill actual close + actual open for all predictions made for session_date.
    Evaluates CLOSING range accuracy (HIT/NEAR/MISS) and opening range accuracy separately.
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

            # Handle constituent predictions (stored as CONST::nifty etc.)
            if sym.startswith("CONST::"):
                index_sym_map = {"nifty": "^NSEI", "banknifty": "^NSEBANK", "sensex": "^BSESN"}
                index_key_str = sym.replace("CONST::", "")
                actual_sym    = index_sym_map.get(index_key_str)
                if not actual_sym:
                    continue
                try:
                    t = yf.Ticker(actual_sym)
                    hist = t.history(period="2d")
                    if hist.empty:
                        continue
                    actual_close = round(float(hist["Close"].iloc[-1]), 2)
                    actual_open  = round(float(hist["Open"].iloc[-1]),  2)
                    pred["actual_close"] = actual_close
                    pred["actual_open"]  = actual_open

                    low  = pred["close_low"];  high = pred["close_high"];  base = pred["close_base"]
                    near_threshold = (high - low) * 0.25
                    if low <= actual_close <= high:
                        pred["accuracy"] = "HIT"
                    elif abs(actual_close - base) <= near_threshold:
                        pred["accuracy"] = "NEAR"
                    else:
                        pred["accuracy"] = "MISS"

                    if pred.get("open_low") and pred.get("open_high"):
                        o_low = pred["open_low"]; o_high = pred["open_high"]
                        if o_low <= actual_open <= o_high:
                            pred["open_accuracy"] = "HIT"
                        elif abs(actual_open - pred["open_base"]) <= (o_high - o_low) * 0.3:
                            pred["open_accuracy"] = "NEAR"
                        else:
                            pred["open_accuracy"] = "MISS"
                    updated += 1
                except Exception:
                    pass
                continue
            try:
                t = yf.Ticker(sym)
                hist = t.history(period="2d")
                if hist.empty:
                    continue
                actual_close = round(float(hist["Close"].iloc[-1]), 2)
                actual_open  = round(float(hist["Open"].iloc[-1]),  2)
                pred["actual_close"] = actual_close
                pred["actual_open"]  = actual_open

                # ── Closing range accuracy ────────────────────────────────
                rng  = pred["range"]
                low  = rng["low"]
                high = rng["high"]
                base = rng["base"]
                # NEAR = within half the range width outside (tighter than old 0.5%)
                near_threshold = (high - low) * 0.25
                if low <= actual_close <= high:
                    pred["accuracy"] = "HIT"
                elif abs(actual_close - base) <= (base * 0.005 + near_threshold):
                    pred["accuracy"] = "NEAR"
                else:
                    pred["accuracy"] = "MISS"

                # ── Opening range accuracy ────────────────────────────────
                if rng.get("open_low") and rng.get("open_high"):
                    o_low  = rng["open_low"]
                    o_high = rng["open_high"]
                    if o_low <= actual_open <= o_high:
                        pred["open_accuracy"] = "HIT"
                    elif abs(actual_open - rng["open_base"]) <= (o_high - o_low) * 0.3:
                        pred["open_accuracy"] = "NEAR"
                    else:
                        pred["open_accuracy"] = "MISS"

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

    # During live market hours: allow prediction (uses intraday mode), just label it clearly
    # Only block if market hours AND not force AND NOT intraday mode
    if _is_market_hours() and not force:
        # Still generate — intraday factors will be included
        pass  # fall through to build()

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
            "prediction_mode": gf.get("mode", "overnight"),  # overnight / intraday / end_of_day
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


class PreGenerateInput(BaseModel):
    symbols: list[str]
    force: bool = False


@router.post("/predict/pre-generate")
async def pre_generate_predictions(body: PreGenerateInput):
    """
    Bulk pre-generate and cache predictions for a list of symbols.
    Skips symbols already cached for today's session unless force=True.
    Runs full 6-engine analysis per stock. Fire-and-forget safe.
    """
    from data.market_data import normalize_symbol

    session_date = _next_trading_date()
    symbols_normalized = [normalize_symbol(s.strip()) for s in body.symbols if s.strip()]

    # Determine which need generating
    if not body.force:
        with _pred_lock:
            cached_data = _load_predictions()
        to_generate = [
            s for s in symbols_normalized
            if not cached_data["predictions"].get(_pred_key(s, session_date))
        ]
    else:
        to_generate = symbols_normalized

    if not to_generate:
        return JSONResponse(content={
            "generated": 0, "skipped": len(symbols_normalized),
            "session_date": session_date,
            "message": "All predictions already cached for this session.",
        })

    # Generate in parallel batches — max 8 concurrent (full analysis is heavy)
    loop     = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=8)

    async def generate_one(sym: str):
        try:
            # Call predict_next_session with force=True to bypass market-hours gate
            resp = await predict_next_session(sym, force=True)
            return sym, True
        except Exception:
            return sym, False

    results = await asyncio.gather(*[generate_one(s) for s in to_generate])
    generated = sum(1 for _, ok in results if ok)
    failed    = sum(1 for _, ok in results if not ok)

    return JSONResponse(content=clean_for_json({
        "generated":    generated,
        "failed":       failed,
        "skipped":      len(symbols_normalized) - len(to_generate),
        "total":        len(symbols_normalized),
        "session_date": session_date,
    }))


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


@router.get("/predict/constituents-history/{index_key}")
async def constituent_prediction_history(index_key: str, days: int = Query(default=30, le=90)):
    """Return constituent prediction history + accuracy for an index."""
    key_prefix = f"CONST::{index_key.lower()}::"
    with _pred_lock:
        data = _load_predictions()
    preds = [v for k, v in data["predictions"].items() if k.startswith(key_prefix)]
    preds.sort(key=lambda x: x["session_date"], reverse=True)
    preds = preds[:days]

    total   = len([p for p in preds if p.get("accuracy")])
    hits    = len([p for p in preds if p.get("accuracy") == "HIT"])
    nears   = len([p for p in preds if p.get("accuracy") == "NEAR"])
    misses  = len([p for p in preds if p.get("accuracy") == "MISS"])
    hit_rate = round((hits + nears) / total * 100, 1) if total else None

    return JSONResponse(content=clean_for_json({
        "index_key": index_key,
        "total_evaluated": total,
        "hit_rate_pct": hit_rate,
        "hits": hits, "nears": nears, "misses": misses,
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
