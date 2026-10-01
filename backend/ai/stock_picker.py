"""AI-driven quality stock picker — screens Nifty 100/midcap for fallen large/mid-caps."""
from __future__ import annotations
import math
import time
from datetime import datetime, timezone
from typing import Any

from ai.llm_client import call_llm

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
            elif "Close" in data.columns:
                closes_raw = data["Close"].dropna()
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

            metrics[sym] = {
                "symbol":            sym,
                "current_price":     round(current, 2),
                "52w_high":          round(high_52w, 2),
                "52w_low":           round(low_52w, 2),
                "pct_from_52w_high": pct_from_high,
                "pct_from_52w_low":  pct_from_low,
                "ret_5d":            ret_5d,
                "ret_20d":           ret_20d,
                "ret_3m":            ret_3m,
                "rsi":               rsi,
            }
        except Exception:
            continue

    return metrics


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
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            return []
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
        return result
    except Exception:
        return []


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

    metrics    = _get_metrics(UNIVERSE)
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

    _picks_cache = {
        "_ts":                   now,
        "fetched_at":            datetime.now(timezone.utc).isoformat(),
        "market_context":        market_context,
        "picks":                 picks,
        "total_screened":        len(metrics),
        "candidates_shortlisted": len(candidates),
    }
    return _clean({k: v for k, v in _picks_cache.items() if k != "_ts"})
