"""AI-driven quality stock picker — screens Nifty 100/midcap for fallen large/mid-caps."""
from __future__ import annotations
import json
import math
import os
import time
from datetime import datetime, timezone
from typing import Any

from ai.llm_client import call_llm

# ── NSE sector lookup (loaded from catalog if available) ──────────────────────
_NSE_SECTORS: dict[str, str] = {}
try:
    _catalog_path = os.path.join(os.path.dirname(__file__), "..", "nse_catalog.json")
    with open(_catalog_path) as _f:
        _catalog_data = json.load(_f)
    for _sym, _entry in _catalog_data.items():
        _NSE_SECTORS[_sym] = _entry.get("sector", "")
except Exception:
    pass

# ── Stock universe ─────────────────────────────────────────────────────────────

UNIVERSE = [
    # Nifty 50 core
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR",
    "SBIN", "BAJFINANCE", "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK",
    "ASIANPAINT", "MARUTI", "TITAN", "WIPRO", "ULTRACEMCO", "NESTLEIND",
    "TECHM", "SUNPHARMA", "HCLTECH", "POWERGRID", "NTPC", "ONGC",
    "ADANIPORTS", "COALINDIA", "BAJAJFINSV", "GRASIM", "DIVISLAB",
    "CIPLA", "DRREDDY", "EICHERMOT", "BPCL", "TATACONSUM", "APOLLOHOSP",
    "TATAMOTORS", "HINDALCO", "JSWSTEEL", "TATASTEEL", "INDUSINDBK",
    "HDFCLIFE", "SBILIFE", "BAJAJ-AUTO", "HEROMOTOCO", "BRITANNIA",
    "M&M", "ITC", "SHRIRAMFIN", "TRENT", "BEL",
    # Nifty Next 50 / quality mid-caps
    "PIDILITIND", "DABUR", "GODREJCP", "MARICO", "BERGEPAINT",
    "COLPAL", "HAVELLS", "MUTHOOTFIN", "CHOLAFIN", "DMART",
    "IRCTC", "INDHOTEL", "MOTHERSON", "BOSCHLTD", "BALKRISIND",
    "CUMMINSIND", "AUROPHARMA", "TORNTPHARM", "ALKEM", "LUPIN",
    "BANDHANBNK", "FEDERALBNK", "IDFCFIRSTB", "NMDC", "HINDZINC",
    "TATAPOWER", "JUBLFOOD", "ZOMATO", "NYKAA", "PAYTM",
    "VEDL", "SAIL", "TATACOMM", "ADANIENT", "ADANIGREEN",
    "RADICO", "UBL", "MCDOWELL-N", "GODFRYPHLP", "PGHH",
    "VOLTAS", "WHIRLPOOL", "CESC", "NATIONALUM", "PNB",
    "CANBK", "BIOCON", "LALPATHLAB", "METROPOLIS", "MAXHEALTH",
    "DELHIVERY", "NUVAMA", "POLICYBZR", "PAYTM", "INOXWIND",
]
# Deduplicate
UNIVERSE = list(dict.fromkeys(UNIVERSE))

_picks_cache: dict = {}
_PICKS_TTL = 1800  # 30 min

_metrics_cache: dict = {}
_METRICS_TTL = 900  # 15 min — shared between screener and AI picks


def _compute_rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    if len(gains) < period:
        return None
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)


def _safe_float(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except Exception:
        return None


def _compute_ema(closes: list[float], period: int) -> list[float]:
    k = 2 / (period + 1)
    ema = [closes[0]]
    for p in closes[1:]:
        ema.append(p * k + ema[-1] * (1 - k))
    return ema


def _compute_macd(closes: list[float]) -> tuple[float | None, float | None, bool | None]:
    if len(closes) < 35:
        return None, None, None
    ema12 = _compute_ema(closes, 12)
    ema26 = _compute_ema(closes, 26)
    macd_vals = [e12 - e26 for e12, e26 in zip(ema12, ema26)]
    signal = _compute_ema(macd_vals[-26:], 9)
    line = round(macd_vals[-1], 4)
    sig  = round(signal[-1], 4)
    return line, sig, bool(line > sig)


def _count_consecutive_down(closes: list[float]) -> int:
    count = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] < closes[i - 1]:
            count += 1
        else:
            break
    return count


