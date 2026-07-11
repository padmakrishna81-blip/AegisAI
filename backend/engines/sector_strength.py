"""Level 4 — Sector Strength Score (0-100).

Weights: Revenue Growth 15, Earnings Growth 15, Gov Policy 15,
Industry Outlook 15, Market Leadership 10, Institutional Rotation 10,
Global Trend 10, Competition 5, Innovation 5, Risk 5.
"""

from data.market_data import get_index_history, get_info, batch_get_info
from data.indices import SECTOR_INDEX_MAP, INDEX_GROUPS, STOCK_SECTOR_MAP, get_sector
from data.news_fetcher import fetch_stock_news, extract_news_text
from ai.llm_client import classify_sentiment


# Static sector quality data (updated periodically)
SECTOR_DATA = {
    "Defence": {"gov": 10, "innovation": 9, "competition": 9, "global": 8, "risk": 8},
    "IT": {"gov": 8, "innovation": 10, "competition": 6, "global": 9, "risk": 8},
    "Banking": {"gov": 7, "innovation": 7, "competition": 7, "global": 7, "risk": 7},
    "Pharma": {"gov": 7, "innovation": 9, "competition": 7, "global": 8, "risk": 7},
    "Auto": {"gov": 7, "innovation": 7, "competition": 6, "global": 7, "risk": 7},
    "FMCG": {"gov": 6, "innovation": 6, "competition": 6, "global": 6, "risk": 8},
    "Metal": {"gov": 6, "innovation": 5, "competition": 5, "global": 7, "risk": 6},
    "Energy": {"gov": 8, "innovation": 7, "competition": 7, "global": 7, "risk": 7},
    "Infrastructure": {"gov": 9, "innovation": 6, "competition": 7, "global": 6, "risk": 7},
    "Financial Services": {"gov": 7, "innovation": 8, "competition": 7, "global": 7, "risk": 7},
    "Healthcare": {"gov": 7, "innovation": 8, "competition": 7, "global": 7, "risk": 8},
    "Cement": {"gov": 7, "innovation": 5, "competition": 6, "global": 6, "risk": 7},
    "Consumer": {"gov": 6, "innovation": 7, "competition": 6, "global": 6, "risk": 8},
    "Diversified": {"gov": 6, "innovation": 6, "competition": 6, "global": 6, "risk": 6},
}


def calculate(symbol: str) -> dict:
    sector = get_sector(symbol)
    sd = SECTOR_DATA.get(sector, SECTOR_DATA["Diversified"])
    index_ticker = SECTOR_INDEX_MAP.get(sector)

    # Sector index performance
    hist_3m = get_index_history(index_ticker, "3mo") if index_ticker else None
    hist_1y = get_index_history(index_ticker, "1y") if index_ticker else None

    ret_3m = _index_return(hist_3m)
    ret_1y = _index_return(hist_1y)

    breakdown = {}

    s1, d1 = _score_revenue_growth(ret_3m, ret_1y)
    breakdown["revenue_growth"] = {"score": s1, "weight": 15, "details": d1}

    s2, d2 = _score_earnings_growth(ret_1y, sd)
    breakdown["earnings_growth"] = {"score": s2, "weight": 15, "details": d2}

    s3, d3 = _score_gov_policy(sd, sector)
    breakdown["gov_policy"] = {"score": s3, "weight": 15, "details": d3}

    s4, d4 = _score_industry_outlook(ret_3m, ret_1y)
    breakdown["industry_outlook"] = {"score": s4, "weight": 15, "details": d4}

    s5, d5 = _score_market_leadership(sector)
    breakdown["market_leadership"] = {"score": s5, "weight": 10, "details": d5}

    s6, d6 = _score_institutional_rotation(ret_3m)
    breakdown["institutional_rotation"] = {"score": s6, "weight": 10, "details": d6}

    s7, d7 = _score_global_trend(sd)
    breakdown["global_trend"] = {"score": s7, "weight": 10, "details": d7}

    s8, d8 = _score_competition(sd)
    breakdown["competition"] = {"score": s8, "weight": 5, "details": d8}

    s9, d9 = _score_innovation(sd)
    breakdown["innovation"] = {"score": s9, "weight": 5, "details": d9}

    s10, d10 = _score_risk(sd)
    breakdown["sector_risk"] = {"score": s10, "weight": 5, "details": d10}

    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    return {"score": final_score, "sector": sector, "breakdown": breakdown}


def _index_return(hist) -> float:
    if hist is None or hist.empty:
        return 0.0
    try:
        return float((hist["Close"].iloc[-1] / hist["Close"].iloc[0] - 1) * 100)
    except Exception:
        return 0.0


def _ret_to_score(ret: float) -> int:
    if ret > 20:
        return 10
    elif ret > 15:
        return 9
    elif ret > 10:
        return 8
    elif ret > 5:
        return 7
    elif ret > 0:
        return 6
    elif ret > -5:
        return 4
    else:
        return 2


def _score_revenue_growth(ret_3m, ret_1y) -> tuple[int, dict]:
    score = _ret_to_score(max(ret_3m, ret_1y * 0.3))
    return score, {"sector_3m_return_pct": round(ret_3m, 1), "sector_1y_return_pct": round(ret_1y, 1)}


def _score_earnings_growth(ret_1y, sd) -> tuple[int, dict]:
    base = _ret_to_score(ret_1y)
    return base, {"sector_1y_return_pct": round(ret_1y, 1)}


def _score_gov_policy(sd, sector) -> tuple[int, dict]:
    return sd["gov"], {"sector": sector, "policy_support": "high" if sd["gov"] >= 8 else "moderate" if sd["gov"] >= 6 else "low"}


def _score_industry_outlook(ret_3m, ret_1y) -> tuple[int, dict]:
    if ret_3m > 10 or ret_1y > 25:
        score = 10
    elif ret_3m > 5 or ret_1y > 15:
        score = 8
    elif ret_3m > 0 or ret_1y > 5:
        score = 6
    else:
        score = 4
    return score, {"ret_3m": round(ret_3m, 1), "ret_1y": round(ret_1y, 1)}


SECTOR_LEADERSHIP = {
    "Defence": 9, "IT": 9, "Banking": 9, "Pharma": 8, "Auto": 8,
    "FMCG": 9, "Energy": 8, "Infrastructure": 8, "Financial Services": 8,
    "Metal": 7, "Cement": 7, "Consumer": 7, "Healthcare": 8, "Diversified": 6,
}


def _score_market_leadership(sector) -> tuple[int, dict]:
    score = SECTOR_LEADERSHIP.get(sector, 6)
    return score, {"sector": sector}


def _score_institutional_rotation(ret_3m) -> tuple[int, dict]:
    # Proxy: strong sector momentum → institutions flowing in
    if ret_3m > 8:
        score = 10
    elif ret_3m > 4:
        score = 8
    elif ret_3m > 0:
        score = 6
    elif ret_3m > -4:
        score = 4
    else:
        score = 2
    return score, {"sector_momentum_3m_pct": round(ret_3m, 1)}


def _score_global_trend(sd) -> tuple[int, dict]:
    return sd["global"], {"global_trend_score": sd["global"]}


def _score_competition(sd) -> tuple[int, dict]:
    return sd["competition"], {"competition_score": sd["competition"]}


def _score_innovation(sd) -> tuple[int, dict]:
    return sd["innovation"], {"innovation_score": sd["innovation"]}


def _score_risk(sd) -> tuple[int, dict]:
    return sd["risk"], {"risk_score": sd["risk"]}
