"""AI-driven ETF screener — momentum ETFs and bounce candidates (2-3 consecutive down days)."""
from __future__ import annotations
import math
import time
from datetime import datetime, timezone
from typing import Any

from ai.llm_client import call_llm

# ── ETF Universe ───────────────────────────────────────────────────────────────

ETF_UNIVERSE = [
    # Broad market
    "NIFTYBEES", "JUNIORBEES", "SETFNIF50", "ICICINIFTY",
    # Sector
    "BANKBEES", "ITBEES", "PHARMABEES", "AUTOBEES", "INFRAIETF", "CPSEETF",
    # Commodity
    "GOLDBEES", "SILVERBEES",
    # International / Factor
    "MON100", "MOM100", "ALPHA", "MIDSMALL",
    # Mid/Small
    "MAFANG", "NIFTYMID150", "SMALLCAP",
    # PSU / Infra
    "PSUBNKBEES", "KONSTETF",
]
# Deduplicate
ETF_UNIVERSE = list(dict.fromkeys(ETF_UNIVERSE))

_picks_cache: dict = {}
_PICKS_TTL = 1800  # 30 min


def _safe_float(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except Exception:
        return None


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


def _count_consecutive_down(closes: list[float]) -> int:
    """Count how many of the most recent daily returns were negative (consecutive from today back)."""
    count = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] < closes[i - 1]:
            count += 1
        else:
            break
    return count


