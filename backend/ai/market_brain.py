"""
AI Market Brain — assesses market conditions and plans Iron Fly / Iron Condor trades.

Responsibilities:
  1. gather_market_data()        — yfinance: Nifty, VIX, S&P, INR/USD, Crude
  2. assess_market(data)         — LLM prompt → structured assessment
  3. get_monthly_expiry(sym, dte_target) — jugaad NSELive → monthly expiry at ~35-40 DTE
  4. plan_iron_fly(...)           — 4-leg Iron Fly strike plan
  5. plan_iron_condor(...)        — 4-leg Iron Condor strike plan
  6. fetch_option_premium(sym, expiry, strike, option_type) — live LTP from option chain
"""

from __future__ import annotations

import json
import math
import time
from datetime import date, datetime, timezone
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────────

LOT_SIZE: dict[str, int] = {
    "NIFTY":     25,
    "BANKNIFTY": 15,
}

STRIKE_STEP: dict[str, int] = {
    "NIFTY":     50,
    "BANKNIFTY": 100,
}

# Assessment cache: avoid hammering LLM on every click
_assess_cache: dict[str, dict] = {}
_ASSESS_TTL = 1800  # 30 minutes

# Option chain cache (per symbol+expiry): 5-minute TTL
_chain_cache: dict[str, dict] = {}
_CHAIN_TTL = 300


# ── Helpers ───────────────────────────────────────────────────────────────────

def _round_strike(price: float, symbol: str) -> float:
    step = STRIKE_STEP.get(symbol.upper(), 50)
    return round(price / step) * step


def _days_to(expiry_str: str) -> int:
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d", "%b %Y"):
        try:
            exp = datetime.strptime(expiry_str, fmt).date()
            return max(0, (exp - date.today()).days)
        except ValueError:
            pass
    return 0


