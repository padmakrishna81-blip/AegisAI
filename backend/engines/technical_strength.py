"""Level 3 — Technical Strength Score (0-100).

All indicators computed from OHLCV history using pandas only (no ta-lib).
Weights: Long-Term Trend 20, Pullback Opportunity 20, Momentum 15,
Volume 10, Price Structure 10, Volatility 5, Support 5,
Relative Strength 5, Breakout 5, Technical Risk 5.
"""

import pandas as pd
from data.market_data import get_history, get_nifty_history, safe_get


def calculate(symbol: str) -> dict:
    hist = get_history(symbol, period="1y")
    if hist.empty or len(hist) < 50:
        return {"score": 50, "breakdown": _neutral_breakdown(), "current_price": 0}

    indicators = _compute_indicators(hist)
    nifty = get_nifty_history(period="3mo")
    stock_3m = get_history(symbol, period="3mo")
    rs = _relative_strength(stock_3m, nifty)

    breakdown = {}

    s1, d1 = _score_long_term_trend(indicators)
    breakdown["long_term_trend"] = {"score": s1, "weight": 20, "details": d1}

    s2, d2 = _score_pullback(indicators)
    breakdown["pullback_opportunity"] = {"score": s2, "weight": 20, "details": d2}

    s3, d3 = _score_momentum(indicators)
    breakdown["momentum"] = {"score": s3, "weight": 15, "details": d3}

    s4, d4 = _score_volume(indicators)
    breakdown["volume_confirmation"] = {"score": s4, "weight": 10, "details": d4}

    s5, d5 = _score_price_structure(indicators)
    breakdown["price_structure"] = {"score": s5, "weight": 10, "details": d5}

    s6, d6 = _score_volatility(indicators)
    breakdown["volatility"] = {"score": s6, "weight": 5, "details": d6}

    s7, d7 = _score_support(indicators)
    breakdown["support_strength"] = {"score": s7, "weight": 5, "details": d7}

    s8, d8 = _score_relative_strength(rs)
    breakdown["relative_strength"] = {"score": s8, "weight": 5, "details": d8}

    s9, d9 = _score_breakout(indicators)
    breakdown["breakout_readiness"] = {"score": s9, "weight": 5, "details": d9}

    s10, d10 = _score_technical_risk(indicators)
    breakdown["technical_risk"] = {"score": s10, "weight": 5, "details": d10}

    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    current = float(indicators["current_price"])
    entry_low = round(current * 0.98, 1)
    entry_high = round(current * 1.02, 1)

    return {
        "score": final_score,
        "breakdown": breakdown,
        "current_price": current,
        "entry_range": {"low": entry_low, "high": entry_high},
        "indicators": {
            "sma20": round(float(indicators["sma20"]), 2),
            "sma50": round(float(indicators["sma50"]), 2),
            "sma200": round(float(indicators["sma200"]), 2),
            "rsi": round(float(indicators["rsi"]), 1),
            "macd": round(float(indicators["macd"]), 4),
            "atr_pct": round(float(indicators["atr_pct"]), 2),
        },
    }


def _compute_indicators(hist: pd.DataFrame) -> dict:
    close = hist["Close"]
    high = hist["High"]
    low = hist["Low"]
    volume = hist["Volume"]

    sma20 = close.rolling(20).mean()
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    ema9 = close.ewm(span=9, adjust=False).mean()

    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    macd_hist = macd_line - signal_line

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta).clip(lower=0).rolling(14).mean()
    rs_ratio = gain / loss.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs_ratio))

    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()

    bb_mid = sma20
    bb_std = close.rolling(20).std()
    bb_upper = bb_mid + 2 * bb_std
    bb_lower = bb_mid - 2 * bb_std
    bb_range = bb_upper - bb_lower
    bb_position = (close - bb_lower) / bb_range.replace(0, float("nan"))

    vol_sma20 = volume.rolling(20).mean()
    vol_ratio = volume / vol_sma20.replace(0, float("nan"))

    curr = close.iloc[-1]
    prev_high_20 = close.rolling(20).max().iloc[-2] if len(close) > 20 else curr
    prev_high_50 = close.rolling(50).max().iloc[-2] if len(close) > 50 else curr
    prev_high_52w = close.rolling(252).max().iloc[-2] if len(close) > 252 else close.max()

    drop_20 = (prev_high_20 - curr) / prev_high_20 * 100 if prev_high_20 else 0
    drop_50 = (prev_high_50 - curr) / prev_high_50 * 100 if prev_high_50 else 0
    drop_52w = (prev_high_52w - curr) / prev_high_52w * 100 if prev_high_52w else 0

    # Swing highs/lows for structure
    recent_highs = high.rolling(10).max()
    recent_lows = low.rolling(10).min()

    return {
        "current_price": curr,
        "sma20": _last(sma20),
        "sma50": _last(sma50),
        "sma200": _last(sma200),
        "rsi": _last(rsi),
        "macd": _last(macd_line),
        "macd_hist": _last(macd_hist),
        "macd_prev_hist": macd_hist.iloc[-2] if len(macd_hist) > 1 else 0,
        "atr": _last(atr),
        "atr_pct": _last(atr) / curr * 100 if curr else 0,
        "bb_position": _last(bb_position),
        "vol_ratio": _last(vol_ratio),
        "drop_20": drop_20,
        "drop_50": drop_50,
        "drop_52w": drop_52w,
        "close_series": close,
        "volume_series": volume,
    }


