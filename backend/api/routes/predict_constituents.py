"""
Constituent-based index prediction.

Predicts Nifty 50 / Bank Nifty / Sensex range by:
1. Running a quick per-stock predictor on the top 15 constituents by weight
2. Weighting each stock's predicted move by its index weight
3. Aggregating to get an index-level predicted range

This is a bottom-up approach vs the top-down macro prediction.
Both run in parallel — compare accuracy over time.
"""

import asyncio
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from api.utils import clean_for_json

router = APIRouter()

IST = timezone(timedelta(hours=5, minutes=30))

# ── Index constituent weights (NSE official, July 2026) ───────────────────────
# Format: symbol → weight_pct
# Source: NSE index fact sheets. Updated ~every 6 months.

NIFTY50_WEIGHTS: dict[str, float] = {
    "RELIANCE.NS":   10.1, "HDFCBANK.NS":    8.2, "ICICIBANK.NS":   7.5,
    "INFY.NS":        6.0, "TCS.NS":         5.2, "BHARTIARTL.NS":  4.3,
    "KOTAKBANK.NS":   3.8, "SBIN.NS":        3.2, "ITC.NS":         3.0,
    "LT.NS":          2.8, "AXISBANK.NS":    2.6, "BAJFINANCE.NS":  2.5,
    "HCLTECH.NS":     2.3, "MARUTI.NS":      2.1, "SUNPHARMA.NS":   1.9,
    # Remaining 35 stocks
    "HINDUNILVR.NS":  1.8, "M&M.NS":         1.8, "BAJAJFINSV.NS":  1.8,
    "TMPV.NS":  1.5, "ONGC.NS":        1.5, "ADANIPORTS.NS":  1.5,
    "WIPRO.NS":       1.2, "BAJAJ-AUTO.NS":  1.2, "CIPLA.NS":       1.2,
    "DRREDDY.NS":     1.2, "NTPC.NS":        1.3, "COALINDIA.NS":   1.3,
    "TITAN.NS":       1.3, "POWERGRID.NS":   1.1, "HINDALCO.NS":    1.1,
    "ULTRACEMCO.NS":  1.1, "ETERNAL.NS":     1.1, "GRASIM.NS":      1.0,
    "INDUSINDBK.NS":  1.0, "JSWSTEEL.NS":    1.0, "APOLLOHOSP.NS":  1.0,
    "EICHERMOT.NS":   1.0, "DIVISLAB.NS":    0.9, "HDFCLIFE.NS":    0.9,
    "SBILIFE.NS":     0.9, "HEROMOTOCO.NS":  0.9, "TECHM.NS":       0.9,
    "ASIANPAINT.NS":  1.4, "ADANIENT.NS":    0.9, "NESTLEIND.NS":   0.8,
    "BRITANNIA.NS":   0.8, "TATACONSUM.NS":  0.8, "TATASTEEL.NS":   1.0,
    "BEL.NS":         0.7, "BPCL.NS":        1.0,
}  # ~100% coverage — all 50 Nifty stocks

BANKNIFTY_WEIGHTS: dict[str, float] = {
    "HDFCBANK.NS":    27.5, "ICICIBANK.NS":   23.8, "KOTAKBANK.NS":   13.5,
    "SBIN.NS":        10.2, "AXISBANK.NS":     9.8, "INDUSINDBK.NS":   4.6,
    "BANDHANBNK.NS":   2.8, "FEDERALBNK.NS":   2.5, "IDFCFIRSTB.NS":   2.3,
    "AUBANK.NS":       1.2, "PNB.NS":           0.9, "BANKBARODA.NS":   0.9,
}  # 100% — all 12 Bank Nifty stocks

SENSEX_WEIGHTS: dict[str, float] = {
    "RELIANCE.NS":   11.2, "HDFCBANK.NS":    9.5, "ICICIBANK.NS":   8.8,
    "INFY.NS":        7.2, "TCS.NS":         6.1, "BHARTIARTL.NS":  5.0,
    "KOTAKBANK.NS":   4.2, "ITC.NS":         3.6, "SBIN.NS":        3.4,
    "LT.NS":          3.1, "AXISBANK.NS":    3.0, "BAJFINANCE.NS":  2.9,
    "HCLTECH.NS":     2.6, "MARUTI.NS":      2.3, "SUNPHARMA.NS":   2.1,
    # Remaining 15 stocks
    "WIPRO.NS":       1.5, "M&M.NS":         1.8, "NESTLEIND.NS":   1.2,
    "TECHM.NS":       1.3, "BAJAJFINSV.NS":  1.6, "NTPC.NS":        1.2,
    "POWERGRID.NS":   1.1, "INDUSINDBK.NS":  1.0, "ASIANPAINT.NS":  1.4,
    "HINDUNILVR.NS":  1.8, "TMPV.NS":  1.3, "TATACONSUM.NS":  0.9,
    "ADANIPORTS.NS":  1.1, "TITAN.NS":       1.2, "ULTRACEMCO.NS":  1.1,
}  # ~100% coverage — all 30 Sensex stocks

INDEX_NAMES = {
    "nifty":     "NIFTY 50",
    "banknifty": "Bank Nifty",
    "sensex":    "Sensex",
}

INDEX_BASE_SYMBOLS = {
    "nifty":     "^NSEI",
    "banknifty": "^NSEBANK",
    "sensex":    "^BSESN",
}


def _normalize(d: dict) -> dict:
    total = sum(d.values())
    return {k: round(v / total * 100, 2) for k, v in d.items()} if total else d

NIFTY50_WEIGHTS  = _normalize(NIFTY50_WEIGHTS)
SENSEX_WEIGHTS   = _normalize(SENSEX_WEIGHTS)
# BankNifty already sums to 100

# INDEX_WEIGHTS defined AFTER normalization so it references the corrected dicts
INDEX_WEIGHTS = {
    "nifty":     NIFTY50_WEIGHTS,
    "banknifty": BANKNIFTY_WEIGHTS,
    "sensex":    SENSEX_WEIGHTS,
}