def _get_metrics(symbols: list[str]) -> dict[str, dict]:
    """Download 1-year price data for all symbols and compute screening metrics."""
    import yfinance as yf

    ns_symbols = [s + ".NS" for s in symbols]
    try:
        data = yf.download(
            ns_symbols, period="1y", auto_adjust=True,
            progress=False, threads=True, group_by="ticker",
        )
    except Exception:
        return {}

    metrics: dict[str, dict] = {}
    for sym in symbols:
        ns = sym + ".NS"
        try:
            if hasattr(data.columns, "get_level_values") and ns in data.columns.get_level_values(0):
                closes_raw = data[ns]["Close"].dropna()
                volume_raw = data[ns]["Volume"].dropna() if "Volume" in data[ns].columns else None
            elif "Close" in data.columns:
                closes_raw = data["Close"].dropna()
                volume_raw = data["Volume"].dropna() if "Volume" in data.columns else None
            else:
                continue

            close_list = [_safe_float(v) for v in closes_raw.tolist()]
            close_list = [v for v in close_list if v is not None]
            if len(close_list) < 30:
                continue

            current   = close_list[-1]
            high_52w  = max(close_list)
            low_52w   = min(close_list)
            pct_from_high = round((current - high_52w) / high_52w * 100, 2)
            pct_from_low  = round((current - low_52w) / low_52w * 100, 2)
            ret_5d  = round((current - close_list[-6]) / close_list[-6] * 100, 2) if len(close_list) >= 6 else None
            ret_20d = round((current - close_list[-21]) / close_list[-21] * 100, 2) if len(close_list) >= 21 else None
            ret_3m  = round((current - close_list[-63]) / close_list[-63] * 100, 2) if len(close_list) >= 63 else None
            rsi = _compute_rsi(close_list)

            sma_50  = round(sum(close_list[-50:]) / 50, 2) if len(close_list) >= 50 else None
            sma_200 = round(sum(close_list[-200:]) / 200, 2) if len(close_list) >= 200 else None
            above_50_dma  = bool(current > sma_50)  if sma_50  is not None else None
            above_200_dma = bool(current > sma_200) if sma_200 is not None else None
            macd_line, macd_signal, macd_bullish = _compute_macd(close_list)
            consec_down = _count_consecutive_down(close_list)

            avg_vol_ratio: float | None = None
            if volume_raw is not None:
                vols = [_safe_float(v) for v in volume_raw.tolist()]
                vols = [v for v in vols if v is not None and v > 0]
                if len(vols) >= 20:
                    avg5  = sum(vols[-5:]) / 5
                    avg20 = sum(vols[-20:]) / 20
                    avg_vol_ratio = round(avg5 / avg20, 2) if avg20 > 0 else None

            metrics[sym] = {
                "symbol":               sym,
                "sector":               _NSE_SECTORS.get(sym, ""),
                "current_price":        round(current, 2),
                "52w_high":             round(high_52w, 2),
                "52w_low":              round(low_52w, 2),
                "pct_from_52w_high":    pct_from_high,
                "pct_from_52w_low":     pct_from_low,
                "ret_5d":               ret_5d,
                "ret_20d":              ret_20d,
                "ret_3m":               ret_3m,
                "rsi":                  rsi,
                "sma_50":               sma_50,
                "sma_200":              sma_200,
                "above_50_dma":         above_50_dma,
                "above_200_dma":        above_200_dma,
                "macd_line":            macd_line,
                "macd_signal":          macd_signal,
                "macd_bullish":         macd_bullish,
                "consecutive_down_days": consec_down,
                "avg_vol_ratio":        avg_vol_ratio,
            }
        except Exception:
            continue

    return metrics