def _last(series: pd.Series):
    try:
        v = series.dropna().iloc[-1]
        return float(v) if v is not None else 0.0
    except (IndexError, TypeError):
        return 0.0


def _score_long_term_trend(ind: dict) -> tuple[int, dict]:
    curr = ind["current_price"]
    s200 = ind["sma200"]
    s50 = ind["sma50"]
    s20 = ind["sma20"]

    if s200 <= 0:
        return 5, {"condition": "insufficient_data"}

    above_200 = curr > s200
    above_50 = curr > s50
    above_20 = curr > s20

    if above_200 and above_50 and above_20 and s50 > s200:
        score = 10
        cond = "strong_uptrend"
    elif above_200 and above_50:
        score = 9
        cond = "uptrend"
    elif above_200 and not above_50:
        score = 7
        cond = "above_200_below_50"
    elif not above_200 and above_50:
        score = 5
        cond = "below_200_above_50"
    elif curr < s200 and curr > s200 * 0.95:
        score = 3
        cond = "just_below_200"
    else:
        score = 2
        cond = "downtrend"

    return score, {
        "condition": cond,
        "above_200dma": above_200,
        "above_50dma": above_50,
        "pct_from_200dma": round((curr - s200) / s200 * 100, 1) if s200 else None,
    }


def _score_pullback(ind: dict) -> tuple[int, dict]:
    drop_20 = ind["drop_20"]
    drop_50 = ind["drop_50"]
    drop_52w = ind["drop_52w"]
    rsi = ind["rsi"]
    curr = ind["current_price"]
    s50 = ind["sma50"]
    s20 = ind["sma20"]

    # Ideal: pulled back 5-12% from recent high, above 200DMA
    above_200 = curr > ind["sma200"] if ind["sma200"] else False

    if above_200 and 5 <= drop_20 <= 12 and 40 <= rsi <= 60:
        score = 10  # ideal pullback entry
    elif above_200 and 3 <= drop_20 <= 15 and rsi < 65:
        score = 8
    elif above_200 and drop_20 > 15 and rsi < 45:
        score = 6  # deeper correction
    elif drop_20 < 2:
        score = 5  # near highs, less attractive entry
    elif drop_52w > 40:
        score = 2  # significant damage
    else:
        score = 4

    return score, {
        "drop_from_20d_high_pct": round(drop_20, 1),
        "drop_from_50d_high_pct": round(drop_50, 1),
        "drop_from_52w_high_pct": round(drop_52w, 1),
        "near_50dma": abs(curr - s50) / s50 * 100 < 3 if s50 else False,
    }


def _score_momentum(ind: dict) -> tuple[int, dict]:
    rsi = ind["rsi"]
    macd_hist = ind["macd_hist"]
    prev_hist = ind["macd_prev_hist"]
    macd_rising = macd_hist > prev_hist

    if 45 <= rsi <= 65 and macd_hist > 0 and macd_rising:
        score = 10
    elif 40 <= rsi <= 70 and macd_rising:
        score = 8
    elif rsi > 70:
        score = 4  # overbought
    elif rsi < 30:
        score = 4  # oversold (falling knives)
    elif 35 <= rsi < 45:
        score = 6  # recovering
    else:
        score = 5

    return score, {
        "rsi": round(rsi, 1),
        "macd_histogram": round(macd_hist, 4),
        "macd_rising": macd_rising,
        "rsi_zone": "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral" if rsi < 45 else "bullish",
    }


def _score_volume(ind: dict) -> tuple[int, dict]:
    vol_ratio = ind["vol_ratio"]
    if vol_ratio > 1.5:
        score = 10
    elif vol_ratio > 1.2:
        score = 8
    elif vol_ratio > 0.8:
        score = 6
    elif vol_ratio > 0.5:
        score = 4
    else:
        score = 2
    return score, {"vol_ratio_vs_20d_avg": round(vol_ratio, 2)}


