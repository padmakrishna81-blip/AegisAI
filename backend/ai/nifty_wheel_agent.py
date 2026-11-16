"""
NIFTY Wheel + NIFTYBEES Accumulation Strategy Engine.

Direction scoring (rule-based, no LLM):
  Technical signals  30%  — RSI, MACD, price vs SMAs
  Options/OI signals 40%  — PCR, max pain, OI walls
  Macro signals      30%  — VIX, USD/INR, crude, Nifty trend

Strike selection: filter by |delta| 0.20–0.30, direction-aligned.
"""

from __future__ import annotations

import math
import time
from datetime import datetime, date, timezone
from typing import Any

# ── Re-export BS helpers so routes can import from here ──────────────────────
from ai.wheel_agent import (
    put_delta, call_delta,
    bs_put_price, bs_call_price,
    theta_per_day,
)

NIFTY_LOT   = 65    # NSE lot size (updated Nov 2024)
NIFTY_STEP  = 50    # strike interval
DELTA_MIN   = 0.20
DELTA_MAX   = 0.30


# ── Helpers ───────────────────────────────────────────────────────────────────

def _days_to(expiry_str: str) -> int:
    try:
        exp = datetime.strptime(expiry_str, "%d-%b-%Y").date()
        return max(0, (exp - date.today()).days)
    except Exception:
        return 0


def _T(dte: int) -> float:
    return max(dte, 1) / 365.0


# ── Direction assessment ──────────────────────────────────────────────────────

