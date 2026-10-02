"""Smart Wheel V2 — Short Strangle + Equity Participation strategy engine.

Entry: Sell CE (2 SD) + Sell PE (1 SD) + Buy 25% lot shares at CMP.
Phase 1 (Strangle): monitor CMP vs PE-BE and CE-BE.
  → CMP crosses PE-BE downward: exit PE at loss + buy 25% more shares → Phase 2.
  → CMP crosses CE-BE upward:   close all three → profitable exit.
Phase 2 (Covered Call): short CE only + 50% lot shares.
  → CMP crosses CE-BE: close all → profitable exit.
MTM guardrail: amber at -6000, red at -10000, notify + recommend.
"""
from __future__ import annotations
import math
from datetime import datetime, date, timezone
from typing import Any

DTE_MIN      = 30
DTE_MAX      = 50
PHASE1_PCT   = 0.25   # 25% of lot at entry
PHASE2_PCT   = 0.25   # 25% more when PE-BE crossed


# ── Math helpers ──────────────────────────────────────────────────────────────

def _safe(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except Exception:
        return None


def _days_to_expiry(expiry_str: str) -> int:
    try:
        exp = datetime.strptime(expiry_str, "%Y-%m-%d").date()
        return max(0, (exp - date.today()).days)
    except Exception:
        return 0


def _strike_step(price: float) -> float:
    if price < 500:   return 10
    if price < 1000:  return 20
    if price < 2000:  return 50
    if price < 5000:  return 100
    return 200


def _round_to_step(price: float, step: float) -> float:
    return round(round(price / step) * step, 2)


def _sd_strike(spot: float, iv: float, dte: int, sd: float, direction: str) -> float:
    T    = dte / 365
    move = spot * iv * math.sqrt(T) * sd
    step = _strike_step(spot)
    raw  = spot + move if direction == "up" else spot - move
    return _round_to_step(raw, step)


# ── Live data ─────────────────────────────────────────────────────────────────

def _get_cmp(symbol: str) -> float | None:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol + ".NS").fast_info
        return _safe(info.last_price or info.previous_close)
    except Exception:
        return None


def _get_option_price(symbol: str, strike: float, expiry: str, opt_type: str) -> float | None:
    """Fetch option LTP from yfinance (fallback when broker session unavailable)."""
    try:
        import yfinance as yf
        chain = yf.Ticker(symbol + ".NS").option_chain(expiry)
        df    = chain.calls if opt_type == "CE" else chain.puts
        row   = df[abs(df["strike"] - strike) < 0.01]
        if row.empty:
            # nearest strike
            row = df.iloc[(df["strike"] - strike).abs().argsort()[:1]]
        return _safe(row.iloc[0]["lastPrice"])
    except Exception:
        return None


def _get_iv(symbol: str) -> float:
    try:
        from ai.wheel_agent import _get_live_iv
        iv = _get_live_iv(symbol)
        return float(iv) if iv else 0.25
    except Exception:
        return 0.25


def _get_lot_size(symbol: str) -> int:
    try:
        from ai.wheel_agent import _lot_size
        return _lot_size(symbol)
    except Exception:
        return 1


def _find_expiry(symbol: str) -> tuple[str, int] | None:
    """Find nearest expiry with DTE in [DTE_MIN, DTE_MAX]."""
    try:
        import yfinance as yf
        for e in yf.Ticker(symbol + ".NS").options:
            dte = _days_to_expiry(e)
            if DTE_MIN <= dte <= DTE_MAX:
                return e, dte
        return None
    except Exception:
        return None


def _get_otm_option(symbol: str, strike: float, expiry: str, opt_type: str) -> dict:
    """Return premium + delta for the closest available strike."""
    try:
        import yfinance as yf
        chain = yf.Ticker(symbol + ".NS").option_chain(expiry)
        df    = chain.calls if opt_type == "CE" else chain.puts
        # Find nearest strike
        df = df.copy()
        df["_diff"] = (df["strike"] - strike).abs()
        row = df.sort_values("_diff").iloc[0]
        return {
            "strike":    float(row["strike"]),
            "premium":   _safe(row["lastPrice"]) or 0,
            "iv":        _safe(row.get("impliedVolatility")) or 0,
            "delta":     _safe(row.get("delta")),
        }
    except Exception:
        return {"strike": strike, "premium": 0, "iv": 0, "delta": None}


# ── Capital estimate ──────────────────────────────────────────────────────────

def estimate_capital(symbol: str, cmp: float, lot_size: int,
                     iv: float, dte: int, ce_strike: float, pe_strike: float) -> dict:
    pe_be       = pe_strike - (cmp * iv * math.sqrt(dte / 365) * 0.5)  # approx
    span_margin = cmp * lot_size * 0.18                                  # ~18% notional
    phase1_cost = lot_size * PHASE1_PCT * cmp
    phase2_cost = lot_size * PHASE2_PCT * max(pe_be, pe_strike * 0.90)
    subtotal    = span_margin + phase1_cost + phase2_cost
    buffer      = subtotal * 0.10
    return {
        "span_margin":    round(span_margin),
        "phase1_shares":  round(phase1_cost),
        "phase2_reserve": round(phase2_cost),
        "subtotal":       round(subtotal),
        "buffer_10pct":   round(buffer),
        "total_required": round(subtotal + buffer),
    }