def _is_monthly(expiry_str: str) -> bool:
    """True if expiry is the last Thursday of its month (NSE monthly expiry)."""
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(expiry_str, fmt).date()
            # Last Thursday: check if no Thursday in the same month after this date
            nxt = date(dt.year + (dt.month // 12), (dt.month % 12) + 1, 1)
            last_thu = max(
                d for d in range(dt.day, (nxt - dt).days + dt.day)
                if date(dt.year, dt.month, d).weekday() == 3  # Thursday
            )
            return dt.day == last_thu
        except Exception:
            pass
    return False


# ── Market Data ───────────────────────────────────────────────────────────────

def gather_market_data() -> dict:
    """Fetch macro market indicators via yfinance."""
    import yfinance as yf

    result: dict[str, Any] = {"fetched_at": datetime.now(timezone.utc).isoformat()}

    def _pct_change(hist, days: int) -> float | None:
        if hist is None or hist.empty or len(hist) < 2:
            return None
        close = hist["Close"]
        window = min(days, len(close) - 1)
        if window < 1:
            return None
        return round((float(close.iloc[-1]) - float(close.iloc[-window])) / float(close.iloc[-window]) * 100, 2)

    def _last(hist) -> float | None:
        if hist is None or hist.empty:
            return None
        return round(float(hist["Close"].iloc[-1]), 2)

    def _sma(hist, n: int) -> float | None:
        if hist is None or hist.empty or len(hist) < n:
            return None
        v = float(hist["Close"].rolling(n).mean().iloc[-1])
        return round(v, 2) if not math.isnan(v) else None

    def _atr(hist, n: int = 20) -> float | None:
        if hist is None or hist.empty or len(hist) < n + 1:
            return None
        h = hist["High"]
        l = hist["Low"]
        c = hist["Close"]
        tr = (h - l).combine(abs(h - c.shift()), max).combine(abs(l - c.shift()), max)
        atr = tr.rolling(n).mean().iloc[-1]
        return round(float(atr), 2) if not math.isnan(float(atr)) else None

    tickers = {
        "nifty": "^NSEI",
        "vix":   "^INDIAVIX",
        "sp500": "^GSPC",
        "inrusd": "USDINR=X",
        "crude": "CL=F",
        "banknifty": "^NSEBANK",
    }

    hists: dict[str, Any] = {}
    try:
        dl = yf.download(list(tickers.values()), period="3mo", group_by="ticker",
                         auto_adjust=True, progress=False, threads=True)
        for key, sym in tickers.items():
            try:
                if sym in dl.columns.get_level_values(0):
                    hists[key] = dl[sym]
                elif hasattr(dl, "columns") and "Close" in dl.columns:
                    hists[key] = dl
                else:
                    hists[key] = None
            except Exception:
                hists[key] = None
    except Exception:
        # Fallback: fetch individually
        for key, sym in tickers.items():
            try:
                hists[key] = yf.Ticker(sym).history(period="3mo", auto_adjust=True)
            except Exception:
                hists[key] = None

    # Nifty
    nh = hists.get("nifty")
    result["nifty_spot"]    = _last(nh)
    result["nifty_5d_ret"]  = _pct_change(nh, 5)
    result["nifty_20d_ret"] = _pct_change(nh, 20)
    result["nifty_sma20"]   = _sma(nh, 20)
    result["nifty_atr20"]   = _atr(nh, 20)

    # BankNifty
    bh = hists.get("banknifty")
    result["banknifty_spot"]   = _last(bh)
    result["banknifty_5d_ret"] = _pct_change(bh, 5)

    # VIX
    vh = hists.get("vix")
    result["india_vix"]     = _last(vh)
    result["vix_sma20"]     = _sma(vh, 20)
    result["vix_5d_ret"]    = _pct_change(vh, 5)

    # Global
    result["sp500_5d_ret"]  = _pct_change(hists.get("sp500"), 5)
    result["inrusd_rate"]   = _last(hists.get("inrusd"))
    result["inrusd_5d_ret"] = _pct_change(hists.get("inrusd"), 5)
    result["crude_5d_ret"]  = _pct_change(hists.get("crude"), 5)

    return result


# ── Market Assessment (LLM) ───────────────────────────────────────────────────

def assess_market(data: dict) -> dict:
    """Call LLM with gathered market data. Returns structured assessment dict."""
    cache_key = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H") + str(int(time.time() // _ASSESS_TTL))
    cached = _assess_cache.get(cache_key)
    if cached:
        return cached

    result = _rule_assess(data)
    try:
        from ai.llm_client import call_llm, is_configured
        if is_configured():
            llm_result = _llm_assess(data, call_llm)
            if llm_result:
                result = llm_result
    except Exception:
        pass

    _assess_cache.clear()
    _assess_cache[cache_key] = result
    return result


def _rule_assess(data: dict) -> dict:
    """Fallback rule-based assessment when LLM is unavailable."""
    vix = data.get("india_vix") or 16.0
    nifty_5d = data.get("nifty_5d_ret") or 0.0
    sp500_5d = data.get("sp500_5d_ret") or 0.0

    if vix < 13:
        strategy = "WAIT"
        iv_regime = "LOW"
        trend = "NEUTRAL"
    elif vix > 22:
        strategy = "WAIT"
        iv_regime = "EXTREME"
        trend = "NEUTRAL"
    elif abs(nifty_5d) > 1.5:
        iv_regime = "HIGH" if vix > 17 else "NORMAL"
        if nifty_5d > 0:
            trend = "BULLISH"
            strategy = "BULL_PUT_SPREAD"
        else:
            trend = "BEARISH"
            strategy = "BEAR_CALL_SPREAD"
    else:
        trend = "NEUTRAL"
        if vix >= 17:
            iv_regime = "HIGH"
            strategy = "IRON_FLY"
        else:
            iv_regime = "NORMAL"
            strategy = "IRON_CONDOR"

    underlying = "BANKNIFTY" if (vix > 17 and (data.get("banknifty_spot") or 0) > 0) else "NIFTY"

    return {
        "trend":                trend,
        "iv_regime":            iv_regime,
        "recommended_strategy": strategy,
        "underlying":           underlying,
        "entry_timing":         "Wait for market open and confirm direction" if trend != "NEUTRAL" else "Entry today if IV holds",
        "risks":                _rule_risks(data),
        "reasoning":            [
            f"India VIX at {vix:.1f} — {iv_regime.lower()} IV regime",
            f"Nifty 5-day return: {nifty_5d:+.2f}%",
            f"S&P 500 5-day return: {sp500_5d:+.2f}%",
        ],
        "ai_powered": False,
    }


def _rule_risks(data: dict) -> list[str]:
    risks = []
    vix = data.get("india_vix") or 16.0
    if vix > 20:
        risks.append("VIX elevated — premium selling risky, prefer smaller size")
    crude = data.get("crude_5d_ret") or 0.0
    if abs(crude) > 5:
        risks.append(f"Crude oil moved {crude:+.1f}% this week — macro uncertainty")
    inrusd = data.get("inrusd_5d_ret") or 0.0
    if abs(inrusd) > 1.5:
        risks.append(f"INR/USD moved {inrusd:+.2f}% — FII flow risk")
    return risks


def _llm_assess(data: dict, call_llm) -> dict | None:
    today = date.today().strftime("%d %B %Y")
    prompt = f"""You are an expert NSE options strategist. Today is {today}.

Market data:
- Nifty spot: {data.get('nifty_spot', 'N/A')} | 5-day return: {data.get('nifty_5d_ret', 'N/A')}% | 20-day return: {data.get('nifty_20d_ret', 'N/A')}%
- India VIX: {data.get('india_vix', 'N/A')} | VIX 20-day avg: {data.get('vix_sma20', 'N/A')} | VIX 5-day change: {data.get('vix_5d_ret', 'N/A')}%
- BankNifty spot: {data.get('banknifty_spot', 'N/A')} | 5-day return: {data.get('banknifty_5d_ret', 'N/A')}%
- S&P 500 5-day: {data.get('sp500_5d_ret', 'N/A')}%
- INR/USD rate: {data.get('inrusd_rate', 'N/A')} | 5-day change: {data.get('inrusd_5d_ret', 'N/A')}%
- Crude oil 5-day: {data.get('crude_5d_ret', 'N/A')}%
- Nifty ATR-20: {data.get('nifty_atr20', 'N/A')}

Strategy selection rules:
- VIX < 13 → WAIT (low IV, not worth selling premium)
- VIX 13-17 and neutral trend → IRON_CONDOR
- VIX 17-22 and neutral trend → IRON_FLY (higher premium, narrower profit zone)
- VIX > 22 → WAIT (extreme volatility)
- Strong bullish trend (>1.5% 5-day) → BULL_PUT_SPREAD
- Strong bearish trend (<-1.5% 5-day) → BEAR_CALL_SPREAD
- Major event (RBI/Fed meeting) within 7 days → WAIT
- Pick BANKNIFTY when VIX > 17 and banking sector premiums justify margin; otherwise NIFTY

Respond ONLY with valid JSON (no markdown, no explanation):
{{
  "trend": "NEUTRAL|BULLISH|BEARISH",
  "iv_regime": "LOW|NORMAL|HIGH|EXTREME",
  "recommended_strategy": "IRON_FLY|IRON_CONDOR|BULL_PUT_SPREAD|BEAR_CALL_SPREAD|WAIT",
  "underlying": "NIFTY|BANKNIFTY",
  "entry_timing": "one sentence",
  "risks": ["risk1", "risk2", "risk3"],
  "reasoning": ["bullet1", "bullet2", "bullet3", "bullet4"],
  "ai_powered": true
}}"""

    system = "NSE options strategist. Respond only with valid JSON, no markdown fences."
    try:
        raw = call_llm(prompt, system=system, max_tokens=600)
        # Strip markdown fences if LLM adds them
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = json.loads(raw)
        parsed.setdefault("ai_powered", True)
        return parsed
    except Exception:
        return None


# ── Option Chain ──────────────────────────────────────────────────────────────

def get_option_chain(symbol: str) -> dict:
    """Fetch NSE index option chain. Returns raw chain dict. Cached for 5 min."""
    key = f"{symbol.upper()}:{date.today().isoformat()}"
    cached = _chain_cache.get(key)
    if cached and time.time() - cached.get("_ts", 0) < _CHAIN_TTL:
        return cached

    from jugaad_data.nse import NSELive
    nse = NSELive()
    sym = symbol.upper().replace("NIFTY 50", "NIFTY").replace("NIFTY50", "NIFTY")
    data = nse.index_option_chain(sym)
    data["_ts"] = time.time()
    _chain_cache[key] = data
    return data


def get_monthly_expiry(symbol: str = "NIFTY", dte_target: int = 37) -> tuple[str, int]:
    """
    Select the NSE monthly expiry nearest to dte_target (prefer 30-50 DTE).
    Returns (expiry_str, actual_dte).
    """
    try:
        chain = get_option_chain(symbol)
        expiries: list[str] = chain.get("records", {}).get("expiryDates", [])
        if not expiries:
            return "", dte_target

        # Score each expiry by proximity to dte_target, prefer monthly
        best = ("", 0, float("inf"))
        for e in expiries:
            dte = _days_to(e)
            if dte < 25 or dte > 60:
                continue
            monthly_bonus = 0 if _is_monthly(e) else 5  # weekly penalty
            score = abs(dte - dte_target) + monthly_bonus
            if score < best[2]:
                best = (e, dte, score)

        if best[0]:
            return best[0], best[1]

        # Relax range if nothing found
        for e in expiries:
            dte = _days_to(e)
            if 20 <= dte <= 70:
                return e, dte

        return expiries[0] if expiries else ("", dte_target)
    except Exception:
        return "", dte_target


def fetch_option_premium(
    symbol: str,
    expiry: str,
    strike: float,
    option_type: str,
    spot: float = 0.0,
    iv: float = 16.0,
    dte: int = 35,
) -> float:
    """
    Fetch option last-traded price from NSE chain.

    Uses records.data (all strikes) as primary source.
    Falls back to Black-Scholes when lastPrice is 0 (market closed, no trades).
    """
    best_ltp = 0.0
    best_iv  = 0.0
    try:
        chain = get_option_chain(symbol)
        # Use records.data (all strikes+expiries) as primary — filtered.data omits OTM wings
        rows = (chain.get("records", {}).get("data") or
                chain.get("filtered", {}).get("data") or [])
        ot = option_type.upper()  # CE or PE
        best_dist = float("inf")
        for r in rows:
            exp = r.get("expiryDate", "")
            if exp and exp != expiry:
                continue
            entry = r.get(ot, {})
            sk = float(r.get("strikePrice") or entry.get("strikePrice") or 0)
            if sk <= 0:
                continue
            dist = abs(sk - strike)
            if dist < best_dist:
                best_dist = dist
                ltp = float(entry.get("lastPrice") or entry.get("ltp") or 0)
                row_iv = float(entry.get("impliedVolatility") or 0)
                best_ltp = ltp
                if row_iv > 1:
                    best_iv = row_iv
    except Exception:
        pass

    if best_ltp > 0:
        return round(best_ltp, 2)

    # Black-Scholes fallback when market closed or no trades on this strike
    bs_iv = best_iv if best_iv > 1 else iv
    bs_spot = spot if spot > 0 else 0
    if bs_spot > 0 and bs_iv > 0 and dte > 0:
        T = dte / 365.0
        if option_type.upper() == "CE":
            return round(_bs_call(bs_spot, strike, bs_iv, T), 2)
        else:
            return round(_bs_put(bs_spot, strike, bs_iv, T), 2)

    return 0.0


# ── Minimal Black-Scholes (for premium fallback) ──────────────────────────────

def _ncdf(x: float) -> float:
    return (1 + math.erf(x / math.sqrt(2))) / 2

def _bs_call(spot: float, strike: float, iv_pct: float, T: float, rf: float = 0.065) -> float:
    if T <= 0:
        return max(0.0, spot - strike)
    s = iv_pct / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return spot * _ncdf(d1) - strike * math.exp(-rf * T) * _ncdf(d2)

def _bs_put(spot: float, strike: float, iv_pct: float, T: float, rf: float = 0.065) -> float:
    if T <= 0:
        return max(0.0, strike - spot)
    s = iv_pct / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return strike * math.exp(-rf * T) * _ncdf(-d2) - spot * _ncdf(-d1)


def _get_spot(symbol: str, chain: dict | None = None) -> float:
    """Extract underlying spot from chain or fallback to yfinance."""
    if chain is None:
        try:
            chain = get_option_chain(symbol)
        except Exception:
            chain = {}
    spot = float(chain.get("records", {}).get("underlyingValue", 0) or 0)
    if spot > 0:
        return spot
    # yfinance fallback
    try:
        import yfinance as yf
        sym_map = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"}
        t = yf.Ticker(sym_map.get(symbol.upper(), "^NSEI"))
        return round(float(t.fast_info.last_price or 0), 2)
    except Exception:
        return 0.0


# ── Standard Deviation Strike Calculator ─────────────────────────────────────

def _sd_move(spot: float, iv_pct: float, dte: int) -> float:
    """Expected 1-sigma move: spot × (iv/100) × √(dte/365)."""
    return spot * (iv_pct / 100) * math.sqrt(max(dte, 1) / 365)


# ── OI Analysis ───────────────────────────────────────────────────────────────

def compute_max_pain(chain: dict, expiry: str) -> float:
    """
    Max Pain = strike at which total option writer loss is minimized.
    Writers will tend to steer the index toward this strike near expiry.
    """
    rows = chain.get("records", {}).get("data") or []
    strikes: dict[float, dict] = {}
    for r in rows:
        exp = r.get("expiryDate", "")
        if exp and exp != expiry:
            continue
        sk = float(r.get("strikePrice") or 0)
        if sk <= 0:
            continue
        ce_oi = float(r.get("CE", {}).get("openInterest") or 0)
        pe_oi = float(r.get("PE", {}).get("openInterest") or 0)
        if sk not in strikes:
            strikes[sk] = {"ce_oi": 0.0, "pe_oi": 0.0}
        strikes[sk]["ce_oi"] += ce_oi
        strikes[sk]["pe_oi"] += pe_oi

    if not strikes:
        return 0.0

    all_strikes = sorted(strikes)
    min_pain = float("inf")
    max_pain_strike = all_strikes[len(all_strikes) // 2]

    for test_sk in all_strikes:
        pain = 0.0
        for sk, oi in strikes.items():
            pain += max(0.0, test_sk - sk) * oi["ce_oi"]   # ITM call writer loss
            pain += max(0.0, sk - test_sk) * oi["pe_oi"]   # ITM put writer loss
        if pain < min_pain:
            min_pain = pain
            max_pain_strike = test_sk

    return max_pain_strike


def compute_pcr(chain: dict, expiry: str) -> float:
    """Put-Call Ratio for the given expiry. > 1.2 = bullish; < 0.8 = bearish."""
    rows = chain.get("records", {}).get("data") or []
    total_ce = 0.0
    total_pe = 0.0
    for r in rows:
        exp = r.get("expiryDate", "")
        if exp and exp != expiry:
            continue
        total_ce += float(r.get("CE", {}).get("openInterest") or 0)
        total_pe += float(r.get("PE", {}).get("openInterest") or 0)
    if total_ce == 0:
        return 1.0
    return round(total_pe / total_ce, 2)


def find_oi_walls(chain: dict, expiry: str, spot: float, top_n: int = 3) -> dict:
    """
    Identify the strikes with the heaviest OI above (resistance) and below (support) spot.
    These are the levels option writers will defend most aggressively.
    """
    rows = chain.get("records", {}).get("data") or []
    ce_oi: dict[float, float] = {}
    pe_oi: dict[float, float] = {}

    for r in rows:
        exp = r.get("expiryDate", "")
        if exp and exp != expiry:
            continue
        sk = float(r.get("strikePrice") or 0)
        if sk <= 0:
            continue
        c = float(r.get("CE", {}).get("openInterest") or 0)
        p = float(r.get("PE", {}).get("openInterest") or 0)
        if c > 0:
            ce_oi[sk] = ce_oi.get(sk, 0) + c
        if p > 0:
            pe_oi[sk] = pe_oi.get(sk, 0) + p

    # Top CE OI strikes above spot = resistance walls
    above = {sk: v for sk, v in ce_oi.items() if sk > spot}
    top_ce = sorted(above, key=lambda s: above[s], reverse=True)[:top_n]

    # Top PE OI strikes below spot = support walls
    below = {sk: v for sk, v in pe_oi.items() if sk < spot}
    top_pe = sorted(below, key=lambda s: below[s], reverse=True)[:top_n]

    return {
        "resistance": sorted(top_ce),        # ascending — nearest resistance first
        "support":    sorted(top_pe, reverse=True),  # descending — nearest support first
        "ce_oi":      {int(sk): int(above[sk]) for sk in top_ce},
        "pe_oi":      {int(sk): int(below[sk]) for sk in top_pe},
    }


def get_oi_analysis(symbol: str, expiry: str = "") -> dict:
    """
    Full OI analysis for a symbol+expiry.
    If expiry is empty, uses the nearest monthly expiry.
    """
    try:
        chain = get_option_chain(symbol)
        spot  = _get_spot(symbol, chain)
        if not expiry:
            expiry, _ = get_monthly_expiry(symbol)
        pcr        = compute_pcr(chain, expiry)
        max_pain   = compute_max_pain(chain, expiry)
        walls      = find_oi_walls(chain, expiry, spot)

        # PCR interpretation
        if pcr > 1.3:
            pcr_signal = "BULLISH"
        elif pcr < 0.7:
            pcr_signal = "BEARISH"
        else:
            pcr_signal = "NEUTRAL"

        # Max pain vs spot divergence
        mp_diff = round(max_pain - spot, 0) if max_pain and spot else 0
        mp_bias  = "ABOVE_SPOT" if mp_diff > 0 else ("BELOW_SPOT" if mp_diff < 0 else "AT_SPOT")

        nearest_resistance = walls["resistance"][0] if walls["resistance"] else None
        nearest_support    = walls["support"][0]    if walls["support"]    else None

        return {
            "expiry":             expiry,
            "spot":               spot,
            "pcr":                pcr,
            "pcr_signal":         pcr_signal,
            "max_pain":           max_pain,
            "max_pain_diff":      mp_diff,
            "max_pain_bias":      mp_bias,
            "nearest_resistance": nearest_resistance,
            "nearest_support":    nearest_support,
            "resistance_walls":   walls["resistance"],
            "support_walls":      walls["support"],
            "ce_oi":              walls["ce_oi"],
            "pe_oi":              walls["pe_oi"],
        }
    except Exception as e:
        return {"error": str(e)}


def _check_wings_vs_walls(walls: dict, ce_wing: float, pe_wing: float) -> dict:
    """
    Check whether the Iron Fly/Condor wings are outside the major OI walls.
    Wings beyond OI walls = extra natural protection (writers defend those levels).
    """
    nearest_res = walls.get("nearest_resistance") or 0
    nearest_sup = walls.get("nearest_support")    or 0
    ce_ok = (ce_wing >= nearest_res) if nearest_res else True
    pe_ok = (pe_wing <= nearest_sup) if nearest_sup else True
    return {
        "ce_wing_beyond_wall": ce_ok,
        "pe_wing_beyond_wall": pe_ok,
        "both_wings_safe":     ce_ok and pe_ok,
        "note": (
            "Wings are beyond OI walls — strong natural protection" if (ce_ok and pe_ok)
            else "Wings are inside OI walls — consider widening for extra safety"
        ),
    }

def plan_iron_fly(symbol: str = "NIFTY", lots: int = 1) -> dict:
    """
    Iron Fly: Sell ATM straddle, Buy wings at ±1.5 SD.
    Fetches spot + IV from option chain; picks monthly expiry at ~37 DTE.
    """
    sym = symbol.upper()
    expiry, dte = get_monthly_expiry(sym)
    if not expiry:
        return {"error": f"Could not find monthly expiry for {sym}"}

    chain = get_option_chain(sym)
    spot = _get_spot(sym, chain)
    if spot <= 0:
        return {"error": f"Could not fetch spot price for {sym}"}

    atm = _round_strike(spot, sym)

    # Estimate IV from chain ATM options
    iv = _estimate_iv(sym, expiry, atm, chain)

    sd = _sd_move(spot, iv, dte)
    wing_dist = sd * 1.5
    ce_wing = _round_strike(atm + wing_dist, sym)
    pe_wing = _round_strike(atm - wing_dist, sym)

    # Ensure minimum wing distance
    step = STRIKE_STEP.get(sym, 50)
    ce_wing = max(ce_wing, atm + step)
    pe_wing = min(pe_wing, atm - step)

    lot_size = LOT_SIZE.get(sym, 25)
    qty = lots * lot_size

    # Fetch live premiums (with BS fallback when market closed)
    short_ce_px = fetch_option_premium(sym, expiry, atm,     "CE", spot, iv, dte)
    short_pe_px = fetch_option_premium(sym, expiry, atm,     "PE", spot, iv, dte)
    long_ce_px  = fetch_option_premium(sym, expiry, ce_wing, "CE", spot, iv, dte)
    long_pe_px  = fetch_option_premium(sym, expiry, pe_wing, "PE", spot, iv, dte)

    net_credit = round((short_ce_px + short_pe_px - long_ce_px - long_pe_px), 2)
    wing_width = round((ce_wing - atm), 2)
    max_profit = round(net_credit * qty, 2)
    max_loss   = round((wing_width - net_credit) * qty, 2)
    pop_est    = round(net_credit / wing_width * 50 + 50, 1) if wing_width > 0 else 50.0

    # OI analysis — max pain, PCR, wall check
    oi = get_oi_analysis(sym, expiry)
    wing_check = _check_wings_vs_walls(oi, ce_wing, pe_wing)

    legs = [
        {"role": "short", "option_type": "CE", "strike": atm,     "premium": short_ce_px, "exchange": "NFO"},
        {"role": "short", "option_type": "PE", "strike": atm,     "premium": short_pe_px, "exchange": "NFO"},
        {"role": "long",  "option_type": "CE", "strike": ce_wing, "premium": long_ce_px,  "exchange": "NFO"},
        {"role": "long",  "option_type": "PE", "strike": pe_wing, "premium": long_pe_px,  "exchange": "NFO"},
    ]

    return {
        "strategy":    "IRON_FLY",
        "symbol":      sym,
        "expiry":      expiry,
        "dte":         dte,
        "spot":        spot,
        "atm":         atm,
        "iv_used":     iv,
        "sd_move":     round(sd, 2),
        "legs":        legs,
        "lot_size":    lot_size,
        "lots":        lots,
        "qty":         qty,
        "net_credit":  net_credit,
        "max_profit":  max_profit,
        "max_loss":    max_loss,
        "pop_estimate": pop_est,
        "breakevens":  [round(atm - net_credit, 2), round(atm + net_credit, 2)],
        "profit_zone": f"{round(atm - net_credit)}-{round(atm + net_credit)}",
        "exit_targets": {
            "profit": round(net_credit * 0.5, 2),
            "stop":   round(net_credit * 2.0, 2),
            "dte_stop": 21,
        },
        "oi_context": {
            "max_pain":           oi.get("max_pain"),
            "max_pain_diff":      oi.get("max_pain_diff"),
            "pcr":                oi.get("pcr"),
            "pcr_signal":         oi.get("pcr_signal"),
            "nearest_resistance": oi.get("nearest_resistance"),
            "nearest_support":    oi.get("nearest_support"),
            "resistance_walls":   oi.get("resistance_walls", []),
            "support_walls":      oi.get("support_walls", []),
            "ce_oi":              oi.get("ce_oi", {}),
            "pe_oi":              oi.get("pe_oi", {}),
            "wing_check":         wing_check,
        },
    }


# ── Iron Condor Plan ──────────────────────────────────────────────────────────

def plan_iron_condor(symbol: str = "NIFTY", lots: int = 1) -> dict:
    """
    Iron Condor: Sell OTM strangle at ±0.8 SD, Buy wings at ±1.5 SD.
    """
    sym = symbol.upper()
    expiry, dte = get_monthly_expiry(sym)
    if not expiry:
        return {"error": f"Could not find monthly expiry for {sym}"}

    chain = get_option_chain(sym)
    spot = _get_spot(sym, chain)
    if spot <= 0:
        return {"error": f"Could not fetch spot price for {sym}"}

    atm = _round_strike(spot, sym)
    iv = _estimate_iv(sym, expiry, atm, chain)
    sd = _sd_move(spot, iv, dte)

    short_ce_strike = _round_strike(spot + sd * 0.8, sym)
    short_pe_strike = _round_strike(spot - sd * 0.8, sym)
    long_ce_strike  = _round_strike(spot + sd * 1.5, sym)
    long_pe_strike  = _round_strike(spot - sd * 1.5, sym)

    step = STRIKE_STEP.get(sym, 50)
    short_ce_strike = max(short_ce_strike, atm + step)
    short_pe_strike = min(short_pe_strike, atm - step)
    long_ce_strike  = max(long_ce_strike, short_ce_strike + step)
    long_pe_strike  = min(long_pe_strike, short_pe_strike - step)

    lot_size = LOT_SIZE.get(sym, 25)
    qty = lots * lot_size

    short_ce_px = fetch_option_premium(sym, expiry, short_ce_strike, "CE", spot, iv, dte)
    short_pe_px = fetch_option_premium(sym, expiry, short_pe_strike, "PE", spot, iv, dte)
    long_ce_px  = fetch_option_premium(sym, expiry, long_ce_strike,  "CE", spot, iv, dte)
    long_pe_px  = fetch_option_premium(sym, expiry, long_pe_strike,  "PE", spot, iv, dte)

    net_credit  = round(short_ce_px + short_pe_px - long_ce_px - long_pe_px, 2)
    ce_width    = round(long_ce_strike - short_ce_strike, 2)
    max_profit  = round(net_credit * qty, 2)
    max_loss    = round((ce_width - net_credit) * qty, 2)
    profit_zone = f"{round(short_pe_strike)}-{round(short_ce_strike)}"
    pop_est     = round(80 - max(0, 20 - (short_ce_strike - short_pe_strike) / sd * 10), 1)

    # OI analysis
    oi = get_oi_analysis(sym, expiry)
    wing_check = _check_wings_vs_walls(oi, long_ce_strike, long_pe_strike)

    legs = [
        {"role": "short", "option_type": "CE", "strike": short_ce_strike, "premium": short_ce_px, "exchange": "NFO"},
        {"role": "short", "option_type": "PE", "strike": short_pe_strike, "premium": short_pe_px, "exchange": "NFO"},
        {"role": "long",  "option_type": "CE", "strike": long_ce_strike,  "premium": long_ce_px,  "exchange": "NFO"},
        {"role": "long",  "option_type": "PE", "strike": long_pe_strike,  "premium": long_pe_px,  "exchange": "NFO"},
    ]

    return {
        "strategy":    "IRON_CONDOR",
        "symbol":      sym,
        "expiry":      expiry,
        "dte":         dte,
        "spot":        spot,
        "atm":         atm,
        "iv_used":     iv,
        "sd_move":     round(sd, 2),
        "legs":        legs,
        "lot_size":    lot_size,
        "lots":        lots,
        "qty":         qty,
        "net_credit":  net_credit,
        "max_profit":  max_profit,
        "max_loss":    max_loss,
        "pop_estimate": pop_est,
        "breakevens":  [round(short_pe_strike - net_credit, 2), round(short_ce_strike + net_credit, 2)],
        "profit_zone": profit_zone,
        "exit_targets": {
            "profit": round(net_credit * 0.5, 2),
            "stop":   round(net_credit * 2.0, 2),
            "dte_stop": 21,
        },
        "oi_context": {
            "max_pain":           oi.get("max_pain"),
            "max_pain_diff":      oi.get("max_pain_diff"),
            "pcr":                oi.get("pcr"),
            "pcr_signal":         oi.get("pcr_signal"),
            "nearest_resistance": oi.get("nearest_resistance"),
            "nearest_support":    oi.get("nearest_support"),
            "resistance_walls":   oi.get("resistance_walls", []),
            "support_walls":      oi.get("support_walls", []),
            "ce_oi":              oi.get("ce_oi", {}),
            "pe_oi":              oi.get("pe_oi", {}),
            "wing_check":         wing_check,
        },
    }


# ── IV Estimator ──────────────────────────────────────────────────────────────

def _estimate_iv(symbol: str, expiry: str, atm: float, chain: dict) -> float:
    """Extract ATM implied volatility from option chain; fallback to VIX-based estimate."""
    try:
        # Use records.data (all strikes) as primary — filtered may omit OTM strikes
        rows = (chain.get("records", {}).get("data") or
                chain.get("filtered", {}).get("data") or [])
        best_iv = 0.0
        best_dist = float("inf")
        for r in rows:
            exp = r.get("expiryDate", "")
            if exp and exp != expiry:
                continue
            sk = float(r.get("strikePrice") or 0)
            if sk <= 0:
                continue
            dist = abs(sk - atm)
            for ot in ("CE", "PE"):
                iv = float(r.get(ot, {}).get("impliedVolatility") or 0)
                if iv > 0 and dist < best_dist:
                    best_dist = dist
                    best_iv = iv
        if best_iv > 5:
            return round(best_iv, 1)
        # Retry ignoring expiry filter — picks nearest ATM IV from any expiry
        best_dist = float("inf")
        for r in rows:
            sk = float(r.get("strikePrice") or 0)
            if sk <= 0:
                continue
            dist = abs(sk - atm)
            for ot in ("CE", "PE"):
                iv = float(r.get(ot, {}).get("impliedVolatility") or 0)
                if iv > 0 and dist < best_dist:
                    best_dist = dist
                    best_iv = iv
        if best_iv > 5:
            return round(best_iv, 1)
    except Exception:
        pass

    # Fallback: use India VIX as proxy
    try:
        import yfinance as yf
        vix = float(yf.Ticker("^INDIAVIX").fast_info.last_price or 16)
        return round(vix * 1.1, 1)  # slight premium over index VIX
    except Exception:
        return 16.0


# ── Current P&L for Active Trade ─────────────────────────────────────────────

def calculate_current_pnl(trade: dict) -> dict:
    """
    Fetch current leg premiums and compute trade P&L.
    Returns dict with current_value, pnl, pnl_pct, exit_flag.
    """
    try:
        sym    = trade.get("symbol", "NIFTY")
        expiry = trade.get("expiry", "")
        legs   = trade.get("legs", [])
        qty    = trade.get("qty") or (trade.get("lots", 1) * trade.get("lot_size", 25))
        entry  = trade.get("entry_credit", 0.0)

        current_net = 0.0
        updated_legs = []
        for leg in legs:
            ltp = fetch_option_premium(sym, expiry, leg["strike"], leg["option_type"])
            if ltp == 0:
                ltp = leg.get("premium", 0)
            sign = -1 if leg["role"] == "short" else 1
            current_net += sign * ltp
            updated_legs.append({**leg, "current_price": ltp})

        # current_net is current cost to close the position
        # profit = entry_credit - current_debit_to_close
        current_debit = -current_net  # what we pay to close
        pnl_per_unit  = entry - current_debit
        pnl_total     = round(pnl_per_unit * qty, 2)
        pnl_pct       = round(pnl_per_unit / entry * 100, 1) if entry > 0 else 0.0

        exit_flag = None
        exit_targets = trade.get("exit_targets", {})
        profit_target = entry - (exit_targets.get("profit") or entry * 0.5)
        stop_level    = entry + (exit_targets.get("stop") or entry * 2.0)
        dte_remaining = _days_to(expiry)

        if current_debit <= profit_target:
            exit_flag = "PROFIT_TARGET"
        elif current_debit >= stop_level:
            exit_flag = "STOP_LOSS"
        elif dte_remaining <= (exit_targets.get("dte_stop") or 21):
            exit_flag = "TIME_STOP"

        return {
            "current_debit":   round(current_debit, 2),
            "pnl_per_unit":    round(pnl_per_unit, 2),
            "pnl_total":       pnl_total,
            "pnl_pct":         pnl_pct,
            "dte_remaining":   dte_remaining,
            "exit_flag":       exit_flag,
            "legs":            updated_legs,
        }
    except Exception as e:
        return {
            "current_debit": 0.0,
            "pnl_per_unit":  0.0,
            "pnl_total":     0.0,
            "pnl_pct":       0.0,
            "dte_remaining": _days_to(trade.get("expiry", "")),
            "exit_flag":     None,
            "legs":          trade.get("legs", []),
            "error":         str(e),
        }
