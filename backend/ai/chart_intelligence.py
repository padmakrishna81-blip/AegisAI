"""
Technical Chart Intelligence Engine.

Deterministic (no LLM) pattern detection on OHLCV data:
  - Swing highs/lows via rolling window pivot detection
  - Trendline fitting from pivot pairs (scored by touches + time span + recency)
  - Channel detection (parallel trendline pairs with ≥60% containment)
  - Support/resistance zone clustering
  - RSI / MACD / EMA / ATR indicators (pure pandas)
  - Trend classification (EMA alignment + swing structure)
  - Rule engine R01–R15
"""

from __future__ import annotations

import math
import time
import threading
from datetime import datetime, timezone
from typing import Any

import pandas as pd
import numpy as np
import yfinance as yf

_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 900  # 15 minutes


# ── Cache helpers ─────────────────────────────────────────────────────────────

def _get_cached(key: str) -> Any:
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (time.time() - entry["ts"]) < _CACHE_TTL:
            return entry["data"]
    return None


def _set_cached(key: str, data: Any) -> None:
    with _cache_lock:
        _cache[key] = {"data": data, "ts": time.time()}


# ── Symbol normalisation ──────────────────────────────────────────────────────

def _resolve_symbol(symbol: str, market: str) -> str:
    """Return yfinance-ready symbol."""
    s = symbol.strip().upper()
    if market == "US":
        return s          # NVDA, AAPL, SPY, QQQ — no suffix
    # NSE / Indian: indices keep ^, ETFs and stocks get .NS if no . present
    if s.startswith("^") or "." in s:
        return s
    return s + ".NS"


# ── OHLCV fetch ───────────────────────────────────────────────────────────────

_TF_INTERVAL: dict[str, str] = {
    "15m":     "15m",
    "1h":      "1h",
    "4h":      "1h",   # resample from 1h
    "daily":   "1d",
    "weekly":  "1wk",
    "monthly": "1mo",
}

_TF_MAX_LOOKBACK: dict[str, list[str]] = {
    "15m":  ["3mo", "6mo", "1y", "3y", "5y"],  # hard-capped to 60d
    "1h":   ["3mo", "6mo", "1y", "3y", "5y"],  # capped to 730d
    "4h":   ["3mo", "6mo", "1y", "3y", "5y"],
}


def fetch_ohlcv(
    symbol: str,
    market: str,
    timeframe: str,
    lookback: str,
) -> dict:
    """
    Return dict with keys:
      candles     — list of {time, open, high, low, close, volume}
      symbol      — resolved yfinance symbol
      interval    — actual yfinance interval used
      lookback    — as requested
      timeframe   — as requested
      warning     — optional string (e.g. lookback capped for 15m)
      bars        — number of bars returned
    """
    yfm_sym = _resolve_symbol(symbol, market)
    interval = _TF_INTERVAL.get(timeframe, "1d")

    # Enforce yfinance intraday limits
    warning = None
    period = lookback
    if timeframe == "15m" and lookback not in ("3mo",):
        period = "60d"
        warning = f"15m timeframe limited to 60 days by yfinance. Showing last 60 days instead of {lookback}."
    elif timeframe in ("1h", "4h") and lookback in ("3y", "5y"):
        period = "730d"
        warning = f"{timeframe} timeframe limited to 2 years by yfinance. Showing last 2 years instead of {lookback}."

    cache_key = f"ohlcv:{yfm_sym}:{interval}:{period}"
    cached = _get_cached(cache_key)
    if cached is not None:
        df = cached
    else:
        try:
            df = yf.Ticker(yfm_sym).history(period=period, interval=interval)
        except Exception as e:
            return {"error": f"Failed to fetch data for {symbol}: {e}"}
        if df is None or df.empty:
            return {"error": f"No data returned for {symbol}. Check the symbol and try again."}
        _set_cached(cache_key, df)

    # Resample 1h → 4h
    if timeframe == "4h":
        df = _resample_4h(df)

    if df.empty or len(df) < 10:
        return {"error": f"Insufficient data for {symbol} ({len(df)} bars)."}

    candles = _df_to_candles(df)
    return {
        "candles":   candles,
        "symbol":    yfm_sym,
        "interval":  interval,
        "lookback":  lookback,
        "timeframe": timeframe,
        "bars":      len(candles),
        "warning":   warning,
    }