# ── Stock assessment ──────────────────────────────────────────────────────────

def assess_stock(symbol: str) -> dict:
    result: dict[str, Any] = {"symbol": symbol, "eligible": False, "score": 0, "reasons": []}

    cmp = _get_cmp(symbol)
    if not cmp:
        result["reason"] = "Cannot fetch price"
        return result

    expiry_result = _find_expiry(symbol)
    if not expiry_result:
        result["reason"] = f"No expiry with {DTE_MIN}–{DTE_MAX} DTE"
        return result
    expiry, dte = expiry_result

    lot_size = _get_lot_size(symbol)
    iv       = _get_iv(symbol)

    try:
        from ai.wheel_agent import _get_stock_context
        ctx = _get_stock_context(symbol)
    except Exception:
        ctx = {}

    rsi    = _safe(ctx.get("rsi"))
    ret_5d = _safe(ctx.get("ret_5d"))
    score  = 0
    reasons: list[str] = []

    # IV: higher = better premium
    if iv > 0.35:   score += 30; reasons.append(f"High IV {iv:.0%}")
    elif iv > 0.25: score += 20; reasons.append(f"Moderate IV {iv:.0%}")
    else:           score += 5

    # Trend: oversold preferred
    if rsi is not None:
        if rsi < 35:   score += 30; reasons.append(f"RSI {rsi:.0f} — oversold")
        elif rsi < 45: score += 20; reasons.append(f"RSI {rsi:.0f} — leaning oversold")
        elif rsi > 65: score += 5;  reasons.append(f"RSI {rsi:.0f} — overbought risk")
        else:          score += 12

    # Recent dip: bounce candidate
    if ret_5d is not None and ret_5d < -3:
        score += 20; reasons.append(f"5d dip {ret_5d:.1f}% — bounce setup")

    # DTE quality
    if 35 <= dte <= 45: score += 20; reasons.append(f"DTE {dte} — ideal")
    else:               score += 10; reasons.append(f"DTE {dte}")

    ce_strike_est = _sd_strike(cmp, iv, dte, 2.0, "up")
    pe_strike_est = _sd_strike(cmp, iv, dte, 1.0, "down")
    capital       = estimate_capital(symbol, cmp, lot_size, iv, dte, ce_strike_est, pe_strike_est)

    result.update({
        "eligible":        True,
        "score":           score,
        "reasons":         reasons,
        "cmp":             cmp,
        "dte":             dte,
        "expiry":          expiry,
        "lot_size":        lot_size,
        "iv":              round(iv, 4),
        "rsi":             rsi,
        "ce_strike_est":   ce_strike_est,
        "pe_strike_est":   pe_strike_est,
        "capital":         capital,
    })
    return result


def pick_best_stock(watchlist: list[str]) -> tuple[dict | None, list[dict]]:
    """Assess all watchlist stocks. Returns (best, all_results)."""
    results = []
    for sym in watchlist:
        r = assess_stock(sym)
        results.append(r)
    eligible = [r for r in results if r.get("eligible")]
    eligible.sort(key=lambda x: x["score"], reverse=True)
    return (eligible[0] if eligible else None), results


# ── MTM calculation ───────────────────────────────────────────────────────────

def calculate_mtm(position: dict, cmp: float | None = None) -> dict:
    symbol   = position["stock"]
    lot_size = position["lot_size"]
    phase    = position.get("phase", "strangle")
    expiry   = position["expiry"]

    if cmp is None:
        cmp = _get_cmp(symbol)
    if not cmp:
        return {"error": "Cannot fetch CMP", "mtm": position.get("current_mtm", 0)}

    # CE leg (always open)
    ce_sold = position["ce_premium_sold"]
    ce_live = _get_option_price(symbol, position["ce_strike"], expiry, "CE") or ce_sold
    ce_pnl  = (ce_sold - ce_live) * lot_size

    # PE leg (open only in phase strangle)
    pe_pnl = 0.0
    pe_live: float | None = None
    if phase == "strangle":
        pe_sold = position["pe_premium_sold"]
        pe_live = _get_option_price(symbol, position["pe_strike"], expiry, "PE") or pe_sold
        pe_pnl  = (pe_sold - pe_live) * lot_size

    # Shares P&L
    total_shares = position.get("shares_phase1", 0) + position.get("shares_phase2", 0)
    avg_price    = position.get("shares_avg_price", cmp)
    shares_pnl   = (cmp - avg_price) * total_shares

    total_mtm = ce_pnl + pe_pnl + shares_pnl

    cfg = _get_thresholds(position.get("username", ""))
    amber_thr = cfg.get("mtm_amber", -6000)
    red_thr   = cfg.get("mtm_red",   -10000)

    if total_mtm >= amber_thr:
        mtm_status = "green"
    elif total_mtm >= red_thr:
        mtm_status = "amber"
    else:
        mtm_status = "red"

    return {
        "cmp":        cmp,
        "ce_live":    round(ce_live, 2),
        "ce_pnl":     round(ce_pnl, 2),
        "pe_live":    round(pe_live, 2) if pe_live is not None else None,
        "pe_pnl":     round(pe_pnl, 2),
        "shares_pnl": round(shares_pnl, 2),
        "total_mtm":  round(total_mtm, 2),
        "mtm_status": mtm_status,
    }