def _lock_import():
    """Return a no-op context manager — predictions.json reads are already lock-safe via _pred_lock."""
    import contextlib
    return contextlib.nullcontext()


# ── Earnings intelligence ─────────────────────────────────────────────────────

def _get_earnings_bias(symbol: str, bare: str) -> dict:
    """
    Returns earnings-based bias for a stock:
    - If results announced recently (≤3 days): compute actual vs analyst expectation surprise
    - If results due soon (1–7 days): flag as event risk, note analyst consensus
    - Market reaction logic: strong beat doesn't always mean up (already priced in),
      and miss doesn't always mean down (guidance may be strong).

    Returns:
        bias_pct:      float  — additional % bias from earnings
        event_label:   str    — human-readable event description
        event_type:    str    — 'announced_beat' | 'announced_miss' | 'announced_inline'
                                | 'upcoming' | 'none'
        confidence_adj: float — multiplier on prediction confidence (0.7–1.2)
        detail:        str    — explanation for plain English
    """
    import yfinance as yf
    from datetime import date, datetime, timedelta

    result = {
        "bias_pct": 0.0,
        "event_label": "",
        "event_type": "none",
        "confidence_adj": 1.0,
        "detail": "",
    }

    try:
        t    = yf.Ticker(symbol)
        info = t.info or {}
        cal  = t.calendar or {}

        today = date.today()

        # ── Step 1: Get earnings date ─────────────────────────────────────────
        earn_dates = cal.get("Earnings Date", [])
        if not earn_dates:
            return result
        if not isinstance(earn_dates, list):
            earn_dates = [earn_dates]
        earn_date = earn_dates[0] if earn_dates else None
        if earn_date is None:
            return result

        if hasattr(earn_date, 'date'):
            earn_date = earn_date.date()

        days_to_results = (earn_date - today).days

        # ── Step 2: Results already announced (0 to -3 days) ─────────────────
        if -3 <= days_to_results <= 0:
            # Results announced. Get actual vs estimate.
            # EPS estimate from calendar
            est_low  = cal.get("Earnings Low")
            est_avg  = cal.get("Earnings Average")
            est_high = cal.get("Earnings High")

            # Actual EPS — use quarterly income stmt
            actual_eps = None
            actual_net_income = None
            try:
                inc = t.quarterly_income_stmt
                if inc is not None and not inc.empty:
                    ni_rows = [idx for idx in inc.index if "net income" in str(idx).lower()]
                    if ni_rows:
                        ni_series = inc.loc[ni_rows[0]]
                        actual_net_income = float(ni_series.iloc[0])
            except Exception:
                pass

            # yfinance earningsSurprisePercent (if available, already calculated)
            surprise_pct = info.get("earningsSurprisePercent")
            if surprise_pct is not None:
                surprise_pct = float(surprise_pct) * 100   # convert 0.05 → 5%
            elif est_avg and actual_net_income:
                # Approximate: compare net income growth to expected EPS growth
                qoq_growth = info.get("earningsQuarterlyGrowth") or 0
                actual_growth_pct = qoq_growth * 100
                # Estimate expected growth from analyst range
                expected_growth_pct = float(info.get("earningsGrowth") or 0) * 100
                surprise_pct = actual_growth_pct - expected_growth_pct
            else:
                surprise_pct = None

            # Market reaction model:
            # Strong beat (>10%): price already partially priced in, actual move ~40% of beat
            # Moderate beat (5-10%): moderate positive
            # Miss (<-5%): negative but guidance matters too
            # Guidance proxy: revenueGrowth YoY as forward indicator

            rev_growth_yoy = float(info.get("revenueGrowth") or 0) * 100
            earn_growth    = float(info.get("earningsGrowth") or 0) * 100

            if surprise_pct is not None:
                if surprise_pct > 15:
                    # Big beat — "buy the rumor sell the news" risk
                    bias = surprise_pct * 0.10   # only 10% of surprise translates
                    if rev_growth_yoy < 0:
                        bias *= 0.5   # revenue declining despite earnings beat — caution
                    event_type = "announced_beat"
                    detail = f"Strong beat ({surprise_pct:+.1f}%). Bias +{bias:.2f}% (partial — may be priced in)."
                elif surprise_pct > 5:
                    bias = surprise_pct * 0.15
                    event_type = "announced_beat"
                    detail = f"Moderate beat ({surprise_pct:+.1f}%). Bias +{bias:.2f}%."
                elif surprise_pct < -10:
                    bias = surprise_pct * 0.20   # miss hits harder than beat
                    if earn_growth > 0:
                        bias *= 0.7   # still growing YoY, some cushion
                    event_type = "announced_miss"
                    detail = f"Miss ({surprise_pct:+.1f}%). Bias {bias:.2f}%. YoY growth: {earn_growth:+.1f}%."
                elif surprise_pct < -3:
                    bias = surprise_pct * 0.15
                    event_type = "announced_miss"
                    detail = f"Slight miss ({surprise_pct:+.1f}%). Bias {bias:.2f}%."
                else:
                    bias = 0.0
                    event_type = "announced_inline"
                    detail = f"In-line results ({surprise_pct:+.1f}% vs estimates). Minimal bias."

                # Revenue guidance adjustment
                if rev_growth_yoy > 10 and event_type in ("announced_beat", "announced_inline"):
                    bias += 0.10   # strong revenue growth = bullish for next quarter
                    detail += f" Revenue growth {rev_growth_yoy:+.1f}% adds tailwind."
                elif rev_growth_yoy < -5:
                    bias -= 0.15
                    detail += f" Revenue declining {rev_growth_yoy:.1f}% — headwind."

                result["bias_pct"]      = round(bias, 3)
                result["event_type"]    = event_type
                result["event_label"]   = f"Results announced {abs(days_to_results)}d ago"
                result["confidence_adj"] = 1.15   # higher confidence with actual data
                result["detail"]        = detail
            else:
                # No surprise data yet — use growth metrics as proxy
                if earn_growth > 15:
                    result["bias_pct"]   = 0.20
                    result["event_type"] = "announced_beat"
                    result["detail"]     = f"Strong earnings growth {earn_growth:+.1f}% YoY. +0.20% bias."
                elif earn_growth < -10:
                    result["bias_pct"]   = -0.20
                    result["event_type"] = "announced_miss"
                    result["detail"]     = f"Weak earnings growth {earn_growth:+.1f}% YoY. -0.20% bias."
                result["event_label"] = f"Results announced {abs(days_to_results)}d ago"
                result["confidence_adj"] = 1.10

        # ── Step 3: Results due soon (1–7 days) ──────────────────────────────
        elif 1 <= days_to_results <= 7:
            est_avg  = cal.get("Earnings Average")
            est_low  = cal.get("Earnings Low")
            est_high = cal.get("Earnings High")
            earn_growth = float(info.get("earningsGrowth") or 0) * 100

            # Analyst consensus direction
            rec_mean = float(info.get("recommendationMean") or 3.0)

            if earn_growth > 10 and rec_mean < 2.5:
                # Analysts expect strong growth + buy consensus → mild pre-results rally
                result["bias_pct"]   = 0.15
                result["detail"]     = f"Results in {days_to_results}d — analysts expect +{earn_growth:.1f}% growth. Pre-results optimism."
            elif earn_growth < -5:
                result["bias_pct"]   = -0.10
                result["detail"]     = f"Results in {days_to_results}d — analysts expect weak {earn_growth:.1f}% growth. Pre-results caution."
            else:
                result["bias_pct"]   = 0.0
                result["detail"]     = f"Results in {days_to_results}d — neutral expectations."

            result["event_type"]    = "upcoming"
            result["event_label"]   = f"Results in {days_to_results}d"
            result["confidence_adj"] = 0.80   # lower confidence — outcome uncertain, wider range

    except Exception:
        pass

    return result


