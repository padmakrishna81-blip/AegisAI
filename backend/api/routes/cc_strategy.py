"""Covered Call Strategy Scanner and Trade Planner."""

import math
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from api.utils import clean_for_json
import asyncio
from concurrent.futures import ThreadPoolExecutor


# ─── Black-Scholes Greeks + probability helpers ───────────────────────────────

def _ncdf(x: float) -> float:
    return (1 + math.erf(x / math.sqrt(2))) / 2

def _npdf(x: float) -> float:
    return math.exp(-x * x / 2) / math.sqrt(2 * math.pi)

def _d2(spot: float, level: float, iv_pct: float, days: int, rf: float = 0.065) -> float:
    T = days / 365
    s = iv_pct / 100
    if T <= 0 or s <= 0 or spot <= 0 or level <= 0:
        return 0.0
    return (math.log(spot / level) + (rf - 0.5 * s * s) * T) / (s * math.sqrt(T))

def _bs_greeks(spot: float, strike: float, iv_pct: float, days: int, rf: float = 0.065) -> dict:
    """Full Black-Scholes Greeks for a call option."""
    T = days / 365
    s = iv_pct / 100
    if T <= 0 or s <= 0 or spot <= 0 or strike <= 0:
        return {}
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    delta = _ncdf(d1)
    gamma = _npdf(d1) / (spot * s * math.sqrt(T))
    # Theta per calendar day (negative = cost to option holder = income to seller)
    theta = (-(spot * _npdf(d1) * s) / (2 * math.sqrt(T))
             - rf * strike * math.exp(-rf * T) * _ncdf(d2)) / 365
    vega  = spot * _npdf(d1) * math.sqrt(T) / 100  # per 1% change in IV
    rho   = strike * T * math.exp(-rf * T) * _ncdf(d2) / 100  # per 1% rate change
    return {
        "delta": round(delta, 3),
        "gamma": round(gamma, 5),
        "theta": round(theta, 2),  # negative — seller earns |theta| per day
        "vega":  round(vega,  2),  # positive — seller loses this per 1% IV rise
        "rho":   round(rho,   3),
    }

def _find_delta_target_strike(strikes: list[dict], spot: float, days: int,
                               target_delta: float = 0.225,
                               min_oi: int = 10) -> dict | None:
    """Find the strike whose CE delta is closest to target_delta with sufficient OI."""
    best = None
    best_diff = 999.0
    for row in strikes:
        ce = row.get("ce", {}) if "ce" in row else row.get("CE", {})
        strike = row.get("strike") or row.get("strikePrice", 0)
        iv_pct  = ce.get("iv") or ce.get("impliedVolatility") or 0
        ltp     = ce.get("ltp") or ce.get("lastPrice") or 0
        oi      = ce.get("oi") or ce.get("openInterest") or 0
        if iv_pct <= 0 or ltp <= 0 or strike <= spot:
            continue
        if oi < min_oi:
            continue
        g = _bs_greeks(spot, float(strike), float(iv_pct), days)
        if not g:
            continue
        diff = abs(g["delta"] - target_delta)
        if diff < best_diff:
            best_diff = diff
            best = {
                "strike": float(strike),
                "iv":     round(float(iv_pct), 1),
                "ltp":    round(float(ltp), 2),
                "oi":     int(oi),
                **g,
            }
    return best

def _prob_above(spot, level, iv_pct, days) -> float:
    return round(_ncdf(_d2(spot, level, iv_pct, days)) * 100, 1)

def _prob_below(spot, level, iv_pct, days) -> float:
    return round((1 - _ncdf(_d2(spot, level, iv_pct, days))) * 100, 1)

def _price_range(spot: float, iv_pct: float, days: int,
                 hist_max_up: float | None = None,
                 hist_max_down: float | None = None,
                 hist_expiry_p90_up: float | None = None,
                 hist_expiry_p90_down: float | None = None) -> dict:
    """
    Blended price range: IV-based Black-Scholes + historical expiry-cycle actuals.
    The 'blended' range uses the wider of (IV model, historical) at each percentile.
    """
    T = days / 365
    iv_move = spot * (iv_pct / 100) * math.sqrt(T)

    low_1sd_iv  = round(spot - iv_move, 0)
    high_1sd_iv = round(spot + iv_move, 0)
    low_2sd_iv  = round(spot - 2 * iv_move, 0)
    high_2sd_iv = round(spot + 2 * iv_move, 0)

    # Blend with historical: use whichever gives the wider range
    if hist_expiry_p90_up is not None and hist_expiry_p90_down is not None:
        hist_up_move   = spot * hist_expiry_p90_up / 100
        hist_down_move = spot * abs(hist_expiry_p90_down) / 100
        high_1sd_blended = round(max(high_1sd_iv, spot + hist_up_move), 0)
        low_1sd_blended  = round(min(low_1sd_iv,  spot - hist_down_move), 0)
    else:
        high_1sd_blended = high_1sd_iv
        low_1sd_blended  = low_1sd_iv

    if hist_max_up is not None and hist_max_down is not None:
        hist_max_up_move   = spot * hist_max_up / 100
        hist_max_down_move = spot * abs(hist_max_down) / 100
        high_2sd_blended = round(max(high_2sd_iv, spot + hist_max_up_move), 0)
        low_2sd_blended  = round(min(low_2sd_iv,  spot - hist_max_down_move), 0)
    else:
        high_2sd_blended = high_2sd_iv
        low_2sd_blended  = low_2sd_iv

    has_hist = hist_max_up is not None
    return {
        # IV-only (pure Black-Scholes)
        "low_1sd":         low_1sd_iv,
        "high_1sd":        high_1sd_iv,
        "low_2sd":         low_2sd_iv,
        "high_2sd":        high_2sd_iv,
        # Blended (wider of IV model vs historical actuals)
        "low_1sd_blended":  low_1sd_blended,
        "high_1sd_blended": high_1sd_blended,
        "low_2sd_blended":  low_2sd_blended,
        "high_2sd_blended": high_2sd_blended,
        "iv_used":          round(iv_pct, 1),
        "has_historical":   has_hist,
    }

def _iv_spike_risk(bare: str, expiry: str, current_iv: float) -> dict:
    """
    Detect IV spike risk:
    1. Upcoming results/board meeting within expiry window
    2. Current IV unusually high (already spiked)
    """
    risks = []
    risk_level = "low"  # low / medium / high

    try:
        from api.routes.market import _fetch_results_calendar
        from datetime import datetime, date
        events = _fetch_results_calendar()
        # Check if this stock has an event before expiry
        try:
            expiry_dt = datetime.strptime(expiry, "%d-%b-%Y").date()
            days_to_expiry = (expiry_dt - date.today()).days
        except Exception:
            days_to_expiry = 44
        stock_events = [e for e in events
                        if e.get("symbol", "").upper() == bare.upper()
                        and e.get("days_from_today", 999) <= days_to_expiry]
        if stock_events:
            ev = stock_events[0]
            risks.append(f"⚠ {ev['purpose']} on {ev['when']} — IV will spike before this date")
            risk_level = "high"
    except Exception:
        pass

    # IV level assessment (for NSE midcap stocks: typical range 25–55%)
    if current_iv > 60:
        risks.append(f"⚠ IV at {current_iv:.0f}% is unusually high — premium may contract after selling")
        risk_level = "high" if risk_level != "high" else "high"
    elif current_iv > 45:
        risks.append(f"IV at {current_iv:.0f}% is elevated — good time to sell, premium is rich")
        risk_level = max(risk_level, "medium") if risk_level == "low" else risk_level
    elif current_iv < 25:
        risks.append(f"IV at {current_iv:.0f}% is low — premium is thin, consider waiting for IV expansion")
        risk_level = "medium"
    else:
        risks.append(f"IV at {current_iv:.0f}% is in normal range — acceptable time to sell")

    # IV rank approximation (since we don't have historical IV, use % of 52W range proxy)
    iv_assessment = (
        "Rich (good time to sell)" if current_iv > 40 else
        "Normal (acceptable)" if current_iv >= 28 else
        "Cheap (consider waiting)"
    )

    return {
        "risk_level": risk_level,
        "current_iv": round(current_iv, 1),
        "iv_assessment": iv_assessment,
        "risks": risks,
        "recommendation": (
            "DO NOT sell CE — results/event before expiry will cause IV spike and loss"
            if risk_level == "high" and any("results" in r.lower() or "meeting" in r.lower() for r in risks)
            else "Acceptable — proceed with caution" if risk_level == "medium"
            else "Safe to sell CE"
        ),
    }


