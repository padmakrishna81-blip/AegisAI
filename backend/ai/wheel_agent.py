"""
Wheel Strategy AI Agent.

Three modes:
  scout  — rank candidates from a scan list; recommend the best 2-3 for CSP entry
  plan   — for a chosen stock, recommend specific strike/expiry with full reasoning
  review — for an open position (put or CC), recommend close / hold / roll

All modes produce a structured dict.  If LLM is configured the narrative fields are
written by the model; if not, they are built from rule-based templates.
"""

from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime, date
from typing import Any

# ─── Black-Scholes helpers ────────────────────────────────────────────────────

def _ncdf(x: float) -> float:
    return (1 + math.erf(x / math.sqrt(2))) / 2

def _npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

def bs_put_price(spot: float, strike: float, iv: float, T: float, rf: float = 0.065) -> float:
    if T <= 0: return max(0.0, strike - spot)
    s = iv / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return strike * math.exp(-rf * T) * _ncdf(-d2) - spot * _ncdf(-d1)

def bs_call_price(spot: float, strike: float, iv: float, T: float, rf: float = 0.065) -> float:
    if T <= 0: return max(0.0, spot - strike)
    s = iv / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return spot * _ncdf(d1) - strike * math.exp(-rf * T) * _ncdf(d2)

def put_delta(spot: float, strike: float, iv: float, T: float, rf: float = 0.065) -> float:
    if T <= 0: return -1.0 if strike > spot else 0.0
    s = iv / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    return _ncdf(d1) - 1.0

def prob_put_worthless(spot: float, strike: float, iv: float, T: float, rf: float = 0.065) -> float:
    """Prob of stock finishing above strike at expiry (put expires worthless)."""
    if T <= 0: return 100.0 if spot > strike else 0.0
    s = iv / 100.0
    d2 = (math.log(spot / strike) + (rf - 0.5 * s * s) * T) / (s * math.sqrt(T))
    return round(_ncdf(d2) * 100, 1)

def call_delta(spot: float, strike: float, iv: float, T: float, rf: float = 0.065) -> float:
    if T <= 0: return 1.0 if spot > strike else 0.0
    s = iv / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    return _ncdf(d1)