def _score_price_structure(ind: dict) -> tuple[int, dict]:
    # Proxy via BB position + trend consistency
    bb_pos = ind["bb_position"]
    curr = ind["current_price"]
    s20 = ind["sma20"]
    s50 = ind["sma50"]

    if s20 > s50 and curr > s20:
        score = 9  # strong uptrend structure
    elif s20 > s50:
        score = 7
    elif abs(s20 - s50) / s50 < 0.02 if s50 else True:
        score = 5  # sideways
    else:
        score = 3  # downtrend structure

    return score, {
        "bb_position": round(bb_pos, 2) if bb_pos else None,
        "sma20_above_sma50": s20 > s50 if s50 else None,
    }


def _score_volatility(ind: dict) -> tuple[int, dict]:
    atr_pct = ind["atr_pct"]
    if atr_pct < 1.5:
        score = 10
    elif atr_pct < 2.5:
        score = 8
    elif atr_pct < 4.0:
        score = 6
    elif atr_pct < 6.0:
        score = 4
    else:
        score = 2
    return score, {"atr_pct_of_price": round(atr_pct, 2)}


def _score_support(ind: dict) -> tuple[int, dict]:
    curr = ind["current_price"]
    s50 = ind["sma50"]
    s200 = ind["sma200"]
    s20 = ind["sma20"]

    near_50 = abs(curr - s50) / s50 * 100 < 3 if s50 else False
    near_200 = abs(curr - s200) / s200 * 100 < 3 if s200 else False

    if near_50 or near_200:
        score = 10  # at strong support
    elif curr > s50 > s200:
        score = 8  # above support
    elif curr > s200:
        score = 6
    else:
        score = 3

    return score, {
        "near_50dma_support": near_50,
        "near_200dma_support": near_200,
    }


def _relative_strength(stock_hist: pd.DataFrame, nifty_hist: pd.DataFrame) -> float:
    """Stock 3-month return relative to Nifty."""
    try:
        if stock_hist.empty or nifty_hist.empty:
            return 0.0
        stock_ret = (stock_hist["Close"].iloc[-1] / stock_hist["Close"].iloc[0] - 1) * 100
        nifty_ret = (nifty_hist["Close"].iloc[-1] / nifty_hist["Close"].iloc[0] - 1) * 100
        return float(stock_ret - nifty_ret)
    except Exception:
        return 0.0


def _score_relative_strength(rs: float) -> tuple[int, dict]:
    if rs > 10:
        score = 10
    elif rs > 5:
        score = 8
    elif rs > 0:
        score = 6
    elif rs > -5:
        score = 4
    else:
        score = 2
    return score, {"rs_vs_nifty_3m_pct": round(rs, 1)}


def _score_breakout(ind: dict) -> tuple[int, dict]:
    bb_pos = ind["bb_position"]
    vol_ratio = ind["vol_ratio"]
    rsi = ind["rsi"]

    # Consolidation: BB position mid-range + volume low + RSI 45-55
    if bb_pos and 0.3 <= bb_pos <= 0.7 and vol_ratio < 0.9 and 45 <= rsi <= 60:
        score = 9  # coiling for breakout
    elif bb_pos and bb_pos > 0.8 and vol_ratio > 1.3:
        score = 7  # breaking out now
    elif bb_pos and 0.4 <= bb_pos <= 0.6:
        score = 6
    else:
        score = 4

    return score, {
        "bb_position": round(bb_pos, 2) if bb_pos else None,
        "consolidating": bool(bb_pos and 0.3 <= bb_pos <= 0.7) if bb_pos else False,
    }


def _score_technical_risk(ind: dict) -> tuple[int, dict]:
    rsi = ind["rsi"]
    atr_pct = ind["atr_pct"]
    curr = ind["current_price"]
    s200 = ind["sma200"]
    s50 = ind["sma50"]

    risk_flags = []
    if rsi > 75:
        risk_flags.append("overbought")
    if atr_pct > 5:
        risk_flags.append("high_volatility")
    if s50 and s200 and s50 < s200 and curr < s50:
        risk_flags.append("death_cross_zone")
    if ind["drop_52w"] > 35:
        risk_flags.append("severe_drawdown")

    if not risk_flags:
        score = 10
    elif len(risk_flags) == 1:
        score = 7
    elif len(risk_flags) == 2:
        score = 4
    else:
        score = 2

    return score, {"risk_flags": risk_flags}


def _neutral_breakdown() -> dict:
    keys = ["long_term_trend", "pullback_opportunity", "momentum", "volume_confirmation",
            "price_structure", "volatility", "support_strength", "relative_strength",
            "breakout_readiness", "technical_risk"]
    weights = [20, 20, 15, 10, 10, 5, 5, 5, 5, 5]
    return {k: {"score": 5, "weight": w, "details": {}} for k, w in zip(keys, weights)}