# ── Global multiplier helpers ─────────────────────────────────────────────────

def _scan_news_impact_for_mult(global_factors: dict) -> dict:
    """Lightweight news scan using global market news (already fetched)."""
    try:
        from api.routes.market import _news_cache
        news = _news_cache.get("data") or []
        bearish = sum(1 for n in news if n.get("sentiment") == "negative")
        bullish = sum(1 for n in news if n.get("sentiment") == "positive")
        geo = any(
            kw in " ".join(n.get("title","") for n in news[:5]).lower()
            for kw in ["war", "invasion", "sanctions", "attack", "geopolit", "conflict", "terror"]
        )
        return {"bearish": bearish, "bullish": bullish, "geopolitical": geo}
    except Exception:
        return {"bearish": 0, "bullish": 0, "geopolitical": False}


def _compute_global_multiplier(gf: dict, ni: dict, extrapolated_pts: float) -> tuple:
    """
    Compute directional global multiplier.
    Bullish factors amplify positive moves; bearish factors dampen them (and vice versa).
    Returns (multiplier_float, factors_dict).
    """
    m = 1.0
    factors = {}

    vix   = float(gf.get("vix")           or 18)
    sp500 = float(gf.get("sp500_chg_pct") or 0)
    crude = float(gf.get("crude_chg_pct") or 0)
    gift  = float(gf.get("gift_nifty_gap") or 0)
    bullish_direction = extrapolated_pts >= 0   # True = we expect an up day

    # ── Fear / volatility ────────────────────────────────────────────────────
    if vix > 30:
        adj = 0.78; factors["vix_high"] = f"VIX {vix:.1f} (extreme fear) × 0.78"
    elif vix > 25:
        adj = 0.88; factors["vix_elevated"] = f"VIX {vix:.1f} (elevated) × 0.88"
    elif vix < 14:
        adj = 1.05; factors["vix_low"] = f"VIX {vix:.1f} (complacency) × 1.05"
    else:
        adj = 1.0
    m *= adj

    # ── US market ────────────────────────────────────────────────────────────
    if sp500 > 1.5:
        adj = 1.08; factors["sp500_strong"] = f"S&P500 +{sp500:.1f}% × 1.08"
    elif sp500 > 0.5:
        adj = 1.03; factors["sp500_up"] = f"S&P500 +{sp500:.1f}% × 1.03"
    elif sp500 < -1.5:
        adj = 0.85; factors["sp500_weak"] = f"S&P500 {sp500:.1f}% × 0.85"
    elif sp500 < -0.5:
        adj = 0.93; factors["sp500_down"] = f"S&P500 {sp500:.1f}% × 0.93"
    else:
        adj = 1.0
    m *= adj

    # ── Crude oil ────────────────────────────────────────────────────────────
    if crude > 3:
        adj = 0.92; factors["crude_spike"] = f"Crude +{crude:.1f}% (headwind) × 0.92"
    elif crude < -3:
        adj = 1.05; factors["crude_fall"] = f"Crude {crude:.1f}% (tailwind) × 1.05"
    else:
        adj = 1.0
    m *= adj

    # ── GIFT Nifty gap strength ───────────────────────────────────────────────
    if abs(gift) > 150:
        adj = 1.08 if (gift > 0) == bullish_direction else 0.92
        factors["gift_strong"] = f"GIFT gap {gift:+.0f} pts (strong signal) × {adj}"
    elif abs(gift) > 80:
        adj = 1.04 if (gift > 0) == bullish_direction else 0.96
        factors["gift_moderate"] = f"GIFT gap {gift:+.0f} pts × {adj}"
    else:
        adj = 1.0
    m *= adj

    # ── News sentiment ────────────────────────────────────────────────────────
    bearish_news = ni.get("bearish", 0)
    bullish_news = ni.get("bullish", 0)
    if bearish_news >= 3:
        adj = 0.82; factors["bearish_news"] = f"{bearish_news} bearish headlines × 0.82"
        m *= adj
    elif bearish_news >= 1:
        adj = 0.92; factors["bearish_news"] = f"{bearish_news} bearish headline(s) × 0.92"
        m *= adj
    if bullish_news >= 3:
        adj = 1.12; factors["bullish_news"] = f"{bullish_news} bullish headlines × 1.12"
        m *= adj
    elif bullish_news >= 1:
        adj = 1.05; factors["bullish_news"] = f"{bullish_news} bullish headline(s) × 1.05"
        m *= adj

    # ── Geopolitical risk ─────────────────────────────────────────────────────
    if ni.get("geopolitical"):
        adj = 0.80; factors["geopolitical"] = "Geopolitical risk detected × 0.80"
        m *= adj

    m = round(max(0.50, min(1.30, m)), 3)
    return m, factors