def _get_etf_metrics(symbols: list[str]) -> dict[str, dict]:
    """Download 60-day price data for ETFs and compute screening metrics."""
    import yfinance as yf

    ns_symbols = [s + ".NS" for s in symbols]
    try:
        data = yf.download(
            ns_symbols, period="3mo", auto_adjust=True,
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
            if len(close_list) < 15:
                continue

            current  = close_list[-1]
            ret_1d   = round((close_list[-1] - close_list[-2]) / close_list[-2] * 100, 2) if len(close_list) >= 2 else None
            ret_5d   = round((close_list[-1] - close_list[-6]) / close_list[-6] * 100, 2) if len(close_list) >= 6 else None
            ret_10d  = round((close_list[-1] - close_list[-11]) / close_list[-11] * 100, 2) if len(close_list) >= 11 else None
            ret_1m   = round((close_list[-1] - close_list[-22]) / close_list[-22] * 100, 2) if len(close_list) >= 22 else None
            rsi      = _compute_rsi(close_list)
            consec_down = _count_consecutive_down(close_list)

            # Total drop over the consecutive down period
            if consec_down > 0 and len(close_list) > consec_down:
                drop_pct = round((close_list[-1] - close_list[-(consec_down + 1)]) / close_list[-(consec_down + 1)] * 100, 2)
            else:
                drop_pct = 0.0

            metrics[sym] = {
                "symbol":               sym,
                "current_price":        round(current, 2),
                "ret_1d":               ret_1d,
                "ret_5d":               ret_5d,
                "ret_10d":              ret_10d,
                "ret_1m":               ret_1m,
                "rsi":                  rsi,
                "consecutive_down_days": consec_down,
                "drop_pct_streak":      drop_pct,
            }
        except Exception:
            continue

    return metrics


def _screen_etf_candidates(metrics: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """
    Returns (bounce_candidates, momentum_candidates).
    Bounce: 2+ consecutive down days, total drop <= 8%, RSI < 60 (not overbought).
    Momentum: positive 5d AND 10d, RSI between 40-70.
    """
    bounce, momentum = [], []
    for sym, m in metrics.items():
        consec = m.get("consecutive_down_days", 0)
        drop   = m.get("drop_pct_streak", 0.0)
        ret5   = m.get("ret_5d")
        ret10  = m.get("ret_10d")
        rsi    = m.get("rsi")

        # Bounce: 2-3 consecutive down days, not too deep a drop
        if consec >= 2 and drop >= -8.0 and (rsi is None or rsi < 60):
            bounce.append(m)

        # Momentum: both 5d and 10d positive, RSI not overbought
        elif ret5 is not None and ret10 is not None and ret5 > 0 and ret10 > 0:
            if rsi is None or (40 <= rsi <= 72):
                momentum.append(m)

    bounce.sort(key=lambda x: x.get("consecutive_down_days", 0), reverse=True)
    momentum.sort(key=lambda x: x.get("ret_5d", 0), reverse=True)
    return bounce[:10], momentum[:10]


def _ai_analyze_etfs(bounce: list[dict], momentum: list[dict], market_context: str) -> list[dict]:
    """LLM call to evaluate bounce + momentum candidates and return 5-8 picks."""
    if not bounce and not momentum:
        return []

    # Cap to stay within token-per-minute limits for reasoning models
    bounce   = bounce[:8]
    momentum = momentum[:8]

    def fmt(lst: list[dict]) -> str:
        return "\n".join([
            f"- {m['symbol']}: ₹{m['current_price']} | "
            f"ConsecDown: {m.get('consecutive_down_days', 0)}d "
            f"({m.get('drop_pct_streak', 0):.1f}%) | "
            f"5d: {m.get('ret_5d', 'N/A')}% | 10d: {m.get('ret_10d', 'N/A')}% | "
            f"1m: {m.get('ret_1m', 'N/A')}% | RSI: {m.get('rsi', 'N/A')}"
            for m in lst
        ]) or "None"

    today = datetime.now().strftime("%d %b %Y")
    prompt = f"""Today is {today}. You are an Indian ETF analyst.

Market context:
{market_context}

BOUNCE CANDIDATES (fallen 2+ consecutive days — potential mean-reversion):
{fmt(bounce)}

MOMENTUM ETFs (positive 5d + 10d return):
{fmt(momentum)}

For bounce candidates: Is this a temporary dip in a healthy underlying index, or a genuine breakdown?
For momentum ETFs: Is this trend continuation likely, or is it overbought/due for pullback?

Return a JSON array of the TOP 5-8 picks:
[
  {{
    "symbol": "NIFTYBEES",
    "screen_type": "bounce",
    "etf_type": "Broad Market",
    "theme": "Nifty 50 index",
    "conviction": "HIGH",
    "current_price": 245.0,
    "consecutive_down_days": 2,
    "ret_5d": -1.2,
    "ret_10d": 0.8,
    "rsi": 48,
    "reason": "2-day dip aligns with FII selling; Nifty 50 fundamentals intact",
    "justification": "NiftyBees tracks Nifty 50 which has held key 24,000 support. The 2-day decline follows broad FII selling not any index-specific event. Historical mean reversion on these dips is strong.",
    "hold_horizon": "3-5 trading days"
  }}
]

Include picks from both bounce and momentum categories if available.
screen_type: "bounce" for bounce candidates, "momentum" for momentum picks.
Only include ETFs where the thesis is clear and current_price is valid.
Respond with JSON array ONLY."""

    system = "You are an Indian ETF analyst. Respond only with a valid JSON array."
    try:
        import json, re
        raw = call_llm(prompt, system=system, max_tokens=2500)
        if raw.startswith('[LLM'):
            return _rule_based_etf_picks(bounce, momentum)
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            return _rule_based_etf_picks(bounce, momentum)
        picks = json.loads(m.group())
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
        return result if result else _rule_based_etf_picks(bounce, momentum)
    except Exception:
        return _rule_based_etf_picks(bounce, momentum)


def _rule_based_etf_picks(bounce: list[dict], momentum: list[dict]) -> list[dict]:
    """Fallback when LLM is unavailable: return scored bounce + momentum ETF picks."""
    result = []

    # Bounce picks — sorted by consecutive_down_days desc, RSI asc
    for m in sorted(bounce, key=lambda x: (-(x.get("consecutive_down_days") or 0), x.get("rsi") or 99)):
        cd   = m.get("consecutive_down_days", 0)
        drop = m.get("drop_pct_streak", 0) or 0
        rsi  = m.get("rsi")
        r5   = m.get("ret_5d")
        r10  = m.get("ret_10d")
        signals = [f"{cd}d consecutive dip ({drop:.1f}%)"]
        if rsi is not None and rsi < 45: signals.append(f"RSI {rsi:.0f}")
        conviction = "HIGH" if cd >= 3 and (rsi or 99) < 45 else "MEDIUM"
        result.append({
            "symbol":               m["symbol"],
            "etf_type":             "ETF",
            "theme":                m["symbol"],
            "screen_type":          "bounce",
            "conviction":           conviction,
            "current_price":        m["current_price"],
            "consecutive_down_days": cd,
            "ret_5d":               r5,
            "ret_10d":              r10,
            "rsi":                  rsi,
            "reason":               f"{cd}-day dip, potential mean reversion",
            "justification":        f"Rule-based bounce pick: {', '.join(signals)}. Short-term mean reversion candidate.",
            "hold_horizon":         "3-5 trading days",
        })
        if len(result) >= 4:
            break

    # Momentum picks
    for m in sorted(momentum, key=lambda x: -(x.get("ret_5d") or 0)):
        r5  = m.get("ret_5d")
        r10 = m.get("ret_10d")
        rsi = m.get("rsi")
        result.append({
            "symbol":               m["symbol"],
            "etf_type":             "ETF",
            "theme":                m["symbol"],
            "screen_type":          "momentum",
            "conviction":           "MEDIUM",
            "current_price":        m["current_price"],
            "consecutive_down_days": 0,
            "ret_5d":               r5,
            "ret_10d":              r10,
            "rsi":                  rsi,
            "reason":               f"Positive 5d ({r5}%) and 10d ({r10}%) momentum",
            "justification":        f"Rule-based momentum pick: 5d {r5}%, 10d {r10}%, RSI {rsi}. Trend continuation candidate.",
            "hold_horizon":         "1-2 weeks",
        })
        if len(result) >= 8:
            break

    return result


def get_etf_picks(force_refresh: bool = False) -> dict:
    """Main entry: screen + AI analyze ETFs. Cached 30 min."""
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
            f"Assessment: {' '.join(asmt.get('reasoning', []))[:300]}"
        )
    except Exception:
        market_context = "Market context unavailable."

    metrics   = _get_etf_metrics(ETF_UNIVERSE)
    bounce, momentum = _screen_etf_candidates(metrics)
    picks     = _ai_analyze_etfs(bounce, momentum, market_context)

    import math as _math

    def _clean(obj):
        if isinstance(obj, dict):
            return {k: _clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean(v) for v in obj]
        if isinstance(obj, float) and _math.isnan(obj):
            return None
        return obj

    result = {
        "_ts":                    now,
        "fetched_at":             datetime.now(timezone.utc).isoformat(),
        "market_context":         market_context,
        "picks":                  picks,
        "total_screened":         len(metrics),
        "bounce_candidates_count": len(bounce),
        "momentum_etfs_count":    len(momentum),
    }
    # Only write to cache if LLM returned picks — don't overwrite good cache with empty LLM failure
    if picks:
        _picks_cache = result
    elif not _picks_cache.get("_ts"):
        _picks_cache = result
    return _clean({k: v for k, v in _picks_cache.items() if k != "_ts"})
