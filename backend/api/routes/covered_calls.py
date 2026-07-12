"""Covered calls endpoint using LIVE NSE option chain data via jugaad-data."""

import math
from datetime import datetime, date
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from data.market_data import get_info, safe_get, normalize_symbol
from api.utils import clean_for_json

router = APIRouter()

_nse = None


def _get_nse():
    global _nse
    if _nse is None:
        from jugaad_data.nse import NSELive
        _nse = NSELive()
    return _nse


def _pick_best_expiry(expiry_dates: list[str], min_days: int = 24, preferred_max: int = 50) -> str | None:
    """Pick the expiry closest to preferred window (24-50 days). Fall back to next available ≥ 24d."""
    today = date.today()
    best = None
    best_days = 9999
    for exp_str in expiry_dates:
        try:
            exp_date = datetime.strptime(exp_str, "%d-%b-%Y").date()
            days = (exp_date - today).days
            if days >= min_days and days < best_days:
                best = exp_str
                best_days = days
                if days <= preferred_max:
                    break
        except Exception:
            pass
    return best


def _fetch_option_chain(symbol: str, expiry: str | None = None) -> dict:
    """Fetch live NSE option chain for given symbol and expiry."""
    bare = symbol.replace(".NS", "").replace(".BO", "").upper()
    try:
        nse = _get_nse()
        if expiry:
            data = nse.equities_option_chain(bare, expiry=expiry)
        else:
            data = nse.equities_option_chain(bare)
        return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NSE option chain unavailable: {str(e)[:200]}")


def _parse_chain(data: dict, expiry_filter: str | None = None) -> dict:
    """Parse raw NSE option chain into structured dict."""
    rec  = data.get("records", {})
    filt = data.get("filtered", {})

    underlying    = float(rec.get("underlyingValue") or 0)
    expiry_dates  = rec.get("expiryDates", [])

    # If expiry filter given, fetch that expiry's data
    rows = filt.get("data") or rec.get("data") or []

    # Determine selected expiry
    if expiry_filter and expiry_filter in expiry_dates:
        selected_expiry = expiry_filter
    elif expiry_dates:
        # Auto-pick best expiry (24-50 days)
        selected_expiry = _pick_best_expiry(expiry_dates) or expiry_dates[0]
    else:
        selected_expiry = None

    def _fmt_expiry(raw: str) -> str:
        try:
            return datetime.strptime(raw, "%d-%m-%Y").strftime("%d %b %Y")
        except Exception:
            try:
                return datetime.strptime(raw, "%d-%b-%Y").strftime("%d %b %Y")
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

        expiry_raw = ce.get("expiryDate") or pe.get("expiryDate") or ""
        expiry_display = _fmt_expiry(expiry_raw) if expiry_raw else (selected_expiry or "")

        def _f(x): return round(float(x), 2) if x else 0.0
        def _i(x): return int(x) if x else 0

        strikes.append({
            "strike":        float(strike),
            "expiry_display": expiry_display,
            "expiry_raw":     expiry_raw,
            "ce": {
                "ltp":    _f(ce.get("lastPrice")),
                "iv":     _f(ce.get("impliedVolatility")),
                "oi":     _i(ce.get("openInterest")),
                "bid":    _f(ce.get("buyPrice1")),
                "ask":    _f(ce.get("sellPrice1")),
                "volume": _i(ce.get("totalTradedVolume")),
                "change": _f(ce.get("change")),
            },
            "pe": {
                "ltp": _f(pe.get("lastPrice")),
                "iv":  _f(pe.get("impliedVolatility")),
                "oi":  _i(pe.get("openInterest")),
            },
        })

    strikes.sort(key=lambda x: x["strike"])

    return {
        "underlying":     underlying,
        "expiry_dates":   expiry_dates,
        "selected_expiry": selected_expiry,
        "strikes":        strikes,
    }


