"""Level 2 — Growth Trend Score (0-100).

Weights: Board Guidance 20, Analyst Consensus 15, Revenue Forecast 15,
EPS Forecast 15, Order Book 10, Industry Growth 10, Gov Tailwinds 5,
Innovation 5, Expansion 3, Risk 2.
"""

from data.market_data import get_info, get_recommendations, get_index_history, safe_get
from data.indices import get_sector, SECTOR_INDEX_MAP
from data.news_fetcher import fetch_stock_news, extract_news_text
from ai.llm_client import classify_sentiment


def calculate(symbol: str) -> dict:
    info = get_info(symbol)
    sector = get_sector(symbol)
    news = fetch_stock_news(symbol)
    news_text = extract_news_text(news)
    sentiment = classify_sentiment(news_text) if news_text else "NEUTRAL"

    breakdown = {}

    s1, d1 = _score_board_guidance(info, sentiment, news_text)
    breakdown["board_guidance"] = {"score": s1, "weight": 20, "details": d1}

    s2, d2 = _score_analyst_consensus(info)
    breakdown["analyst_consensus"] = {"score": s2, "weight": 15, "details": d2}

    s3, d3 = _score_revenue_forecast(info)
    breakdown["revenue_forecast"] = {"score": s3, "weight": 15, "details": d3}

    s4, d4 = _score_eps_forecast(info)
    breakdown["eps_forecast"] = {"score": s4, "weight": 15, "details": d4}

    s5, d5 = _score_order_book(sentiment, news_text)
    breakdown["order_book"] = {"score": s5, "weight": 10, "details": d5}

    s6, d6 = _score_industry_growth(sector)
    breakdown["industry_growth"] = {"score": s6, "weight": 10, "details": d6}

    s7, d7 = _score_gov_tailwinds(sector, sentiment)
    breakdown["gov_tailwinds"] = {"score": s7, "weight": 5, "details": d7}

    s8, d8 = _score_innovation(info, sector)
    breakdown["innovation"] = {"score": s8, "weight": 5, "details": d8}

    s9, d9 = _score_expansion(sentiment)
    breakdown["expansion"] = {"score": s9, "weight": 3, "details": d9}

    s10, d10 = _score_risk(info)
    breakdown["risk_outlook"] = {"score": s10, "weight": 2, "details": d10}

    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    return {"score": final_score, "breakdown": breakdown}


def _score_board_guidance(info: dict, sentiment: str, news_text: str) -> tuple[int, dict]:
    # Use analyst recommendation mean + news sentiment as proxy
    rec_mean = safe_get(info, "recommendationMean", default=3.0) or 3.0

    if sentiment == "POSITIVE" and rec_mean <= 2.0:
        score = 9
    elif sentiment == "POSITIVE":
        score = 8
    elif sentiment == "NEGATIVE" and rec_mean >= 3.5:
        score = 3
    elif sentiment == "NEGATIVE":
        score = 4
    else:
        score = 6  # neutral

    return score, {"news_sentiment": sentiment, "recommendation_mean": round(rec_mean, 2)}


def _score_analyst_consensus(info: dict) -> tuple[int, dict]:
    rec_mean = safe_get(info, "recommendationMean", default=3.0) or 3.0
    num_analysts = safe_get(info, "numberOfAnalystOpinions", default=0) or 0
    target_price = safe_get(info, "targetMeanPrice", default=None)
    current_price = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=0)

    upside = None
    if target_price and current_price and current_price > 0:
        upside = (target_price - current_price) / current_price * 100

    # rec_mean: 1=strong buy, 5=strong sell
    if rec_mean <= 1.5:
        score = 10
    elif rec_mean <= 2.0:
        score = 9
    elif rec_mean <= 2.5:
        score = 7
    elif rec_mean <= 3.0:
        score = 5
    elif rec_mean <= 3.5:
        score = 3
    else:
        score = 2

    if upside and upside > 15:
        score = min(10, score + 1)

    return score, {
        "recommendation_mean": round(rec_mean, 2),
        "num_analysts": num_analysts,
        "target_price": round(target_price, 1) if target_price else None,
        "upside_pct": round(upside, 1) if upside else None,
    }