def _get_metrics_cached() -> dict[str, dict]:
    """Return metrics for UNIVERSE, refreshing every 15 min. Shared by screener + AI picks."""
    global _metrics_cache
    now = time.time()
    if _metrics_cache.get("_ts") and (now - _metrics_cache["_ts"]) < _METRICS_TTL:
        return {k: v for k, v in _metrics_cache.items() if k != "_ts"}
    result = _get_metrics(UNIVERSE)
    _metrics_cache = {"_ts": now, **result}
    return result


# ── Chip-based screener ────────────────────────────────────────────────────────

CHIP_FILTERS: dict[str, Any] = {
    "RSI Oversold":     lambda m: (m.get("rsi") or 999) < 35,
    "RSI Overbought":   lambda m: (m.get("rsi") or 0) > 65,
    "Above 50 DMA":     lambda m: m.get("above_50_dma") is True,
    "Below 50 DMA":     lambda m: m.get("above_50_dma") is False,
    "Above 200 DMA":    lambda m: m.get("above_200_dma") is True,
    "Below 200 DMA":    lambda m: m.get("above_200_dma") is False,
    "Near 52W High":    lambda m: (m.get("pct_from_52w_high") or -999) > -5,
    "Near 52W Low":     lambda m: (m.get("pct_from_52w_low") or 999) < 10,
    "Big Dip >15%":     lambda m: (m.get("pct_from_52w_high") or 0) < -15,
    "Recent Rally >3%": lambda m: (m.get("ret_5d") or 0) > 3,
    "Recent Dip <-3%":  lambda m: (m.get("ret_5d") or 0) < -3,
    "2+ Down Days":     lambda m: m.get("consecutive_down_days", 0) >= 2,
    "MACD Bullish":     lambda m: m.get("macd_bullish") is True,
    "MACD Bearish":     lambda m: m.get("macd_bullish") is False,
    "Volume Surge":     lambda m: (m.get("avg_vol_ratio") or 0) > 1.5,
}


def screen_by_chips(chips: list[str]) -> dict:
    """Screen UNIVERSE stocks by named filter chips (AND logic). Results sorted by drawdown."""
    metrics = _get_metrics_cached()
    active = [c for c in chips if c in CHIP_FILTERS]
    if not active:
        results = sorted(metrics.values(), key=lambda x: x.get("pct_from_52w_high") or 0)
    else:
        results = [
            m for m in metrics.values()
            if all(CHIP_FILTERS[c](m) for c in active)
        ]
        results.sort(key=lambda x: x.get("pct_from_52w_high") or 0)
    return {
        "results": results,
        "total_screened": len(metrics),
        "matched": len(results),
        "filters_applied": active,
    }


def _screen_candidates(metrics: dict[str, dict]) -> list[dict]:
    """Filter to quality-dip candidates: fallen meaningfully but not destroyed."""
    candidates = []
    for sym, m in metrics.items():
        d = m.get("pct_from_52w_high")
        if d is None or d > -5:
            continue   # At or near all-time high — no dip
        if d < -65:
            continue   # Down >65% — potential fundamental collapse
        rsi = m.get("rsi")
        if rsi is not None and rsi > 68:
            continue   # Overbought despite being down — suspicious
        ret_20d = m.get("ret_20d")
        if ret_20d is not None and ret_20d > 8:
            continue   # Strong recent bounce already
        candidates.append(m)

    candidates.sort(key=lambda x: x["pct_from_52w_high"])
    return candidates[:30]