def _covered_call_suggestions(strikes: list[dict], underlying: float,
                               expiry_display: str, days_to_expiry: int) -> list[dict]:
    """Pick best covered call strikes (0-15% OTM, liquid, OTM only)."""
    suggestions = []
    for s in strikes:
        strike = s["strike"]
        ce     = s["ce"]
        ltp    = ce["ltp"]
        if ltp <= 0:
            continue
        pct_otm = (strike - underlying) / underlying * 100
        if pct_otm < 0 or pct_otm > 15:
            continue

        monthly_yield = ltp / underlying * 100

        if pct_otm <= 3:   label, tier = "Near ATM", 1
        elif pct_otm <= 6: label, tier = "5% OTM",   2
        elif pct_otm <= 10:label, tier = "8% OTM",   3
        else:              label, tier = "Deep OTM",  4

        suggestions.append({
            "strike":               strike,
            "strike_pct_above_spot": round(pct_otm, 1),
            "ltp":                  ltp,
            "bid":                  ce["bid"],
            "ask":                  ce["ask"],
            "iv":                   ce["iv"],
            "oi":                   ce["oi"],
            "volume":               ce["volume"],
            "change":               ce["change"],
            "monthly_yield_pct":    round(monthly_yield, 2),
            "expiry_date":          expiry_display,
            "days_to_expiry":       days_to_expiry,
            "label":                label,
            "tier":                 tier,
            "recommendation":       "SELL" if pct_otm >= 3 else "CONSIDER",
        })

    # Best 3: one per tier
    result, seen_tiers = [], set()
    for tier in [1, 2, 3]:
        for s in suggestions:
            if s["tier"] == tier and tier not in seen_tiers:
                result.append(s); seen_tiers.add(tier); break
    for s in suggestions:
        if s not in result: result.append(s)
        if len(result) >= 5: break
    return result[:5]


@router.get("/covered-calls/{symbol}")
async def get_covered_calls(symbol: str, expiry: str | None = Query(None)):
    """Fetch LIVE NSE option chain with correct expiry switching."""
    sym  = normalize_symbol(symbol)
    bare = sym.replace(".NS", "").replace(".BO", "").upper()

    info         = get_info(sym)
    company_name = safe_get(info, "longName", default=bare) or bare

    # Fetch option chain (with expiry filter if provided)
    raw_data = _fetch_option_chain(sym, expiry=expiry if expiry else None)
    expiry_dates = raw_data.get("records", {}).get("expiryDates", [])

    # If expiry specified and valid, refetch with that expiry to get correct premiums
    if expiry and expiry in expiry_dates:
        raw_data = _fetch_option_chain(sym, expiry=expiry)

    parsed = _parse_chain(raw_data, expiry_filter=expiry)

    if not parsed["strikes"]:
        raise HTTPException(status_code=404, detail=f"No option chain data for {bare}")

    underlying     = parsed["underlying"]
    expiry_dates   = parsed["expiry_dates"]
    selected_expiry = parsed["selected_expiry"] or (expiry_dates[0] if expiry_dates else "")

    # Days to expiry
    days_to_expiry = 0
    expiry_display = selected_expiry or ""
    for s in parsed["strikes"]:
        if s["expiry_raw"]:
            try:
                fmt = "%d-%m-%Y" if "-" in s["expiry_raw"] and len(s["expiry_raw"].split("-")[1]) == 2 else "%d-%b-%Y"
                exp_date = datetime.strptime(s["expiry_raw"], fmt).date()
                days_to_expiry = (exp_date - date.today()).days
                expiry_display = s["expiry_display"]
            except Exception:
                pass
            break

    # Is this expiry in recommended window (24-50 days)?
    recommended = 24 <= days_to_expiry <= 50
    recommended_expiry = _pick_best_expiry(expiry_dates)

    chain = [{
        "strike":    s["strike"],
        "expiry":    s["expiry_display"],
        "ce_ltp":    s["ce"]["ltp"],
        "ce_iv":     s["ce"]["iv"],
        "ce_oi":     s["ce"]["oi"],
        "ce_bid":    s["ce"]["bid"],
        "ce_ask":    s["ce"]["ask"],
        "ce_volume": s["ce"]["volume"],
        "ce_change": s["ce"]["change"],
        "pe_ltp":    s["pe"]["ltp"],
        "pe_iv":     s["pe"]["iv"],
        "pe_oi":     s["pe"]["oi"],
    } for s in parsed["strikes"]]

    suggestions = _covered_call_suggestions(parsed["strikes"], underlying, expiry_display, days_to_expiry)

    return JSONResponse(content=clean_for_json({
        "symbol":              sym,
        "underlying_symbol":   bare,
        "company_name":        company_name,
        "current_price":       round(underlying, 2),
        "expiry_dates":        expiry_dates,
        "selected_expiry":     expiry_display,
        "days_to_expiry":      days_to_expiry,
        "recommended_expiry":  recommended_expiry,
        "expiry_in_window":    recommended,
        "suggestions":         suggestions,
        "chain":               chain,
        "data_source":         "NSE India (Live)",
    }))