def _get_thresholds(username: str) -> dict:
    try:
        from data.wheel_positions import get_config
        cfg = get_config(username)
        return {"mtm_amber": cfg.get("mtm_amber", -6000), "mtm_red": cfg.get("mtm_red", -10000)}
    except Exception:
        return {"mtm_amber": -6000, "mtm_red": -10000}


# ── Break-even triggers ───────────────────────────────────────────────────────

def check_triggers(position: dict, cmp: float) -> list[str]:
    triggers = []
    if position.get("phase") == "strangle" and cmp <= position.get("pe_be", 0):
        triggers.append("PE_BE_CROSSED")
    if cmp >= position.get("ce_be", 0):
        triggers.append("CE_BE_CROSSED")
    return triggers


# ── Recommendation ────────────────────────────────────────────────────────────

def get_recommendation(position: dict, mtm_data: dict) -> str:
    cmp       = mtm_data.get("cmp", 0)
    total_mtm = mtm_data.get("total_mtm", 0)
    phase     = position.get("phase", "strangle")
    pe_be     = position.get("pe_be", 0)
    ce_be     = position.get("ce_be", 0)
    dte       = _days_to_expiry(position.get("expiry", ""))
    shares2   = int(position.get("lot_size", 0) * PHASE2_PCT)

    if cmp <= pe_be and phase == "strangle":
        return (f"CMP ₹{cmp:.0f} crossed PE-BE ₹{pe_be:.0f} — "
                f"exit PE at loss + buy {shares2} more shares now")
    if cmp >= ce_be:
        return f"CMP ₹{cmp:.0f} crossed CE-BE ₹{ce_be:.0f} — close all legs, profitable exit"
    cfg = _get_thresholds(position.get("username", ""))
    if total_mtm < cfg["mtm_red"]:
        if dte > 15:
            return f"MTM ₹{total_mtm:,.0f} | DTE {dte}d — roll PE down for credit or close to protect capital"
        return f"MTM ₹{total_mtm:,.0f} | DTE {dte}d — close all legs immediately"
    if total_mtm < cfg["mtm_amber"]:
        return f"MTM ₹{total_mtm:,.0f} | DTE {dte}d — monitor closely, hold while trend intact"
    return f"MTM ₹{total_mtm:,.0f} | DTE {dte}d — on track, let theta decay work"


# ── Monitor cycle (called every 15 min) ──────────────────────────────────────

def monitor_all(username: str) -> list[dict]:
    """Monitor all active positions for a user. Called by background scheduler."""
    from data.wheel_positions import get_positions, update_position
    from services.notify import notify_wheel

    results = []
    for pos in get_positions(username):
        if pos.get("status") not in ("active", "covered_call"):
            continue
        pos_id = pos["id"]
        mtm_data = calculate_mtm(pos)
        if "error" in mtm_data:
            results.append({"id": pos_id, "error": mtm_data["error"]})
            continue

        cmp       = mtm_data["cmp"]
        total_mtm = mtm_data["total_mtm"]
        status    = mtm_data["mtm_status"]
        triggers  = check_triggers(pos, cmp)
        reco      = get_recommendation(pos, mtm_data)
        prev_status = pos.get("mtm_status", "green")

        patch = {
            "current_cmp":    cmp,
            "current_mtm":    total_mtm,
            "mtm_status":     status,
            "last_monitored": datetime.now(timezone.utc).isoformat(),
        }

        # Alert on trigger or status degradation
        alerts = list(pos.get("alerts", []))
        should_alert = bool(triggers) or (status == "red") or (status == "amber" and prev_status == "green")
        if should_alert:
            entry = {
                "time":    datetime.now(timezone.utc).isoformat(),
                "level":   "action" if triggers else status,
                "trigger": triggers,
                "message": reco,
                "cmp":     cmp,
                "mtm":     total_mtm,
            }
            alerts.append(entry)
            patch["alerts"] = alerts[-20:]
            note = f"Triggers: {', '.join(triggers)}" if triggers else ""
            notify_wheel(username, "action" if triggers else status,
                         pos["stock"], total_mtm, cmp, reco, note)

        update_position(username, pos_id, patch)
        results.append({"id": pos_id, "cmp": cmp, "mtm": total_mtm,
                         "status": status, "triggers": triggers, "reco": reco})
    return results