def assess_direction() -> dict:
    """
    Run all three signal groups and return direction probabilities.
    Returns a dict with keys: bullish_score, up_prob, down_prob, sideways_prob,
    direction, nifty_spot, vix, signals, timestamp.
    """
    tech_result  = _score_technical()
    oi_result    = _score_oi()
    macro_result = _score_macro()

    # Weighted bullish score 0-100
    bullish_score = round(
        tech_result["score"] * 0.30 +
        oi_result["score"]   * 0.40 +
        macro_result["score"] * 0.30,
        1,
    )

    # VIX-adjusted sideways base
    vix = macro_result.get("vix", 16.0)
    sideways_base = 20 if vix < 14 else 12

    up_prob       = max(5, min(85, int(bullish_score)))
    down_prob     = max(5, min(85, int(100 - bullish_score - sideways_base)))
    sideways_prob = max(5, 100 - up_prob - down_prob)

    if up_prob >= down_prob and up_prob >= sideways_prob:
        direction = "UP"
    elif down_prob >= up_prob and down_prob >= sideways_prob:
        direction = "DOWN"
    else:
        direction = "SIDEWAYS"

    return {
        "bullish_score": bullish_score,
        "up_prob":       up_prob,
        "down_prob":     down_prob,
        "sideways_prob": sideways_prob,
        "direction":     direction,
        "nifty_spot":    oi_result.get("spot", 0.0),
        "vix":           vix,
        "signals": {
            "technical": tech_result,
            "oi":        oi_result,
            "macro":     macro_result,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _score_technical() -> dict:
    """Technical signals, returns score 0-100 + key indicators."""
    try:
        from engines.technical_strength import calculate
        r = calculate("^NSEI")
        score = r.get("score", 50)
        ind   = r.get("indicators", {})
        cp    = r.get("current_price", 0)
        bd    = r.get("breakdown", {})

        # extract RSI and MACD for signals display
        rsi  = ind.get("rsi", 50)
        macd = ind.get("macd", 0)
        sma50  = ind.get("sma50", cp)
        sma200 = ind.get("sma200", cp)

        return {
            "score":      score,
            "rsi":        rsi,
            "macd":       round(macd, 2),
            "above_sma50":  cp > sma50  if cp and sma50  else None,
            "above_sma200": cp > sma200 if cp and sma200 else None,
            "summary": "BULLISH" if score >= 60 else ("BEARISH" if score <= 40 else "NEUTRAL"),
        }
    except Exception as e:
        return {"score": 50, "error": str(e), "summary": "NEUTRAL"}


def _score_oi() -> dict:
    """Options/OI signals, returns score 0-100 + PCR, max pain, spot."""
    try:
        from ai.market_brain import get_oi_analysis, _get_spot, get_option_chain
        oi = get_oi_analysis("NIFTY")
        if "error" in oi:
            return {"score": 50, "error": oi["error"], "summary": "NEUTRAL", "spot": 0.0}

        spot   = oi.get("spot", 0.0)
        pcr    = oi.get("pcr", 1.0)
        mp     = oi.get("max_pain", spot)

        # ce_oi / pe_oi are dicts {strike: oi_amount} — sum to get totals
        ce_oi_raw = oi.get("ce_oi", {})
        pe_oi_raw = oi.get("pe_oi", {})
        ce_oi = sum(ce_oi_raw.values()) if isinstance(ce_oi_raw, dict) else float(ce_oi_raw or 0)
        pe_oi = sum(pe_oi_raw.values()) if isinstance(pe_oi_raw, dict) else float(pe_oi_raw or 0)

        score = 50  # neutral start

        # PCR contribution (40 pts)
        if pcr > 1.3:
            score += 20
        elif pcr > 1.0:
            score += 10
        elif pcr < 0.7:
            score -= 20
        elif pcr < 0.9:
            score -= 10

        # Max pain vs spot (30 pts)
        if spot > 0 and mp > 0:
            diff_pct = (mp - spot) / spot * 100
            if diff_pct > 0.5:
                score += 15
            elif diff_pct < -0.5:
                score -= 15

        # PE vs CE OI ratio (30 pts)
        if ce_oi and pe_oi:
            oi_ratio = pe_oi / ce_oi if ce_oi else 1.0
            if oi_ratio > 1.2:
                score += 15
            elif oi_ratio < 0.8:
                score -= 15

        score = max(0, min(100, score))

        return {
            "score":      score,
            "spot":       spot,
            "pcr":        round(pcr, 3),
            "pcr_signal": oi.get("pcr_signal", "NEUTRAL"),
            "max_pain":   mp,
            "max_pain_bias": oi.get("max_pain_bias", "AT_SPOT"),
            "summary": "BULLISH" if score >= 60 else ("BEARISH" if score <= 40 else "NEUTRAL"),
        }
    except Exception as e:
        return {"score": 50, "error": str(e), "summary": "NEUTRAL", "spot": 0.0}


def _score_macro() -> dict:
    """Macro signals, returns score 0-100 + VIX, trend."""
    try:
        from engines.macro_environment import calculate
        r     = calculate()
        score = r.get("score", 50)
        bd    = r.get("breakdown", {})

        vix_data = bd.get("volatility", {}).get("details", {})
        vix = 0.0
        try:
            from data.market_data import get_index_history
            vh = get_index_history("^INDIAVIX", "5d")
            if vh is not None and not vh.empty:
                vix = round(float(vh["Close"].iloc[-1]), 2)
        except Exception:
            pass

        return {
            "score":       score,
            "market_mode": r.get("market_mode", "NEUTRAL"),
            "vix":         vix,
            "summary": "BULLISH" if score >= 60 else ("BEARISH" if score <= 40 else "NEUTRAL"),
        }
    except Exception as e:
        return {"score": 50, "error": str(e), "summary": "NEUTRAL", "vix": 16.0}


# ── Strike recommendations ────────────────────────────────────────────────────

def get_strike_recommendations(
    direction: str,
    expiry: str,
    n_strikes: int = 12,   # per page; caller passes offset for pagination
    offset: int = 0,
) -> dict:
    """
    Return strikes divisible by 100 within spot ±1200 for the given direction+expiry.
    Sorted closest-to-spot first within each side (PE/CE).
    """
    from ai.market_brain import _get_spot, _estimate_iv
    from jugaad_data.nse import NSELive

    nse   = NSELive()
    chain = nse.index_option_chain("NIFTY", expiry=expiry)
    spot  = _get_spot("NIFTY", chain)
    if spot <= 0:
        return {"error": "Cannot fetch NIFTY spot price"}

    dte = _days_to(expiry)
    if dte <= 0:
        return {"error": f"Expiry {expiry} has already passed"}

    T       = _T(dte)
    iv_base = _estimate_iv("NIFTY", expiry, spot, chain)
    if iv_base <= 0:
        iv_base = 14.0

    rows = chain.get("records", {}).get("data") or []
    strikes_data: dict[float, dict] = {}
    for r in rows:
        strike = float(r.get("strikePrice", 0) or 0)
        if strike <= 0:
            continue
        entry = strikes_data.setdefault(strike, {})
        if "CE" in r:
            ce = r["CE"]
            entry["ce_ltp"] = float(ce.get("lastPrice") or 0)
            entry["ce_iv"]  = float(ce.get("impliedVolatility") or iv_base)
            entry["ce_oi"]  = int(ce.get("openInterest") or 0)
        if "PE" in r:
            pe = r["PE"]
            entry["pe_ltp"] = float(pe.get("lastPrice") or 0)
            entry["pe_iv"]  = float(pe.get("impliedVolatility") or iv_base)
            entry["pe_oi"]  = int(pe.get("openInterest") or 0)

    def _build_pe_row(strike: float, d: dict) -> dict:
        iv    = d.get("pe_iv") or iv_base
        dlt   = abs(put_delta(spot, strike, iv, T))
        ltp   = d.get("pe_ltp") or bs_put_price(spot, strike, iv, T)
        theta = abs(theta_per_day(spot, strike, iv, T, is_call=False))
        return {
            "strike":       strike,
            "type":         "PE",
            "ltp":          round(ltp, 2),
            "delta":        round(dlt, 3),
            "theta":        round(theta, 2),
            "iv":           round(iv, 1),
            "oi":           d.get("pe_oi", 0),
            "otm_pct":      round((spot - strike) / spot * 100, 2),
            "lot_size":     NIFTY_LOT,
            "premium_1lot": round(ltp * NIFTY_LOT, 0),
        }

    def _build_ce_row(strike: float, d: dict) -> dict:
        iv    = d.get("ce_iv") or iv_base
        dlt   = call_delta(spot, strike, iv, T)
        ltp   = d.get("ce_ltp") or bs_call_price(spot, strike, iv, T)
        theta = abs(theta_per_day(spot, strike, iv, T, is_call=True))
        return {
            "strike":       strike,
            "type":         "CE",
            "ltp":          round(ltp, 2),
            "delta":        round(dlt, 3),
            "theta":        round(theta, 2),
            "iv":           round(iv, 1),
            "oi":           d.get("ce_oi", 0),
            "otm_pct":      round((strike - spot) / spot * 100, 2),
            "lot_size":     NIFTY_LOT,
            "premium_1lot": round(ltp * NIFTY_LOT, 0),
        }

    pe_list, ce_list = [], []
    lo, hi = spot - 1200, spot + 1200
    atm = round(spot / 100) * 100   # nearest 100-pt strike to spot
    for strike in sorted(strikes_data.keys()):
        if int(strike) % 100 != 0:
            continue
        if not (lo <= strike <= hi):
            continue
        d = strikes_data[strike]
        if strike <= atm:            # PE: ATM and below (includes ATM)
            pe_list.append(_build_pe_row(strike, d))
        if strike >= atm:            # CE: ATM and above (includes ATM)
            ce_list.append(_build_ce_row(strike, d))

    # Sort PE by strike descending (closest to spot first)
    pe_list.sort(key=lambda x: -x["strike"])
    # Sort CE by strike ascending (closest to spot first)
    ce_list.sort(key=lambda x: x["strike"])

    return {
        "spot":      round(spot, 2),
        "expiry":    expiry,
        "dte":       dte,
        "direction": direction,
        "iv_base":   round(iv_base, 1),
        "all_pe":    pe_list,
        "all_ce":    ce_list,
        "total_pe":  len(pe_list),
        "total_ce":  len(ce_list),
    }


# ── Available expiries ────────────────────────────────────────────────────────

def get_expiries() -> list[dict]:
    """Return available NIFTY option expiries with DTE."""
    try:
        from ai.market_brain import get_option_chain
        chain    = get_option_chain("NIFTY")
        expiries = chain.get("records", {}).get("expiryDates", [])
        result   = []
        for e in expiries:
            dte = _days_to(e)
            if dte < 0:
                continue
            result.append({"expiry": e, "dte": dte})
        return result[:12]  # next 12 expiries
    except Exception as e:
        return []


# ── MTM monitoring ────────────────────────────────────────────────────────────

def get_position_mtm(pos: dict) -> dict:
    """Fetch current LTP and compute P&L for an active option position."""
    try:
        from ai.market_brain import get_option_chain, _estimate_iv, _get_spot

        strike     = float(pos.get("strike", 0))
        opt_type   = pos.get("type", "PE")
        expiry     = pos.get("expiry", "")
        sold_price = float(pos.get("premium_sold", 0))
        lots       = int(pos.get("lots", 1))
        lot_size   = int(pos.get("lot_size", NIFTY_LOT))

        chain = get_option_chain("NIFTY")
        spot  = _get_spot("NIFTY", chain)
        dte   = _days_to(expiry)
        T     = _T(dte)
        iv    = _estimate_iv("NIFTY", expiry, spot, chain) or 14.0

        # Try to find LTP from chain, else BS
        current_price = 0.0
        rows = chain.get("records", {}).get("data") or []
        for r in rows:
            if r.get("expiryDates", "") != expiry:   # top-level key is "expiryDates" (plural)
                continue
            if abs(float(r.get("strikePrice", 0)) - strike) < 0.01:
                side = r.get(opt_type, {})
                ltp  = float(side.get("lastPrice") or 0)
                if ltp > 0:
                    current_price = ltp
                    break

        if current_price <= 0:
            if opt_type == "PE":
                current_price = bs_put_price(spot, strike, iv, T)
            else:
                current_price = bs_call_price(spot, strike, iv, T)

        pnl = (sold_price - current_price) * lot_size * lots
        pnl_pct = (pnl / (sold_price * lot_size * lots) * 100) if sold_price else 0.0

        return {
            "id":             pos.get("id"),
            "spot":           round(spot, 2),
            "current_price":  round(current_price, 2),
            "pnl":            round(pnl, 2),
            "pnl_pct":        round(pnl_pct, 1),
            "dte":            dte,
            "profit_booking": pnl_pct >= 50,
            "risk_alert":     pnl_pct <= -100,
        }
    except Exception as e:
        return {"id": pos.get("id"), "error": str(e)}