router = APIRouter()

# ─── NSE F&O Lot Sizes (verified live from NSE, July 2026) ────────────────────
LOT_SIZES: dict[str, int] = {
    "ADANIENT":  309,  "ADANIPORTS": 475,  "APOLLOHOSP": 125, "ASIANPAINT": 250,
    "AXISBANK":  625,  "BAJAJ-AUTO":  75,  "BAJFINANCE": 750, "BAJAJFINSV": 300,
    "BEL":      1425,  "BHARTIARTL": 475,  "BPCL":      1975, "BRITANNIA":  125,
    "CHOLAFIN":  625,  "CIPLA":      425,  "COALINDIA": 1350, "DIVISLAB":   100,
    "DRREDDY":   625,  "EICHERMOT":  100,  "FEDERALBNK":2500, "GRASIM":     250,
    "HAL":       150,  "HCLTECH":    400,  "HDFCBANK":  650,  "HDFCLIFE":  1100,
    "HEROMOTOCO":150,  "HINDALCO":   700,  "HINDUNILVR":300,  "ICICIBANK":  700,
    "IDFCFIRSTB":9275, "INDUSINDBK": 700,  "INFY":      400,  "IOC":       4875,
    "IRCTC":     875,  "ITC":       1725,  "JSWSTEEL":  675,  "KOTAKBANK": 2000,
    "LT":        175,  "M&M":        200,  "MARUTI":     50,  "MUTHOOTFIN": 275,
    "NESTLEIND": 500,  "NHPC":      6950,  "NMDC":      6750, "NTPC":      1500,
    "ONGC":     2250,  "PFC":       1300,  "PIDILITIND": 500, "PNB":       8000,
    "POWERGRID":1900,  "BANKBARODA":2925,  "RECLTD":    1575, "RELIANCE":   500,
    "SAIL":     4700,  "SBIN":       750,  "SBILIFE":    375, "SHRIRAMFIN": 825,
    "SUNPHARMA": 350,  "TATACONSUM": 550,  "TATAMOTORS":1400, "TATAPOWER": 1450,
    "TATASTEEL":2750,  "TCS":        225,  "TECHM":      600, "TITAN":      175,
    "ULTRACEMCO": 50,  "VEDL":      1150,  "WIPRO":     3000, "ZOMATO":    4500,
    "BHEL":     2625,  "CANBK":     6750,  "CESC":       600, "ZYDUSLIFE":  900,
    "LUPIN":     425,  "AUROPHARMA": 550,  "CDSL":       475, "MCX":        250,
    "DLF":       950,  "GODREJPROP": 325,  "PRESTIGE":   450, "IRFC":      5425,
}

_live_lot_cache: dict[str, int] = {}


def _get_lot_size(symbol: str) -> int:
    """Return lot size — static table first, then live NSE derivation."""
    bare = symbol.replace(".NS", "").replace(".BO", "").upper()
    if bare in LOT_SIZES:
        return LOT_SIZES[bare]
    if bare in _live_lot_cache:
        return _live_lot_cache[bare]
    # Try live derivation from NSE option chain
    try:
        import math
        from jugaad_data.nse import NSELive
        nse = NSELive()
        data = nse.equities_option_chain(bare)
        rows = data.get("records", {}).get("data", [])
        qtys = []
        for r in rows:
            ce = r.get("CE", {})
            for k in ["buyQuantity1", "sellQuantity1"]:
                q = ce.get(k, 0) or 0
                if 0 < q < 200000:
                    qtys.append(int(q))
        if qtys:
            g = qtys[0]
            for q in qtys[1:]:
                g = math.gcd(g, q)
            if 10 <= g <= 50000:
                _live_lot_cache[bare] = g
                return g
    except Exception:
        pass
    return 1000  # safe fallback


def _get_fresh_nse():
    from jugaad_data.nse import NSELive
    return NSELive()


def _fetch_chain_for_plan(sym: str, expiry: str) -> dict:
    bare = sym.replace(".NS", "").upper()
    try:
        return _get_fresh_nse().equities_option_chain(bare, expiry=expiry)
    except Exception:
        return {}


def _get_live_spot(bare: str) -> float | None:
    """Get live spot price from NSE option chain (most accurate)."""
    try:
        from jugaad_data.nse import NSELive
        nse = NSELive()
        data = nse.equities_option_chain(bare)
        spot = data.get("records", {}).get("underlyingValue")
        if spot and float(spot) > 0:
            return float(spot)
    except Exception:
        pass
    return None


# ─── Scanner ───────────────────────────────────────────────────────────────────

def _scan_one(symbol: str) -> dict | None:
    import yfinance as yf
    from data.market_data import get_info, safe_get

    bare = symbol.replace(".NS", "").upper()
    try:
        t    = yf.Ticker(symbol)
        info = t.info

        # Try live spot first, fall back to yfinance
        cmp = _get_live_spot(bare)
        if not cmp:
            cmp = safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice")
        if not cmp or float(cmp) <= 0:
            return None
        cmp = float(cmp)

        high52 = safe_get(info, "fiftyTwoWeekHigh")
        low52  = safe_get(info, "fiftyTwoWeekLow")
        name   = safe_get(info, "longName") or safe_get(info, "shortName") or bare
        sector = safe_get(info, "sector") or ""

        if not high52 or not low52:
            return None
        high52, low52 = float(high52), float(low52)

        # Rule 1: Flat last 5 sessions (< ±2%)
        hist5 = t.history(period="5d")
        if hist5.empty or len(hist5) < 3:
            return None
        change_5d = round((float(hist5["Close"].iloc[-1]) / float(hist5["Close"].iloc[0]) - 1) * 100, 2)
        if abs(change_5d) > 2.0:
            return None

        # Rule 2: Not near 52W high (≥10% below)
        pct_from_high = round((cmp / high52 - 1) * 100, 2)
        if pct_from_high > -10:
            return None

        # Rule 3: ≥20% above 52W low
        pct_from_low = round((cmp / low52 - 1) * 100, 2)
        if pct_from_low < 20:
            return None

        # Rule 4: F&O eligible
        lot_size = _get_lot_size(symbol)

        # Rule 5: Not in breakdown (not >8% below 50 DMA)
        hist1y = t.history(period="1y")
        above_200dma = False
        score_adj    = 50
        if not hist1y.empty and len(hist1y) >= 50:
            close    = hist1y["Close"]
            sma50    = float(close.rolling(50).mean().iloc[-1])
            sma200   = float(close.rolling(200).mean().iloc[-1]) if len(hist1y) >= 200 else None
            above_200dma = bool(sma200 and cmp > sma200)
            if cmp < sma50 * 0.92:
                return None
            score_adj = 60
            if above_200dma:   score_adj += 15
            if cmp > sma50:    score_adj += 10
            if change_5d >= -1:score_adj += 5

        phase1_qty   = lot_size // 2
        phase1_cost  = round(phase1_qty * cmp, 0)
        avg_trigger  = round(cmp * 0.97, 2)          # default 3% down
        phase2_qty   = lot_size - phase1_qty
        phase2_cost  = round(phase2_qty * avg_trigger, 0)
        avg_cost     = round((phase1_qty * cmp + phase2_qty * avg_trigger) / lot_size, 2)
        full_lot_val = round(lot_size * cmp, 0)
        margin_est   = round(cmp * lot_size * 0.12, 0)
        total_funds  = int(full_lot_val + margin_est)

        return {
            "symbol":              bare,
            "name":                name,
            "sector":              sector,
            "cmp":                 round(cmp, 2),
            "high_52w":            round(high52, 2),
            "low_52w":             round(low52, 2),
            "pct_from_high":       pct_from_high,
            "pct_from_low":        pct_from_low,
            "change_5d":           change_5d,
            "above_200dma":        above_200dma,
            "lot_size":            lot_size,
            "phase1_qty":          phase1_qty,
            "phase1_cost":         int(phase1_cost),
            "total_funds_required":total_funds,
            "margin_estimate":     int(margin_est),
            "strike_8pct":         round(cmp * 1.08 / 5) * 5,
            "strike_10pct":        round(cmp * 1.10 / 5) * 5,
            "score":               min(100, score_adj),
        }
    except Exception:
        return None


