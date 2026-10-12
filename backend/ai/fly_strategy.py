"""
Custom Fly (Naked Fly) Strategy Engine.

Strategy: Short a near-ATM PE + Short a CE whose premium matches the PE premium.
Equal premiums → near-delta-zero naked short straddle/strangle.
Propose optional hedges (Iron Fly conversion or stock delta hedge) for user to decide.

Consolidation scan: Nifty 50 stocks where actual N-day range ≤ 1 SD expected move.
Safety ranking: LLM assigns Rank 1 (safe) / 2 (moderate) / 3 (avoid) based on upcoming events.
"""

import inspect
import json
import logging
import math
import re
import time
from datetime import date, datetime
from typing import Optional

import requests as _req
import yfinance as yf

from ai.llm_client import call_llm, is_configured

logger = logging.getLogger("aegisai")

# ─── Nifty 50 universe ───────────────────────────────────────────────────────

NIFTY50 = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BEL", "BHARTIARTL",
    "BPCL", "BRITANNIA", "CHOLAFIN", "CIPLA", "COALINDIA",
    "DIVISLAB", "DRREDDY", "EICHERMOT", "GRASIM", "HAL",
    "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO", "HINDALCO",
    "HINDUNILVR", "ICICIBANK", "INFY", "IOC", "ITC",
    "JSWSTEEL", "KOTAKBANK", "LT", "M&M", "MARUTI",
    "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE",
    "SBIN", "SBILIFE", "SUNPHARMA", "TATACONSUM", "TATAMOTORS",
    "TATASTEEL", "TCS", "TECHM", "TITAN", "ULTRACEMCO",
]

SECTOR = {
    "ADANIENT": "Conglomerates", "ADANIPORTS": "Infrastructure", "APOLLOHOSP": "Healthcare",
    "ASIANPAINT": "Paints", "AXISBANK": "Banking", "BAJAJ-AUTO": "Auto",
    "BAJFINANCE": "NBFC", "BAJAJFINSV": "NBFC", "BEL": "Defence",
    "BHARTIARTL": "Telecom", "BPCL": "Energy", "BRITANNIA": "FMCG",
    "CHOLAFIN": "NBFC", "CIPLA": "Pharma", "COALINDIA": "Mining",
    "DIVISLAB": "Pharma", "DRREDDY": "Pharma", "EICHERMOT": "Auto",
    "GRASIM": "Cement", "HAL": "Defence", "HCLTECH": "IT",
    "HDFCBANK": "Banking", "HDFCLIFE": "Insurance", "HEROMOTOCO": "Auto",
    "HINDALCO": "Metals", "HINDUNILVR": "FMCG", "ICICIBANK": "Banking",
    "INFY": "IT", "IOC": "Energy", "ITC": "FMCG",
    "JSWSTEEL": "Metals", "KOTAKBANK": "Banking", "LT": "Infrastructure",
    "M&M": "Auto", "MARUTI": "Auto", "NESTLEIND": "FMCG",
    "NTPC": "Power", "ONGC": "Energy", "POWERGRID": "Power",
    "RELIANCE": "Conglomerates", "SBIN": "Banking", "SBILIFE": "Insurance",
    "SUNPHARMA": "Pharma", "TATACONSUM": "FMCG", "TATAMOTORS": "Auto",
    "TATASTEEL": "Metals", "TCS": "IT", "TECHM": "IT",
    "TITAN": "Consumer", "ULTRACEMCO": "Cement",
}

# Lot sizes for Nifty 50 F&O stocks
_LOTS = {
    "ADANIENT":  309, "ADANIPORTS": 475, "APOLLOHOSP": 125, "ASIANPAINT": 250,
    "AXISBANK":  625, "BAJAJ-AUTO":  75, "BAJFINANCE": 750, "BAJAJFINSV": 300,
    "BEL":      1425, "BHARTIARTL": 475, "BPCL":      1975, "BRITANNIA":  125,
    "CHOLAFIN":  625, "CIPLA":       425, "COALINDIA": 1350, "DIVISLAB":   100,
    "DRREDDY":   625, "EICHERMOT":   100, "GRASIM":    250,  "HAL":        150,
    "HCLTECH":   400, "HDFCBANK":    650, "HDFCLIFE":  1100, "HEROMOTOCO": 150,
    "HINDALCO":  700, "HINDUNILVR":  300, "ICICIBANK":  700, "INFY":       400,
    "IOC":      4875, "ITC":        1725, "JSWSTEEL":   675, "KOTAKBANK": 2000,
    "LT":        175, "M&M":         200, "MARUTI":      50, "NESTLEIND":  500,
    "NTPC":     1500, "ONGC":       2250, "POWERGRID": 1900, "RELIANCE":   500,
    "SBIN":      750, "SBILIFE":     375, "SUNPHARMA":  350, "TATACONSUM": 550,
    "TATAMOTORS":1425,"TATASTEEL":  2750, "TCS":        225, "TECHM":      600,
    "TITAN":     175, "ULTRACEMCO":   50,
}