# ── Quick per-stock predictor ─────────────────────────────────────────────────

def _quick_predict_stock(symbol: str, global_factors: dict, results_calendar: list) -> dict:
    """
    Fast single-stock prediction using fast_info + ATM IV + news + events.
    No full 6-engine analysis — designed to run in ~1s per stock.
    Returns predicted move in % with reasoning.
    """
    import yfinance as yf
    import time as _t

    bare = symbol.replace(".NS", "")
    try:
        t  = yf.Ticker(symbol)
        fi = t.fast_info
        cmp        = float(getattr(fi, "last_price", None) or 0)
        prev_close = float(getattr(fi, "previous_close", None) or 0)
        year_high  = float(getattr(fi, "year_high", None) or cmp)
        year_low   = float(getattr(fi, "year_low",  None) or cmp)

        if cmp <= 0:
            return {"symbol": bare, "error": "no price"}

        # Prev day change
        prev_chg_pct = round((cmp / prev_close - 1) * 100, 2) if prev_close > 0 else 0

        # 52W position — stocks near highs tend to consolidate, near lows tend to bounce
        pct_from_high = round((cmp / year_high - 1) * 100, 1) if year_high > 0 else 0
        pct_from_low  = round((cmp / year_low  - 1) * 100, 1) if year_low  > 0 else 0

        # Quick technicals: RSI, MACD, Volume, 200DMA via 10-day history
        hist10 = t.history(period="20d")
        rsi_proxy    = 50.0
        macd_signal  = "neutral"
        vol_signal   = "normal"
        dma_signal   = "neutral"
        above_200dma = False

        if not hist10.empty and len(hist10) >= 10:
            closes = hist10["Close"].tolist()
            vols   = hist10["Volume"].tolist()

            # RSI (10-period proxy)
            gains  = [max(0, closes[i] - closes[i-1]) for i in range(1, len(closes))]
            losses = [max(0, closes[i-1] - closes[i]) for i in range(1, len(closes))]
            avg_g  = sum(gains[-10:]) / 10 if gains  else 0.01
            avg_l  = sum(losses[-10:])/ 10 if losses else 0.01
            rsi_proxy = round(100 - (100 / (1 + avg_g / max(avg_l, 0.01))), 1)

            # MACD proxy (EMA5 vs EMA10)
            import statistics
            if len(closes) >= 10:
                def ema(data, n):
                    k = 2/(n+1); e = data[0]
                    for v in data[1:]: e = v*k + e*(1-k)
                    return e
                ema5  = ema(closes[-10:], 5)
                ema10 = ema(closes[-10:], 10)
                macd_signal = "bullish" if ema5 > ema10 else "bearish"

            # Volume signal (today vs 5-day avg)
            if len(vols) >= 6:
                recent_vol = vols[-1] or 0
                avg_vol    = sum(v for v in vols[-6:-1] if v) / 5 if vols[-6:-1] else 0
                if avg_vol > 0:
                    vol_ratio = recent_vol / avg_vol
                    if vol_ratio > 1.5:
                        vol_signal = "high"    # high volume confirms move
                    elif vol_ratio < 0.6:
                        vol_signal = "low"     # low volume = weak conviction

            # 200 DMA proxy (use 20-day as proxy — faster to compute)
            if len(closes) >= 20:
                dma20 = sum(closes[-20:]) / 20
                above_200dma = closes[-1] > dma20
                dma_signal = "above" if above_200dma else "below"

        # FII sensitivity (sector-based heuristic — FII flows heavily into banking/IT/FMCG)
        sector_lower = ""
        try:
            if not hist10.empty:
                info_q = t.info
                sector_lower = (info_q.get("sector") or "").lower()
                earn_surprise = float(info_q.get("earningsSurprisePercent") or 0)  # already a fraction e.g. 0.08 = 8%
                info = info_q
            else:
                earn_surprise = 0
                info = {}
        except Exception:
            earn_surprise = 0
            info = {}

        fii_sensitivity = (
            "high"   if any(s in sector_lower for s in ["bank", "financial", "technology", "information"]) else
            "medium" if any(s in sector_lower for s in ["consumer", "pharma", "energy", "auto"]) else
            "low"
        )

        # ── Build bias for this stock ────────────────────────────────────────
        bias_pct = 0.0

        # 1. Global factor contribution (sector-adjusted)
        sector = sector_lower or (info.get("sector", "").lower() if info else "")
        sp500  = global_factors.get("sp500_chg_pct") or 0
        gift   = global_factors.get("gift_nifty_gap") or 0
        vix    = global_factors.get("vix") or 18
        crude  = global_factors.get("crude_chg_pct") or 0

        # Pre-compute gift% relative to index (not stock price)
        index_ref = 24000
        gift_pct_of_index = (gift / index_ref) * 100  # e.g. +50 pts = +0.21%

        # Sector-specific global sensitivity
        if "technology" in sector or "information" in sector:
            bias_pct += sp500 * 0.50
        elif "bank" in sector or "financial" in sector:
            bias_pct += sp500 * 0.30
            bias_pct += gift_pct_of_index * 0.50   # banking extra sensitive
        elif "energy" in sector or "oil" in sector:
            bias_pct += crude * 0.40
        elif "consumer" in sector:
            bias_pct += sp500 * 0.20
        else:
            bias_pct += sp500 * 0.25

        # 2. Index gap (GIFT Nifty) — all stocks get base transmission
        bias_pct += gift_pct_of_index * 0.60

        # 3. VIX fear
        if vix > 25:
            bias_pct -= (vix - 25) * 0.03

        # 4. Earnings intelligence — actual vs analyst expectation + event risk
        earnings_data = _get_earnings_bias(symbol, bare)
        bias_pct      += earnings_data["bias_pct"]
        event_impact   = earnings_data["event_label"]
        event_warning  = earnings_data["event_type"] in ("upcoming", "announced_miss")
        event_type     = earnings_data["event_type"]
        earnings_detail = earnings_data["detail"]
        # Adjust range based on event: upcoming results = wider range
        if earnings_data["event_type"] == "upcoming":
            open_half_override  = round(cmp * 0.020, 1)
            close_half_override = round(cmp * 0.035, 1)
        elif earnings_data["event_type"] in ("announced_beat", "announced_miss"):
            open_half_override  = round(cmp * 0.015, 1)
            close_half_override = round(cmp * 0.025, 1)
        else:
            open_half_override  = None
            close_half_override = None

        # 5. MACD momentum signal
        if macd_signal == "bullish":  bias_pct += 0.10
        elif macd_signal == "bearish": bias_pct -= 0.10

        # 6. Volume confirmation — high volume amplifies the directional move
        if vol_signal == "high":
            bias_pct *= 1.15
        elif vol_signal == "low":
            bias_pct *= 0.80

        # 7. DMA position
        if dma_signal == "above":  bias_pct += 0.05
        elif dma_signal == "below": bias_pct -= 0.08

        # 8. FII sensitivity × global bias
        gb = global_factors.get("global_bias_score") or 0
        fii_mult = {"high": 0.12, "medium": 0.07, "low": 0.03}.get(fii_sensitivity, 0.05)
        bias_pct += gb * fii_mult

        # 9. ATR-based range (unless overridden by earnings event)
        if open_half_override:
            open_half  = open_half_override
            close_half = close_half_override
        else:
            atr_pct = 1.5
            if not hist10.empty and len(hist10) >= 3:
                hi = hist10["High"].tolist()
                lo = hist10["Low"].tolist()
                cl = hist10["Close"].tolist()
                trs = [max(hi[i]-lo[i], abs(hi[i]-cl[i-1]), abs(lo[i]-cl[i-1])) for i in range(1, len(cl))]
                atr_pct = round(sum(trs[-3:]) / 3 / cmp * 100, 2) if trs else 1.5
            open_half  = round(cmp * min(0.008, atr_pct / 100 * 0.4), 1)
            close_half = round(cmp * min(0.012, atr_pct / 100 * 0.6), 1)

        # 10. RSI extremes
        if rsi_proxy > 72:   bias_pct -= 0.30
        elif rsi_proxy < 32: bias_pct += 0.30

        bias_pct = round(bias_pct, 3)

        # ── Build ranges ──────────────────────────────────────────────────────
        open_base  = round(cmp * (1 + bias_pct * 0.7 / 100), 2)
        close_base = round(cmp * (1 + bias_pct / 100), 2)

        open_low   = round(open_base  - open_half,  2)
        open_high  = round(open_base  + open_half,  2)
        close_low  = round(close_base - close_half, 2)
        close_high = round(close_base + close_half, 2)

        predicted_move_pct = round(bias_pct, 3)

        direction = "bullish" if bias_pct > 0.05 else "bearish" if bias_pct < -0.05 else "neutral"

        return {
            "symbol":       bare,
            "cmp":          round(cmp, 2),
            "prev_close":   round(prev_close, 2) if prev_close else None,
            "prev_chg_pct": prev_chg_pct,
            "predicted_move_pct": predicted_move_pct,
            "predicted_move_pts": round(cmp * bias_pct / 100, 2),
            "open_base":    open_base,
            "open_low":     open_low,
            "open_high":    open_high,
            "close_base":   close_base,
            "close_low":    close_low,
            "close_high":   close_high,
            "direction":    direction,
            "rsi_proxy":    round(rsi_proxy, 1),
            "pct_from_high": pct_from_high,
            "upcoming_event":  event_impact,
            "event_warning":   event_warning,
            "event_type":      event_type,
            "earnings_detail": earnings_detail,
            "earn_surprise":   round(earnings_data.get("bias_pct", 0) * 100, 1),
            "macd_signal":    macd_signal,
            "volume_signal":  vol_signal,
            "dma_signal":     dma_signal,
            "fii_sensitivity": fii_sensitivity,
            "above_200dma":   above_200dma,
        }
    except Exception as e:
        return {"symbol": bare, "error": str(e)[:60]}