def _find_atm_iv(rows: list, spot: float) -> tuple:
    """Scan option chain rows and return (best_iv, best_diff) for strike closest to spot."""
    best_iv, best_diff = None, 999.0
    for r in rows:
        ce     = r.get("CE", {})
        strike = float(r.get("strikePrice") or ce.get("strikePrice") or 0)
        iv     = float(ce.get("impliedVolatility") or 0)
        if iv <= 0:
            pe = r.get("PE", {})
            iv = float(pe.get("impliedVolatility") or 0)
        if iv > 0 and strike > 0:
            diff = abs(strike - spot)
            if diff < best_diff:
                best_diff = diff
                best_iv   = round(iv, 1)
    return best_iv, best_diff


def _get_atm_iv(bare: str) -> float | None:
    """Fetch ATM IV — tries default chain first, falls back to best-expiry call only if needed."""
    try:
        import time as _time
        from jugaad_data.nse import NSELive
        from api.routes.covered_calls import _pick_best_expiry
        nse  = NSELive()
        data = nse.equities_option_chain(bare)
        rec  = data.get("records", {})
        spot = float(rec.get("underlyingValue") or 0)
        if spot <= 0:
            return None
        rows = (data.get("filtered", {}).get("data", [])
                or rec.get("data", []))
        best_iv, _ = _find_atm_iv(rows, spot)
        # If default chain had no IV (nearest expiry < 24 days), try best upcoming expiry
        if best_iv is None:
            exp_dates  = rec.get("expiryDates", [])
            best_expiry = _pick_best_expiry(exp_dates)
            if best_expiry:
                _time.sleep(0.08)
                data2 = nse.equities_option_chain(bare, expiry=best_expiry)
                rows2 = (data2.get("filtered", {}).get("data", [])
                         or data2.get("records", {}).get("data", []))
                best_iv, _ = _find_atm_iv(rows2, spot)
        return best_iv
    except Exception:
        return None


def _get_upcoming_event(bare: str, days: int = 45) -> dict | None:
    """Return the nearest upcoming results/board meeting within `days`."""
    try:
        from api.routes.market import _fetch_results_calendar
        events = _fetch_results_calendar()
        stock_events = [
            e for e in events
            if e.get("symbol", "").upper() == bare.upper()
            and 0 <= e.get("days_from_today", 999) <= days
        ]
        if stock_events:
            return min(stock_events, key=lambda e: e["days_from_today"])
    except Exception:
        pass
    return None


def _build_warnings(bare: str, cmp: float, high52: float, low52: float,
                    change_5d: float, above_200dma: bool, atm_iv: float | None,
                    min_iv: float = 25.0) -> list[dict]:
    """Build a list of risk warnings for display (used in assess endpoint)."""
    warnings = []

    # IV warning
    if atm_iv is None:
        warnings.append({"level": "medium", "category": "IV",
                         "message": "Could not fetch live IV — verify premium manually before selling."})
    elif atm_iv < min_iv:
        warnings.append({"level": "high", "category": "IV",
                         "message": f"IV at {atm_iv}% is below your threshold of {min_iv}% — premium too thin. Wait for IV expansion before selling CE."})
    elif atm_iv < 30:
        warnings.append({"level": "medium", "category": "IV",
                         "message": f"IV at {atm_iv}% is low-normal — premium is thin. Consider waiting for better IV."})
    elif atm_iv > 60:
        warnings.append({"level": "medium", "category": "IV",
                         "message": f"IV at {atm_iv}% is unusually high — premium may contract (mean-revert) after selling. Good for income but monitor."})
    else:
        warnings.append({"level": "ok", "category": "IV",
                         "message": f"IV at {atm_iv}% is in the good range — solid premium available."})

    # Upcoming event / IV spike risk
    event = _get_upcoming_event(bare, days=45)
    if event:
        days_left = event.get("days_from_today", 0)
        warnings.append({"level": "high", "category": "IV Spike",
                         "message": f"{event.get('purpose','Event')} on {event.get('when','soon')} ({days_left}d away) — IV will spike, CE will gain value. DO NOT sell CE now."})

    # 52W high proximity
    pct_from_high = round((cmp / high52 - 1) * 100, 2)
    if pct_from_high > -5:
        warnings.append({"level": "high", "category": "52W High",
                         "message": f"Stock is within 5% of 52W high (₹{high52}) — limited upside room, higher assignment risk. Wait for pullback."})
    elif pct_from_high > -10:
        warnings.append({"level": "medium", "category": "52W High",
                         "message": f"Stock is {abs(pct_from_high):.1f}% below 52W high (₹{high52}) — borderline. Proceed with caution."})

    # 52W low proximity
    pct_from_low = round((cmp / low52 - 1) * 100, 2)
    if pct_from_low < 15:
        warnings.append({"level": "high", "category": "52W Low",
                         "message": f"Stock is only {pct_from_low:.1f}% above 52W low (₹{low52}) — near support but breakdown risk is high. Averaging may not help if fundamentals are weak."})

    # Trend
    if not above_200dma:
        warnings.append({"level": "medium", "category": "Trend",
                         "message": "Stock is below 200 DMA — medium-term downtrend. Strategy still works but recovery may take longer. Monitor closely."})

    # 5-day momentum
    if change_5d < -3:
        warnings.append({"level": "medium", "category": "Momentum",
                         "message": f"Stock fell {abs(change_5d):.1f}% in last 5 sessions — recent selling pressure. May fall further before stabilising."})
    elif change_5d > 4:
        warnings.append({"level": "medium", "category": "Momentum",
                         "message": f"Stock rose {change_5d:.1f}% in last 5 sessions — may be near-term overbought. Better to wait for consolidation."})

    return warnings