# ─── Black-Scholes helpers (copied from cushion_strangle.py to avoid route→ai dependency) ──

def _ncdf(x: float) -> float:
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def _d1(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    s = iv / 100.0
    if s <= 0 or T <= 0 or S <= 0 or K <= 0:
        return 0.0
    return (math.log(S / K) + (r + 0.5 * s * s) * T) / (s * math.sqrt(T))

def _call_delta(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0:
        return 1.0 if S >= K else 0.0
    return _ncdf(_d1(S, K, iv, T, r))

def _put_delta_abs(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0:
        return 1.0 if S <= K else 0.0
    return 1.0 - _ncdf(_d1(S, K, iv, T, r))

def _round_strike(K: float, cmp: float) -> float:
    interval = (2.5 if cmp < 100 else 5 if cmp < 250 else 10 if cmp < 500
                else 20 if cmp < 1000 else 50 if cmp < 2000 else 100)
    return round(K / interval) * interval

# ─── NSE option chain fetcher ────────────────────────────────────────────────

_NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
}
_NSE_SESSION: Optional[_req.Session] = None
_NSE_SESSION_TS: float = 0.0
_NSE_SESSION_TTL = 300


def _nse_session() -> _req.Session:
    global _NSE_SESSION, _NSE_SESSION_TS
    now = time.time()
    if _NSE_SESSION is None or (now - _NSE_SESSION_TS) > _NSE_SESSION_TTL:
        s = _req.Session()
        try:
            s.get("https://www.nseindia.com", headers=_NSE_HEADERS, timeout=8)
        except Exception:
            pass
        _NSE_SESSION = s
        _NSE_SESSION_TS = now
    return _NSE_SESSION


def _parse_expiry_date(s: str) -> Optional[date]:
    for fmt in ["%Y-%m-%d", "%d-%b-%Y", "%d/%m/%Y", "%d %b %Y", "%b %d, %Y"]:
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    return None


def _parse_jugaad_records(raw: list, spot: float, today: date, chain: dict) -> None:
    """Parse jugaad records[] items into chain dict in-place."""
    for item in raw:
        # NSE returns "expiryDate"; jugaad sometimes renames to "expiryDates"
        exp_str = item.get("expiryDate") or item.get("expiryDates", "")
        exp_date = _parse_expiry_date(exp_str)
        if not exp_date:
            continue
        dte = (exp_date - today).days
        if exp_str not in chain:
            chain[exp_str] = {"spot": spot, "dte": dte, "calls": [], "puts": []}

        strike = float(item.get("strikePrice", 0))
        for side, key in [("calls", "CE"), ("puts", "PE")]:
            seg = item.get(key)
            if not seg:
                continue
            bid = float(seg.get("buyPrice1") or 0)
            ask = float(seg.get("sellPrice1") or 0)
            ltp = float(seg.get("lastPrice") or 0)
            mid = round((bid + ask) / 2, 2) if bid > 0 and ask > 0 else ltp
            if mid <= 0 and ltp > 0:
                mid = ltp
            chain[exp_str][side].append({
                "strike": strike,
                "ltp": ltp,
                "mid": mid,
                "bid": bid,
                "ask": ask,
                "iv": float(seg.get("impliedVolatility") or 0),
                "volume": int(seg.get("totalTradedVolume") or 0),
                "oi": int(seg.get("openInterest") or 0),
            })


def _fetch_chain_jugaad(symbol: str, today: date) -> dict:
    """
    Fetch full multi-expiry option chain using jugaad-data.
    - First call gets near-month data + list of all expiry dates.
    - Subsequent calls fetch each remaining expiry via expiry_date param.
    Works from cloud/EC2 IPs where NSE is blocked.
    """
    from jugaad_data.nse import NSELive
    n = NSELive()

    data = n.equities_option_chain(symbol)
    records = data.get("records", {})
    spot = float(records.get("underlyingValue") or 0)
    if spot <= 0:
        return {}

    chain: dict = {}

    # Parse whatever records the initial call returned (usually near-month)
    _parse_jugaad_records(records.get("data", []), spot, today, chain)

    # Discover all available expiries from top-level list
    all_expiries: list = records.get("expiryDates", [])

    # Fetch expiries not yet in chain (up to 3 total including near-month)
    for exp_str in all_expiries[:3]:
        if exp_str in chain:
            continue
        try:
            sig = inspect.signature(n.equities_option_chain)
            if "expiry_date" in sig.parameters:
                extra = n.equities_option_chain(symbol, expiry_date=exp_str)
            else:
                # Older jugaad — try keyword arg anyway, fall back silently
                try:
                    extra = n.equities_option_chain(symbol, exp_str)
                except TypeError:
                    continue
            extra_records = extra.get("records", {})
            extra_spot = float(extra_records.get("underlyingValue") or spot)
            _parse_jugaad_records(extra_records.get("data", []), extra_spot, today, chain)
        except Exception as e:
            logger.debug("jugaad extra expiry fetch failed for %s %s: %s", symbol, exp_str, e)

    return chain


def _fetch_full_chain(symbol: str) -> dict:
    """
    Fetch complete NSE option chain for a stock symbol.
    Tries jugaad-data (cloud-safe) first, then NSE direct scrape, then yfinance.
    Returns {expiry_str: {spot, dte, calls, puts}}.
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    today = date.today()

    # ── jugaad-data (primary — works from cloud IPs) ─────────────────────────
    try:
        chain = _fetch_chain_jugaad(clean, today)
        if chain:
            return chain
    except Exception as e:
        logger.debug("jugaad chain failed for %s: %s", clean, e)

    # ── NSE direct scrape (fallback — may be blocked from EC2) ───────────────
    url = f"https://www.nseindia.com/api/option-chain-equities?symbol={clean}"
    try:
        global _NSE_SESSION_TS
        sess = _nse_session()
        r = sess.get(url, headers=_NSE_HEADERS, timeout=12)
        if r.status_code == 403:
            _NSE_SESSION_TS = 0.0
            sess = _nse_session()
            r = sess.get(url, headers=_NSE_HEADERS, timeout=12)

        if r.status_code == 200:
            data = r.json()
            spot = float(data.get("records", {}).get("underlyingValue") or 0)
            raw = data.get("records", {}).get("data", [])
            chain = {}
            for item in raw:
                exp_str = item.get("expiryDate", "")
                exp_date = _parse_expiry_date(exp_str)
                if not exp_date:
                    continue
                dte = (exp_date - today).days
                if exp_str not in chain:
                    chain[exp_str] = {"spot": spot, "dte": dte, "calls": [], "puts": []}

                strike = float(item.get("strikePrice", 0))
                for side, key in [("calls", "CE"), ("puts", "PE")]:
                    seg = item.get(key)
                    if not seg:
                        continue
                    ltp = float(seg.get("lastPrice") or 0)
                    bid = float(seg.get("bidprice", seg.get("bid", 0)) or 0)
                    ask = float(seg.get("askPrice", seg.get("ask", 0)) or 0)
                    iv = float(seg.get("impliedVolatility") or 0)
                    vol = int(seg.get("totalTradedVolume", seg.get("volume", 0)) or 0)
                    oi = int(seg.get("openInterest") or 0)
                    mid = round((bid + ask) / 2, 2) if bid > 0 and ask > 0 else ltp
                    chain[exp_str][side].append({
                        "strike": strike,
                        "ltp": ltp,
                        "mid": mid,
                        "bid": bid,
                        "ask": ask,
                        "iv": iv,
                        "volume": vol,
                        "oi": oi,
                    })
            if chain:
                return chain
    except Exception as e:
        logger.warning("NSE chain fetch failed for %s: %s", symbol, e)

    # yfinance fallback
    return _fetch_chain_yfinance(clean, today)


def _fetch_chain_yfinance(symbol: str, today: date) -> dict:
    """Fallback: fetch option chain from yfinance."""
    ticker = yf.Ticker(symbol + ".NS")
    chain: dict = {}
    try:
        expiries = ticker.options
        if not expiries:
            return {}
        spot_info = ticker.history(period="1d")
        spot = float(spot_info["Close"].iloc[-1]) if not spot_info.empty else 0.0

        for exp_str in expiries:
            exp_date = _parse_expiry_date(exp_str)
            if not exp_date:
                continue
            dte = (exp_date - today).days
            oc = ticker.option_chain(exp_str)
            calls = []
            for _, row in oc.calls.iterrows():
                calls.append({
                    "strike": float(row.get("strike", 0)),
                    "ltp": float(row.get("lastPrice", 0)),
                    "mid": float(row.get("lastPrice", 0)),
                    "bid": float(row.get("bid", 0)),
                    "ask": float(row.get("ask", 0)),
                    "iv": float(row.get("impliedVolatility", 0)) * 100,
                    "volume": int(row.get("volume", 0) or 0),
                    "oi": int(row.get("openInterest", 0) or 0),
                })
            puts = []
            for _, row in oc.puts.iterrows():
                puts.append({
                    "strike": float(row.get("strike", 0)),
                    "ltp": float(row.get("lastPrice", 0)),
                    "mid": float(row.get("lastPrice", 0)),
                    "bid": float(row.get("bid", 0)),
                    "ask": float(row.get("ask", 0)),
                    "iv": float(row.get("impliedVolatility", 0)) * 100,
                    "volume": int(row.get("volume", 0) or 0),
                    "oi": int(row.get("openInterest", 0) or 0),
                })
            chain[exp_str] = {"spot": spot, "dte": dte, "calls": calls, "puts": puts}
    except Exception as e:
        logger.warning("yfinance chain fallback failed for %s: %s", symbol, e)
    return chain


def get_chain_expiries(symbol: str) -> list[dict]:
    """
    Return available expiries for a symbol with DTE info.
    Each entry: {expiry_str, dte, calls_count, puts_count}
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    today = date.today()
    chain = _fetch_full_chain(clean)
    expiries = []
    for exp_str, data in sorted(chain.items(), key=lambda x: x[1]["dte"]):
        expiries.append({
            "expiry": exp_str,
            "dte": data["dte"],
            "calls_count": len(data.get("calls", [])),
            "puts_count": len(data.get("puts", [])),
        })
    return expiries

_SCAN_CACHE: dict = {}
_SCAN_CACHE_TTL = 900  # 15 minutes


def scan_consolidating(days: int) -> list[dict]:
    """
    Download Nifty 50 price history and identify consolidating stocks.
    Returns list of {symbol, sector, cmp, actual_range, expected_1sd, ratio,
                     consolidating, hv_pct}.
    Caches results for 15 minutes.
    """
    cache_key = str(days)
    cached = _SCAN_CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _SCAN_CACHE_TTL:
        return cached["data"]

    tickers = [s + ".NS" for s in NIFTY50]
    period = f"{days + 30}d"
    try:
        raw = yf.download(tickers, period=period, progress=False, auto_adjust=True)
    except Exception as e:
        logger.error("yfinance batch download failed: %s", e)
        return []

    close = raw.get("Close", raw) if isinstance(raw.columns, object) and hasattr(raw, "xs") else raw
    # Handle both MultiIndex and flat columns
    if hasattr(close.columns, "levels"):
        close = close["Close"] if "Close" in close.columns.get_level_values(0) else close
    else:
        # Already flat or single-level
        pass

    results = []
    for sym in NIFTY50:
        yfkey = sym + ".NS"
        try:
            # Get series for this symbol
            if hasattr(raw.columns, "levels"):
                col_data = raw["Close"][yfkey]
            else:
                col_data = raw[yfkey] if yfkey in raw.columns else None
            if col_data is None or col_data.dropna().empty:
                continue

            prices = col_data.dropna()
            if len(prices) < days + 5:
                continue

            cmp = float(prices.iloc[-1])
            # Use last `days` candles for range
            window = prices.iloc[-days:]
            actual_range = float(window.max() - window.min())

            # Historical volatility from returns (annualized → daily → N-day)
            returns = prices.pct_change().dropna()
            hv_daily = float(returns.std())
            hv_annual = hv_daily * math.sqrt(252)
            expected_1sd = cmp * hv_daily * math.sqrt(days)
            ratio = actual_range / expected_1sd if expected_1sd > 0 else 9.9
            consolidating = ratio <= 1.0

            # HV rank: how elevated is current HV vs its own rolling distribution (proxy for IV rank)
            rolling_hv = returns.rolling(20).std().dropna()
            hv_vals = rolling_hv.values
            if len(hv_vals) >= 10:
                hv_rank_val = int(round(100 * sum(v < hv_daily for v in hv_vals) / len(hv_vals)))
            else:
                hv_rank_val = 50

            results.append({
                "symbol": sym,
                "sector": SECTOR.get(sym, "Other"),
                "cmp": round(cmp, 2),
                "actual_range": round(actual_range, 2),
                "expected_1sd": round(expected_1sd, 2),
                "ratio": round(ratio, 3),
                "consolidating": consolidating,
                "hv_pct": round(hv_annual * 100, 1),
                "hv_rank": hv_rank_val,
                "safety_rank": None,
                "rank_reason": "",
                "highly_recommended": False,
            })
        except Exception as e:
            logger.debug("Skipping %s in scan: %s", sym, e)
            continue

    _SCAN_CACHE[cache_key] = {"data": results, "ts": time.time()}
    return results


def rank_safety(stocks: list[dict]) -> list[dict]:
    """
    LLM-rank the consolidating stocks by event/macro risk.
    Rank 1 = safe (no events), 2 = moderate, 3 = avoid.
    Falls back to rank 2 if LLM unavailable.
    """
    consolidating = [s for s in stocks if s.get("consolidating")]
    if not consolidating:
        return stocks

    if not is_configured():
        for s in stocks:
            if s.get("consolidating"):
                s["safety_rank"] = 2
                s["rank_reason"] = "LLM not configured — defaulting to moderate"
        return stocks

    names = [s["symbol"] for s in consolidating]
    hv_context = ", ".join(
        f"{s['symbol']} (HV rank {s.get('hv_rank', 50)}/100)"
        for s in consolidating
    )
    prompt = (
        f"Today is {date.today().isoformat()}. You are analysing Nifty 50 stocks for a SHORT-TERM "
        f"naked fly options strategy (target: 2-3% return in under 5 days via theta + IV crush).\n\n"
        f"Rank each stock by options-selling risk IN THE NEXT 2 WEEKS. "
        f"Consider: earnings/results, AGM, index rebalancing, macro events, regulatory risk, "
        f"sector headwinds, and whether IV is likely to COMPRESS soon (post-event, overshoot, etc).\n\n"
        f"Stocks with their historical volatility rank (HV rank = where current HV sits in "
        f"the 90-day rolling distribution; higher = more elevated IV, better premiums):\n{hv_context}\n\n"
        f"Stocks: {', '.join(names)}\n\n"
        f"Respond ONLY as a JSON array:\n"
        f'[{{"symbol":"SYMBOL","rank":1,"reason":"one sentence","iv_crush_likely":true}},...]\n\n'
        f"Rank 1 = Highest safety (no known events, stable sector). "
        f"Rank 2 = Moderate (some event risk, 50%+ chance stays in 1SD). "
        f"Rank 3 = Avoid (results/AGM/high volatility expected). "
        f"iv_crush_likely = true ONLY when: (a) a near-term event has just passed and IV is "
        f"likely to deflate, OR (b) IV is clearly elevated above fundamentals with no fresh catalyst "
        f"coming in the next 5 days. "
        f"Return ALL {len(names)} stocks."
    )

    response = call_llm(prompt, system="You are a financial event risk analyst for Indian equities. Respond ONLY with valid JSON.", max_tokens=1500)

    rank_map: dict[str, dict] = {}
    if not response.startswith("[LLM"):
        # Extract JSON array from response
        try:
            m = re.search(r'\[.*\]', response, re.DOTALL)
            if m:
                parsed = json.loads(m.group())
                for item in parsed:
                    sym = item.get("symbol", "").upper()
                    if sym:
                        rank_map[sym] = {
                            "rank": int(item.get("rank", 2)),
                            "reason": str(item.get("reason", "")),
                            "iv_crush_likely": bool(item.get("iv_crush_likely", False)),
                        }
        except Exception as e:
            logger.warning("Safety rank JSON parse failed: %s", e)

    for s in stocks:
        if s.get("consolidating"):
            info = rank_map.get(s["symbol"], {"rank": 2, "reason": "Could not rank — using default", "iv_crush_likely": False})
            s["safety_rank"] = info["rank"]
            # "Highly recommended" = safe/moderate rank + elevated IV + IV crush likely OR just very high HV rank
            hv_rank = s.get("hv_rank", 0)
            iv_crush = info.get("iv_crush_likely", False)
            s["highly_recommended"] = (
                info["rank"] <= 2 and (iv_crush or hv_rank >= 70)
            )
            reason = info["reason"]
            if s["highly_recommended"] and iv_crush:
                reason = "🔥 IV crush candidate — " + reason
            elif s["highly_recommended"] and hv_rank >= 70:
                reason = f"🔥 Elevated IV (rank {hv_rank}/100) — " + reason
            s["rank_reason"] = reason
        else:
            s["safety_rank"] = None
            s["rank_reason"] = ""
            s["highly_recommended"] = False

    # Update cache
    for cache_entry in _SCAN_CACHE.values():
        for item in cache_entry.get("data", []):
            match = next((s for s in stocks if s["symbol"] == item["symbol"]), None)
            if match:
                item["safety_rank"] = match["safety_rank"]
                item["rank_reason"] = match["rank_reason"]
                item["highly_recommended"] = match.get("highly_recommended", False)

    return stocks


# ─── Naked Fly setup ──────────────────────────────────────────────────────────

def _refresh_ltp_angel_one(symbol: str, expiry_str: str, strike: float, opt_type: str, username: str) -> float | None:
    """Try to get live option LTP from Angel One broker session."""
    try:
        from data.broker_creds import get_session
        from brokers.angel_one import AngelOneClient
        session = get_session(username, "angelone")
        if not session:
            return None
        client = AngelOneClient(session, cache_key=f"{username}:angelone")
        return client.get_option_ltp(symbol, expiry_str, strike, opt_type)
    except Exception as e:
        logger.debug("Angel One option LTP failed: %s", e)
    return None


def get_naked_fly(symbol: str, expiry: str | None = None, username: str | None = None) -> dict:
    """
    Build a naked fly (premium-matched short CE + short PE) setup for symbol.
    expiry: optional expiry string (e.g. "27-Oct-2026") — if None, auto-selects best
    username: if provided, tries Angel One for live option LTPs before jugaad/NSE

    Returns:
    {
      symbol, spot, lot_size, expiry, dte, atm_iv,
      sell_pe: {strike, premium, delta, volume, oi, liq_ok},
      sell_ce: {strike, premium, delta, volume, oi, liq_ok},
      net_credit, net_delta, premium_diff_pct,
      hedge_iron_fly: {buy_pe_strike, buy_pe_premium, buy_ce_strike, buy_ce_premium,
                        wing_width, hedge_debit, capped_max_loss},
      hedge_stock: {side, shares, value},
      breakeven_up, breakeven_down,
      source,  # "angel_one", "jugaad", or "yfinance"
      dte_warning,  # non-null if DTE < 30
      error,   # non-null if setup could not be built
    }
    """
    clean = symbol.upper().replace(".NS", "").replace(".BO", "")
    lot_size = _LOTS.get(clean, 500)
    today = date.today()

    chain = _fetch_full_chain(clean)
    source = "jugaad" if chain else "none"

    if not chain:
        return {"error": f"Could not fetch option chain for {clean}", "symbol": clean}

    # Use caller-specified expiry if provided, otherwise auto-select
    if expiry and expiry in chain:
        expiry_str = expiry
        exp_data = chain[expiry]
    else:
        def _qualifies(exp_str: str, data: dict, min_dte: int) -> bool:
            return (data["dte"] >= min_dte
                    and len(data.get("calls", [])) >= 3
                    and len(data.get("puts", [])) >= 3)

        qualifying = [(e, d) for e, d in chain.items() if _qualifies(e, d, 30)]
        if not qualifying:
            qualifying = [(e, d) for e, d in chain.items() if _qualifies(e, d, 7)]
        if not qualifying:
            return {"error": f"No expiry with sufficient liquidity found for {clean}", "symbol": clean}

        qualifying.sort(key=lambda x: x[1]["dte"])
        expiry_str, exp_data = qualifying[0]

    spot = exp_data["spot"]
    dte = exp_data["dte"]
    dte_warning = "Near-month expiry (DTE < 30). Strategy works best with DTE > 30." if dte < 30 else None
    T = dte / 365.0

    if spot <= 0:
        # Try to get spot from yfinance
        try:
            hist = yf.Ticker(clean + ".NS").history(period="1d")
            spot = float(hist["Close"].iloc[-1]) if not hist.empty else 0.0
            exp_data["spot"] = spot
        except Exception:
            pass

    if spot <= 0:
        return {"error": f"Could not determine spot price for {clean}", "symbol": clean}

    calls = sorted(exp_data["calls"], key=lambda x: x["strike"])
    puts = sorted(exp_data["puts"], key=lambda x: x["strike"])

    # ── Find ATM PE ──────────────────────────────────────────────────────────
    atm_put = min(puts, key=lambda x: abs(x["strike"] - spot))
    pe_strike = atm_put["strike"]
    pe_premium = atm_put["mid"] if atm_put["mid"] > 0 else atm_put["ltp"]
    pe_iv = atm_put["iv"]

    if pe_premium <= 0:
        return {"error": f"ATM PE has zero premium for {clean} at strike {pe_strike}", "symbol": clean}

    # ── Find CE with matching premium ────────────────────────────────────────
    best_ce = min(
        calls,
        key=lambda x: abs((x["mid"] if x["mid"] > 0 else x["ltp"]) - pe_premium)
    )
    ce_strike = best_ce["strike"]
    ce_premium = best_ce["mid"] if best_ce["mid"] > 0 else best_ce["ltp"]
    ce_iv = best_ce["iv"]

    if ce_premium <= 0:
        return {"error": f"Could not find CE with matching premium for {clean}", "symbol": clean}

    # ── Refresh premiums from Angel One if broker session is available ────────
    if username:
        ao_pe = _refresh_ltp_angel_one(clean, expiry_str, pe_strike, "PE", username)
        if ao_pe and ao_pe > 0:
            pe_premium = ao_pe
            source = "angel_one"
        ao_ce = _refresh_ltp_angel_one(clean, expiry_str, ce_strike, "CE", username)
        if ao_ce and ao_ce > 0:
            ce_premium = ao_ce
            source = "angel_one"

    premium_diff_pct = abs(ce_premium - pe_premium) / pe_premium * 100

    # ── ATM IV (average of PE and CE IVs) ────────────────────────────────────
    atm_iv = (pe_iv + ce_iv) / 2 if pe_iv > 0 and ce_iv > 0 else max(pe_iv, ce_iv)
    if atm_iv <= 0:
        atm_iv = 25.0  # reasonable fallback

    # ── Deltas ───────────────────────────────────────────────────────────────
    # Option deltas (option's own theoretical delta):
    #   PE delta is negative (-put_delta_abs), CE delta is positive (+call_delta)
    # Position deltas when SELLING both:
    #   Short PE: +put_delta_abs (positive), Short CE: -call_delta (negative)
    # Net position delta = +put_delta_abs - call_delta
    pe_delta_abs = _put_delta_abs(spot, pe_strike, atm_iv, T)
    ce_delta_val = _call_delta(spot, ce_strike, atm_iv, T)
    net_delta = round(pe_delta_abs - ce_delta_val, 3)

    # ── Liquidity checks ─────────────────────────────────────────────────────
    pe_liq = atm_put["volume"] >= 100 and atm_put["oi"] >= 500
    ce_liq = best_ce["volume"] >= 100 and best_ce["oi"] >= 500

    net_credit = round((pe_premium + ce_premium) * lot_size, 2)

    # Return metrics for "2-3% in few days" objective
    # return_pct: total credit as % of stock's spot price (premium yield per share)
    return_pct = round((pe_premium + ce_premium) / spot * 100, 2) if spot > 0 else 0.0
    # Rough 5-day theta capture: assume ~sqrt(5/DTE) fraction of total premium decays in 5 days
    # (theta is not linear — front-loaded near expiry, but sqrt approximation is common)
    if dte > 0:
        est_5d_theta_pct = round(return_pct * min(math.sqrt(5.0 / dte), 1.0), 2)
    else:
        est_5d_theta_pct = return_pct

    # ── Breakevens ───────────────────────────────────────────────────────────
    total_prem = pe_premium + ce_premium
    breakeven_up = round(ce_strike + total_prem, 2)
    breakeven_down = round(pe_strike - total_prem, 2)

    # ── Hedge A: Iron Fly (buy OTM PE and OTM CE at ~1SD wings) ─────────────
    sd_move = spot * (atm_iv / 100) * math.sqrt(T)
    wing_pe_strike = _round_strike(spot - sd_move, spot)
    wing_ce_strike = _round_strike(spot + sd_move, spot)

    # Find actual chain options closest to wing strikes
    hedge_pe = min(puts, key=lambda x: abs(x["strike"] - wing_pe_strike))
    hedge_ce = min(calls, key=lambda x: abs(x["strike"] - wing_ce_strike))
    h_pe_prem = hedge_pe["mid"] if hedge_pe["mid"] > 0 else hedge_pe["ltp"]
    h_ce_prem = hedge_ce["mid"] if hedge_ce["mid"] > 0 else hedge_ce["ltp"]

    hedge_debit = round((h_pe_prem + h_ce_prem) * lot_size, 2)
    wing_width = round(min(spot - hedge_pe["strike"], hedge_ce["strike"] - spot), 2)
    # Max loss with wings = wing_width - net_premium_after_hedges
    net_prem_after_hedge = (pe_premium + ce_premium) - (h_pe_prem + h_ce_prem)
    capped_max_loss = round((wing_width - net_prem_after_hedge) * lot_size, 2) if wing_width > 0 else None

    # ── Hedge B: Stock delta hedge ────────────────────────────────────────────
    # net_delta > 0 → position has long-delta bias → sell shares to flatten
    # net_delta < 0 → position has short-delta bias → buy shares
    if abs(net_delta) > 0.05:
        delta_shares = abs(round(net_delta * lot_size))
        stock_side = "SELL" if net_delta > 0 else "BUY"
        stock_value = round(delta_shares * spot, 2)
    else:
        delta_shares = 0
        stock_side = "NONE"
        stock_value = 0.0

    return {
        "symbol": clean,
        "spot": round(spot, 2),
        "lot_size": lot_size,
        "expiry": expiry_str,
        "dte": dte,
        "atm_iv": round(atm_iv, 1),
        "sd_move": round(sd_move, 2),
        "sell_pe": {
            "strike": pe_strike,
            "premium": round(pe_premium, 2),
            "delta": round(pe_delta_abs, 3),       # stored as positive; position delta = +pe_delta_abs
            "volume": atm_put["volume"],
            "oi": atm_put["oi"],
            "liq_ok": pe_liq,
        },
        "sell_ce": {
            "strike": ce_strike,
            "premium": round(ce_premium, 2),
            "delta": round(ce_delta_val, 3),        # stored as positive; position delta = -ce_delta_val
            "volume": best_ce["volume"],
            "oi": best_ce["oi"],
            "liq_ok": ce_liq,
        },
        "net_credit": net_credit,
        "return_pct": return_pct,
        "est_5d_theta_pct": est_5d_theta_pct,
        "net_delta": net_delta,
        "premium_diff_pct": round(premium_diff_pct, 1),
        "breakeven_up": breakeven_up,
        "breakeven_down": breakeven_down,
        "hedge_iron_fly": {
            "buy_pe_strike": hedge_pe["strike"],
            "buy_pe_premium": round(h_pe_prem, 2),
            "buy_ce_strike": hedge_ce["strike"],
            "buy_ce_premium": round(h_ce_prem, 2),
            "wing_width": wing_width,
            "hedge_debit": hedge_debit,
            "capped_max_loss": capped_max_loss,
        },
        "hedge_stock": {
            "side": stock_side,
            "shares": delta_shares,
            "value": stock_value,
        },
        "source": source,
        "dte_warning": dte_warning,
        "error": None,
    }