def theta_per_day(spot: float, strike: float, iv: float, T: float, is_call: bool, rf: float = 0.065) -> float:
    if T <= 0: return 0.0
    s = iv / 100.0
    d1 = (math.log(spot / strike) + (rf + 0.5 * s * s) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    base = -(spot * _npdf(d1) * s) / (2 * math.sqrt(T))
    if is_call:
        return (base - rf * strike * math.exp(-rf * T) * _ncdf(d2)) / 365
    else:
        return (base + rf * strike * math.exp(-rf * T) * _ncdf(-d2)) / 365


# ─── Data helpers ─────────────────────────────────────────────────────────────

def _get_stock_context(symbol: str) -> dict[str, Any]:
    """Fetch CMP, IV, RSI, 200DMA, 52W high/low for a symbol."""
    import yfinance as yf
    from data.market_data import normalize_symbol, get_info, safe_get

    sym = normalize_symbol(symbol)
    ctx: dict[str, Any] = {"symbol": sym, "bare": sym.replace(".NS", "")}
    try:
        t = yf.Ticker(sym)
        fi = t.fast_info
        ctx["cmp"]     = round(float(getattr(fi, "last_price", None) or 0), 2)
        ctx["high_52w"] = round(float(getattr(fi, "year_high", None) or 0), 2)
        ctx["low_52w"]  = round(float(getattr(fi, "year_low", None) or 0), 2)

        hist = t.history(period="1y")
        if not hist.empty:
            close = hist["Close"]
            # RSI-14
            delta = close.diff()
            gain  = delta.clip(lower=0).rolling(14).mean()
            loss  = (-delta.clip(upper=0)).rolling(14).mean()
            rs    = gain / loss.replace(0, 0.001)
            ctx["rsi"] = round(float((100 - 100 / (1 + rs)).iloc[-1]), 1)
            # 200-day SMA
            ctx["sma200"] = round(float(close.rolling(200).mean().iloc[-1]), 2) if len(close) >= 200 else None
            ctx["above_200dma"] = bool(ctx["cmp"] > ctx["sma200"]) if ctx["sma200"] else None
            # 30-day historical vol → proxy IV if jugaad fails
            returns = close.pct_change().dropna()
            ctx["hist_vol_30d"] = round(float(returns.tail(30).std() * math.sqrt(252) * 100), 1)
    except Exception:
        pass

    # Sector / name
    try:
        info = get_info(sym)
        ctx["name"]   = safe_get(info, "longName") or safe_get(info, "shortName") or ctx["bare"]
        ctx["sector"] = safe_get(info, "sector") or ""
    except Exception:
        ctx["name"] = ctx["bare"]
        ctx["sector"] = ""

    return ctx


def _get_live_iv(symbol: str, expiry: str = "") -> float | None:
    """Try jugaad NSE option chain for ATM IV; fallback to hist_vol proxy."""
    try:
        from jugaad_data.nse import NSELive
        bare = symbol.replace(".NS", "")
        nse  = NSELive()
        data = nse.equities_option_chain(bare)
        spot = float(data.get("records", {}).get("underlyingValue", 0))
        if spot <= 0:
            return None
        rows  = data.get("records", {}).get("data", [])
        expiries = data.get("records", {}).get("expiryDates", [])
        if expiry not in expiries:
            expiry = expiries[0] if expiries else ""
        best_iv = None
        best_dist = float("inf")
        for r in rows:
            if r.get("expiryDate") != expiry:
                continue
            for side in ("CE", "PE"):
                entry = r.get(side, {})
                sk    = float(r.get("strikePrice") or entry.get("strikePrice") or 0)
                iv    = float(entry.get("impliedVolatility") or 0)
                if sk > 0 and iv > 0 and abs(sk - spot) < best_dist:
                    best_dist = abs(sk - spot)
                    best_iv   = iv
        return round(best_iv, 1) if best_iv else None
    except Exception:
        return None


def _get_otm_puts(symbol: str, spot: float, expiry: str = "") -> list[dict]:
    """Fetch all OTM puts from NSE chain for the given expiry."""
    try:
        from jugaad_data.nse import NSELive
        from api.routes.paper_trade import _pick_best_expiry_str  # type: ignore
        bare = symbol.replace(".NS", "")
        nse  = NSELive()
        data = nse.equities_option_chain(bare)
        expiries = data.get("records", {}).get("expiryDates", [])
        if not expiry or expiry not in expiries:
            expiry = expiries[0] if expiries else ""
        rows = data.get("filtered", {}).get("data", []) or data.get("records", {}).get("data", [])
        puts = []
        for r in rows:
            pe     = r.get("PE", {})
            strike = float(r.get("strikePrice") or pe.get("strikePrice") or 0)
            ltp    = float(pe.get("lastPrice") or 0)
            oi     = int(pe.get("openInterest") or 0)
            iv     = float(pe.get("impliedVolatility") or 0)
            if strike <= 0 or ltp <= 0 or oi < 1 or strike >= spot:
                continue
            puts.append({"strike": strike, "ltp": ltp, "oi": oi, "iv": iv or 22.0})
        puts.sort(key=lambda x: x["strike"])
        return puts
    except Exception:
        return []


def _days_to(expiry_str: str) -> int:
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            exp = datetime.strptime(expiry_str, fmt).date()
            return max(0, (exp - date.today()).days)
        except ValueError:
            pass
    return 30


def _best_expiry_str(symbol: str) -> tuple[str, int]:
    """Return (expiry_str, dte) picking 21-50 DTE from NSE chain."""
    try:
        from jugaad_data.nse import NSELive
        bare = symbol.replace(".NS", "")
        nse  = NSELive()
        expiries = nse.equities_option_chain(bare).get("records", {}).get("expiryDates", [])
        best = ""
        best_dte = 30
        for e in expiries:
            dte = _days_to(e)
            if 21 <= dte <= 50:
                return e, dte
            if 50 < dte <= 65 and not best:
                best, best_dte = e, dte
        return (best or (expiries[0] if expiries else ""), best_dte)
    except Exception:
        return "", 30


def _lot_size(symbol: str) -> int:
    try:
        from api.routes.cc_strategy import _get_lot_size
        return int(_get_lot_size(symbol.replace(".NS", "").replace(".ns", "") + ".NS") or 1)
    except Exception:
        return 1


def _strike_step(cmp: float) -> float:
    """NSE standard strike intervals by price band."""
    if cmp < 100:   return 2.5
    if cmp < 250:   return 5.0
    if cmp < 500:   return 10.0
    if cmp < 1000:  return 20.0
    if cmp < 2500:  return 50.0
    if cmp < 5000:  return 100.0
    return 200.0


def _round_to_step(price: float, cmp: float) -> float:
    step = _strike_step(cmp)
    return round(price / step) * step


# ─── Rule-based templates ─────────────────────────────────────────────────────

def _iv_label(iv: float) -> str:
    if iv >= 40: return "very high (excellent premium)"
    if iv >= 28: return "elevated (good premium)"
    if iv >= 18: return "moderate"
    return "low (thin premium)"

def _rsi_label(rsi: float) -> str:
    if rsi >= 70: return "overbought — caution, avoid entry"
    if rsi >= 60: return "mildly overbought"
    if rsi <= 30: return "oversold — rebound risk"
    if rsi <= 42: return "neutral-to-bearish — good for CSP entry"
    return "neutral"

def _trend_label(ctx: dict) -> str:
    above = ctx.get("above_200dma")
    if above is True:  return "above 200 DMA — uptrend intact"
    if above is False: return "below 200 DMA — use extra caution"
    return "trend data unavailable"

def _support_label(spot: float, low_52w: float) -> str:
    pct = (spot - low_52w) / low_52w * 100 if low_52w > 0 else 0
    if pct < 5:   return "near 52W low — high support risk"
    if pct < 15:  return "moderate cushion above 52W low"
    return f"{pct:.0f}% above 52W low — good cushion"


# ─── SCOUT mode ───────────────────────────────────────────────────────────────

def scout(candidates: list[dict]) -> dict:
    """
    Rank 2-3 candidates for CSP entry.
    Each candidate: {symbol, cmp, atm_iv, score, above_200dma, ...}
    """
    results = []
    for c in candidates[:8]:
        sym  = c.get("symbol", "")
        cmp  = float(c.get("cmp") or 0)
        iv   = float(c.get("atm_iv") or c.get("iv") or 22)
        rsi  = float(c.get("rsi") or 50)
        sc   = float(c.get("score") or 50)
        a200 = c.get("above_200dma", None)
        low  = float(c.get("low_52w") or 0)
        high = float(c.get("high_52w") or 0)

        # Composite wheel score (out of 100)
        wheel_score = 0
        wheel_score += min(30, iv * 0.75)         # IV premium potential
        wheel_score += min(20, sc * 0.2)           # AegisAI fundamental score
        wheel_score += 10 if a200 else 0           # trend
        cushion = (cmp - low) / low * 100 if low > 0 else 0
        wheel_score += min(20, cushion * 0.5)      # safety cushion
        # RSI: best at 35-55
        rsi_pts = max(0, 20 - abs(rsi - 45) * 0.8)
        wheel_score += rsi_pts
        wheel_score = round(wheel_score, 1)

        lot = _lot_size(sym)
        T   = 30 / 365.0
        strike_5pct = _round_to_step(cmp * 0.95, cmp)
        est_premium = round(bs_put_price(cmp, strike_5pct, iv, T) * lot)

        reasons = []
        reasons.append(f"IV {iv}% — {_iv_label(iv)}")
        reasons.append(f"RSI {rsi} — {_rsi_label(rsi)}")
        reasons.append(_trend_label({"above_200dma": a200}))
        reasons.append(_support_label(cmp, low))
        if high > 0:
            from_high = round((cmp - high) / high * 100, 1)
            reasons.append(f"{from_high}% from 52W high")

        results.append({
            "symbol":       sym,
            "name":         c.get("name", sym),
            "cmp":          cmp,
            "iv":           iv,
            "rsi":          rsi,
            "above_200dma": a200,
            "wheel_score":  wheel_score,
            "lot_size":     lot,
            "est_strike":   strike_5pct,
            "est_premium":  est_premium,
            "reasons":      reasons,
        })

    results.sort(key=lambda x: x["wheel_score"], reverse=True)
    top3 = results[:3]

    # LLM narrative (optional)
    summary = _llm_scout_summary(top3) if _llm_available() else _rule_scout_summary(top3)

    return {
        "mode":     "scout",
        "rankings": top3,
        "summary":  summary,
    }


def _rule_scout_summary(top3: list[dict]) -> str:
    if not top3:
        return "No candidates available for evaluation."
    best = top3[0]
    lines = [f"Top pick: {best['symbol']} (Wheel Score {best['wheel_score']}/100)."]
    lines.append(f"IV {best['iv']}% — {_iv_label(best['iv'])}. RSI {best['rsi']} — {_rsi_label(best['rsi'])}.")
    if len(top3) > 1:
        lines.append(f"Also consider: {', '.join(c['symbol'] for c in top3[1:])}.")
    return " ".join(lines)


def _llm_scout_summary(top3: list[dict]) -> str:
    from ai.llm_client import call_llm
    data_str = json.dumps(top3, indent=2)
    prompt = (
        "You are a Wheel Strategy advisor for Indian NSE stocks.\n"
        f"Ranked candidates (already sorted by wheel_score):\n{data_str}\n\n"
        "Write 3-4 sentences: confirm top pick with key reasons, briefly note the runner-up, "
        "and highlight any risk to watch. Be specific and concise. No generic disclaimers."
    )
    result = call_llm(prompt, system="Concise options trading advisor. Plain text, no markdown.")
    return result if result and not result.startswith("[LLM") else _rule_scout_summary(top3)


# ─── PLAN mode ────────────────────────────────────────────────────────────────

def plan(symbol: str, lots: int = 1, expiry: str = "", avg_pct: float = 3.0) -> dict:
    """
    Recommend a specific CSP strike and expiry with full reasoning.
    Returns structured recommendation + 2 alternatives.
    """
    ctx = _get_stock_context(symbol)
    sym = ctx["symbol"]
    cmp = ctx.get("cmp", 0)
    if cmp <= 0:
        return {"error": f"Could not fetch live price for {symbol}"}

    # Get best expiry
    if not expiry:
        expiry, dte = _best_expiry_str(sym)
    else:
        dte = _days_to(expiry)
    if dte <= 0:
        dte = 30

    T   = dte / 365.0
    lot = _lot_size(sym)
    qty = lots * lot

    # Try live IV from NSE chain
    iv = _get_live_iv(sym, expiry) or ctx.get("hist_vol_30d", 22.0) or 22.0

    # Fetch live put strikes
    live_puts = _get_otm_puts(sym, cmp, expiry)

    def _score_put(strike: float, ltp: float, put_iv: float) -> dict:
        d    = round(put_delta(cmp, strike, put_iv, T), 3)
        prob = prob_put_worthless(cmp, strike, put_iv, T)
        prem = ltp if ltp > 0 else round(bs_put_price(cmp, strike, put_iv, T), 2)
        income    = round(prem * qty)
        eff_buy   = round(strike - prem, 2)
        margin    = round(strike * qty * 0.12)   # ~12% SPAN
        yield_pct = round(income / margin * 100, 2) if margin > 0 else 0
        pct_otm   = round((cmp - strike) / cmp * 100, 1)
        θ         = round(theta_per_day(cmp, strike, put_iv, T, is_call=False) * qty, 0)
        return {
            "strike":      strike,
            "ltp":         round(prem, 2),
            "delta":       d,
            "prob_worthless": prob,
            "income":      income,
            "eff_buy":     eff_buy,
            "margin":      margin,
            "yield_pct":   yield_pct,
            "pct_otm":     pct_otm,
            "theta_day":   θ,
            "expiry":      expiry,
            "dte":         dte,
        }

    # Build candidate strikes: use live puts first, then synthetic
    candidates = []
    if live_puts:
        # Find put closest to 3/5/8% OTM targets
        target_pct = [3, 5, 8]
        seen: set[float] = set()
        for pct in target_pct:
            strike = _round_to_step(cmp * (1 - pct / 100), cmp)
            closest = min(live_puts, key=lambda p: abs(p["strike"] - strike), default=None)
            if closest and closest["strike"] not in seen:
                seen.add(closest["strike"])
                candidates.append(_score_put(closest["strike"], closest["ltp"], closest["iv"] or iv))
    if len(candidates) < 3:
        # Synthetic fallback
        for pct in [3, 5, 8]:
            strike = _round_to_step(cmp * (1 - pct / 100), cmp)
            if not any(abs(c["strike"] - strike) < 1 for c in candidates):
                candidates.append(_score_put(strike, 0.0, iv))

    candidates.sort(key=lambda c: abs(c["delta"] + 0.25))  # closest to -0.25 delta first

    primary = candidates[0]
    alts    = candidates[1:3]

    # Earnings proximity check
    earnings_warn = _check_earnings(sym, expiry)
    rsi   = ctx.get("rsi", 50)
    above = ctx.get("above_200dma")

    flags = []
    if abs(primary["delta"]) > 0.40:
        flags.append("Strike is deep ITM — high assignment risk")
    if iv < 18:
        flags.append("IV is low — premium may not justify margin; consider waiting for IV expansion")
    if rsi and rsi > 65:
        flags.append(f"RSI {rsi} — stock is overbought; put premium is thinner from elevated base")
    if rsi and rsi < 35:
        flags.append(f"RSI {rsi} — stock oversold; assignment risk is higher near lows")
    if earnings_warn:
        flags.append(earnings_warn)
    if above is False:
        flags.append("Stock below 200 DMA — use conservative (lower) strike")

    # Next trigger
    trigger = f"Consider closing when position hits 50% profit (buy back at ₹{round(primary['ltp'] * 0.5, 1)})"

    # LLM or rule reasoning
    reasoning = (_llm_plan_reasoning(ctx, primary, alts, flags, lots)
                 if _llm_available()
                 else _rule_plan_reasoning(ctx, primary, alts, flags))

    return {
        "mode":       "plan",
        "symbol":     sym,
        "name":       ctx.get("name", ""),
        "cmp":        cmp,
        "iv":         iv,
        "rsi":        rsi,
        "above_200dma": above,
        "expiry":     expiry,
        "dte":        dte,
        "lots":       lots,
        "lot_size":   lot,
        "primary":    primary,
        "alternatives": alts,
        "risk_flags": flags,
        "next_trigger": trigger,
        "reasoning":  reasoning,
        "action":     "sell_put",
    }


def _check_earnings(symbol: str, expiry: str) -> str | None:
    try:
        import yfinance as yf
        cal = yf.Ticker(symbol).calendar
        if cal is None:
            return None
        if isinstance(cal, dict):
            dates = cal.get("Earnings Date") or []
        else:
            import pandas as pd
            dates = []
            for col in cal.columns:
                if "earning" in str(col).lower():
                    dates = list(cal[col])
                    break
        if not dates:
            return None
        exp_dt = None
        for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
            try:
                exp_dt = datetime.strptime(expiry, fmt).date(); break
            except ValueError:
                pass
        if not exp_dt:
            return None
        for d in dates:
            try:
                ed = d.date() if hasattr(d, "date") else datetime.strptime(str(d)[:10], "%Y-%m-%d").date()
                days_gap = (ed - date.today()).days
                if 0 <= days_gap <= 60:
                    if exp_dt >= ed:
                        return f"Earnings on {ed} — INSIDE expiry window; IV will spike into earnings"
                    else:
                        return f"Earnings on {ed} — {(ed - date.today()).days}d away, expiry is safe"
            except Exception:
                pass
    except Exception:
        pass
    return None


def _rule_plan_reasoning(ctx: dict, p: dict, alts: list[dict], flags: list[str]) -> list[str]:
    lines = [
        f"IV {ctx.get('iv', p.get('ltp', 0))}% — {_iv_label(ctx.get('hist_vol_30d', 22))}",
        f"RSI {ctx.get('rsi', 50)} — {_rsi_label(ctx.get('rsi', 50))}",
        _trend_label(ctx),
        _support_label(ctx.get("cmp", 0), ctx.get("low_52w", 0)),
        f"Delta {p['delta']} → P(expire worthless) ≈ {p['prob_worthless']}%",
        f"Income ₹{p['income']:,} = {p['yield_pct']}% on margin (₹{p['margin']:,}) for {p['dte']}d",
        f"Effective buy price if assigned: ₹{p['eff_buy']}",
    ]
    return lines


def _llm_plan_reasoning(ctx: dict, p: dict, alts: list[dict], flags: list[str], lots: int) -> list[str]:
    from ai.llm_client import call_llm
    prompt = (
        f"Wheel Strategy advisor for {ctx.get('name', ctx.get('bare', ''))} (NSE).\n"
        f"Stock data: CMP ₹{ctx.get('cmp')}, IV {ctx.get('hist_vol_30d', 22)}%, "
        f"RSI {ctx.get('rsi', 50)}, {'above' if ctx.get('above_200dma') else 'below'} 200 DMA, "
        f"52W High ₹{ctx.get('high_52w')}, Low ₹{ctx.get('low_52w')}.\n"
        f"Recommended strike: ₹{p['strike']} {p['expiry']} PE — "
        f"delta {p['delta']}, P(worthless) {p['prob_worthless']}%, "
        f"income ₹{p['income']:,}, yield {p['yield_pct']}% on ₹{p['margin']:,} margin.\n"
        f"Risk flags: {'; '.join(flags) if flags else 'none'}\n\n"
        "List exactly 5 concise bullet-point reasons (no numbers, no asterisks) why this is a good trade. "
        "Each bullet max 15 words. Output one bullet per line starting with '-'."
    )
    result = call_llm(prompt, system="Concise options advisor. 5 bullets only.", max_tokens=300)
    bullets = [ln.lstrip("- •").strip() for ln in result.splitlines() if ln.strip().startswith("-")]
    if len(bullets) >= 3:
        return bullets[:6]
    return _rule_plan_reasoning(ctx, p, alts, flags)


# ─── REVIEW mode ──────────────────────────────────────────────────────────────

def review(position: dict) -> dict:
    """
    Review an open Wheel position and recommend close / hold / roll.

    position keys:
      type        — 'put' or 'call'
      symbol      — e.g. 'INFY.NS'
      strike      — float
      expiry      — str  e.g. '30-Oct-2025'
      sell_price  — premium received when sold
      lots        — int
      lot_size    — int
      entry_date  — str (optional)
    """
    sym        = position.get("symbol", "")
    pos_type   = position.get("type", "put").lower()   # 'put' or 'call'
    strike     = float(position.get("strike", 0))
    expiry_str = position.get("expiry", "")
    sell_px    = float(position.get("sell_price", 0))
    lots       = int(position.get("lots", 1))
    lot_size   = int(position.get("lot_size", 1))
    qty        = lots * lot_size
    avg_cost   = float(position.get("avg_cost", 0))  # used for CC review

    ctx = _get_stock_context(sym)
    cmp = ctx.get("cmp", 0)
    if cmp <= 0:
        return {"error": f"Could not fetch live price for {sym}"}

    iv  = _get_live_iv(sym, expiry_str) or ctx.get("hist_vol_30d", 22.0) or 22.0
    dte = _days_to(expiry_str)
    T   = dte / 365.0

    is_call = pos_type == "call"
    cur_val = (bs_call_price(cmp, strike, iv, T) if is_call
               else bs_put_price(cmp, strike, iv, T))
    cur_val = round(cur_val, 2)

    # P&L metrics
    pnl_per_unit = sell_px - cur_val
    pnl_total    = round(pnl_per_unit * qty, 0)
    pct_profit   = round(pnl_per_unit / sell_px * 100, 1) if sell_px > 0 else 0
    max_profit   = round(sell_px * qty, 0)

    # Delta & prob
    delta = (call_delta(cmp, strike, iv, T) if is_call
             else put_delta(cmp, strike, iv, T))
    prob  = (prob_put_worthless(cmp, strike, iv, T) if not is_call
             else round((1 - prob_put_worthless(cmp, strike, iv, T) / 100) * 100, 1))
    θ     = round(theta_per_day(cmp, strike, iv, T, is_call) * qty, 0)

    # Decision logic
    action = "hold"
    confidence = "medium"

    if pct_profit >= 80:
        action = "close_now"
        confidence = "high"
    elif pct_profit >= 50 and dte <= 14:
        action = "close_now"
        confidence = "high"
    elif pct_profit >= 50:
        action = "close_now"
        confidence = "medium"
    elif dte <= 7:
        action = "close_now" if pct_profit > 20 else "hold"
    elif not is_call and cmp < strike * 0.98:
        action = "roll"
        confidence = "medium"
    elif is_call and cmp > strike * 1.01:
        action = "roll"
        confidence = "medium"
    elif pct_profit < 0 and abs(pct_profit) > 30:
        action = "roll"
        confidence = "low"

    # Roll suggestion
    roll_suggestion = None
    if action == "roll":
        new_strike = (_round_to_step(cmp * 0.95, cmp) if not is_call
                      else _round_to_step(cmp * 1.05, cmp))
        _, new_dte = _best_expiry_str(sym)
        new_T  = new_dte / 365.0
        new_px = (bs_put_price(cmp, new_strike, iv, new_T) if not is_call
                  else bs_call_price(cmp, new_strike, iv, new_T))
        roll_credit = round((new_px - cur_val) * qty, 0)
        roll_suggestion = {
            "new_strike":  round(new_strike, 2),
            "new_dte":     new_dte,
            "new_premium": round(new_px, 2),
            "roll_credit": roll_credit,
            "note": ("Roll for a credit" if roll_credit > 0 else "Roll at a small debit to reduce risk"),
        }

    # CC suggestion after put assignment
    cc_suggestion = None
    if not is_call and action in ("close_now",) and avg_cost > 0:
        cc_strike = _round_to_step(avg_cost * 1.05, cmp)
        _, cc_dte  = _best_expiry_str(sym)
        cc_T       = cc_dte / 365.0
        cc_px      = bs_call_price(cmp, cc_strike, iv, cc_T)
        cc_income  = round(cc_px * qty, 0)
        cc_suggestion = {
            "cc_strike":  round(cc_strike, 2),
            "cc_dte":     cc_dte,
            "cc_premium": round(cc_px, 2),
            "cc_income":  cc_income,
            "note": f"After closing put, sell CC at ₹{cc_strike:,.0f} for ₹{cc_income:,} more income",
        }

    reasoning = (_llm_review_reasoning(ctx, position, action, pct_profit, pnl_total, delta, dte, roll_suggestion)
                 if _llm_available()
                 else _rule_review_reasoning(action, pct_profit, pnl_total, delta, dte, cmp, strike, is_call))

    return {
        "mode":           "review",
        "symbol":         sym,
        "name":           ctx.get("name", ""),
        "cmp":            cmp,
        "strike":         strike,
        "type":           pos_type,
        "expiry":         expiry_str,
        "dte_remaining":  dte,
        "current_value":  cur_val,
        "sell_price":     sell_px,
        "pnl_total":      int(pnl_total),
        "pct_profit":     pct_profit,
        "max_profit":     int(max_profit),
        "delta":          round(delta, 3),
        "prob_worthless": prob,
        "theta_day":      θ,
        "action":         action,
        "confidence":     confidence,
        "roll":           roll_suggestion,
        "cc_next":        cc_suggestion,
        "reasoning":      reasoning,
    }


def _rule_review_reasoning(action: str, pct_profit: float, pnl: float, delta: float, dte: int,
                           cmp: float, strike: float, is_call: bool) -> list[str]:
    lines = []
    direction = "call" if is_call else "put"
    if action == "close_now":
        lines.append(f"Position at {pct_profit}% of max profit — locking in ₹{abs(int(pnl)):,}")
        lines.append(f"Closing now removes {dte}d of gamma risk with most premium already captured")
        if pct_profit >= 80:
            lines.append("At >80% profit, risk/reward favors closing immediately")
    elif action == "roll":
        if not is_call and cmp < strike * 0.98:
            lines.append(f"Stock ₹{cmp} is approaching {direction} strike ₹{strike} — assignment risk rising")
        elif is_call and cmp > strike * 1.01:
            lines.append(f"Stock ₹{cmp} is above call strike ₹{strike} — call-away risk rising")
        lines.append("Rolling to next month extends duration and collects additional credit")
        lines.append("Prefer rolling for a NET credit — do not roll at large debit")
    else:
        lines.append(f"Only {pct_profit}% profit — {dte}d of theta decay remaining")
        lines.append(f"Delta {delta:.2f}: position has manageable directional risk")
        lines.append("Hold and let time decay work; re-evaluate at 50% profit or <14 DTE")
    return lines


def _llm_review_reasoning(ctx: dict, pos: dict, action: str, pct: float, pnl: float,
                          delta: float, dte: int, roll: dict | None) -> list[str]:
    from ai.llm_client import call_llm
    roll_str = f"Roll suggestion: ₹{roll['new_strike']} for ₹{roll['roll_credit']:,} credit" if roll else "No roll needed"
    prompt = (
        f"Wheel Strategy position review for {ctx.get('name', pos.get('symbol', ''))}.\n"
        f"Open {pos.get('type','put').upper()} at strike ₹{pos.get('strike')}, "
        f"sold at ₹{pos.get('sell_price')}, current value ≈ ₹{ctx.get('cmp','?')}.\n"
        f"P&L: {pct}% of max profit (₹{int(abs(pnl)):,}), {dte} DTE remaining, delta {delta:.2f}.\n"
        f"Recommended action: {action.upper()}. {roll_str}.\n\n"
        "Give exactly 4 concise bullet reasons for the recommended action. "
        "One bullet per line starting with '-'. Max 15 words each."
    )
    result = call_llm(prompt, system="Concise options position reviewer.", max_tokens=250)
    bullets = [ln.lstrip("- •").strip() for ln in result.splitlines() if ln.strip().startswith("-")]
    if len(bullets) >= 3:
        return bullets[:5]
    return _rule_review_reasoning(action, pct, pnl, delta, dte, ctx.get("cmp", 0), pos.get("strike", 0),
                                   pos.get("type", "put") == "call")


# ─── LLM availability check ───────────────────────────────────────────────────

def _llm_available() -> bool:
    try:
        from ai.llm_client import is_configured
        return is_configured()
    except Exception:
        return False


# ─── STRATEGY REVIEW mode ─────────────────────────────────────────────────────

def strategy_review(legs: list[dict], strategy_name: str = "") -> dict:
    """
    Review a multi-leg strategy (options + shares) and recommend per-leg actions.

    Each leg:
      type          — 'short_put'|'short_call'|'long_put'|'long_call'|'long_share'
      symbol        — str
      strike        — float (options only)
      expiry        — str  (options only)
      dte           — int  days to expiry (options only)
      entry_price   — float  (premium received for short, buy price for shares)
      current_price — float  (current BS price for options, current CMP for shares)
      underlying_cmp — float
      lots          — int  (options)
      lot_size      — int  (options)
      qty           — int  (shares)
      pnl           — float  current ₹ P&L (positive = profit for the holder)
      is_short      — bool
    """
    if not legs:
        return {"error": "No legs provided"}

    leg_actions = []
    total_pnl      = 0.0
    total_max_prof = 0.0
    all_flags: list[str] = []

    for leg in legs:
        leg_type    = leg.get("type", "short_put")
        symbol      = leg.get("symbol", "?")
        strike      = float(leg.get("strike") or 0)
        dte         = int(leg.get("dte") or 30)
        entry_px    = float(leg.get("entry_price") or 0)
        cur_px      = float(leg.get("current_price") or 0)
        cmp         = float(leg.get("underlying_cmp") or cur_px)
        lots        = int(leg.get("lots") or 1)
        lot_size    = int(leg.get("lot_size") or 1)
        qty         = int(leg.get("qty") or lots * lot_size)
        pnl         = float(leg.get("pnl") or 0)
        is_short    = bool(leg.get("is_short", True))
        leg_id      = leg.get("id", leg_type)

        is_share = leg_type == "long_share"
        is_option = not is_share

        # Max profit for this leg
        if is_short and is_option:
            max_p = entry_px * qty
        elif not is_short and is_option:
            max_p = 0.0   # uncapped upside
        else:
            max_p = 0.0   # shares: no fixed max

        total_max_prof += max_p

        # P&L %
        if is_option and entry_px > 0:
            pnl_pct = round(pnl / (entry_px * qty) * 100, 1)
        elif is_share and entry_px > 0:
            pnl_pct = round(pnl / (entry_px * qty) * 100, 1)
        else:
            pnl_pct = 0.0

        total_pnl += pnl

        # Per-leg action decision
        action = "hold"
        reason = ""

        if is_short and is_option:
            if pnl_pct >= 75:
                action = "close"
                reason = f"{pnl_pct}% of max profit captured — close to lock in gains"
            elif pnl_pct >= 50 and dte <= 14:
                action = "close"
                reason = f"{pnl_pct}% profit with only {dte}d left — close, gamma risk accelerating"
            elif pnl_pct >= 50:
                action = "close"
                reason = f"50%+ profit target reached (₹{abs(int(pnl)):,}) — close and redeploy"
            elif is_option and "put" in leg_type and cmp < strike * 0.99:
                action = "roll"
                reason = f"Stock ₹{cmp} approaching put strike ₹{strike} — roll down and out for credit"
                all_flags.append(f"{symbol} put ₹{strike} at risk of assignment (CMP ₹{cmp})")
            elif is_option and "call" in leg_type and cmp > strike * 1.01:
                action = "roll"
                reason = f"Stock ₹{cmp} above call strike ₹{strike} — roll up and out"
                all_flags.append(f"{symbol} call ₹{strike} in-the-money (CMP ₹{cmp})")
            elif pnl_pct < -30:
                action = "roll"
                reason = f"Position down {abs(pnl_pct)}% — consider rolling to reduce loss"
            else:
                action = "hold"
                reason = f"{pnl_pct}% profit — theta decay working, hold to 50% target"

        elif not is_short and is_option:
            if pnl_pct >= 100:
                action = "close"
                reason = "Long option has doubled — consider taking profit"
            elif pnl_pct < -50 and dte <= 7:
                action = "close"
                reason = f"Down {abs(pnl_pct)}% with {dte}d left — salvage remaining time value"
            else:
                action = "hold"
                reason = f"{pnl_pct}% — hold for target move"

        elif is_share:
            share_loss_pct = pnl / (entry_px * qty) * 100 if entry_px > 0 else 0
            if share_loss_pct < -15:
                action = "close"
                reason = f"Share position down {abs(round(share_loss_pct, 1))}% — review stop-loss"
                all_flags.append(f"{symbol} shares down {abs(round(share_loss_pct, 1))}% — consider stop")
            elif share_loss_pct >= 10:
                action = "hold"
                reason = f"Up {round(share_loss_pct, 1)}% — hold; consider covered call if stagnating"
            else:
                action = "hold"
                reason = "Within normal range — hold as hedge/collateral"

        leg_actions.append({
            "id":      leg_id,
            "type":    leg_type,
            "symbol":  symbol,
            "strike":  strike if is_option else None,
            "action":  action,
            "pnl":     int(pnl),
            "pnl_pct": pnl_pct,
            "reason":  reason,
        })

    # DTE flags
    short_opts_near_expiry = [
        la for la in leg_actions
        if la["action"] == "hold"
        and "put" in la["type"] or "call" in la["type"]
    ]
    _ = short_opts_near_expiry  # used below

    # Overall action
    close_count = sum(1 for la in leg_actions if la["action"] == "close")
    roll_count  = sum(1 for la in leg_actions if la["action"] == "roll")

    if close_count == len(leg_actions):
        overall_action = "close_all"
        confidence     = "high"
    elif close_count > 0 and roll_count > 0:
        overall_action = "partial_close"
        confidence     = "medium"
    elif close_count > 0:
        overall_action = "partial_close"
        confidence     = "high" if close_count / len(leg_actions) >= 0.5 else "medium"
    elif roll_count > 0:
        overall_action = "roll"
        confidence     = "medium"
    else:
        overall_action = "hold"
        confidence     = "high"

    pct_of_max = round(total_pnl / total_max_prof * 100, 1) if total_max_prof > 0 else None

    # Next trigger
    if overall_action == "hold":
        next_trigger = "Re-check when any leg hits 50% profit or <14 DTE"
    elif overall_action in ("partial_close", "close_all"):
        next_trigger = "Execute closes with limit orders; redeploy freed margin next session"
    else:
        next_trigger = "Roll flagged legs for net credit before next market open"

    # Narrative
    reasoning = (_llm_strategy_reasoning(leg_actions, overall_action, total_pnl, all_flags, strategy_name)
                 if _llm_available()
                 else _rule_strategy_reasoning(leg_actions, overall_action, total_pnl, pct_of_max))

    return {
        "mode":           "strategy_review",
        "strategy_name":  strategy_name,
        "overall_action": overall_action,
        "confidence":     confidence,
        "total_pnl":      int(total_pnl),
        "pct_of_max":     pct_of_max,
        "leg_actions":    leg_actions,
        "risk_flags":     all_flags,
        "next_trigger":   next_trigger,
        "reasoning":      reasoning,
    }


def _rule_strategy_reasoning(leg_actions: list[dict], overall: str, pnl: float,
                              pct: float | None) -> list[str]:
    lines = []
    close_legs = [la for la in leg_actions if la["action"] == "close"]
    roll_legs  = [la for la in leg_actions if la["action"] == "roll"]
    hold_legs  = [la for la in leg_actions if la["action"] == "hold"]
    pnl_sign   = "profit" if pnl >= 0 else "loss"
    lines.append(f"Portfolio {pnl_sign}: ₹{abs(int(pnl)):,}" + (f" ({pct}% of max)" if pct else ""))
    if close_legs:
        lines.append(f"{len(close_legs)} leg(s) at 50%+ profit — close to capture gains and free margin")
    if roll_legs:
        lines.append(f"{len(roll_legs)} leg(s) need rolling — ITM risk increasing; roll for net credit")
    if hold_legs:
        lines.append(f"{len(hold_legs)} leg(s) in healthy range — theta decay continues working")
    lines.append("Never use market orders for options — always limit orders within bid-ask spread")
    return lines


def _llm_strategy_reasoning(leg_actions: list[dict], overall: str, pnl: float,
                             flags: list[str], name: str) -> list[str]:
    from ai.llm_client import call_llm
    legs_summary = "\n".join(
        f"  {la['type']} {la['symbol']}{' ₹'+str(la['strike']) if la['strike'] else ''}: "
        f"P&L ₹{la['pnl']:,} ({la['pnl_pct']}%) → {la['action'].upper()} — {la['reason']}"
        for la in leg_actions
    )
    flags_str = "; ".join(flags) if flags else "none"
    prompt = (
        f"Multi-leg options strategy review{': ' + name if name else ''}.\n"
        f"Leg actions:\n{legs_summary}\n"
        f"Overall recommendation: {overall.upper()}, total P&L ₹{int(pnl):,}\n"
        f"Risk flags: {flags_str}\n\n"
        "Write exactly 4 concise bullet reasons supporting the overall recommendation. "
        "One bullet per line starting with '-'. Max 15 words each. "
        "Focus on options mechanics: theta, delta, IV, risk."
    )
    result = call_llm(prompt, system="Concise multi-leg options strategy advisor.", max_tokens=250)
    bullets = [ln.lstrip("- •").strip() for ln in result.splitlines() if ln.strip().startswith("-")]
    if len(bullets) >= 3:
        return bullets[:5]
    return _rule_strategy_reasoning(leg_actions, overall, pnl, None)