@router.get("/covered-calls/scan/strategy")
async def scan_cc_strategy(
    flat_pct:       float = Query(default=2.5,  description="Max 5-day price change % (both sides)"),
    below_high_pct: float = Query(default=5.0,  description="Min % below 52W high"),
    above_low_pct:  float = Query(default=10.0, description="Min % above 52W low"),
    below_sma50_pct:float = Query(default=10.0, description="Max % below 50 DMA (breakdown filter)"),
    min_score:      int   = Query(default=0,    description="Minimum AegisAI score (0 = no filter)"),
    min_iv:         float = Query(default=20.0, description="Minimum ATM IV % — stocks below this are excluded (premium too thin)"),
):
    from data.indices import NIFTY50, NIFTY_BANK, NIFTY_IT, NIFTY_MIDCAP_SELECTION
    candidates = list(set(NIFTY50 + NIFTY_BANK + NIFTY_IT + NIFTY_MIDCAP_SELECTION))
    candidates = [s for s in candidates if s.replace(".NS", "") in LOT_SIZES]

    # ── Pre-fetch all IVs sequentially using shared NSE instance ────────────
    # One call per stock — use the default chain first (fastest).
    # Only fall back to expiry-specific call when the default chain yields no ATM IV
    # (happens when nearest expiry < 24 days — e.g. week before monthly expiry).
    iv_map: dict[str, float | None] = {}
    spot_map: dict[str, float] = {}  # bare -> live spot (captured during IV pre-fetch)
    if min_iv > 0:
        try:
            import time as _time
            from jugaad_data.nse import NSELive
            from api.routes.covered_calls import _pick_best_expiry as _pbe
            nse_shared = NSELive()
            for sym in candidates:
                bare = sym.replace(".NS", "")
                try:
                    data = nse_shared.equities_option_chain(bare)
                    _time.sleep(0.06)
                    spot = float(data.get("records", {}).get("underlyingValue") or 0)
                    if spot <= 0:
                        iv_map[bare] = None
                        continue
                    spot_map[bare] = spot
                    rows = (data.get("filtered", {}).get("data", [])
                            or data.get("records", {}).get("data", []))
                    best_iv, best_diff = _find_atm_iv(rows, spot)
                    # If no IV found in default chain, try the best upcoming expiry
                    if best_iv is None:
                        exp_dates = data.get("records", {}).get("expiryDates", [])
                        best_exp  = _pbe(exp_dates)
                        if best_exp:
                            try:
                                data2 = nse_shared.equities_option_chain(bare, expiry=best_exp)
                                _time.sleep(0.06)
                                rows2 = (data2.get("filtered", {}).get("data", [])
                                         or data2.get("records", {}).get("data", []))
                                best_iv, _ = _find_atm_iv(rows2, spot)
                            except Exception:
                                pass
                    iv_map[bare] = best_iv
                except Exception:
                    iv_map[bare] = None
        except Exception:
            pass

    criteria = {
        "flat_pct":        flat_pct,
        "below_high_pct":  below_high_pct,
        "above_low_pct":   above_low_pct,
        "below_sma50_pct": below_sma50_pct,
        "min_score":       min_score,
        "min_iv":          min_iv,
        "iv_map":          iv_map,
        "spot_map":        spot_map,  # pre-fetched spots — no extra NSE call per stock
    }

    loop     = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=12)
    tasks    = [loop.run_in_executor(executor, _scan_one_with_criteria, sym, criteria) for sym in candidates]
    results  = await asyncio.gather(*tasks)

    qualified = [r for r in results if r is not None]
    if min_score > 0:
        qualified = [r for r in qualified if r["score"] >= min_score]
    # Sort by total funds required (low to high) — easier for user to find affordable ones
    qualified.sort(key=lambda x: x["total_funds_required"])

    # Build a helpful message when nothing qualifies
    why_empty = None
    if not qualified:
        from datetime import date
        month = date.today().strftime("%B")
        why_empty = (
            f"No stocks passed all filters this scan. Common reasons during {month}: "
            f"(1) Most large-caps are near 52W highs — try reducing 'Below 52W High' threshold. "
            f"(2) Q1/Q2 results season blocks many stocks (results within 21 days). "
            f"(3) Low volatility period — try reducing Min ATM IV to 15–18%. "
            f"Try the 'Assess Specific Stocks' section to evaluate stocks of your choice without auto-filters."
        )

    return JSONResponse(content=clean_for_json({
        "count":        len(qualified),
        "scanned":      len(candidates),
        "stocks":       qualified,
        "criteria_used":criteria,
        "why_empty":    why_empty,
    }))