def _rule_based_picks(candidates: list[dict]) -> list[dict]:
    """Fallback when LLM is unavailable: score candidates by technicals and return top 10."""
    scored = []
    for c in candidates:
        score = 0
        rsi = c.get("rsi")
        draw = c.get("pct_from_52w_high", 0) or 0
        r5   = c.get("ret_5d", 0) or 0
        r20  = c.get("ret_20d", 0) or 0

        # Oversold RSI = strong bounce candidate
        if rsi is not None:
            if rsi < 30:   score += 35
            elif rsi < 40: score += 20
            elif rsi < 50: score += 10

        # Significant dip from 52w high (quality dip, not collapse)
        if -40 < draw <= -20: score += 25
        elif -20 < draw <= -10: score += 15
        elif -10 < draw <= -5:  score += 5

        # Recent dip = near-term bounce potential
        if r5 < -5:   score += 20
        elif r5 < -3: score += 12
        elif r5 < -1: score += 5

        # Medium-term weakness but not freefall
        if -15 < r20 <= -5: score += 10

        # MACD bullish = momentum turning
        if c.get("macd_bullish") is True: score += 10

        # Above 200 DMA = long-term uptrend intact
        if c.get("above_200_dma") is True: score += 8

        scored.append((score, c))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:10]

    result = []
    for score, c in top:
        rsi     = c.get("rsi")
        draw    = c.get("pct_from_52w_high", 0) or 0
        r5      = c.get("ret_5d")
        r20     = c.get("ret_20d")
        sector  = c.get("sector", "")
        above50 = c.get("above_50_dma")
        macd_b  = c.get("macd_bullish")

        # Build a concise justification from available metrics
        signals = []
        if rsi is not None and rsi < 40: signals.append(f"RSI {rsi:.0f} (oversold)")
        if draw < -15: signals.append(f"{abs(draw):.0f}% off 52W high")
        if r5 is not None and r5 < -2: signals.append(f"5d dip {r5:.1f}%")
        if above50 is True: signals.append("above 50 DMA")
        elif above50 is False: signals.append("below 50 DMA")
        if macd_b is True: signals.append("MACD bullish")
        if not signals: signals.append(f"{abs(draw):.0f}% off 52W high")

        conviction = "HIGH" if score >= 55 else "MEDIUM" if score >= 35 else "LOW"
        prob = min(80, max(35, 40 + score // 2))

        result.append({
            "symbol":           c["symbol"],
            "sector":           sector,
            "cap_type":         "",
            "conviction":       conviction,
            "current_price":    c["current_price"],
            "pct_from_52w_high": draw,
            "decline_reason":   "Rule-based screen (LLM unavailable)",
            "recovery_catalyst": "Technical mean reversion",
            "risks":            "Market-wide correction risk",
            "justification":    f"Technical dip pick: {', '.join(signals)}. "
                                f"{'Sector: ' + sector + '.' if sector else ''} "
                                f"Score {score}/100 from RSI, drawdown, and momentum signals.",
            "hold_horizon":     "1-2 weeks",
            "prob_2pct_1w":     prob,
            "prob_reasoning":   f"Score {score}/100 — {', '.join(signals[:2])}",
        })

    return result


def _ai_analyze(candidates: list[dict], market_context: str) -> list[dict]:
    """LLM call: assess each candidate, return 8–12 best picks with full justification."""
    if not candidates:
        return []

    # Cap at 15 to stay within token-per-minute limits for Qwen/reasoning models
    candidates = candidates[:15]

    cand_lines = "\n".join([
        f"- {c['symbol']}: ₹{c['current_price']} | "
        f"52w-high drawdown: {c['pct_from_52w_high']}% | "
        f"5d: {c.get('ret_5d','N/A')}% | 20d: {c.get('ret_20d','N/A')}% | "
        f"3m: {c.get('ret_3m','N/A')}% | RSI: {c.get('rsi','N/A')}"
        for c in candidates
    ])

    today = datetime.now().strftime("%d %b %Y")
    prompt = f"""Today is {today}. You are a SEBI-registered research analyst analyzing Indian equities for a quality-dip equity portfolio.

Market context:
{market_context}

Candidate stocks (fallen from 52w high, price data only — assess based on your knowledge):
{cand_lines}

For each stock evaluate:
1. Is the decline due to broad market conditions, sector rotation, or macro headwinds (buy opportunity)?
   Or due to company-specific fundamental deterioration, debt crisis, management fraud (avoid)?
2. Does the company have strong/stable fundamentals: consistent profit, low leverage, market leadership?
3. What is the near-term (3-6 month) recovery potential?
4. Any recent news, sector trends, or events that affect the thesis?

Return a JSON array of the TOP 8-12 best picks ONLY (exclude any with fundamental concerns):
[
  {{
    "symbol": "RELIANCE",
    "sector": "Energy & Retail",
    "cap_type": "Large Cap",
    "conviction": "HIGH",
    "current_price": 1245.0,
    "pct_from_52w_high": -18.5,
    "decline_reason": "Broad market correction + FII outflows — not company specific",
    "recovery_catalyst": "Jio ARPU growth, new energy ramp-up, retail expansion",
    "risks": "Crude price volatility, telecom competition intensifying",
    "justification": "Reliance remains India's most diversified conglomerate with three growth engines (O2C, Telecom, Retail) all improving margins. The current correction mirrors the broader market selloff with no change in fundamentals. Strong free cash flow generation and debt reduction trajectory intact. At 18% below 52w high, risk-reward is favorable for a 3-6 month hold.",
    "hold_horizon": "3-6 months",
    "prob_2pct_1w": 68,
    "prob_reasoning": "RSI at 42 approaching oversold, strong support at ₹1220 52w level, sector tailwind from crude stabilization"
  }}
]

For prob_2pct_1w: estimate the probability (integer 0–100) that this stock will move UP by 2% or more in the next 7 trading days.
Base this on: RSI level (lower → higher probability), distance from nearest support, recent momentum, sector trend, and market context.
Provide a 1-line prob_reasoning explaining the key factors.

Only include stocks where: decline is NOT fundamental, company fundamentals are solid, and recovery path is clear.
Sort by conviction DESC then by recovery potential. Respond with JSON array ONLY."""

    system = "You are a senior equity research analyst. Respond only with a valid JSON array."
    try:
        import json, re
        raw = call_llm(prompt, system=system, max_tokens=3500)
        if raw.startswith('[LLM'):
            return _rule_based_picks(candidates)
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            return _rule_based_picks(candidates)
        picks = json.loads(m.group())
        # Deduplicate by symbol (keep first), require current_price
        seen: set[str] = set()
        result = []
        for p in picks:
            if not isinstance(p, dict) or "symbol" not in p:
                continue
            sym = p["symbol"].upper()
            if sym in seen:
                continue
            if not p.get("current_price"):
                continue
            seen.add(sym)
            result.append(p)
        return result if result else _rule_based_picks(candidates)
    except Exception:
        return _rule_based_picks(candidates)


def get_ai_picks(force_refresh: bool = False) -> dict:
    """Main entry: screen + AI analyze. Cached 30 min."""
    global _picks_cache
    now = time.time()

    if (not force_refresh
            and _picks_cache.get("_ts")
            and now - _picks_cache["_ts"] < _PICKS_TTL):
        return {k: v for k, v in _picks_cache.items() if k != "_ts"}

    market_context = ""
    try:
        from ai.market_brain import gather_market_data, assess_market
        mdata = gather_market_data()
        asmt  = assess_market(mdata)
        market_context = (
            f"Nifty: {mdata.get('nifty_spot')} "
            f"(5d {mdata.get('nifty_5d_ret')}%, 20d {mdata.get('nifty_20d_ret')}%)\n"
            f"India VIX: {mdata.get('india_vix')} | "
            f"Trend: {asmt.get('trend')} | IV: {asmt.get('iv_regime')}\n"
            f"Assessment: {' '.join(asmt.get('reasoning', []))[:400]}"
        )
    except Exception:
        market_context = "Market context unavailable."

    metrics    = _get_metrics_cached()
    candidates = _screen_candidates(metrics)
    picks      = _ai_analyze(candidates, market_context)

    import json, math

    def _clean(obj):
        if isinstance(obj, dict):
            return {k: _clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean(v) for v in obj]
        if isinstance(obj, float) and math.isnan(obj):
            return None
        return obj

    result = {
        "_ts":                   now,
        "fetched_at":            datetime.now(timezone.utc).isoformat(),
        "market_context":        market_context,
        "picks":                 picks,
        "total_screened":        len(metrics),
        "candidates_shortlisted": len(candidates),
    }
    # Only write to cache if LLM returned picks — don't overwrite good cache with empty LLM failure
    if picks:
        _picks_cache = result
    elif not _picks_cache.get("_ts"):
        _picks_cache = result
    return _clean({k: v for k, v in _picks_cache.items() if k != "_ts"})
