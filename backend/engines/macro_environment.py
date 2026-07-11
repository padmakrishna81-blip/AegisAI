"""Level 6 — Macro Environment Score (0-100).

Weights: Indian Economy 20, Monetary Policy 15, Inflation 10,
Market Liquidity 10, Global Economy 10, Currency 10, Commodity Prices 10,
Market Sentiment 5, Geopolitical Risk 5, Volatility 5.
"""

from data.market_data import get_index_history, get_info


def calculate(symbol: str = None) -> dict:
    """Calculate macro environment score. symbol is used for sector-specific commodity adjustment."""
    nifty = get_index_history("^NSEI", "3mo")
    vix = get_index_history("^INDIAVIX", "1mo")
    usdinr = get_index_history("USDINR=X", "3mo")
    oil = get_index_history("CL=F", "3mo")
    sp500 = get_index_history("^GSPC", "3mo")

    breakdown = {}

    s1, d1 = _score_indian_economy(nifty)
    breakdown["indian_economy"] = {"score": s1, "weight": 20, "details": d1}

    s2, d2 = _score_monetary_policy()
    breakdown["monetary_policy"] = {"score": s2, "weight": 15, "details": d2}

    s3, d3 = _score_inflation()
    breakdown["inflation"] = {"score": s3, "weight": 10, "details": d3}

    s4, d4 = _score_market_liquidity(nifty)
    breakdown["market_liquidity"] = {"score": s4, "weight": 10, "details": d4}

    s5, d5 = _score_global_economy(sp500)
    breakdown["global_economy"] = {"score": s5, "weight": 10, "details": d5}

    s6, d6 = _score_currency(usdinr)
    breakdown["currency"] = {"score": s6, "weight": 10, "details": d6}

    s7, d7 = _score_commodity(oil)
    breakdown["commodity_prices"] = {"score": s7, "weight": 10, "details": d7}

    s8, d8 = _score_market_sentiment(nifty)
    breakdown["market_sentiment"] = {"score": s8, "weight": 5, "details": d8}

    s9, d9 = _score_geopolitical()
    breakdown["geopolitical_risk"] = {"score": s9, "weight": 5, "details": d9}

    s10, d10 = _score_volatility(vix)
    breakdown["volatility"] = {"score": s10, "weight": 5, "details": d10}

    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    # Market mode
    if final_score >= 90:
        market_mode = "STRONG BULL"
    elif final_score >= 80:
        market_mode = "BULLISH"
    elif final_score >= 70:
        market_mode = "NEUTRAL"
    elif final_score >= 60:
        market_mode = "DEFENSIVE"
    else:
        market_mode = "CAPITAL PRESERVATION"

    return {
        "score": final_score,
        "market_mode": market_mode,
        "breakdown": breakdown,
    }


def _index_return(hist, period: str = "3mo") -> float:
    if hist is None or hist.empty:
        return 0.0
    try:
        return float((hist["Close"].iloc[-1] / hist["Close"].iloc[0] - 1) * 100)
    except Exception:
        return 0.0


def _score_indian_economy(nifty) -> tuple[int, dict]:
    nifty_ret = _index_return(nifty)
    # Proxy GDP strength via Nifty trend
    if nifty_ret > 10:
        score = 10
    elif nifty_ret > 5:
        score = 8
    elif nifty_ret > 0:
        score = 7
    elif nifty_ret > -5:
        score = 5
    else:
        score = 3
    return score, {"nifty_3m_return_pct": round(nifty_ret, 1), "proxy": "nifty_trend"}


def _score_monetary_policy() -> tuple[int, dict]:
    # Static moderate-positive: RBI in rate-cut cycle as of 2025-2026
    return 8, {"rbi_stance": "accommodative", "note": "Rate cut cycle in progress"}


def _score_inflation() -> tuple[int, dict]:
    # Static: India CPI ~4-5% range
    return 8, {"cpi_approx": "4-5%", "note": "Within RBI comfort zone"}


def _score_market_liquidity(nifty) -> tuple[int, dict]:
    nifty_ret = _index_return(nifty)
    if nifty_ret > 5:
        score = 9  # strong inflows
    elif nifty_ret > 0:
        score = 7
    elif nifty_ret > -5:
        score = 5
    else:
        score = 3
    return score, {"nifty_3m_return_pct": round(nifty_ret, 1)}


def _score_global_economy(sp500) -> tuple[int, dict]:
    sp_ret = _index_return(sp500)
    if sp_ret > 5:
        score = 8
    elif sp_ret > 0:
        score = 7
    elif sp_ret > -5:
        score = 5
    else:
        score = 3
    return score, {"sp500_3m_return_pct": round(sp_ret, 1)}


def _score_currency(usdinr) -> tuple[int, dict]:
    if usdinr is None or usdinr.empty:
        return 7, {"usdinr": None}
    try:
        start = float(usdinr["Close"].iloc[0])
        end = float(usdinr["Close"].iloc[-1])
        change_pct = (end - start) / start * 100
        # INR depreciation (positive change in USDINR) is negative for markets
        if change_pct < 1:
            score = 9  # stable/appreciating
        elif change_pct < 2:
            score = 7
        elif change_pct < 4:
            score = 5
        else:
            score = 3  # sharp depreciation
        return score, {"usdinr_change_pct": round(change_pct, 1), "current_rate": round(end, 2)}
    except Exception:
        return 7, {"usdinr": "unavailable"}


def _score_commodity(oil) -> tuple[int, dict]:
    oil_ret = _index_return(oil)
    # Lower oil = better for India (oil importer)
    if oil_ret < -10:
        score = 10  # big oil drop = very positive
    elif oil_ret < 0:
        score = 8
    elif oil_ret < 5:
        score = 7
    elif oil_ret < 15:
        score = 5
    else:
        score = 3  # oil spike = bad for India
    return score, {"oil_3m_return_pct": round(oil_ret, 1)}


def _score_market_sentiment(nifty) -> tuple[int, dict]:
    nifty_ret = _index_return(nifty)
    if nifty_ret > 8:
        score = 9
    elif nifty_ret > 3:
        score = 7
    elif nifty_ret > -3:
        score = 6
    else:
        score = 3
    return score, {"market_trend": "bullish" if nifty_ret > 3 else "bearish" if nifty_ret < -3 else "neutral"}


def _score_geopolitical() -> tuple[int, dict]:
    # Moderate static score
    return 7, {"note": "Moderate geopolitical risks globally"}


def _score_volatility(vix) -> tuple[int, dict]:
    if vix is None or vix.empty:
        return 7, {"vix": None}
    try:
        current_vix = float(vix["Close"].iloc[-1])
        if current_vix < 13:
            score = 10
        elif current_vix < 16:
            score = 9
        elif current_vix < 20:
            score = 7
        elif current_vix < 25:
            score = 5
        else:
            score = 2
        return score, {"india_vix": round(current_vix, 1)}
    except Exception:
        return 7, {"india_vix": None}
