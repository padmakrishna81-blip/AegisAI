"""Covered calls endpoint using LIVE NSE option chain data via jugaad-data."""

import math
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from data.market_data import get_info, safe_get, normalize_symbol
from api.utils import clean_for_json

router = APIRouter()

# jugaad-data NSE live client (module-level singleton)
_nse = None


def _get_nse():
    global _nse
    if _nse is None:
        from jugaad_data.nse import NSELive
        _nse = NSELive()
    return _nse


def _fetch_option_chain(symbol: str) -> dict | None:
    """Fetch live NSE option chain. Returns parsed dict or None on failure."""
    # NSE uses bare symbol without .NS
    bare = symbol.replace(".NS", "").replace(".BO", "").upper()
    try:
        nse = _get_nse()
        data = nse.equities_option_chain(bare)
        return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NSE option chain unavailable: {str(e)[:200]}")


def _parse_chain(data: dict, expiry_filter: str | None = None) -> dict:
    """
    Parse raw NSE option chain into a structured dict.
    Uses filtered.data (has correct expiryDate inside CE/PE objects).
    """
    rec = data.get("records", {})
    filt = data.get("filtered", {})

    underlying = rec.get("underlyingValue") or 0
    expiry_dates = rec.get("expiryDates", [])

    rows = filt.get("data", [])

    # Determine which expiry to use
    if expiry_filter and expiry_filter in expiry_dates:
        selected_expiry = expiry_filter
    elif expiry_dates:
        selected_expiry = expiry_dates[0]
    else:
        selected_expiry = None

    # Normalise expiry date from CE object (format: "28-07-2026") to display ("28 Jul 2026")
    def _fmt_expiry(raw: str) -> str:
        try:
            return datetime.strptime(raw, "%d-%m-%Y").strftime("%d %b %Y")
        except Exception:
            return raw

    # Build strike list
    strikes = []
    for row in rows:
        ce = row.get("CE", {})
        pe = row.get("PE", {})
        strike = row.get("strikePrice") or ce.get("strikePrice") or pe.get("strikePrice")
        if not strike:
            continue

        # Expiry comes from inside CE/PE object
        expiry_raw = ce.get("expiryDate") or pe.get("expiryDate") or ""
        # CE expiryDate format: "28-07-2026"
        expiry_display = _fmt_expiry(expiry_raw) if expiry_raw else (selected_expiry or "")

        ce_ltp = ce.get("lastPrice", 0) or 0
        ce_iv = ce.get("impliedVolatility", 0) or 0
        ce_oi = ce.get("openInterest", 0) or 0
        ce_bid = ce.get("buyPrice1", 0) or 0
        ce_ask = ce.get("sellPrice1", 0) or 0
        ce_vol = ce.get("totalTradedVolume", 0) or 0
        ce_chg = ce.get("change", 0) or 0

        pe_ltp = pe.get("lastPrice", 0) or 0
        pe_iv = pe.get("impliedVolatility", 0) or 0
        pe_oi = pe.get("openInterest", 0) or 0

        strikes.append({
            "strike": float(strike),
            "expiry_display": expiry_display,
            "expiry_raw": expiry_raw,
            "ce": {
                "ltp": round(float(ce_ltp), 2),
                "iv": round(float(ce_iv), 2),
                "oi": int(ce_oi),
                "bid": round(float(ce_bid), 2),
                "ask": round(float(ce_ask), 2),
                "volume": int(ce_vol),
                "change": round(float(ce_chg), 2),
            },
            "pe": {
                "ltp": round(float(pe_ltp), 2),
                "iv": round(float(pe_iv), 2),
                "oi": int(pe_oi),
            },
        })

    # Sort by strike
    strikes.sort(key=lambda x: x["strike"])

    return {
        "underlying": round(float(underlying), 2),
        "expiry_dates": expiry_dates,
        "selected_expiry": selected_expiry,
        "strikes": strikes,
    }