def _score_revenue_forecast(info: dict) -> tuple[int, dict]:
    rev_growth = safe_get(info, "revenueGrowth", default=None)

    if rev_growth is None:
        return 5, {"forward_revenue_growth_pct": None}

    pct = rev_growth * 100
    if pct > 20:
        score = 10
    elif pct > 15:
        score = 9
    elif pct > 10:
        score = 7
    elif pct > 5:
        score = 6
    elif pct > 0:
        score = 4
    else:
        score = 2

    return score, {"forward_revenue_growth_pct": round(pct, 1)}


def _score_eps_forecast(info: dict) -> tuple[int, dict]:
    fwd_eps = safe_get(info, "forwardEps", default=None)
    trailing_eps = safe_get(info, "epsTrailingTwelveMonths", default=None)

    growth_pct = None
    if fwd_eps and trailing_eps and trailing_eps != 0:
        growth_pct = (fwd_eps - trailing_eps) / abs(trailing_eps) * 100

    if growth_pct is None:
        earnings_growth = safe_get(info, "earningsGrowth", default=None)
        if earnings_growth is not None:
            growth_pct = earnings_growth * 100

    if growth_pct is None:
        return 5, {"eps_forecast_growth_pct": None}

    if growth_pct > 25:
        score = 10
    elif growth_pct > 20:
        score = 9
    elif growth_pct > 15:
        score = 8
    elif growth_pct > 10:
        score = 7
    elif growth_pct > 5:
        score = 5
    elif growth_pct > 0:
        score = 4
    else:
        score = 2

    return score, {
        "eps_forecast_growth_pct": round(growth_pct, 1),
        "forward_eps": fwd_eps,
        "trailing_eps": trailing_eps,
    }


def _score_order_book(sentiment: str, news_text: str) -> tuple[int, dict]:
    # Check news for order/contract mentions
    order_keywords = ["order", "contract", "win", "award", "supply", "deal", "agreement"]
    has_order_news = any(kw in news_text.lower() for kw in order_keywords) if news_text else False

    if has_order_news and sentiment == "POSITIVE":
        score = 9
    elif has_order_news:
        score = 7
    elif sentiment == "POSITIVE":
        score = 6
    else:
        score = 5  # neutral default

    return score, {"has_order_news": has_order_news, "basis": "news_analysis"}


def _score_industry_growth(sector: str) -> tuple[int, dict]:
    index_ticker = SECTOR_INDEX_MAP.get(sector)
    if not index_ticker:
        return 6, {"sector": sector, "index_3m_return_pct": None}

    hist = get_index_history(index_ticker, period="3mo")
    if hist.empty:
        return 6, {"sector": sector, "index_3m_return_pct": None}

    ret = (hist["Close"].iloc[-1] / hist["Close"].iloc[0] - 1) * 100

    if ret > 15:
        score = 10
    elif ret > 10:
        score = 8
    elif ret > 5:
        score = 7
    elif ret > 0:
        score = 6
    elif ret > -5:
        score = 4
    else:
        score = 2

    return score, {"sector": sector, "index_3m_return_pct": round(float(ret), 1)}


# Government support scores by sector (periodically updated)
SECTOR_GOV_SCORE = {
    "Defence": 10, "IT": 8, "Banking": 7, "Infrastructure": 9,
    "Energy": 8, "Auto": 7, "Pharma": 7, "FMCG": 6,
    "Metal": 6, "Cement": 7, "Financial Services": 7,
    "Healthcare": 7, "Consumer": 6, "Diversified": 5,
}


def _score_gov_tailwinds(sector: str, sentiment: str) -> tuple[int, dict]:
    base = SECTOR_GOV_SCORE.get(sector, 5)
    if sentiment == "POSITIVE":
        base = min(10, base + 1)
    return base, {"sector": sector, "policy_score": base}


def _score_innovation(info: dict, sector: str) -> tuple[int, dict]:
    # IT and Pharma get higher baseline for innovation
    high_innovation = ["IT", "Pharma", "Healthcare", "Defence"]
    base = 8 if sector in high_innovation else 5
    return base, {"sector": sector, "innovation_score": base}


def _score_expansion(sentiment: str) -> tuple[int, dict]:
    expand_score = 7 if sentiment == "POSITIVE" else 5
    return expand_score, {"news_sentiment": sentiment}


def _score_risk(info: dict) -> tuple[int, dict]:
    beta = safe_get(info, "beta", default=1.0) or 1.0
    if beta < 0.8:
        score = 10
    elif beta < 1.2:
        score = 8
    elif beta < 1.5:
        score = 6
    else:
        score = 4
    return score, {"beta": round(beta, 2)}