def _resample_4h(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 1h OHLCV DataFrame into 4h bars."""
    df = df.copy()
    df.index = pd.to_datetime(df.index)
    rule = "4h"
    resampled = df.resample(rule).agg({
        "Open":   "first",
        "High":   "max",
        "Low":    "min",
        "Close":  "last",
        "Volume": "sum",
    }).dropna()
    return resampled


def _df_to_candles(df: pd.DataFrame) -> list[dict]:
    candles = []
    for ts, row in df.iterrows():
        try:
            o, h, l, c = float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"])
            if any(math.isnan(v) for v in (o, h, l, c)):
                continue  # skip incomplete bars (e.g. today's partial session)
            t = int(pd.Timestamp(ts).timestamp())
            candles.append({
                "time":   t,
                "open":   o,
                "high":   h,
                "low":    l,
                "close":  c,
                "volume": float(row.get("Volume", 0) or 0),
            })
        except Exception:
            continue
    return candles


# ── Swing detection ───────────────────────────────────────────────────────────

def detect_swings(df: pd.DataFrame, window: int = 5) -> dict:
    """
    Returns {'highs': [...], 'lows': [...]}
    Each entry: {idx, price, time_unix, bar_index}
    Only confirmed pivots (require window bars after).
    """
    highs = df["High"].values
    lows  = df["Low"].values
    times = [int(pd.Timestamp(t).timestamp()) for t in df.index]
    n = len(highs)

    pivot_highs = []
    pivot_lows  = []

    for i in range(window, n - window):
        # Pivot high: high[i] is max of surrounding window
        if highs[i] == max(highs[i - window: i + window + 1]):
            pivot_highs.append({
                "bar_index": i,
                "price":     float(highs[i]),
                "time":      times[i],
            })
        # Pivot low: low[i] is min of surrounding window
        if lows[i] == min(lows[i - window: i + window + 1]):
            pivot_lows.append({
                "bar_index": i,
                "price":     float(lows[i]),
                "time":      times[i],
            })

    return {"highs": pivot_highs, "lows": pivot_lows}


# ── Trendline detection ───────────────────────────────────────────────────────

def _atr_of_df(df: pd.DataFrame) -> float:
    """14-period ATR of the DataFrame."""
    hi = df["High"]
    lo = df["Low"]
    cl = df["Close"]
    tr = pd.concat([hi - lo, (hi - cl.shift()).abs(), (lo - cl.shift()).abs()], axis=1).max(axis=1)
    return float(tr.rolling(14).mean().dropna().iloc[-1]) if len(tr) >= 14 else float(tr.mean())


def _score_trendline(pivots: list[dict], slope: float, intercept: float,
                     df: pd.DataFrame, atr: float, n: int,
                     all_same_type_pivots: list[dict] | None = None) -> dict:
    """
    Score a trendline defined by slope/intercept over bar indices.
    Returns {touches, score, start, end} or None if < 2 independent touches.

    Touches are counted from pivot points only (independent price reactions),
    not from every bar near the line. Consecutive pivots must be separated
    by at least MIN_TOUCH_GAP bars to count as distinct reactions.
    """
    if atr <= 0:
        return None
    tolerance = atr * 0.4
    MIN_TOUCH_GAP = 5  # bars between independent reactions

    # Use all same-type pivots for counting; fall back to anchor pair
    check_pivots = sorted(all_same_type_pivots or pivots, key=lambda x: x["bar_index"])

    touch_bars: list[int] = []
    for p in check_pivots:
        proj = slope * p["bar_index"] + intercept
        if abs(p["price"] - proj) <= tolerance:
            if not touch_bars or p["bar_index"] - touch_bars[-1] >= MIN_TOUCH_GAP:
                touch_bars.append(p["bar_index"])

    touches = len(touch_bars)
    if touches < 2:
        return None

    # Score: touches × recency weight × time span
    p0, p1 = pivots[0], pivots[1]
    span = p1["bar_index"] - p0["bar_index"]
    recency = 1.0 + (p1["bar_index"] / n)  # lines ending later score higher
    score = touches * recency * math.log1p(span)

    return {
        "touches":   touches,
        "score":     round(score, 2),
        "start":     {"bar_index": p0["bar_index"], "price": round(slope * p0["bar_index"] + intercept, 2), "time": p0["time"]},
        "end":       {"bar_index": p1["bar_index"], "price": round(slope * p1["bar_index"] + intercept, 2), "time": p1["time"]},
        "slope":     slope,
        "intercept": intercept,
    }


def detect_trendlines(df: pd.DataFrame, swings: dict) -> dict:
    """
    Enumerate pivot pairs → fit lines → score → return top 2 support + top 2 resistance.
    Touches are counted from all pivots of the same type (independent reactions only).
    """
    n   = len(df)
    atr = _atr_of_df(df)

    def _best_lines(pivots: list[dict], top_n: int = 2) -> list[dict]:
        candidates = []
        for i in range(len(pivots)):
            for j in range(i + 1, len(pivots)):
                p0, p1 = pivots[i], pivots[j]
                dx = p1["bar_index"] - p0["bar_index"]
                if dx < 5:
                    continue
                slope     = (p1["price"] - p0["price"]) / dx
                intercept = p0["price"] - slope * p0["bar_index"]
                # Pass full pivot list so all independent reactions are counted
                scored = _score_trendline(
                    [p0, p1], slope, intercept, df, atr, n,
                    all_same_type_pivots=pivots,
                )
                if scored:
                    scored["type"] = "support" if pivots is swings["lows"] else "resistance"
                    candidates.append(scored)

        candidates.sort(key=lambda x: -x["score"])
        # De-duplicate: skip lines with slope similar to an already-chosen one
        chosen = []
        for c in candidates:
            if len(chosen) >= top_n:
                break
            duplicate = any(
                abs(c["slope"] - ch["slope"]) < atr * 0.001
                for ch in chosen
            )
            if not duplicate:
                chosen.append(c)
        return chosen

    support_lines    = _best_lines(swings["lows"],  top_n=2)
    resistance_lines = _best_lines(swings["highs"], top_n=2)

    return {"support": support_lines, "resistance": resistance_lines}


# ── Channel detection ─────────────────────────────────────────────────────────

def _channel_line_pts(
    slope: float, intercept: float, s_bar: int, e_bar: int,
    times: list[int], n: int, steps: int = 8,
) -> list[dict]:
    """Evenly-spaced {time, price} points along one channel boundary."""
    pts: list[dict] = []
    for step in range(steps + 1):
        bar = s_bar + round((e_bar - s_bar) * step / steps)
        bar = max(0, min(n - 1, bar))
        pts.append({"time": times[bar], "price": round(slope * bar + intercept, 2)})
    return pts


def _eval_channel(
    slope: float, ic_sup: float, ic_res: float,
    s_bar: int, e_bar: int, n: int,
    times: list[int], atr: float,
    highs_arr: np.ndarray, lows_arr: np.ndarray, closes: np.ndarray,
    pivot_highs: list[dict], pivot_lows: list[dict],
) -> dict | None:
    """
    Score a candidate structural parallel channel defined by:
      - One slope shared by both boundaries
      - Lower boundary intercept ic_sup (through pivot lows)
      - Upper boundary intercept ic_res (through pivot highs)

    Returns None if the channel fails minimum quality thresholds.
    Returns a complete channel dict with diagnostics otherwise.
    """
    span = e_bar - s_bar
    if span < 20:
        return None

    touch_tol = atr * 0.4  # ATR-adjusted touch tolerance

    # Count independent pivot touches on each boundary
    sup_touch_bars = [
        p["bar_index"] for p in pivot_lows
        if s_bar <= p["bar_index"] <= e_bar
        and abs(p["price"] - (slope * p["bar_index"] + ic_sup)) <= touch_tol
    ]
    res_touch_bars = [
        p["bar_index"] for p in pivot_highs
        if s_bar <= p["bar_index"] <= e_bar
        and abs(p["price"] - (slope * p["bar_index"] + ic_res)) <= touch_tol
    ]
    sup_touches = len(sup_touch_bars)
    res_touches = len(res_touch_bars)

    # Require at least 1 independent touch on each boundary
    if sup_touches < 1 or res_touches < 1:
        return None

    # Containment and violation analysis
    contained        = 0
    body_violations  = 0
    wick_overshoots  = 0

    for i in range(s_bar, e_bar + 1):
        sup_proj = slope * i + ic_sup
        res_proj = slope * i + ic_res
        lo, hi, cl = lows_arr[i], highs_arr[i], closes[i]

        if (sup_proj - atr * 0.15) <= lo and hi <= (res_proj + atr * 0.15):
            contained += 1

        # Body violation: close outside the structural band
        if cl < sup_proj - atr * 0.1:
            body_violations += 1
        elif cl > res_proj + atr * 0.1:
            body_violations += 1

        # Wick overshoot: wick more than 0.5 ATR outside (meaningful breach)
        if hi > res_proj + atr * 0.5:
            wick_overshoots += 1
        if lo < sup_proj - atr * 0.5:
            wick_overshoots += 1

    containment = contained / span
    if containment < 0.40:
        return None

    # Quality score: reward touches + containment + span; penalise violations
    quality = (
        (sup_touches + res_touches) * containment * math.log1p(span)
    ) / (1.0 + body_violations * 0.4 + wick_overshoots * 0.15)

    # ATR-normalised mean fitting error across all touching pivots
    touch_errors: list[float] = []
    for bar in sup_touch_bars:
        p = next((p for p in pivot_lows  if p["bar_index"] == bar), None)
        if p:
            touch_errors.append(abs(p["price"] - (slope * bar + ic_sup)) / atr)
    for bar in res_touch_bars:
        p = next((p for p in pivot_highs if p["bar_index"] == bar), None)
        if p:
            touch_errors.append(abs(p["price"] - (slope * bar + ic_res)) / atr)
    avg_error_atr = float(np.mean(touch_errors)) if touch_errors else 0.0

    # Direction
    avg_close = float(np.mean(closes[s_bar:e_bar + 1])) or 1.0
    per_bar   = slope / avg_close
    if per_bar > 0.0003:
        ch_type = "ascending"
    elif per_bar < -0.0003:
        ch_type = "descending"
    else:
        ch_type = "horizontal"

    # Representative anchor pivots for diagnostics
    sup_anchor = next((p for p in pivot_lows  if p["bar_index"] == sup_touch_bars[0]),  None) if sup_touch_bars else None
    res_anchor = next((p for p in pivot_highs if p["bar_index"] == res_touch_bars[0]), None) if res_touch_bars else None

    # Validation tier:
    #   validated   — 2+ independent touches on each boundary AND quality ≥ 2.0
    #   provisional — 1+ touch on each boundary (minimum passed), weaker evidence
    #   unconfirmed — passed minimum thresholds but quality below meaningful level
    if sup_touches >= 2 and res_touches >= 2 and quality >= 2.0:
        validation_status = "validated"
    elif sup_touches >= 1 and res_touches >= 1 and quality >= 0.8:
        validation_status = "provisional"
    else:
        validation_status = "unconfirmed"

    return {
        "type":              ch_type,
        "containment":       round(containment * 100, 1),
        "validation_status": validation_status,
        "is_structural":     True,
        "support_line": {
            "points":    _channel_line_pts(slope, ic_sup, s_bar, e_bar, times, n),
            "start":     {"time": times[s_bar], "price": round(slope * s_bar + ic_sup, 2)},
            "end":       {"time": times[e_bar], "price": round(slope * e_bar + ic_sup, 2)},
            "slope":     slope,
            "intercept": ic_sup,
        },
        "resistance_line": {
            "points":    _channel_line_pts(slope, ic_res, s_bar, e_bar, times, n),
            "start":     {"time": times[s_bar], "price": round(slope * s_bar + ic_res, 2)},
            "end":       {"time": times[e_bar], "price": round(slope * e_bar + ic_res, 2)},
            "slope":     slope,
            "intercept": ic_res,
        },
        "channel_width": round(abs(ic_res - ic_sup), 2),
        "diagnostics": {
            "slope":           round(slope, 6),
            "sup_touches":     sup_touches,
            "res_touches":     res_touches,
            "body_violations": body_violations,
            "wick_overshoots": wick_overshoots,
            "containment_pct": round(containment * 100, 1),
            "quality_score":   round(quality, 3),
            "avg_error_atr":   round(avg_error_atr, 3),
            "span_bars":       span,
            "start_time":      times[s_bar],
            "end_time":        times[e_bar],
            "sup_anchor_price": round(sup_anchor["price"], 2) if sup_anchor else None,
            "sup_anchor_time":  sup_anchor["time"] if sup_anchor else None,
            "res_anchor_price": round(res_anchor["price"], 2) if res_anchor else None,
            "res_anchor_time":  res_anchor["time"] if res_anchor else None,
        },
    }


def detect_structural_channels(
    trendlines: dict, swings: dict, df: pd.DataFrame,
) -> list[dict]:
    """
    Structural parallel channel detection.

    For each support trendline (slope anchored through pivot lows):
      - Projects a parallel resistance through the most prominent pivot high in that range.
    For each resistance trendline (slope anchored through pivot highs):
      - Projects a parallel support through the lowest pivot low in that range.

    Evaluates every candidate on touches, containment, violations, and span.
    Returns up to 2 highest-quality channels with meaningfully different slopes.
    """
    n      = len(df)
    atr    = _atr_of_df(df)
    highs  = df["High"].values
    lows   = df["Low"].values
    closes = df["Close"].values
    times  = [int(pd.Timestamp(t).timestamp()) for t in df.index]

    pivot_highs = swings["highs"]
    pivot_lows  = swings["lows"]

    candidates: list[dict] = []

    # Method A: support trendline → parallel resistance through highest pivot high
    for tl in trendlines.get("support", []):
        sl     = tl["slope"]
        ic_sup = tl["intercept"]
        s_bar  = tl["start"]["bar_index"]
        e_bar  = n - 1

        rel_highs = [p for p in pivot_highs if s_bar <= p["bar_index"] <= e_bar]
        if not rel_highs:
            continue
        # ic_res: parallel line y = sl*x + ic_res that passes through the highest pivot high
        ic_res = max(p["price"] - sl * p["bar_index"] for p in rel_highs)

        # Resistance must be above support through the span
        mid_bar = (s_bar + e_bar) // 2
        if (sl * mid_bar + ic_res) <= (sl * mid_bar + ic_sup):
            continue

        ch = _eval_channel(sl, ic_sup, ic_res, s_bar, e_bar, n, times, atr,
                           highs, lows, closes, pivot_highs, pivot_lows)
        if ch:
            candidates.append(ch)

    # Method B: resistance trendline → parallel support through lowest pivot low
    for tl in trendlines.get("resistance", []):
        sl     = tl["slope"]
        ic_res = tl["intercept"]
        s_bar  = tl["start"]["bar_index"]
        e_bar  = n - 1

        rel_lows = [p for p in pivot_lows if s_bar <= p["bar_index"] <= e_bar]
        if not rel_lows:
            continue
        ic_sup = min(p["price"] - sl * p["bar_index"] for p in rel_lows)

        mid_bar = (s_bar + e_bar) // 2
        if (sl * mid_bar + ic_res) <= (sl * mid_bar + ic_sup):
            continue

        ch = _eval_channel(sl, ic_sup, ic_res, s_bar, e_bar, n, times, atr,
                           highs, lows, closes, pivot_highs, pivot_lows)
        if ch:
            candidates.append(ch)

    # Sort by quality score, de-duplicate by slope proximity
    candidates.sort(key=lambda x: -x["diagnostics"]["quality_score"])
    chosen: list[dict] = []
    for c in candidates:
        sl_c = c["support_line"]["slope"]
        if not any(abs(sl_c - ch["support_line"]["slope"]) < atr * 0.0005 for ch in chosen):
            chosen.append(c)
        if len(chosen) >= 2:
            break
    return chosen


def regression_channel(df: pd.DataFrame, k: float = 1.5) -> dict:
    """
    Linear regression channel: close-price regression ± k standard deviations.
    Used as fallback when structural detection finds no valid channel.
    """
    n = len(df)
    x = np.arange(n, dtype=float)
    y = df["Close"].values.astype(float)

    slope, intercept = np.polyfit(x, y, 1)
    residuals = y - (slope * x + intercept)
    std       = float(np.std(residuals))
    upper_off = k * std
    lower_off = -k * std

    times = [int(pd.Timestamp(t).timestamp()) for t in df.index]

    def _pts(offset: float) -> list[dict]:
        out = []
        for step in range(11):
            bar = round((n - 1) * step / 10)
            out.append({"time": times[bar], "price": round(slope * bar + intercept + offset, 2)})
        return out

    per_bar = slope / float(df["Close"].mean()) if df["Close"].mean() else 0
    ch_type = "ascending" if per_bar > 0.0003 else "descending" if per_bar < -0.0003 else "horizontal"

    return {
        "type":        ch_type,
        "containment": 95.0,
        "is_regression": True,
        "support_line": {
            "points": _pts(lower_off),
            "start": {"time": times[0],      "price": round(intercept + lower_off, 2)},
            "end":   {"time": times[n - 1],  "price": round(slope * (n - 1) + intercept + lower_off, 2)},
            "slope": slope, "intercept": intercept + lower_off,
        },
        "resistance_line": {
            "points": _pts(upper_off),
            "start": {"time": times[0],      "price": round(intercept + upper_off, 2)},
            "end":   {"time": times[n - 1],  "price": round(slope * (n - 1) + intercept + upper_off, 2)},
            "slope": slope, "intercept": intercept + upper_off,
        },
        "channel_width": round(2 * k * std, 2),
        "diagnostics": {
            "slope": round(slope, 6), "sup_touches": 0, "res_touches": 0,
            "body_violations": 0, "wick_overshoots": 0,
            "containment_pct": 95.0, "quality_score": 0.0, "avg_error_atr": 0.0,
            "span_bars": n, "start_time": times[0], "end_time": times[-1],
            "sup_anchor_price": None, "sup_anchor_time": None,
            "res_anchor_price": None, "res_anchor_time": None,
        },
    }


def _channel_status(ch: dict, df: pd.DataFrame, atr: float) -> str:
    """
    Classify channel as active / broken_downward / broken_upward / provisional.

    Criteria:
      broken_downward: current close < support_now - 0.5*ATR
                       OR 2 consecutive recent closes below support
      broken_upward:   current close > resistance_now + 0.5*ATR
                       OR 2 consecutive recent closes above resistance
      provisional:     channel passes minimum thresholds but validation_status
                       is "provisional" or "unconfirmed" — not yet confirmed active
    """
    n = len(df)
    closes = df["Close"].values
    last_bar = n - 1
    current_price = float(closes[-1])

    sup_slope = ch["support_line"]["slope"]
    sup_int   = ch["support_line"]["intercept"]
    res_slope = ch["resistance_line"]["slope"]
    res_int   = ch["resistance_line"]["intercept"]

    support_now = sup_slope * last_bar + sup_int
    resist_now  = res_slope * last_bar + res_int

    # Criterion 1: current close significantly outside
    if current_price < support_now - atr * 0.5:
        return "broken_downward"
    if current_price > resist_now + atr * 0.5:
        return "broken_upward"

    # Criterion 2: 2 consecutive closes outside (last 2 bars)
    if n >= 2:
        below = sum(
            1 for i in range(n - 2, n)
            if closes[i] < (sup_slope * i + sup_int)
        )
        above = sum(
            1 for i in range(n - 2, n)
            if closes[i] > (res_slope * i + res_int)
        )
        if below >= 2:
            return "broken_downward"
        if above >= 2:
            return "broken_upward"

    # Provisional channels retain their validation status as the status label
    vs = ch.get("validation_status", "validated")
    if vs in ("provisional", "unconfirmed"):
        return "provisional"

    return "active"


def detect_convergences(
    trendlines: dict,
    channels: list[dict],
    sr: dict,
    df: pd.DataFrame,
) -> list[dict]:
    """
    Find intersections between trendlines, channel boundaries, and SR horizontal levels.
    Returns up to 5 convergence points (historical or projected future).
    """
    n = len(df)
    if n < 20:
        return []

    atr = _atr_of_df(df)
    times = [int(pd.Timestamp(t).timestamp()) for t in df.index]
    time_per_bar = (times[-1] - times[0]) / max(n - 1, 1)
    current_price = float(df["Close"].iloc[-1])
    price_range = float(df["High"].max() - df["Low"].min())

    # Build unified line list
    all_lines: list[dict] = []
    for i, tl in enumerate(trendlines.get("support", [])):
        all_lines.append({"slope": tl["slope"], "intercept": tl["intercept"],
                          "label": f"Support TL {i+1}", "id": f"tl_support_{i}"})
    for i, tl in enumerate(trendlines.get("resistance", [])):
        all_lines.append({"slope": tl["slope"], "intercept": tl["intercept"],
                          "label": f"Resistance TL {i+1}", "id": f"tl_resistance_{i}"})
    for i, ch in enumerate(channels):
        for side, key in (("support_line", "sup"), ("resistance_line", "res")):
            line = ch.get(side, {})
            if "slope" in line and "intercept" in line:
                all_lines.append({"slope": line["slope"], "intercept": line["intercept"],
                                  "label": f"Channel {side.replace('_line','')} {i+1}",
                                  "id": f"ch_{i}_{key}"})
    for i, z in enumerate(sr.get("support", [])):
        all_lines.append({"slope": 0.0, "intercept": z["price"],
                          "label": f"Support {round(z['price'],2)}", "id": f"sr_sup_{i}"})
    for i, z in enumerate(sr.get("resistance", [])):
        all_lines.append({"slope": 0.0, "intercept": z["price"],
                          "label": f"Resistance {round(z['price'],2)}", "id": f"sr_res_{i}"})

    max_future = n // 2
    convergences: list[dict] = []

    for i in range(len(all_lines)):
        for j in range(i + 1, len(all_lines)):
            l1, l2 = all_lines[i], all_lines[j]
            slope_diff = l1["slope"] - l2["slope"]
            if abs(slope_diff) < 1e-8:
                continue
            # Skip same channel's own boundaries
            i_part = l1["id"].split("_")
            j_part = l2["id"].split("_")
            if i_part[0] == "ch" and j_part[0] == "ch" and i_part[1] == j_part[1]:
                continue

            x_bar = (l2["intercept"] - l1["intercept"]) / slope_diff
            y_price = l1["slope"] * x_bar + l1["intercept"]

            if x_bar < 0 or x_bar > n + max_future or y_price <= 0:
                continue
            if price_range > 0 and abs(y_price - current_price) > price_range * 1.2:
                continue

            is_future = x_bar >= n
            if is_future:
                x_time = int(times[-1] + (x_bar - (n - 1)) * time_per_bar)
            else:
                bar_int = max(0, min(n - 1, int(round(x_bar))))
                x_time = times[bar_int]

            convergences.append({
                "time": x_time, "price": round(y_price, 2),
                "is_future": is_future,
                "line1": l1["label"], "line2": l2["label"],
                "quality": "projected" if is_future else "confirmed",
            })

    # De-duplicate within 2×ATR / 5-bar window, prioritise nearest to current price
    bar_window = 5 * time_per_bar
    deduped: list[dict] = []
    for c in sorted(convergences, key=lambda x: abs(x["price"] - current_price)):
        if not any(
            abs(c["price"] - d["price"]) < atr * 2
            and abs(c["time"] - d["time"]) < bar_window
            for d in deduped
        ):
            deduped.append(c)

    for i, c in enumerate(deduped):
        c["id"] = f"conv_{i}"

    return deduped[:6]


# ── Support / Resistance zones ────────────────────────────────────────────────

def cluster_sr_levels(swings: dict, df: pd.DataFrame) -> dict:
    """
    Cluster swing highs → resistance zones, swing lows → support zones.
    Merge levels within ATR-adjusted tolerance. Score by touch count × recency.

    Sorting:
      Support:    S1 = nearest below price, S2 = next lower, S3 = next lower.
      Resistance: R1 = nearest above price, R2 = next higher, R3 = next higher.

    A level within 0.5×ATR of current price is classified as a "zone under test"
    rather than clean support or resistance.
    """
    atr     = _atr_of_df(df)
    current = float(df["Close"].iloc[-1])
    n       = len(df)
    # Wider tolerance merges closely-spaced pivots into single zones
    cluster_tol = max(atr * 0.5, current * 0.006)
    zone_test_tol = atr * 0.5  # within this distance = zone under test

    def _cluster(pivots: list[dict]) -> list[dict]:
        if not pivots:
            return []
        sorted_p = sorted(pivots, key=lambda x: x["price"])
        zones: list[dict] = []
        for p in sorted_p:
            merged = False
            for z in zones:
                if abs(z["price"] - p["price"]) <= cluster_tol:
                    total_w = z["weight"] + 1
                    z["price"]   = (z["price"] * z["weight"] + p["price"]) / total_w
                    z["weight"]  = total_w
                    z["touches"] = z.get("touches", 1) + 1
                    z["last_bar"] = max(z.get("last_bar", 0), p["bar_index"])
                    merged = True
                    break
            if not merged:
                zones.append({
                    "price":    p["price"],
                    "weight":   1,
                    "touches":  1,
                    "last_bar": p["bar_index"],
                })
        for z in zones:
            z["price"]   = round(z["price"], 2)
            recency = z["last_bar"] / n if n > 0 else 0.5
            z["score"]   = z["touches"] * (0.5 + recency)
            z["pct_from_current"] = round((z["price"] - current) / current * 100, 2)
        return zones

    res_zones = _cluster(swings["highs"])
    sup_zones = _cluster(swings["lows"])

    # Classify each zone: active / zone_under_test
    def _classify(price: float) -> str:
        if abs(price - current) <= zone_test_tol:
            return "zone_under_test"
        return "active"

    for z in res_zones + sup_zones:
        z["zone_status"] = _classify(z["price"])

    # Support: only levels strictly below current; sort descending (nearest first)
    # Resistance: only levels strictly above current; sort ascending (nearest first)
    # Levels AT current (within zone_test_tol) go into both lists with zone_under_test status
    sup_below = sorted(
        [z for z in sup_zones if z["price"] < current + zone_test_tol],
        key=lambda x: -x["price"]  # descending: S1 nearest
    )[:3]
    res_above = sorted(
        [z for z in res_zones if z["price"] > current - zone_test_tol],
        key=lambda x: x["price"]   # ascending: R1 nearest
    )[:3]

    return {
        "resistance": res_above,
        "support":    sup_below,
        "current":    round(current, 2),
        "atr":        round(atr, 2),
    }


# ── Indicators ────────────────────────────────────────────────────────────────

def compute_indicators(df: pd.DataFrame) -> dict:
    """Compute RSI14, MACD(12,26,9), EMA20/50/200, ATR14, volume ratio."""
    close  = df["Close"]
    high   = df["High"]
    low    = df["Low"]
    volume = df["Volume"] if "Volume" in df.columns else pd.Series(dtype=float)

    ema20  = close.ewm(span=20,  adjust=False).mean()
    ema50  = close.ewm(span=50,  adjust=False).mean()
    ema200 = close.ewm(span=200, adjust=False).mean()

    ema12  = close.ewm(span=12, adjust=False).mean()
    ema26  = close.ewm(span=26, adjust=False).mean()
    macd_line   = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    macd_hist   = macd_line - signal_line

    delta = close.diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta).clip(lower=0).rolling(14).mean()
    rs    = gain / loss.replace(0, float("nan"))
    rsi   = 100 - (100 / (1 + rs))

    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low  - close.shift()).abs(),
    ], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()

    vol_sma  = volume.rolling(20).mean() if not volume.empty else pd.Series(dtype=float)
    vol_ratio = (volume / vol_sma.replace(0, float("nan"))).iloc[-1] if not volume.empty else 1.0

    def _last(s: pd.Series) -> float:
        try:
            return float(s.dropna().iloc[-1])
        except Exception:
            return 0.0

    curr     = _last(close)
    e20_val  = _last(ema20)
    e50_val  = _last(ema50)
    e200_val = _last(ema200)
    rsi_val  = _last(rsi)
    macd_val = _last(macd_line)
    sig_val  = _last(signal_line)
    hist_val = _last(macd_hist)
    prev_hist = float(macd_hist.dropna().iloc[-2]) if len(macd_hist.dropna()) >= 2 else hist_val
    atr_val  = _last(atr)
    atr_pct  = atr_val / curr * 100 if curr else 0.0

    # EMA arrays for chart rendering (last N bars)
    def _series_to_points(series: pd.Series) -> list[dict]:
        times = [int(pd.Timestamp(t).timestamp()) for t in df.index]
        return [
            {"time": times[i], "value": round(float(v), 4)}
            for i, v in enumerate(series)
            if not (isinstance(v, float) and math.isnan(v))
        ]

    return {
        "current_price": round(curr, 4),
        "ema20":         round(e20_val,  4),
        "ema50":         round(e50_val,  4),
        "ema200":        round(e200_val, 4),
        "rsi":           round(rsi_val,  2),
        "macd":          round(macd_val, 4),
        "macd_signal":   round(sig_val,  4),
        "macd_hist":     round(hist_val, 4),
        "macd_hist_prev": round(prev_hist, 4),
        "macd_rising":   bool(hist_val > prev_hist),
        "atr":           round(atr_val,  4),
        "atr_pct":       round(atr_pct,  2),
        "vol_ratio":     round(float(vol_ratio) if vol_ratio and not math.isnan(float(vol_ratio)) else 1.0, 2),
        # chart series
        "ema20_series":  _series_to_points(ema20),
        "ema50_series":  _series_to_points(ema50),
        "ema200_series": _series_to_points(ema200),
        "macd_series":   _series_to_points(macd_line),
        "signal_series": _series_to_points(signal_line),
        "hist_series":   _series_to_points(macd_hist),
        "rsi_series":    _series_to_points(rsi),
    }


# ── Trend classification ──────────────────────────────────────────────────────

def _swing_structure(swings: dict) -> str:
    """Classify HH/HL vs LH/LL from last 4 pivot pairs."""
    highs = sorted(swings["highs"], key=lambda x: x["bar_index"])[-5:]
    lows  = sorted(swings["lows"],  key=lambda x: x["bar_index"])[-5:]

    hh = sum(1 for i in range(1, len(highs)) if highs[i]["price"] > highs[i-1]["price"])
    hl = sum(1 for i in range(1, len(lows))  if lows[i]["price"]  > lows[i-1]["price"])
    lh = sum(1 for i in range(1, len(highs)) if highs[i]["price"] < highs[i-1]["price"])
    ll = sum(1 for i in range(1, len(lows))  if lows[i]["price"]  < lows[i-1]["price"])

    bullish = hh + hl
    bearish = lh + ll
    if bullish > bearish + 1:
        return "bullish"
    if bearish > bullish + 1:
        return "bearish"
    return "neutral"


def classify_trend(df: pd.DataFrame, swings: dict, indicators: dict) -> dict:
    curr  = indicators["current_price"]
    e20   = indicators["ema20"]
    e50   = indicators["ema50"]
    e200  = indicators["ema200"]

    # EMA alignment
    if curr > e20 > e50 > e200 > 0:
        ema_trend = "strong_bullish"
    elif curr > e50 > e200 > 0:
        ema_trend = "bullish"
    elif e200 > 0 and curr < e200 * 0.98:
        ema_trend = "strong_bearish"
    elif e50 > 0 and curr < e50:
        ema_trend = "bearish"
    else:
        ema_trend = "neutral"

    swing_str = _swing_structure(swings)

    # Combine
    if ema_trend in ("strong_bullish",) and swing_str == "bullish":
        primary = "Strong Bullish"
        strength = 5
    elif ema_trend in ("bullish", "strong_bullish") or swing_str == "bullish":
        primary = "Bullish"
        strength = 4
    elif ema_trend == "neutral" and swing_str == "neutral":
        primary = "Sideways"
        strength = 3
    elif ema_trend in ("bearish", "strong_bearish") or swing_str == "bearish":
        primary = "Bearish"
        strength = 2
    else:
        primary = "Sideways"
        strength = 3

    if ema_trend == "strong_bearish" and swing_str == "bearish":
        primary = "Strong Bearish"
        strength = 1

    # Short-term: last 30 bars
    short_df = df.tail(30)
    short_ind = compute_indicators(short_df)
    sc = short_ind["current_price"]
    se20 = short_ind["ema20"]
    se50 = short_ind["ema50"]
    if sc > se20 > se50:
        short_term = "Uptrend"
    elif sc < se20 < se50:
        short_term = "Downtrend"
    else:
        short_term = "Sideways"

    # Price position relative to EMAs
    ema_positions = []
    if e200 > 0:
        ema_positions.append(f"{'Above' if curr > e200 else 'Below'} EMA200 ({round((curr/e200-1)*100,1)}%)")
    if e50 > 0:
        ema_positions.append(f"{'Above' if curr > e50 else 'Below'} EMA50 ({round((curr/e50-1)*100,1)}%)")
    if e20 > 0:
        ema_positions.append(f"{'Above' if curr > e20 else 'Below'} EMA20 ({round((curr/e20-1)*100,1)}%)")

    return {
        "primary":        primary,
        "strength":       strength,
        "short_term":     short_term,
        "ema_trend":      ema_trend,
        "swing_structure": swing_str,
        "ema_positions":  ema_positions,
    }


# ── Rule Engine R01–R15 ───────────────────────────────────────────────────────

def _rule(id: str, name: str, status: str, level: str, evidence: str, explanation: str,
          category: str = "other") -> dict:
    return {"id": id, "name": name, "status": status, "level": level,
            "evidence": evidence, "explanation": explanation, "category": category}


def run_rule_engine(
    trend: dict,
    indicators: dict,
    sr: dict,
    trendlines: dict,
    channels: list[dict],
    df: pd.DataFrame,
) -> list[dict]:
    results = []
    curr   = indicators["current_price"]
    rsi    = indicators["rsi"]
    atr    = indicators["atr"]
    atr_pct = indicators["atr_pct"]
    e20    = indicators["ema20"]
    e50    = indicators["ema50"]
    e200   = indicators["ema200"]
    vol    = indicators["vol_ratio"]
    hist   = indicators["macd_hist"]
    hist_p = indicators["macd_hist_prev"]
    macd   = indicators["macd"]
    sig    = indicators["macd_signal"]

    # R01 — EMA Alignment Bullish
    if curr > e20 > e50 > e200 > 0:
        results.append(_rule("R01", "EMA Stack Bullish", "triggered", "bullish",
            f"Price {round(curr,2)} > EMA20 {round(e20,2)} > EMA50 {round(e50,2)} > EMA200 {round(e200,2)}",
            "Full EMA stack alignment signals a sustained uptrend with strong institutional support. "
            "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
            category="ema_structure"))
    elif e200 > 0 and e50 > 0 and e20 > 0 and e20 < e50 < e200:
        results.append(_rule("R01", "EMA Stack Bearish", "triggered", "bearish",
            f"EMA20 {round(e20,2)} < EMA50 {round(e50,2)} < EMA200 {round(e200,2)}",
            "Inverted EMA stack signals a sustained downtrend. "
            "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
            category="ema_structure"))
    else:
        results.append(_rule("R01", "EMA Stack", "not_triggered", "neutral",
            "No full EMA alignment",
            "EMAs are mixed; no strong directional trend signal from MA alignment.",
            category="ema_structure"))

    # R02 — RSI Zone (uses the same zone thresholds as _rsi_zone for consistency)
    if rsi >= 70:
        results.append(_rule("R02", "RSI Overbought", "triggered", "bearish",
            f"RSI {round(rsi,1)} ≥ 70",
            "RSI in overbought territory. Upside momentum may be exhausted; watch for reversal.",
            category="momentum"))
    elif rsi <= 30:
        results.append(_rule("R02", "RSI Oversold", "triggered", "bullish",
            f"RSI {round(rsi,1)} ≤ 30",
            "RSI in oversold territory. Downside momentum may be exhausted; watch for bounce.",
            category="momentum"))
    elif rsi >= 55:
        results.append(_rule("R02", "RSI Bullish Zone", "triggered", "bullish",
            f"RSI {round(rsi,1)} in 55–70 zone",
            "RSI in bullish zone; momentum supports continued upside.",
            category="momentum"))
    elif rsi <= 45:
        results.append(_rule("R02", "RSI Bearish Zone", "triggered", "bearish",
            f"RSI {round(rsi,1)} in 30–45 zone",
            "RSI in bearish zone; momentum supports continued downside.",
            category="momentum"))
    else:
        results.append(_rule("R02", "RSI Neutral", "not_triggered", "neutral",
            f"RSI {round(rsi,1)} in neutral range 45–55",
            "No directional signal from RSI.",
            category="momentum"))

    # R03 — MACD Crossover
    if macd > sig and hist > 0 and hist > hist_p:
        results.append(_rule("R03", "MACD Bullish Crossover", "triggered", "bullish",
            f"MACD {round(macd,4)} > Signal {round(sig,4)}, histogram rising",
            "MACD crossed above signal with rising histogram — bullish momentum building. "
            "Note: MACD below zero means bullish momentum improvement within a bearish trend, not a confirmed reversal.",
            category="momentum"))
    elif macd < sig and hist < 0 and hist < hist_p:
        results.append(_rule("R03", "MACD Bearish Crossover", "triggered", "bearish",
            f"MACD {round(macd,4)} < Signal {round(sig,4)}, histogram falling",
            "MACD crossed below signal with falling histogram — bearish momentum building.",
            category="momentum"))
    else:
        results.append(_rule("R03", "MACD Neutral", "not_triggered", "neutral",
            f"MACD {round(macd,4)}, Signal {round(sig,4)}",
            "No clear MACD crossover signal at this time.",
            category="momentum"))

    # R04 — Volume Confirmation
    if vol >= 1.5:
        results.append(_rule("R04", "High Volume Confirmation", "triggered", "bullish" if curr > e50 else "bearish",
            f"Volume {round(vol,2)}× avg (20d)",
            f"Volume {'surge above' if vol > 2 else 'above'} 20-day average confirms price move direction.",
            category="volume"))
    elif vol < 0.5:
        results.append(_rule("R04", "Low Volume Warning", "triggered", "neutral",
            f"Volume {round(vol,2)}× avg (20d)",
            "Volume significantly below average — current price move lacks conviction.",
            category="volume"))
    else:
        results.append(_rule("R04", "Volume Normal", "not_triggered", "neutral",
            f"Volume {round(vol,2)}× avg (20d)", "Volume is within normal range.",
            category="volume"))

    # R05 — Support Test
    sup_levels = sr.get("support", [])
    if sup_levels:
        nearest_sup = sup_levels[0]
        dist_pct = abs(curr - nearest_sup["price"]) / curr * 100
        zone_st  = nearest_sup.get("zone_status", "active")
        if zone_st == "zone_under_test" or dist_pct < 1.0:
            results.append(_rule("R05", "At Support Level", "triggered", "bullish",
                f"Price {round(curr,2)} {'inside zone at' if zone_st == 'zone_under_test' else 'near'} support {round(nearest_sup['price'],2)} ({round(dist_pct,2)}% away, {nearest_sup['touches']} touches)",
                "Price is testing a key support zone. Watch for bounce or breakdown.",
                category="sr_level"))
        else:
            results.append(_rule("R05", "Support Distance", "not_triggered", "neutral",
                f"Nearest support {round(nearest_sup['price'],2)} is {round(dist_pct,1)}% away",
                "Price is not near a key support level.",
                category="sr_level"))
    else:
        results.append(_rule("R05", "Support Level", "n/a", "neutral", "No support identified",
            "Insufficient pivot data.", category="sr_level"))

    # R06 — Resistance Test
    res_levels = sr.get("resistance", [])
    if res_levels:
        nearest_res = res_levels[0]
        dist_pct = abs(curr - nearest_res["price"]) / curr * 100
        zone_st  = nearest_res.get("zone_status", "active")
        if zone_st == "zone_under_test" or dist_pct < 1.0:
            results.append(_rule("R06", "At Resistance Level", "triggered", "bearish",
                f"Price {round(curr,2)} {'inside zone at' if zone_st == 'zone_under_test' else 'near'} resistance {round(nearest_res['price'],2)} ({round(dist_pct,2)}% away, {nearest_res['touches']} touches)",
                "Price is testing a key resistance zone. Watch for rejection or breakout.",
                category="sr_level"))
        else:
            results.append(_rule("R06", "Resistance Distance", "not_triggered", "neutral",
                f"Nearest resistance {round(nearest_res['price'],2)} is {round(dist_pct,1)}% away",
                "Price is not near a key resistance level.",
                category="sr_level"))
    else:
        results.append(_rule("R06", "Resistance Level", "n/a", "neutral", "No resistance identified",
            "Insufficient pivot data.", category="sr_level"))

    # R07 — Trendline Touch
    all_tl = trendlines.get("support", []) + trendlines.get("resistance", [])
    tl_touched = False
    for tl in all_tl:
        proj_end = tl["end"]["price"]
        dist = abs(curr - proj_end) / curr * 100
        if dist < 1.5:
            tl_type_word = "support" if tl["type"] == "support" else "resistance"
            results.append(_rule("R07", f"Trendline {tl_type_word.title()} Test", "triggered",
                "bullish" if tl["type"] == "support" else "bearish",
                f"Price {round(curr,2)} within 1.5% of {tl_type_word} trendline ({round(proj_end,2)}, {tl['touches']} touches)",
                f"Price is approaching a {tl_type_word} trendline. Watch for bounce ({tl_type_word.lower() == 'support'}) or rejection ({tl_type_word.lower() == 'resistance'}).",
                category="trendline"))
            tl_touched = True
            break
    if not tl_touched:
        if all_tl:
            results.append(_rule("R07", "Trendline", "not_triggered", "neutral",
                "Price not near any trendline", "No trendline test at current price.",
                category="trendline"))
        else:
            results.append(_rule("R07", "Trendline", "n/a", "neutral",
                "No trendlines detected", "Insufficient pivot history for trendlines.",
                category="trendline"))

    # R08 — Channel Detection
    if channels:
        ch = channels[0]
        vs = ch.get("validation_status", "validated")
        ch_status = ch.get("status", "active")
        status_note = (
            f" [Status: {ch_status.replace('_', ' ').title()}]"
            if ch_status not in ("active",) else ""
        )
        results.append(_rule("R08", f"{ch['type'].title()} Channel ({vs.title()})", "triggered", "neutral",
            f"{ch['type'].title()} channel, {ch['containment']}% containment, {vs}{status_note}",
            f"A {ch['type']} price channel has been detected ({vs}). "
            f"{'Breakouts from the channel top signal bullish momentum.' if ch['type'] == 'ascending' else 'Breakdowns from the channel bottom signal bearish momentum.' if ch['type'] == 'descending' else 'Range-bound price action — trade bounces within the channel.'}",
            category="channel_pattern"))
    else:
        results.append(_rule("R08", "Channel", "not_triggered", "neutral",
            "No channel detected", "No parallel trendline channel found in this dataset.",
            category="channel_pattern"))

    # R09 — Volatility (ATR)
    if atr_pct > 4.0:
        results.append(_rule("R09", "High Volatility", "triggered", "neutral",
            f"ATR {round(atr_pct,2)}% of price",
            f"Volatility is elevated (ATR {round(atr_pct,2)}%). Wider stops required; position size accordingly.",
            category="volatility"))
    elif atr_pct < 1.0:
        results.append(_rule("R09", "Low Volatility / Squeeze", "triggered", "neutral",
            f"ATR {round(atr_pct,2)}% of price",
            "Volatility is compressed. A breakout expansion move may be building.",
            category="volatility"))
    else:
        results.append(_rule("R09", "Normal Volatility", "not_triggered", "neutral",
            f"ATR {round(atr_pct,2)}% of price", "Volatility is within normal range.",
            category="volatility"))

    # R10 — Price vs EMA200
    if e200 > 0:
        if curr > e200 * 1.02:
            results.append(_rule("R10", "Price Above 200-EMA", "triggered", "bullish",
                f"Price {round(curr,2)} is {round((curr/e200-1)*100,1)}% above EMA200",
                "Price is well above the 200-EMA long-term support — bullish structural backdrop. "
                "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
                category="ema_structure"))
        elif curr < e200 * 0.98:
            results.append(_rule("R10", "Price Below 200-EMA", "triggered", "bearish",
                f"Price {round(curr,2)} is {round((curr/e200-1)*100,1)}% below EMA200",
                "Price is well below the 200-EMA — bearish long-term structure. "
                "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
                category="ema_structure"))
        else:
            results.append(_rule("R10", "Price Near 200-EMA", "triggered", "neutral",
                f"Price {round(curr,2)} within 2% of EMA200 {round(e200,2)}",
                "Price is at the 200-EMA. This is a key battleground between bulls and bears.",
                category="ema_structure"))
    else:
        results.append(_rule("R10", "200-EMA", "n/a", "neutral", "EMA200 not available",
            "Insufficient data for 200-period EMA.", category="ema_structure"))

    # R11 — RSI Divergence (simplified: RSI falling while price rising or vice versa)
    close_series = df["Close"]
    if len(close_series) >= 20:
        recent_close = close_series.tail(20)
        recent_df = df.tail(20)
        ind_recent = compute_indicators(recent_df)
        price_up  = recent_close.iloc[-1] > recent_close.iloc[0]
        rsi_up    = ind_recent["rsi"] > indicators["rsi"]  # RSI now higher than baseline
        # Compare recent high vs past RSI at that point
        if price_up and not rsi_up and rsi > 55:
            results.append(_rule("R11", "Bearish Divergence", "triggered", "bearish",
                f"Price rising but RSI ({round(rsi,1)}) trending lower",
                "Bearish divergence: price making higher highs while RSI makes lower highs. Momentum weakening.",
                category="momentum"))
        elif not price_up and rsi_up and rsi < 45:
            results.append(_rule("R11", "Bullish Divergence", "triggered", "bullish",
                f"Price falling but RSI ({round(rsi,1)}) trending higher",
                "Bullish divergence: price making lower lows while RSI makes higher lows. Potential reversal.",
                category="momentum"))
        else:
            results.append(_rule("R11", "No Divergence", "not_triggered", "neutral",
                "Price and RSI moving together", "No momentum divergence detected.",
                category="momentum"))
    else:
        results.append(_rule("R11", "RSI Divergence", "n/a", "neutral", "Insufficient bars", "Need at least 20 bars.",
            category="momentum"))

    # R12 — Swing Structure
    swing_str = trend["swing_structure"]
    if swing_str == "bullish":
        results.append(_rule("R12", "Higher Highs / Higher Lows", "triggered", "bullish",
            "Pivot analysis shows HH/HL pattern",
            "Swing structure confirms bullish trend — buyers absorbing dips and price printing higher pivots. "
            "Note: R12/R14 share trend structure evidence and are grouped in bias calculation.",
            category="trend_structure"))
    elif swing_str == "bearish":
        results.append(_rule("R12", "Lower Highs / Lower Lows", "triggered", "bearish",
            "Pivot analysis shows LH/LL pattern",
            "Swing structure confirms bearish trend — sellers dominating and price printing lower pivots. "
            "Note: R12/R14 share trend structure evidence and are grouped in bias calculation.",
            category="trend_structure"))
    else:
        results.append(_rule("R12", "Mixed Swing Structure", "not_triggered", "neutral",
            "No consistent HH/HL or LH/LL sequence",
            "Pivots show mixed swings — no clear directional structure.",
            category="trend_structure"))

    # R13 — Level Convergence (support and resistance clustering near same zone)
    sup_near  = [z for z in sr.get("support", [])    if abs(z["price"] - curr) / curr < 0.03]
    res_near  = [z for z in sr.get("resistance", []) if abs(z["price"] - curr) / curr < 0.03]
    if len(sup_near) >= 1 and len(res_near) >= 1:
        results.append(_rule("R13", "Level Convergence Zone", "triggered", "neutral",
            f"Support {round(sup_near[0]['price'],2)} and resistance {round(res_near[0]['price'],2)} converging near price",
            "Multiple support and resistance levels converging near current price. High-significance zone — expect sharp reaction.",
            category="sr_level"))
    else:
        results.append(_rule("R13", "Level Convergence", "not_triggered", "neutral",
            "No convergence zone near current price", "Support and resistance are not converging near current price.",
            category="sr_level"))

    # R14 — Short-term vs long-term trend alignment
    if trend["primary"] in ("Strong Bullish", "Bullish") and trend["short_term"] == "Uptrend":
        results.append(_rule("R14", "Trend Alignment Bullish", "triggered", "bullish",
            f"Long-term: {trend['primary']}, Short-term: {trend['short_term']}",
            "Short-term and long-term trends are aligned bullish — highest probability setup for long trades. "
            "Note: R12/R14 share trend structure evidence and are grouped in bias calculation.",
            category="trend_structure"))
    elif trend["primary"] in ("Strong Bearish", "Bearish") and trend["short_term"] == "Downtrend":
        results.append(_rule("R14", "Trend Alignment Bearish", "triggered", "bearish",
            f"Long-term: {trend['primary']}, Short-term: {trend['short_term']}",
            "Short-term and long-term trends are aligned bearish — highest probability setup for short trades. "
            "Note: R12/R14 share trend structure evidence and are grouped in bias calculation.",
            category="trend_structure"))
    else:
        results.append(_rule("R14", "Trend Divergence", "triggered", "neutral",
            f"Long-term: {trend['primary']}, Short-term: {trend['short_term']}",
            "Short and long-term trends are not aligned — counter-trend risk exists.",
            category="trend_structure"))

    # R15 — EMA Crossover (Death/Golden Cross)
    ema_cross = "none"
    if e20 > 0 and e50 > 0:
        if abs(e20 - e50) / e50 < 0.005:
            ema_cross = "imminent"
        elif e20 > e50:
            ema_cross = "golden"
        else:
            ema_cross = "death"

    if ema_cross == "golden":
        results.append(_rule("R15", "Golden Cross (EMA20 > EMA50)", "triggered", "bullish",
            f"EMA20 {round(e20,2)} > EMA50 {round(e50,2)}",
            "EMA20 is above EMA50 — medium-term bullish cross in effect. Trend followers will be long. "
            "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
            category="ema_structure"))
    elif ema_cross == "death":
        results.append(_rule("R15", "Death Cross (EMA20 < EMA50)", "triggered", "bearish",
            f"EMA20 {round(e20,2)} < EMA50 {round(e50,2)}",
            "EMA20 is below EMA50 — medium-term bearish cross in effect. Trend followers will be short. "
            "Note: R01/R10/R15 share EMA evidence and are grouped as one signal in bias calculation.",
            category="ema_structure"))
    elif ema_cross == "imminent":
        results.append(_rule("R15", "EMA Cross Imminent", "triggered", "neutral",
            f"EMA20 {round(e20,2)} ≈ EMA50 {round(e50,2)} (within 0.5%)",
            "EMA20 and EMA50 are converging. A crossover signal is imminent — direction TBD.",
            category="ema_structure"))
    else:
        results.append(_rule("R15", "EMA Cross", "n/a", "neutral", "EMA data unavailable",
            "Insufficient data for EMA cross.", category="ema_structure"))

    return results


# ── Assessment ────────────────────────────────────────────────────────────────

def _rsi_zone(rsi: float) -> str:
    """Consistent RSI zone classification used across rule engine and assessment."""
    if rsi >= 70:   return "overbought"
    if rsi >= 55:   return "bullish"
    if rsi >= 45:   return "neutral"
    if rsi >= 30:   return "bearish"
    return "oversold"


def _build_assessment(trend: dict, indicators: dict, rules: list[dict], sr: dict) -> dict:
    # ── Correlated-rule-aware bias calculation ──────────────────────────────
    # Rules R01 (EMA Stack), R10 (Price vs 200-EMA), R15 (Death/Golden Cross),
    # R14 (Trend Alignment), R12 (Swing Structure) measure overlapping evidence.
    # Group them so each evidence category contributes at most 1 to each side.

    def _any_triggered(ids: list[str], side: str) -> int:
        return 1 if any(
            r["id"] in ids and r["level"] == side and r["status"] == "triggered"
            for r in rules
        ) else 0

    # EMA structure group: R01, R10, R15
    ema_bull = _any_triggered(["R01", "R10", "R15"], "bullish")
    ema_bear = _any_triggered(["R01", "R10", "R15"], "bearish")

    # Trend structure group: R12, R14
    trend_bull = _any_triggered(["R12", "R14"], "bullish")
    trend_bear = _any_triggered(["R12", "R14"], "bearish")

    # Independent signals: R02 (RSI), R03 (MACD), R04 (Volume),
    # R05 (Support), R06 (Resistance), R07 (TL), R08 (Channel), R11 (Divergence)
    ind_bull = sum(
        1 for r in rules
        if r["id"] in ("R02", "R03", "R04", "R05", "R06", "R07", "R08", "R11")
        and r["level"] == "bullish" and r["status"] == "triggered"
    )
    ind_bear = sum(
        1 for r in rules
        if r["id"] in ("R02", "R03", "R04", "R05", "R06", "R07", "R08", "R11")
        and r["level"] == "bearish" and r["status"] == "triggered"
    )

    # R09 (Volatility) and R13 (Convergence) are neutral context — not counted
    weighted_bull = ema_bull + trend_bull + ind_bull
    weighted_bear = ema_bear + trend_bear + ind_bear

    # Still report raw rule counts for display, use weighted for bias
    bullish_rules  = sum(1 for r in rules if r["level"] == "bullish"  and r["status"] == "triggered")
    bearish_rules  = sum(1 for r in rules if r["level"] == "bearish"  and r["status"] == "triggered")

    total_weighted = weighted_bull + weighted_bear
    if total_weighted == 0:
        bias = "Neutral"
    elif weighted_bull / max(total_weighted, 1) >= 0.65:
        bias = "Bullish"
    elif weighted_bear / max(total_weighted, 1) >= 0.65:
        bias = "Bearish"
    else:
        bias = "Mixed"

    # ── Scenarios ────────────────────────────────────────────────────────────
    curr     = indicators["current_price"]
    res_list = sr.get("resistance", [])
    sup_list = sr.get("support", [])

    # Targets: use next S/R level beyond the trigger, not an arbitrary percentage
    # Bullish: trigger = break above R1, target = R2 if exists else R1 * 1.04
    # Bearish: trigger = break below S1, target = S2 if exists else S1 * 0.97
    r1_price = res_list[0]["price"] if res_list else round(curr * 1.02, 2)
    r2_price = res_list[1]["price"] if len(res_list) >= 2 else round(r1_price * 1.04, 2)
    s1_price = sup_list[0]["price"] if sup_list else round(curr * 0.98, 2)
    s2_price = sup_list[1]["price"] if len(sup_list) >= 2 else round(s1_price * 0.97, 2)

    # Invalidation: use the nearest opposing level (tight, not distant)
    # Bullish invalidation = S1 (nearest support — if this breaks, bulls are wrong)
    # Bearish invalidation = R1 (nearest resistance — if price recaptures, bears are wrong)
    scenarios = {
        "bullish": {
            "trigger":      f"Close above {r1_price}",
            "target":       r2_price,
            "invalidation": s1_price,
            "method":       "next_resistance" if len(res_list) >= 2 else "4pct_extension",
        },
        "bearish": {
            "trigger":      f"Close below {s1_price}",
            "target":       s2_price,
            "invalidation": r1_price,
            "method":       "next_support" if len(sup_list) >= 2 else "3pct_extension",
        },
    }

    rsi_val  = indicators["rsi"]
    rsi_zone = _rsi_zone(rsi_val)

    return {
        "bias":           bias,
        "primary_trend":  trend["primary"],
        "short_term":     trend["short_term"],
        "bullish_rules":  bullish_rules,
        "bearish_rules":  bearish_rules,
        "neutral_rules":  len(rules) - bullish_rules - bearish_rules,
        "weighted_bull":  weighted_bull,
        "weighted_bear":  weighted_bear,
        "rsi":            rsi_val,
        "rsi_zone":       rsi_zone,
        "vol_ratio":      indicators["vol_ratio"],
        "scenarios":      scenarios,
    }


# ── Main entry point ──────────────────────────────────────────────────────────

def generate_analysis(
    symbol: str, market: str, timeframe: str, lookback: str,
    channel_method: str = "structural",
) -> dict:
    """
    Full pipeline: fetch → swings → trendlines → channels → S/R → indicators → trend → rules → assessment.
    Returns a complete dict for the frontend.
    """
    ohlcv_result = fetch_ohlcv(symbol, market, timeframe, lookback)
    if "error" in ohlcv_result:
        return ohlcv_result

    candles = ohlcv_result["candles"]
    if len(candles) < 30:
        return {"error": f"Only {len(candles)} bars returned — need at least 30 for analysis."}

    # Rebuild DataFrame from candles for analysis
    df = pd.DataFrame(candles)
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("time")
    df = df.rename(columns={
        "open":   "Open",
        "high":   "High",
        "low":    "Low",
        "close":  "Close",
        "volume": "Volume",
    })

    swings     = detect_swings(df)
    trendlines = detect_trendlines(df, swings)

    if channel_method == "regression":
        channels = [regression_channel(df)]
    else:
        channels = detect_structural_channels(trendlines, swings, df)
        if not channels:
            channels = [regression_channel(df)]

    # Compute ATR once for reuse
    atr = float(df["High"].sub(df["Low"]).rolling(14).mean().iloc[-1])
    if not atr or not math.isfinite(atr):
        atr = float(df["Close"].std())

    # Add channel status and IDs
    for i, ch in enumerate(channels):
        ch["id"]     = f"ch_{i}"
        ch["status"] = _channel_status(ch, df, atr)

    sr          = cluster_sr_levels(swings, df)
    indicators  = compute_indicators(df)
    trend       = classify_trend(df, swings, indicators)
    convergences = detect_convergences(trendlines, channels, sr, df)
    rules       = run_rule_engine(trend, indicators, sr, trendlines, channels, df)
    assessment  = _build_assessment(trend, indicators, rules, sr)

    # Build trendline rendering coords (time-based, projected ~12.5% beyond last candle)
    def _tl_coords(tl: dict, times: list[int], tl_id: str) -> dict:
        """Convert bar-index trendline to time-based coords for lightweight-charts."""
        n = len(times)
        s_bar    = max(0, tl["start"]["bar_index"])
        e_bar    = min(n - 1, tl["end"]["bar_index"])
        proj_bars = max(10, n // 8)   # project 12.5% of dataset beyond last bar
        proj_bar = min(n - 1, e_bar + proj_bars)
        proj_price = round(tl["slope"] * proj_bar + tl["intercept"], 4)
        # Estimated future time using average bar spacing
        time_per_bar = (times[-1] - times[0]) / max(n - 1, 1)
        future_bar = e_bar + proj_bars
        future_time = int(times[-1] + max(0, future_bar - (n - 1)) * time_per_bar)
        return {
            "id":         tl_id,
            "type":       tl["type"],
            "touches":    tl["touches"],
            "score":      tl["score"],
            "start":      {"time": times[s_bar],   "value": round(tl["slope"] * s_bar  + tl["intercept"], 4)},
            "end":        {"time": times[e_bar],   "value": round(tl["slope"] * e_bar  + tl["intercept"], 4)},
            "projection": {"time": future_time,    "value": proj_price},
        }

    times  = [c["time"] for c in candles]
    tl_list = []
    for i, tl in enumerate(trendlines.get("support", [])):
        tl_list.append(_tl_coords(tl, times, f"tl_support_{i}"))
    for i, tl in enumerate(trendlines.get("resistance", [])):
        tl_list.append(_tl_coords(tl, times, f"tl_resistance_{i}"))

    # S/R lines for rendering — with stable IDs
    sr_lines: list[dict] = []
    for i, z in enumerate(sr.get("support", [])):
        sr_lines.append({"id": f"sr_support_{i}", "type": "support",
                         "price": z["price"], "touches": z["touches"], "pct": z["pct_from_current"]})
    for i, z in enumerate(sr.get("resistance", [])):
        sr_lines.append({"id": f"sr_resistance_{i}", "type": "resistance",
                         "price": z["price"], "touches": z["touches"], "pct": z["pct_from_current"]})

    return {
        "symbol":         ohlcv_result["symbol"],
        "market":         market,
        "timeframe":      timeframe,
        "lookback":       lookback,
        "bars":           len(candles),
        "warning":        ohlcv_result.get("warning"),
        "channel_method": channel_method,
        "candles":        candles,
        "overlays": {
            "trendlines":    tl_list,
            "channels":      channels,
            "sr_lines":      sr_lines,
            "convergences":  convergences,
        },
        "indicators":  {k: v for k, v in indicators.items() if not k.endswith("_series")},
        "ema20_series":   indicators["ema20_series"],
        "ema50_series":   indicators["ema50_series"],
        "ema200_series":  indicators["ema200_series"],
        "macd_series":    indicators["macd_series"],
        "signal_series":  indicators["signal_series"],
        "hist_series":    indicators["hist_series"],
        "rsi_series":     indicators["rsi_series"],
        "trend":       trend,
        "rules":       rules,
        "assessment":  assessment,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