@router.post("/covered-calls/assess")
async def assess_stocks(body: dict):
    """Assess user-provided stocks — no filters applied, full warnings for every risk."""
    symbols = body.get("symbols", [])
    min_iv  = float(body.get("min_iv", 25.0))
    if not symbols:
        return JSONResponse(content={"results": []})

    normalized = []
    for s in symbols:
        s = s.strip().upper().replace(".NS", "")
        if s:
            normalized.append(s + ".NS")

    # ── Batch-fetch spot + IV via single shared NSE session (fast) ────────────
    import time as _time
    nse_data: dict[str, dict] = {}  # bare -> {spot, iv, expiry_dates}
    try:
        from jugaad_data.nse import NSELive
        from api.routes.covered_calls import _pick_best_expiry as _pbe
        nse_shared = NSELive()
        for sym in normalized:
            bare = sym.replace(".NS", "")
            try:
                data = nse_shared.equities_option_chain(bare)
                _time.sleep(0.05)
                rec  = data.get("records", {})
                spot = float(rec.get("underlyingValue") or 0)
                rows = data.get("filtered", {}).get("data", []) or rec.get("data", [])
                iv, _ = _find_atm_iv(rows, spot)
                if iv is None:
                    exp_dates = rec.get("expiryDates", [])
                    best_exp  = _pbe(exp_dates)
                    if best_exp:
                        try:
                            d2   = nse_shared.equities_option_chain(bare, expiry=best_exp)
                            _time.sleep(0.05)
                            r2   = d2.get("filtered", {}).get("data", []) or d2.get("records", {}).get("data", [])
                            iv, _ = _find_atm_iv(r2, spot)
                        except Exception:
                            pass
                nse_data[bare] = {"spot": spot if spot > 0 else None, "iv": iv}
            except Exception:
                nse_data[bare] = {"spot": None, "iv": None}
    except Exception:
        pass

    loop     = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=8)

    def _assess_one(sym: str) -> dict:
        bare = sym.replace(".NS", "")
        import yfinance as yf
        from data.market_data import get_info, safe_get
        try:
            # Use pre-fetched NSE data — no extra NSE call per stock
            pre   = nse_data.get(bare, {})
            cmp   = pre.get("spot") or 0
            atm_iv = pre.get("iv")

            t    = yf.Ticker(sym)
            # fast_info is much lighter than .info — avoids the 3-5s full info call
            fi   = t.fast_info
            if cmp <= 0:
                cmp = float(getattr(fi, "last_price", None) or getattr(fi, "regular_market_price", None) or 0)
            if cmp <= 0:
                return {"symbol": bare, "eligible": False, "warnings": [{"level":"high","category":"Data","message":"Could not fetch price data."}]}

            high52 = float(getattr(fi, "year_high", None) or 0)
            low52  = float(getattr(fi, "year_low",  None) or 0)

            # .info only for name/sector (these aren't in fast_info)
            info   = t.info
            name   = safe_get(info, "longName") or safe_get(info, "shortName") or bare
            if not high52: high52 = float(safe_get(info, "fiftyTwoWeekHigh") or 0)
            if not low52:  low52  = float(safe_get(info, "fiftyTwoWeekLow")  or 0)
            sector = safe_get(info, "sector") or ""

            # 5-day history only (much faster than 1y)
            hist5     = t.history(period="5d")
            change_5d = round((float(hist5["Close"].iloc[-1]) / float(hist5["Close"].iloc[0]) - 1) * 100, 2) if not hist5.empty and len(hist5) >= 2 else 0.0

            # 3-month history for 50/200 DMA (3mo ≈ 65 bars — enough for 50 DMA, skip 200 DMA)
            above_200dma = False
            sma50_val    = None
            score_adj    = 50
            hist3m = t.history(period="3mo")
            if not hist3m.empty and len(hist3m) >= 50:
                close        = hist3m["Close"]
                sma50_val    = float(close.rolling(50).mean().iloc[-1])
                above_200dma = False  # can't compute 200 DMA from 3mo, skip
                score_adj    = 60
                if cmp > sma50_val:  score_adj += 10
                if change_5d >= -1:  score_adj += 5

            lot_size = _get_lot_size(sym)

            # Build all warnings (no filters skipped)
            warnings = _build_warnings(bare, cmp, high52, low52, change_5d, above_200dma, atm_iv, min_iv)

            # Additional: 5D flat check
            if abs(change_5d) > 2.0:
                warnings.append({"level": "medium", "category": "Momentum",
                                  "message": f"Stock moved {change_5d:+.1f}% in 5 days — not flat. Covered call strategy works best on flat/consolidating stocks."})

            # 50 DMA
            if sma50_val and cmp < sma50_val * 0.92:
                warnings.append({"level": "high", "category": "Trend",
                                  "message": f"Stock is >8% below 50 DMA — potential breakdown. Averaging may extend losses."})

            # Summary eligibility (all risks combined)
            high_risks = [w for w in warnings if w["level"] == "high"]
            eligible   = len(high_risks) == 0

            pct_from_high = round((cmp / high52 - 1) * 100, 2)
            pct_from_low  = round((cmp / low52  - 1) * 100, 2)
            phase1_cost   = round((lot_size // 2) * cmp, 0)
            total_funds   = int(round(lot_size * cmp + lot_size * cmp * 0.12, 0))

            return {
                "symbol":              bare,
                "name":                name,
                "sector":              sector,
                "eligible":            eligible,
                "cmp":                 round(cmp, 2),
                "high_52w":            round(high52, 2),
                "low_52w":             round(low52, 2),
                "pct_from_high":       pct_from_high,
                "pct_from_low":        pct_from_low,
                "change_5d":           change_5d,
                "above_200dma":        above_200dma,
                "atm_iv":              atm_iv,
                "lot_size":            lot_size,
                "score":               min(100, score_adj),
                "phase1_cost":         int(phase1_cost),
                "total_funds_required":total_funds,
                "warnings":            warnings,
                "high_risk_count":     len(high_risks),
            }
        except Exception as e:
            return {"symbol": bare, "eligible": False,
                    "warnings": [{"level":"high","category":"Error","message":f"Could not analyse: {str(e)[:60]}"}]}

    tasks   = [loop.run_in_executor(executor, _assess_one, sym) for sym in normalized]
    results = await asyncio.gather(*tasks)
    # Sort: eligible first, then by high risk count asc
    sorted_results = sorted(results, key=lambda r: (not r.get("eligible", False), r.get("high_risk_count", 0)))
    return JSONResponse(content=clean_for_json({"results": sorted_results}))


def _scan_one_with_criteria(symbol: str, criteria: dict) -> dict | None:
    """Scan one stock with custom criteria including IV and results filters."""
    flat_pct        = criteria.get("flat_pct", 2.0)
    below_high_pct  = criteria.get("below_high_pct", 10.0)
    above_low_pct   = criteria.get("above_low_pct", 20.0)
    below_sma50_pct = criteria.get("below_sma50_pct", 8.0)
    min_iv          = criteria.get("min_iv", 25.0)

    import yfinance as yf
    from data.market_data import get_info, safe_get

    bare = symbol.replace(".NS", "").upper()
    try:
        t  = yf.Ticker(symbol)
        fi = t.fast_info

        # Use pre-fetched NSE spot — skip extra NSE call
        spot_map = criteria.get("spot_map", {})
        cmp = float(spot_map.get(bare) or 0)
        if cmp <= 0:
            cmp = float(getattr(fi, "last_price", None) or getattr(fi, "regular_market_price", None) or 0)
        if cmp <= 0:
            return None

        high52 = float(getattr(fi, "year_high", None) or 0)
        low52  = float(getattr(fi, "year_low",  None) or 0)
        if not high52 or not low52:
            return None

        # name/sector — only fetched if stock passes price filters (lazy)
        hist5 = t.history(period="5d")
        if hist5.empty or len(hist5) < 3:
            return None
        change_5d = round((float(hist5["Close"].iloc[-1]) / float(hist5["Close"].iloc[0]) - 1) * 100, 2)
        if abs(change_5d) > flat_pct:
            return None

        pct_from_high = round((cmp / high52 - 1) * 100, 2)
        if pct_from_high > -below_high_pct:
            return None

        pct_from_low = round((cmp / low52 - 1) * 100, 2)
        if pct_from_low < above_low_pct:
            return None

        lot_size = _get_lot_size(symbol)

        # 3-month history is enough for 50 DMA (65 bars) — much faster than 1y
        hist3m = t.history(period="3mo")
        above_200dma = False
        score_adj    = 50
        if not hist3m.empty and len(hist3m) >= 50:
            close    = hist3m["Close"]
            sma50    = float(close.rolling(50).mean().iloc[-1])
            above_200dma = False  # can't compute 200 DMA from 3mo
            if cmp < sma50 * (1 - below_sma50_pct / 100):
                return None
            score_adj = 60
            if cmp > sma50:     score_adj += 10
            if change_5d >= -1: score_adj += 5

        # Fetch name/sector only after all quick filters passed
        info   = t.info
        name   = safe_get(info, "longName") or safe_get(info, "shortName") or bare
        sector = safe_get(info, "sector") or ""

        # ── IV filter — use pre-fetched IV map (reliable) ─────────────────
        iv_map   = criteria.get("iv_map", {})
        atm_iv   = iv_map.get(bare) if iv_map else None
        if min_iv > 0 and atm_iv is not None and atm_iv < min_iv:
            return None  # confirmed low IV — exclude

        # ── Upcoming results check — only exclude if event within 21 days ──
        upcoming_event = _get_upcoming_event(bare, days=21)
        if upcoming_event:
            return None  # imminent IV spike risk

        phase1_qty   = lot_size // 2
        phase1_cost  = round(phase1_qty * cmp, 0)
        avg_trigger  = round(cmp * 0.97, 2)
        phase2_qty   = lot_size - phase1_qty
        phase2_cost  = round(phase2_qty * avg_trigger, 0)
        full_lot_val = round(lot_size * cmp, 0)
        margin_est   = round(cmp * lot_size * 0.12, 0)
        total_funds  = int(full_lot_val + margin_est)

        return {
            "symbol":              bare,
            "name":                name,
            "sector":              sector,
            "cmp":                 round(cmp, 2),
            "high_52w":            round(high52, 2),
            "low_52w":             round(low52, 2),
            "pct_from_high":       pct_from_high,
            "pct_from_low":        pct_from_low,
            "change_5d":           change_5d,
            "above_200dma":        above_200dma,
            "atm_iv":              atm_iv,
            "lot_size":            lot_size,
            "phase1_qty":          phase1_qty,
            "phase1_cost":         int(phase1_cost),
            "total_funds_required":total_funds,
            "margin_estimate":     int(margin_est),
            "strike_8pct":         round(cmp * 1.08 / 5) * 5,
            "strike_10pct":        round(cmp * 1.10 / 5) * 5,
            "score":               min(100, score_adj),
        }
    except Exception:
        return None




@router.get("/covered-calls/plan/{symbol}")
async def get_cc_plan(
    symbol:          str,
    premium:         float = Query(default=0,   description="CE premium override (0 = auto from NSE)"),
    avg_pct:         float = Query(default=3.0, description="% drop to trigger 2nd chunk"),
    expiry:          str   = Query(default="",  description="Expiry e.g. 25-Aug-2026"),
    lots:            int   = Query(default=1,   description="Number of lots to trade"),
    strike_override: float = Query(default=0,   description="Override strike (0 = auto delta-targeted)"),
):
    """Generate covered call trade plan with 4-scenario P&L."""
    from datetime import date as date_cls, datetime as dt_cls
    import yfinance as yf
    from data.market_data import get_info, safe_get
    from api.routes.covered_calls import _fetch_option_chain, _parse_chain, _pick_best_expiry

    bare = symbol.upper().replace(".NS", "")
    sym  = bare + ".NS"

    loop     = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=2)

    def _fetch():
        t      = yf.Ticker(sym)
        fi     = t.fast_info
        # Use fast_info for 52W range (avoids slow full .info call)
        high52 = float(getattr(fi, "year_high", None) or 0)
        low52  = float(getattr(fi, "year_low",  None) or 0)
        # Still need .info for name — but only fetch it once
        info   = t.info
        name   = safe_get(info, "longName") or safe_get(info, "shortName") or bare
        if not high52: high52 = float(safe_get(info, "fiftyTwoWeekHigh") or 0)
        if not low52:  low52  = float(safe_get(info, "fiftyTwoWeekLow")  or 0)
        hist5  = t.history(period="5d")
        chg5   = round((float(hist5["Close"].iloc[-1]) / float(hist5["Close"].iloc[0]) - 1) * 100, 2) if not hist5.empty and len(hist5) >= 2 else 0.0
        # Also get spot from fast_info as fallback
        fallback_spot = float(getattr(fi, "last_price", None) or getattr(fi, "regular_market_price", None) or safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or 0)
        return name, high52, low52, chg5, fallback_spot

    # Run NSE spot fetch and yfinance fetch in parallel
    spot_future  = loop.run_in_executor(executor, _get_live_spot, bare)
    yf_future    = loop.run_in_executor(executor, _fetch)
    spot_raw, (name, high52, low52, change_5d, fallback_spot) = await asyncio.gather(spot_future, yf_future)

    spot = spot_raw or fallback_spot
    if not spot:
        raise HTTPException(status_code=404, detail=f"No price data for {bare}")

    lot_size  = _get_lot_size(sym)

    # ── Get live option chain to find best strike + premium ────────────────────
    actual_premium = premium
    actual_strike  = 0
    actual_expiry  = expiry
    days_to_expiry = 0
    expiry_dates   = []
    best_greek_row: dict | None = None
    strikes: list   = []

    try:
        raw = _fetch_option_chain(sym)
        rec = raw.get("records", {})
        expiry_dates = rec.get("expiryDates", [])

        # Pick best expiry (24-50 days)
        if not expiry:
            actual_expiry = _pick_best_expiry(expiry_dates) or (expiry_dates[0] if expiry_dates else "")

        # Fetch that specific expiry using a fresh NSE instance to avoid caching
        if actual_expiry:
            raw_exp = _fetch_chain_for_plan(sym, actual_expiry)
            parsed  = _parse_chain(raw_exp, expiry_filter=actual_expiry)
            strikes = parsed.get("strikes", [])

        # Days to expiry — compute directly from the expiry string (most reliable)
        if actual_expiry:
            for fmt_str in ["%d-%b-%Y", "%d-%m-%Y", "%d-%B-%Y"]:
                try:
                    exp_dt = dt_cls.strptime(actual_expiry, fmt_str).date()
                    days_to_expiry = (exp_dt - date_cls.today()).days
                    break
                except Exception:
                    continue

            # ── Delta-targeted strike selection ──────────────────────────────
            # Find strike closest to delta 0.20–0.25 (sweet spot for covered calls)
            best_greek_row = _find_delta_target_strike(
                strikes, spot, days_to_expiry or 44,
                target_delta=0.225, min_oi=5
            )

            if best_greek_row:
                actual_strike  = best_greek_row["strike"]
                actual_premium = best_greek_row["ltp"] if actual_premium == 0 else actual_premium
            else:
                # Fallback: 8% OTM
                actual_strike = round(spot * 1.08 / 5) * 5
                if actual_premium == 0:
                    actual_premium = round(spot * 0.025, 1)
    except Exception:
        if actual_strike == 0:
            actual_strike = round(spot * 1.08 / 5) * 5
        if actual_premium == 0:
            actual_premium = round(spot * 0.025, 1)

    strike      = actual_strike or round(spot * 1.08 / 5) * 5
    # Apply user strike override — always find premium from that strike's chain data
    if strike_override > 0:
        strike = strike_override
        override_row = next((s for s in strikes if abs(s["strike"] - strike_override) < 0.1), None)
        if override_row:
            # Always use the override strike's live premium (ignore any previously set premium)
            actual_premium = override_row["ce"]["ltp"] if override_row["ce"]["ltp"] > 0 else actual_premium
    premium_val = actual_premium or round(spot * 0.025, 1)

    # Collect adjacent strikes — 5 strikes centred on chosen, sorted ascending
    # Returns all as a flat sorted list; frontend marks which is recommended
    adjacent_strikes = []
    if strikes:
        otm_strikes = sorted(
            [s for s in strikes if s["strike"] > spot and s["ce"]["ltp"] > 0],
            key=lambda s: s["strike"]
        )
        chosen_idx = next((i for i, s in enumerate(otm_strikes) if abs(s["strike"] - strike) < 0.1), -1)
        if chosen_idx < 0 and otm_strikes:
            # Find closest
            chosen_idx = min(range(len(otm_strikes)), key=lambda i: abs(otm_strikes[i]["strike"] - strike))

        # Take 2 below + chosen + 2 above, sorted ascending
        indices = sorted(set(
            [max(0, chosen_idx + o) for o in range(-2, 3)]
        ))
        for idx in indices:
            if 0 <= idx < len(otm_strikes):
                s   = otm_strikes[idx]
                iv  = s["ce"]["iv"]
                ltp = s["ce"]["ltp"]
                g   = _bs_greeks(spot, s["strike"], iv, days_to_expiry or 44) if iv > 0 else {}
                adjacent_strikes.append({
                    "strike":  s["strike"],
                    "ltp":     ltp,
                    "iv":      iv,
                    "delta":   g.get("delta"),
                    "pct_otm": round((s["strike"] / spot - 1) * 100, 1),
                    "is_recommended": abs(s["strike"] - strike) < 0.1,
                })

    lots        = max(1, lots)  # safety

    # ── Greeks for the chosen strike ──────────────────────────────────────────
    chosen_iv     = best_greek_row["iv"] if best_greek_row else 35.0
    chosen_greeks = best_greek_row or _bs_greeks(spot, strike, chosen_iv, days_to_expiry or 44)
    delta = chosen_greeks.get("delta", 0.22)
    theta = chosen_greeks.get("theta", -0.15)
    vega  = chosen_greeks.get("vega",   0.30)
    gamma = chosen_greeks.get("gamma",  0.002)

    # ── IV spike risk assessment ───────────────────────────────────────────────
    iv_spike = _iv_spike_risk(bare, actual_expiry, chosen_iv)

    # ── Position sizing (scaled by lots) ──────────────────────────────────────
    total_shares  = lot_size * lots
    phase1_qty    = (lot_size // 2) * lots
    phase2_qty    = total_shares - phase1_qty
    phase1_cost   = round(phase1_qty * spot, 0)
    avg_trigger   = round(spot * (1 - avg_pct / 100), 2)
    phase2_cost   = round(phase2_qty * avg_trigger, 0)
    avg_cost      = round((phase1_qty * spot + phase2_qty * avg_trigger) / total_shares, 2)

    # Total funds = buy full lot(s) + CE margin per lot
    full_lot_val  = round(total_shares * spot, 0)
    margin_est    = round(spot * total_shares * 0.12, 0)
    total_funds   = int(full_lot_val + margin_est)

    # Premium income (sell `lots` full lots of CE)
    premium_income = round(premium_val * total_shares, 0)

    # ── Greeks explanation (needs total_shares, so computed here) ─────────────
    theta_daily_income = round(abs(theta) * total_shares, 0)
    vega_loss_per_1pct = round(abs(vega)  * total_shares, 0)
    greeks_summary = {
        "delta": {
            "value":   round(delta, 3),
            "label":   f"{round(delta*100,1)}% chance of assignment",
            "meaning": f"For every ₹1 rise in {bare}, CE gains ₹{round(delta,2)}. As seller, you need stock to stay BELOW ₹{strike} — {round((1-delta)*100,1)}% probability it stays OTM.",
            "verdict": "Good ✓" if 0.15 <= delta <= 0.30 else "High risk — consider higher strike" if delta > 0.35 else "Too low — premium may not be worth it",
        },
        "theta": {
            "value":   round(theta, 2),
            "label":   f"+₹{theta_daily_income:,}/day time decay income",
            "meaning": f"CE loses ₹{abs(theta):.2f}/share per day due to time decay — YOU earn this as seller. On {total_shares:,} shares: +₹{theta_daily_income:,}/day. Theta accelerates sharply in last 14 days before expiry.",
            "verdict": "Working in your favour ✓",
        },
        "vega": {
            "value":   round(vega, 2),
            "label":   f"-₹{vega_loss_per_1pct:,} if IV rises 1%",
            "meaning": f"If IV rises 1%, CE price rises ₹{vega:.2f}/share — paper loss of ₹{vega_loss_per_1pct:,} on your short position. Results/events cause sudden IV spikes of 20-50% — avoid selling before such events.",
            "verdict": "⚠ Risk to monitor" if chosen_iv > 45 or iv_spike["risk_level"] == "high" else "Manageable ✓",
        },
        "gamma": {
            "value":   round(gamma, 5),
            "label":   f"Delta accelerates {round(gamma*10,4)}/₹10 move",
            "meaning": f"How fast delta changes with price. Low gamma ({round(gamma,4)}) = CE delta responds slowly to price moves — good for OTM sellers. Gamma spikes near expiry when stock approaches strike.",
            "verdict": "Low — good for OTM sellers ✓" if gamma < 0.005 else "Elevated — watch closely near expiry",
        },
        "iv_current": {
            "value":   chosen_iv,
            "label":   iv_spike["iv_assessment"],
            "meaning": f"IV at {chosen_iv:.0f}% determines premium richness. {'Good time to sell — premium is rich and you collect more income.' if chosen_iv > 38 else 'Acceptable range for selling.' if chosen_iv >= 28 else 'Premium is thin — consider waiting for IV to expand before selling.'}",
            "verdict": iv_spike["iv_assessment"],
        },
    }

    # Effective entry after premium
    effective_entry = round(spot - (premium_income / phase1_qty), 2)
    breakeven       = effective_entry

    # ── Probability calculations (Black-Scholes using live IV) ────────────────
    # Get ATM IV for probability estimation
    atm_iv = 35.0  # fallback
    try:
        for s in (strikes or []):
            pct = abs(s["strike"] - spot) / spot * 100
            iv  = s["ce"]["iv"]
            if pct <= 3 and iv > 0:
                atm_iv = iv
                break
    except Exception:
        pass

    stress_price  = round(spot * 0.88, 2)

    # Scenario probabilities (mutually exclusive, sum to 100)
    p1 = _prob_above(spot, strike,      atm_iv, days_to_expiry or 44)  # above strike
    p4 = _prob_below(spot, stress_price,atm_iv, days_to_expiry or 44)  # below stress
    p3 = round((_ncdf(_d2(spot, stress_price, atm_iv, days_to_expiry or 44))
                - _ncdf(_d2(spot, avg_trigger,  atm_iv, days_to_expiry or 44))) * 100, 1)
    p2 = round(max(0.0, 100 - p1 - p3 - p4), 1)

    price_range = _price_range(spot, atm_iv, days_to_expiry or 44)

    # ── Fetch historical expiry-cycle data to enhance price range ─────────────
    hist_expiry_p90_up   = None
    hist_expiry_p90_down = None
    hist_max_cycle_up    = None
    hist_max_cycle_down  = None
    try:
        import yfinance as _yf
        import pandas as _pd
        from datetime import date as _date, timedelta as _td, datetime as _dt
        import calendar as _cal

        def _last_thu(yr, mn):
            last = _cal.monthrange(yr, mn)[1]
            d = _date(yr, mn, last)
            while d.weekday() != 3: d -= _td(days=1)
            return d

        _full = _yf.Ticker(sym).history(period="1y")
        if not _full.empty:
            _full.index = _pd.to_datetime(_full.index.date)
            _fc = _full["Close"]
            _today = _date.today()
            _expiries = []
            for _off in range(14, -1, -1):
                _yr, _mn = _today.year, _today.month - _off
                while _mn <= 0: _mn += 12; _yr -= 1
                _expiries.append(_last_thu(_yr, _mn))

            _cycle_ups, _cycle_downs = [], []
            for _i in range(len(_expiries) - 1):
                _sp = _fc[_fc.index >= _pd.Timestamp(_expiries[_i])]
                _ep = _fc[_fc.index >= _pd.Timestamp(_expiries[_i + 1])]
                if _sp.empty or _ep.empty: continue
                _s = float(_sp.iloc[0])
                _ws = _full[(_full.index >= _pd.Timestamp(_expiries[_i])) &
                            (_full.index <= _pd.Timestamp(_expiries[_i + 1]))]
                if _ws.empty: continue
                _wh = float(_ws["High"].max())
                _wl = float(_ws["Low"].min())
                _up   = round((_wh / _s - 1) * 100, 1)
                _down = round((_wl / _s - 1) * 100, 1)
                _cycle_ups.append(_up)
                _cycle_downs.append(_down)

            if _cycle_ups:
                _cycle_ups.sort(reverse=True)
                _cycle_downs.sort()
                p90_idx = max(0, int(len(_cycle_ups) * 0.1))
                hist_expiry_p90_up   = _cycle_ups[p90_idx]
                hist_expiry_p90_down = _cycle_downs[p90_idx]
                hist_max_cycle_up    = _cycle_ups[0]
                hist_max_cycle_down  = _cycle_downs[0]
    except Exception:
        pass

    price_range = _price_range(
        spot, atm_iv, days_to_expiry or 44,
        hist_max_up=hist_max_cycle_up,
        hist_max_down=hist_max_cycle_down,
        hist_expiry_p90_up=hist_expiry_p90_up,
        hist_expiry_p90_down=hist_expiry_p90_down,
    )

    # ── Scenario P&L ──────────────────────────────────────────────────────────

    # Case 1: Stock rises to strike
    c1_stock_pnl    = round(phase1_qty * (strike - spot), 0)
    c1_ce_buy_back  = round(premium_val * 1.8 * total_shares, 0)
    c1_ce_loss      = int(c1_ce_buy_back - premium_income)
    c1_if_assigned  = int(phase1_qty * (strike - spot) + premium_income)
    c1_return_pct   = round(c1_if_assigned / phase1_cost * 100, 2)

    # Case 2: Stock flat
    c2_profit   = int(premium_income)
    c2_ret_pct  = round(c2_profit / phase1_cost * 100, 2)

    # Case 3: Stock falls avg_pct%
    c3_ce_profit     = int(premium_income * 0.9)
    c3_phase1_unreal = round(phase1_qty * (avg_trigger - spot), 0)
    c3_prob_loss     = int(c3_phase1_unreal)

    # Case 4: Breakdown to -12%
    c4_ce_profit = int(premium_income)
    c4_unreal    = round(total_shares * (stress_price - avg_cost), 0)
    c4_prob_loss = int(c4_unreal)

    probable_loss_note = f"Unrealised ₹{abs(c4_unreal):,} if stock falls 12% and held. No hard stop-loss — sell CEs monthly to recover."

    return JSONResponse(content=clean_for_json({
        "symbol":       bare,
        "name":         name,
        "cmp":          round(spot, 2),
        "high_52w":     round(high52, 2),
        "low_52w":      round(low52, 2),
        "change_5d":    change_5d,
        "lot_size":     lot_size,
        "lots":         lots,
        "total_shares": total_shares,
        "avg_pct":      avg_pct,

        "trade_setup": {
            "phase1_qty":          phase1_qty,
            "phase1_entry":        round(spot, 2),
            "phase1_limit_default":round(spot, 2),      # user can adjust
            "phase1_cost":         int(phase1_cost),
            "strike_recommended":  strike,
            "strike_conservative": round(spot * 1.10 / 5) * 5,
            "expiry":              actual_expiry,
            "days_to_expiry":      days_to_expiry,
            "premium_live":        round(premium_val, 2),
            "premium_limit_default":round(premium_val, 2),  # user can adjust
            "premium_income":      int(premium_income),
            "effective_entry":     effective_entry,
            "breakeven":           breakeven,
            "expiry_note":         f"Enter first week after next expiry. Recommended: {actual_expiry} ({days_to_expiry} days)",
        },

        "averaging": {
            "phase2_trigger":       avg_trigger,
            "phase2_trigger_pct":   -round(avg_pct, 1),
            "phase2_qty":           phase2_qty,
            "phase2_entry":         avg_trigger,
            "phase2_limit_default": avg_trigger,  # user can adjust
            "phase2_cost":          int(phase2_cost),
            "avg_cost_after":       avg_cost,
        },

        "adjacent_strikes":    adjacent_strikes,

        "funds": {
            "phase1_only":         int(phase1_cost),
            "full_lot_stock":      int(full_lot_val),
            "ce_margin_estimate":  int(margin_est),
            "total_funds_required":total_funds,
            "note":               "Total = Buy full lot (both phases) + SPAN margin for short CE (~12% of contract value)",
        },

        "scenarios": {
            "case1_bull": {
                "label":         f"Stock rises above strike ₹{strike}",
                "target_price":  strike,
                "probability":   p1,
                "stock_pnl":     int(c1_stock_pnl),
                "ce_loss":       -abs(c1_ce_loss),
                "max_profit":    c1_if_assigned,
                "probable_loss": 0,
                "return_pct":    c1_return_pct,
                "action":        f"If assigned: stock called at ₹{strike}, profit ₹{c1_if_assigned:,}. Or buy back CE and hold stock.",
            },
            "case2_flat": {
                "label":         f"Stock stays flat (₹{avg_trigger}–₹{strike})",
                "target_price":  round(spot, 2),
                "probability":   p2,
                "max_profit":    c2_profit,
                "probable_loss": 0,
                "return_pct":    c2_ret_pct,
                "action":        f"CE expires worthless. Sell next expiry CE (delta ~0.2) in first week. Compound ₹{c2_profit:,}/month.",
            },
            "case3_dip": {
                "label":             f"Stock dips {avg_pct}% to ₹{avg_trigger}–₹{stress_price}",
                "target_price":      avg_trigger,
                "probability":       p3,
                "ce_profit":         c3_ce_profit,
                "phase1_unrealised": int(c3_phase1_unreal),
                "new_avg_cost":      avg_cost,
                "max_profit":        c3_ce_profit,
                "probable_loss":     abs(int(c3_phase1_unreal)),
                "action":            f"Book CE profit ₹{c3_ce_profit:,}. Add {phase2_qty} shares @ ₹{avg_trigger}. New avg ₹{avg_cost}. Sell Sep CE.",
            },
            "case4_breakdown": {
                "label":            f"Breakdown below ₹{stress_price} (-12%+)",
                "target_price":     stress_price,
                "probability":      p4,
                "ce_profit":        c4_ce_profit,
                "stock_unrealised": int(c4_unreal),
                "avg_cost":         avg_cost,
                "max_profit":       c4_ce_profit,
                "probable_loss":    abs(int(c4_unreal)),
                "action":           f"Book CE ₹{c4_ce_profit:,}. Hold {total_shares} shares @ avg ₹{avg_cost}. Keep selling CEs each month. No hard stop-loss.",
            },
        },

        "price_range": {
            **price_range,
            "days_to_expiry": days_to_expiry or 44,
            "hist_max_cycle_up":    hist_max_cycle_up,
            "hist_max_cycle_down":  hist_max_cycle_down,
            "hist_expiry_p90_up":   hist_expiry_p90_up,
            "hist_expiry_p90_down": hist_expiry_p90_down,
            "note": (
                f"IV model ({round(atm_iv,1)}%): 68% range ₹{price_range['low_1sd']:,.0f}–₹{price_range['high_1sd']:,.0f}. "
                + (f"Historical blended (wider of IV vs actual expiry cycles): ₹{price_range['low_1sd_blended']:,.0f}–₹{price_range['high_1sd_blended']:,.0f}. "
                   f"Worst historical cycle: +{hist_max_cycle_up:.1f}% / {hist_max_cycle_down:.1f}%."
                   if price_range.get("has_historical")
                   else "No historical expiry data available — using IV model only.")
            ),
        },

        "greeks": greeks_summary,

        "iv_spike_risk": iv_spike,

        "summary": {
            "max_profit":              c1_if_assigned,
            "max_profit_case":         f"Case 1 — {p1}% probability",
            "probable_loss_breakdown": abs(int(c4_unreal)),
            "probable_loss_note":      probable_loss_note,
            "margin_note":             f"SPAN margin ≈ ₹{int(margin_est):,} (approx 12% of ₹{int(spot * total_shares):,} contract value for {lots} lot{'s' if lots > 1 else ''}). Verify with broker.",
        },
    }))