def _covered_call_suggestions(strikes: list[dict], underlying: float, expiry_display: str, days_to_expiry: int) -> list[dict]:
    """
    From the live option chain, pick the best covered call strikes:
    - Near ATM (≤2% OTM): delta ~0.4-0.5, captures max premium
    - 5% OTM: balanced premium vs. upside
    - 8% OTM: low probability of assignment
    Only include strikes with actual traded premiums (LTP > 0).
    """
    atm = underlying
    suggestions = []

    for s in strikes:
        strike = s["strike"]
        ce = s["ce"]
        ltp = ce["ltp"]

        if ltp <= 0:
            continue  # skip illiquid / untouched strikes

        pct_otm = (strike - atm) / atm * 100
        if pct_otm < 0 or pct_otm > 15:
            continue  # only OTM calls make sense for covered calls

        monthly_yield = ltp / atm * 100
        prob_itm_approx = max(0, min(100, 50 - pct_otm * 3))  # crude approximation from IV
        prob_otm = 100 - prob_itm_approx

        # Tier label
        if pct_otm <= 3:
            label = "Near ATM"
            tier = 1
        elif pct_otm <= 6:
            label = "5% OTM"
            tier = 2
        elif pct_otm <= 10:
            label = "8% OTM"
            tier = 3
        else:
            label = "Deep OTM"
            tier = 4

        income_per_lot = ltp * 1000  # NSE lot size for VEDL / most mid-caps is 1000 (varies by stock)

        suggestions.append({
            "strike": strike,
            "strike_pct_above_spot": round(pct_otm, 1),
            "ltp": ltp,
            "bid": ce["bid"],
            "ask": ce["ask"],
            "iv": ce["iv"],
            "oi": ce["oi"],
            "volume": ce["volume"],
            "change": ce["change"],
            "income_per_share": ltp,
            "monthly_yield_pct": round(monthly_yield, 2),
            "expiry_date": expiry_display,
            "days_to_expiry": days_to_expiry,
            "label": label,
            "tier": tier,
            "recommendation": "SELL" if pct_otm >= 3 else "CONSIDER",
        })

    # Pick best 3: one from each tier if available, else top 3 by OTM%
    result = []
    seen_tiers = set()
    # Priority: tier 1 (near ATM), 2 (5%), 3 (8%)
    for tier in [1, 2, 3]:
        for s in suggestions:
            if s["tier"] == tier and tier not in seen_tiers:
                result.append(s)
                seen_tiers.add(tier)
                break

    # If we got less than 3, fill from remaining
    if len(result) < 3:
        for s in suggestions:
            if s not in result:
                result.append(s)
            if len(result) >= 3:
                break

    return result[:5]  # max 5


@router.get("/covered-calls/{symbol}")
async def get_covered_calls(symbol: str, expiry: str | None = Query(None)):
    """Fetch LIVE NSE option chain and return covered call opportunities."""
    sym = normalize_symbol(symbol)
    bare = sym.replace(".NS", "").replace(".BO", "").upper()

    # Get stock info for company name and lot size
    info = get_info(sym)
    company_name = safe_get(info, "longName", default=bare) or bare
    current_price = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=0) or 0

    # Fetch live option chain
    raw_data = _fetch_option_chain(sym)
    parsed = _parse_chain(raw_data, expiry_filter=expiry)

    if not parsed["strikes"]:
        raise HTTPException(status_code=404, detail=f"No option chain data found for {bare}. This stock may not have listed options.")

    underlying = parsed["underlying"] or float(current_price)
    expiry_dates = parsed["expiry_dates"]
    selected_expiry = parsed["selected_expiry"] or (expiry_dates[0] if expiry_dates else "")

    # Calculate days to expiry
    days_to_expiry = 0
    expiry_display = selected_expiry
    for s in parsed["strikes"]:
        if s["expiry_raw"]:
            try:
                exp_date = datetime.strptime(s["expiry_raw"], "%d-%m-%Y").date()
                from datetime import date
                days_to_expiry = (exp_date - date.today()).days
                expiry_display = s["expiry_display"]
            except Exception:
                pass
            break

    # Build full strikes list for the chain view
    chain = []
    for s in parsed["strikes"]:
        chain.append({
            "strike": s["strike"],
            "expiry": s["expiry_display"],
            "ce_ltp": s["ce"]["ltp"],
            "ce_iv": s["ce"]["iv"],
            "ce_oi": s["ce"]["oi"],
            "ce_bid": s["ce"]["bid"],
            "ce_ask": s["ce"]["ask"],
            "ce_volume": s["ce"]["volume"],
            "ce_change": s["ce"]["change"],
            "pe_ltp": s["pe"]["ltp"],
            "pe_iv": s["pe"]["iv"],
            "pe_oi": s["pe"]["oi"],
        })

    # Covered call suggestions (top 3-5 OTM strikes)
    suggestions = _covered_call_suggestions(parsed["strikes"], underlying, expiry_display, days_to_expiry)

    return JSONResponse(content=clean_for_json({
        "symbol": sym,
        "underlying_symbol": bare,
        "company_name": company_name,
        "current_price": round(underlying, 2),
        "expiry_dates": expiry_dates,
        "selected_expiry": expiry_display,
        "days_to_expiry": days_to_expiry,
        "suggestions": suggestions,
        "chain": chain,
        "data_source": "NSE India (Live)",
    }))