# ── Main constituent prediction endpoint ──────────────────────────────────────

@router.get("/predict/constituents/{index_key}")
async def predict_by_constituents(index_key: str):
    """
    Bottom-up index prediction using top 15 constituents by weight.
    Each stock gets a quick prediction, weighted contribution aggregated to index range.
    """
    weights = INDEX_WEIGHTS.get(index_key.lower())
    if not weights:
        return JSONResponse(content={"error": f"Unknown index '{index_key}'. Use: nifty, banknifty, sensex"}, status_code=400)

    index_name   = INDEX_NAMES[index_key.lower()]
    index_symbol = INDEX_BASE_SYMBOLS[index_key.lower()]

    # Fetch index current price — fast_info first, history fallback
    import yfinance as yf
    try:
        idx_fi    = yf.Ticker(index_symbol).fast_info
        index_cmp = float(getattr(idx_fi, "last_price", None) or 0)
        if index_cmp <= 0:
            # fast_info returned 0 — fall back to history
            hist = yf.Ticker(index_symbol).history(period="2d")
            if not hist.empty:
                index_cmp = float(hist["Close"].iloc[-1])
    except Exception:
        index_cmp = 0

    if index_cmp <= 0:
        # Last resort: use previous close from global_factors if available
        # or return error
        return JSONResponse(content={"error": f"Could not fetch live price for {index_symbol}"}, status_code=503)

    # Fetch global factors (same as top-down)
    loop     = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=16)

    from api.routes.predict import _fetch_global_factors, _load_predictions, _pred_key, _next_trading_date
    global_factors = await loop.run_in_executor(executor, _fetch_global_factors)

    # Load cached full predictions — use them if available, fall back to quick calc
    session_date = _next_trading_date()
    with _lock_import():
        cached_preds = _load_predictions()["predictions"]

    # Fetch results calendar for event detection (only needed for quick-calc fallback)
    try:
        from api.routes.market import _fetch_results_calendar
        results_calendar = _fetch_results_calendar()
    except Exception:
        results_calendar = []

    # For each constituent: use cached full prediction if exists, else quick calc
    stocks = list(weights.keys())

    def predict_one(sym):
        bare = sym.replace(".NS", "")
        # Check predictions.json for a full prediction for this session
        cached = cached_preds.get(_pred_key(sym, session_date))
        if cached and not cached.get("market_hours") and cached.get("range"):
            r = cached["range"]
            cmp = r.get("current_price", 0)
            bias_pts = r.get("bias_pts", 0) or 0
            bias_pct = (bias_pts / cmp * 100) if cmp else 0

            # Run earnings intelligence even for cached predictions (fast, calendar-only)
            earn_data = _get_earnings_bias(sym, bare)
            # Add earnings bias on top of cached bias
            earnings_bias_pts = round(cmp * earn_data["bias_pct"] / 100, 2) if cmp else 0
            total_bias_pts    = round(bias_pts + earnings_bias_pts, 2)
            total_bias_pct    = round((total_bias_pts / cmp * 100), 3) if cmp else bias_pct

            return sym, {
                "symbol":              bare,
                "cmp":                 cmp,
                "prev_close":          None,
                "prev_chg_pct":        None,
                "predicted_move_pct":  total_bias_pct,
                "predicted_move_pts":  total_bias_pts,
                "open_base":           r.get("open_base"),
                "open_low":            r.get("open_low"),
                "open_high":           r.get("open_high"),
                "close_base":          r.get("base"),
                "close_low":           r.get("low"),
                "close_high":          r.get("high"),
                "direction":           r.get("direction", "neutral"),
                "rsi_proxy":           (r.get("factors") or {}).get("rsi") or 50,
                "pct_from_high":       None,
                "upcoming_event":      earn_data["event_label"],
                "event_warning":       earn_data["event_type"] in ("upcoming", "announced_miss"),
                "event_type":          earn_data["event_type"],
                "earnings_detail":     earn_data["detail"],
                "earn_surprise":       round(earn_data["bias_pct"] * 100, 1),
                "macd_signal":         (r.get("factors") or {}).get("macd_direction") or "neutral",
                "volume_signal":       "normal",
                "dma_signal":          "neutral",
                "fii_sensitivity":     "medium",
                "above_200dma":        False,
                "source":              "full_prediction",
            }
        # Fall back to quick calculation
        result = _quick_predict_stock(sym, global_factors, results_calendar)
        result["source"] = "quick_calc"
        return sym, result

    raw_results = await asyncio.gather(*[
        loop.run_in_executor(executor, predict_one, sym)
        for sym in stocks
    ])

    # Build constituent rows with weighted contribution
    total_weight   = sum(weights.values())
    constituents   = []
    weighted_open_move  = 0.0
    weighted_close_move = 0.0
    error_weight        = 0.0
    event_warnings      = []

    for sym, pred in raw_results:
        w = weights.get(sym, 0)
        if pred.get("error"):
            error_weight += w
            continue

        move_pct = pred.get("predicted_move_pct", 0)
        # Contribution to index = index_cmp × (weight%) × (move%)
        contribution_pts     = round(index_cmp * (w / 100) * (move_pct / 100), 1) if index_cmp else 0
        contribution_pct_idx = round((w / 100) * (move_pct / 100) * 100, 4)  # % of index move

        if pred.get("event_warning"):
            event_warnings.append(f"{pred['symbol']}: {pred['upcoming_event']}")

        constituents.append({
            "symbol":                pred["symbol"],
            "weight_pct":            round(w, 1),
            "cmp":                   pred.get("cmp"),
            "predicted_move_pct":    pred.get("predicted_move_pct"),
            "predicted_move_pts":    pred.get("predicted_move_pts"),
            "contribution_pts":      contribution_pts,
            "contribution_pct_idx":  contribution_pct_idx,
            "direction":             pred.get("direction"),
            "open_low":              pred.get("open_low"),
            "open_base":             pred.get("open_base"),
            "open_high":             pred.get("open_high"),
            "close_low":             pred.get("close_low"),
            "close_base":            pred.get("close_base"),
            "close_high":            pred.get("close_high"),
            "rsi_proxy":             pred.get("rsi_proxy"),
            "pct_from_high":         pred.get("pct_from_high"),
            "event_warning":         pred.get("event_warning") or "",
            "event_type":            pred.get("event_type", "none"),
            "earnings_detail":       pred.get("earnings_detail", ""),
            "earn_surprise":         pred.get("earn_surprise", 0),
            "macd_signal":           pred.get("macd_signal", "neutral"),
            "volume_signal":         pred.get("volume_signal", "normal"),
            "dma_signal":            pred.get("dma_signal", "neutral"),
            "fii_sensitivity":       pred.get("fii_sensitivity", "medium"),
            "above_200dma":          pred.get("above_200dma", False),
            "source":                pred.get("source", "quick_calc"),
        })

    # Sort by absolute contribution (highest impact first)
    constituents.sort(key=lambda x: abs(x.get("contribution_pts") or 0), reverse=True)

    # ── NEW Aggregation: extrapolate → global multiplier → range ──────────────

    # Step 1: Sum raw contributions from covered stocks
    total_contribution_pts = sum(c.get("contribution_pts") or 0 for c in constituents)

    # Step 2: Extrapolate to 100% index coverage
    coverage_pct      = round(total_weight - error_weight, 1)
    coverage_fraction = max(coverage_pct / 100, 0.3)  # never divide by < 30%
    extrapolated_pts  = round(total_contribution_pts / coverage_fraction, 1)

    # Step 3: Directional global multiplier
    # Rule: bearish global factors (m<1) should push bearish predictions MORE negative
    #       bullish global factors (m>1) should push bullish predictions MORE positive
    #       Opposite combos dampen the prediction.
    #
    # Implementation: convert multiplier to an adjustment_factor that always
    # amplifies when same-direction and dampens when opposite:
    #
    #   bearish env (m=0.856) + bearish pred (-145):
    #     adjustment = 1 + (1 - 0.856) = 1.144  → -145 × 1.144 = -165 (more negative) ✓
    #
    #   bearish env (m=0.856) + bullish pred (+145):
    #     adjustment = 1 - (1 - 0.856) = 0.856  → +145 × 0.856 = +124 (less positive) ✓
    #
    #   bullish env (m=1.10) + bullish pred (+145):
    #     adjustment = 1 + (1.10 - 1) = 1.10    → +145 × 1.10 = +160 (more positive) ✓
    #
    #   bullish env (m=1.10) + bearish pred (-145):
    #     adjustment = 1 - (1.10 - 1) = 0.90    → -145 × 0.90 = -131 (less negative) ✓
    news_impact_for_mult = _scan_news_impact_for_mult(global_factors)
    global_multiplier, multiplier_factors = _compute_global_multiplier(
        global_factors, news_impact_for_mult, extrapolated_pts
    )

    if extrapolated_pts != 0 and global_multiplier > 0:
        deviation = global_multiplier - 1.0  # positive = bullish env, negative = bearish env
        bullish_pred = extrapolated_pts > 0
        if (deviation > 0 and bullish_pred) or (deviation < 0 and not bullish_pred):
            # Same direction — amplify: add the deviation
            adjustment = 1.0 + abs(deviation)
        else:
            # Opposite direction — dampen: subtract the deviation
            adjustment = max(0.5, 1.0 - abs(deviation))
        midpoint_pts = round(extrapolated_pts * adjustment, 1)
    else:
        midpoint_pts = extrapolated_pts

    # Step 4: Range half-width = 15% of |midpoint|, clamped [40, 100]
    abs_move   = abs(midpoint_pts)
    half_width = int(max(40, min(100, round(abs_move * 0.15, 0))))

    # Also compute open range (70% of midpoint at open, ±50 half-width)
    open_bias_pts  = round(midpoint_pts * 0.70, 1)
    open_half      = int(max(30, min(80, round(abs(open_bias_pts) * 0.15, 0))))
    open_base_idx  = round(index_cmp + open_bias_pts, 1)
    open_low_idx   = round(open_base_idx - open_half, 1)
    open_high_idx  = round(open_base_idx + open_half, 1)

    close_base_idx = round(index_cmp + midpoint_pts, 1)
    close_low_idx  = round(close_base_idx - half_width, 1)
    close_high_idx = round(close_base_idx + half_width, 1)

    direction = "bullish" if midpoint_pts > 10 else "bearish" if midpoint_pts < -10 else "neutral"

    # Summary
    top_movers = constituents[:3]
    top_mover_str = ", ".join(
        f"{c['symbol']} ({c['contribution_pts']:+.0f} pts)"
        for c in top_movers
    )
    summary = (
        f"Top 15 sum: {total_contribution_pts:+.0f} pts → "
        f"extrapolated: {extrapolated_pts:+.0f} pts → "
        f"× {global_multiplier} = {midpoint_pts:+.0f} pts midpoint. "
        f"Key movers: {top_mover_str}."
    )
    if event_warnings:
        summary += f" ⚠ Events: {'; '.join(event_warnings[:2])}"

    full_count  = sum(1 for c in constituents if c.get("source") == "full_prediction")
    quick_count = sum(1 for c in constituents if c.get("source") == "quick_calc")

    response_data = clean_for_json({
        "index_key":      index_key,
        "index_name":     index_name,
        "index_cmp":      round(index_cmp, 2),
        "full_predictions": full_count,
        "quick_predictions": quick_count,
        "coverage_pct":   coverage_pct,
        "direction":      direction,
        "summary":        summary,
        "event_warnings": event_warnings,
        "total_contribution_pts": total_contribution_pts,
        "extrapolated_pts":       extrapolated_pts,
        "global_multiplier":      global_multiplier,
        "multiplier_factors":     multiplier_factors,
        "midpoint_pts":           midpoint_pts,
        "half_width":             half_width,
        "open_base":   open_base_idx,
        "open_low":    open_low_idx,
        "open_high":   open_high_idx,
        "close_base":  close_base_idx,
        "close_low":   close_low_idx,
        "close_high":  close_high_idx,
        "open_bias_pts":   open_bias_pts,
        "close_bias_pts":  midpoint_pts,
        "constituents": constituents,
        "predicted_at": datetime.now(IST).isoformat(),
    })

    # Persist this constituent prediction for history tracking
    # Key: CONST::{index_key}::{session_date}
    try:
        from api.routes.predict import _load_predictions, _save_predictions, _pred_lock, _next_trading_date
        pred_session = _next_trading_date()
        const_key = f"CONST::{index_key.lower()}::{pred_session}"
        with _pred_lock:
            store = _load_predictions()
            store["predictions"][const_key] = {
                "symbol":          f"CONST::{index_key.lower()}",
                "index_key":       index_key.lower(),
                "index_name":      index_name,
                "session_date":    pred_session,
                "predicted_at":    datetime.now(IST).isoformat(),
                "close_low":       close_low_idx,
                "close_base":      close_base_idx,
                "close_high":      close_high_idx,
                "open_low":        open_low_idx,
                "open_base":       open_base_idx,
                "open_high":       open_high_idx,
                "midpoint_pts":    midpoint_pts,
                "direction":       direction,
                "actual_close":    None,
                "actual_open":     None,
                "accuracy":        None,
                "open_accuracy":   None,
            }
            _save_predictions(store)
    except Exception:
        pass

    return JSONResponse(content=response_data)


@router.get("/predict/constituents-view/{index_key}")
async def constituents_view(index_key: str):
    """
    Returns all constituents of an index grouped by sector,
    with weight, CMP, change%, score, signal, contribution pts.
    Uses cached quick data — no full analysis.
    """
    weights = INDEX_WEIGHTS.get(index_key.lower())
    if not weights:
        return JSONResponse(content={"error": "Unknown index"}, status_code=400)

    from data.indices import STOCK_SECTOR_MAP, SECTOR_INDEX_MAP
    import yfinance as yf

    index_name   = INDEX_NAMES.get(index_key.lower(), index_key)
    index_symbol = INDEX_BASE_SYMBOLS.get(index_key.lower(), "^NSEI")

    # Get index CMP, prev_close and actual move from NSE official data (most accurate)
    nse_index_map = {"^NSEI": "NIFTY 50", "^NSEBANK": "NIFTY BANK", "^BSESN": "S&P BSE SENSEX"}
    nse_name = nse_index_map.get(index_symbol, "")
    index_cmp = index_prev = 0; index_actual_move = None

    if nse_name:
        try:
            import requests as _req, time as _t
            _headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com/"}
            _s = _req.Session()
            _s.get("https://www.nseindia.com", headers=_headers, timeout=8)
            _t.sleep(0.3)
            _r = _s.get("https://www.nseindia.com/api/allIndices", headers=_headers, timeout=8)
            if _r.status_code == 200:
                for item in _r.json().get("data", []):
                    if item.get("index") == nse_name:
                        index_cmp  = float(item.get("last") or 0)
                        index_prev = float(item.get("previousClose") or 0)
                        index_actual_move = round(float(item.get("variation") or 0), 2)
                        break
        except Exception:
            pass

    # Fallback to yfinance if NSE API failed
    if index_cmp <= 0:
        try:
            import yfinance as yf
            idx_fi    = yf.Ticker(index_symbol).fast_info
            index_cmp = float(getattr(idx_fi, "last_price", None) or 0)
            index_prev= float(getattr(idx_fi, "previous_close", None) or 0)
            index_actual_move = round(index_cmp - index_prev, 2) if index_prev > 0 else None
        except Exception:
            pass

    # Use index_prev as base: contribution = index_prev × (weight%) × (stock_chg%)
    # This correctly attributes each stock's move to index points
    base_for_contrib = index_prev if index_prev > 0 else index_cmp

    # Quick per-stock data using fast_info only (no full analysis — fast)
    loop     = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=16)

    def fetch_stock(sym_w):
        sym, w = sym_w
        bare = sym.replace(".NS", "")
        try:
            t  = yf.Ticker(sym)
            fi = t.fast_info
            cmp        = float(getattr(fi, "last_price", None) or 0)
            prev_close = float(getattr(fi, "previous_close", None) or 0)
            chg_pct    = round((cmp / prev_close - 1) * 100, 2) if prev_close > 0 else None
            # Correct formula: index_prev × weight% × stock_chg%
            contrib_pts = round(base_for_contrib * (w / 100) * ((chg_pct or 0) / 100), 1) if base_for_contrib else None
            sector = STOCK_SECTOR_MAP.get(sym, "Other")
            return {
                "symbol":       bare,
                "weight_pct":   round(w, 2),
                "cmp":          round(cmp, 2) if cmp else None,
                "change_pct":   chg_pct,
                "sector":       sector,
                "contrib_pts":  contrib_pts,
            }
        except Exception:
            return {"symbol": bare, "weight_pct": round(w, 2), "sector": STOCK_SECTOR_MAP.get(sym, "Other"),
                    "cmp": None, "change_pct": None, "contrib_pts": None}

    raw = await asyncio.gather(*[
        loop.run_in_executor(executor, fetch_stock, (sym, w))
        for sym, w in weights.items()
    ])

    # Group by sector
    sector_map: dict[str, list] = {}
    for stock in raw:
        sec = stock["sector"]
        if sec not in sector_map:
            sector_map[sec] = []
        sector_map[sec].append(stock)

    # Sort stocks within each sector by weight descending
    sectors = []
    for sec, stocks in sorted(sector_map.items()):
        stocks.sort(key=lambda x: x["weight_pct"], reverse=True)
        total_weight   = round(sum(s["weight_pct"] for s in stocks), 1)
        total_contrib  = round(sum(s["contrib_pts"] or 0 for s in stocks), 1)
        sectors.append({
            "sector":       sec,
            "stock_count":  len(stocks),
            "total_weight": total_weight,
            "total_contrib_pts": total_contrib,
            "stocks": stocks,
        })
    sectors.sort(key=lambda x: x["total_weight"], reverse=True)

    return JSONResponse(content=clean_for_json({
        "index_key":          index_key,
        "index_name":         index_name,
        "index_cmp":          round(index_cmp, 2),
        "index_prev_close":   round(index_prev, 2) if index_prev else None,
        "index_actual_move":  index_actual_move,
        "total_stocks":       len(raw),
        "sectors":            sectors,
    }))


@router.post("/predict/constituents/{index_key}/sync")
async def sync_constituent_predictions(index_key: str):
    """
    Force-regenerate full predictions for all stocks in a given index.
    Stores results in predictions.json. Returns sync count.
    """
    weights = INDEX_WEIGHTS.get(index_key.lower())
    if not weights:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=f"Unknown index '{index_key}'")

    index_name = INDEX_NAMES.get(index_key.lower(), index_key)
    stocks     = list(weights.keys())

    from api.routes.predict import pre_generate_predictions, PreGenerateInput
    result = await pre_generate_predictions(
        PreGenerateInput(symbols=stocks, force=True)
    )

    import json as _json
    body = _json.loads(result.body)
    return {
        "index":    index_name,
        "synced":   body.get("generated", 0),
        "failed":   body.get("failed", 0),
        "session_date": body.get("session_date"),
        "message": f"Synced {body.get('generated',0)}/{len(stocks)} stocks for {index_name}",
    }

