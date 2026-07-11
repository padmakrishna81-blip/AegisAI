"""Level 5 — Business Events Score (0-100).

Weights: Quarterly Results 20, Board Guidance 15, Corporate Announcements 10,
Gov Policy 10, Analyst Revisions 10, News Sentiment 10, Management Actions 10,
Industry Events 5, Global Events 5, Event Risk 5.
"""

from data.market_data import get_info, get_recommendations, safe_get
from data.news_fetcher import fetch_stock_news, extract_news_text
from ai.llm_client import classify_sentiment


def calculate(symbol: str) -> dict:
    info = get_info(symbol)
    news = fetch_stock_news(symbol)
    news_text = extract_news_text(news)
    sentiment = classify_sentiment(news_text) if news_text else "NEUTRAL"
    recommendations = get_recommendations(symbol)

    breakdown = {}

    s1, d1 = _score_quarterly_results(info)
    breakdown["quarterly_results"] = {"score": s1, "weight": 20, "details": d1}

    s2, d2 = _score_board_guidance(info, sentiment)
    breakdown["board_guidance"] = {"score": s2, "weight": 15, "details": d2}

    s3, d3 = _score_corporate_announcements(news_text, sentiment)
    breakdown["corporate_announcements"] = {"score": s3, "weight": 10, "details": d3}

    s4, d4 = _score_gov_policy(news_text, sentiment)
    breakdown["gov_policy"] = {"score": s4, "weight": 10, "details": d4}

    s5, d5 = _score_analyst_revisions(recommendations, info)
    breakdown["analyst_revisions"] = {"score": s5, "weight": 10, "details": d5}

    s6, d6 = _score_news_sentiment(sentiment, len(news))
    breakdown["news_sentiment"] = {"score": s6, "weight": 10, "details": d6}

    s7, d7 = _score_management_actions(info, news_text)
    breakdown["management_actions"] = {"score": s7, "weight": 10, "details": d7}

    s8, d8 = _score_industry_events(sentiment, news_text)
    breakdown["industry_events"] = {"score": s8, "weight": 5, "details": d8}

    s9, d9 = _score_global_events()
    breakdown["global_events"] = {"score": s9, "weight": 5, "details": d9}

    s10, d10 = _score_event_risk(info, news_text)
    breakdown["entry_timing"] = {"score": s10, "weight": 5, "details": d10}

    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    return {
        "score": final_score,
        "breakdown": breakdown,
        "recent_news": [{"title": n.get("title", ""), "source": n.get("source", "")} for n in news[:5]],
    }


def _score_quarterly_results(info: dict) -> tuple[int, dict]:
    earnings_surprise = safe_get(info, "earningsSurprisePercent", default=None)
    qoq_growth = safe_get(info, "earningsQuarterlyGrowth", default=None)

    if earnings_surprise is not None:
        surprise_pct = earnings_surprise * 100 if abs(earnings_surprise) < 10 else earnings_surprise
        if surprise_pct > 10:
            score = 10
        elif surprise_pct > 5:
            score = 9
        elif surprise_pct > 0:
            score = 7
        elif surprise_pct > -5:
            score = 5
        else:
            score = 3
    elif qoq_growth is not None:
        pct = qoq_growth * 100
        if pct > 20:
            score = 10
        elif pct > 10:
            score = 8
        elif pct > 0:
            score = 6
        else:
            score = 3
    else:
        score = 6  # neutral when data unavailable

    return score, {
        "earnings_surprise_pct": earnings_surprise,
        "qoq_growth_pct": round((qoq_growth or 0) * 100, 1),
    }


def _score_board_guidance(info: dict, sentiment: str) -> tuple[int, dict]:
    rec_mean = safe_get(info, "recommendationMean", default=3.0) or 3.0

    if sentiment == "POSITIVE" and rec_mean <= 2.0:
        score = 9
    elif sentiment == "POSITIVE":
        score = 7
    elif sentiment == "NEUTRAL":
        score = 6
    else:
        score = 4

    return score, {"sentiment": sentiment, "rec_mean": round(rec_mean, 2)}


def _score_corporate_announcements(news_text: str, sentiment: str) -> tuple[int, dict]:
    positive_kws = ["order", "contract", "win", "award", "partnership", "acquisition",
                    "expansion", "launch", "buyback", "dividend", "record", "milestone"]
    negative_kws = ["fraud", "probe", "default", "penalty", "resign", "lawsuit",
                    "writeoff", "closure", "downgrade"]

    nt_lower = news_text.lower() if news_text else ""
    pos_count = sum(1 for kw in positive_kws if kw in nt_lower)
    neg_count = sum(1 for kw in negative_kws if kw in nt_lower)

    if pos_count >= 3 and neg_count == 0:
        score = 9
    elif pos_count >= 2 and neg_count <= 1:
        score = 7
    elif neg_count >= 2:
        score = 3
    elif neg_count == 1:
        score = 5
    else:
        score = 6

    return score, {"positive_signals": pos_count, "negative_signals": neg_count}


def _score_gov_policy(news_text: str, sentiment: str) -> tuple[int, dict]:
    policy_kws = ["budget", "policy", "government", "ministry", "pli", "scheme",
                  "regulation", "rbi", "sebi", "tax", "gst"]
    nt_lower = news_text.lower() if news_text else ""
    has_policy = any(kw in nt_lower for kw in policy_kws)

    if has_policy and sentiment == "POSITIVE":
        score = 8
    elif has_policy and sentiment == "NEUTRAL":
        score = 6
    elif has_policy and sentiment == "NEGATIVE":
        score = 4
    else:
        score = 6  # no policy news = neutral

    return score, {"has_policy_news": has_policy}


def _score_analyst_revisions(recommendations, info: dict) -> tuple[int, dict]:
    target = safe_get(info, "targetMeanPrice", default=None)
    current = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=0)

    upside = None
    if target and current and current > 0:
        upside = (target - current) / current * 100

    rec_mean = safe_get(info, "recommendationMean", default=3.0) or 3.0

    if upside and upside > 20:
        score = 10
    elif upside and upside > 10:
        score = 8
    elif upside and upside > 0:
        score = 6
    elif rec_mean <= 2.0:
        score = 7
    else:
        score = 5

    return score, {
        "target_price": round(target, 1) if target else None,
        "current_price": round(current, 1) if current else None,
        "upside_pct": round(upside, 1) if upside else None,
    }


def _score_news_sentiment(sentiment: str, news_count: int) -> tuple[int, dict]:
    if sentiment == "POSITIVE":
        score = 9 if news_count > 5 else 7
    elif sentiment == "NEGATIVE":
        score = 3 if news_count > 5 else 4
    else:
        score = 6

    return score, {"sentiment": sentiment, "news_count": news_count}


def _score_management_actions(info: dict, news_text: str) -> tuple[int, dict]:
    insider_pct = safe_get(info, "heldPercentInsiders", default=0) or 0
    nt_lower = news_text.lower() if news_text else ""

    buyback_kws = ["buyback", "buy back", "repurchase", "promoter buying", "insider buy"]
    red_flags = ["ceo resign", "cfo resign", "promoter selling", "pledge", "fraud"]

    has_positive = any(kw in nt_lower for kw in buyback_kws)
    has_negative = any(kw in nt_lower for kw in red_flags)

    if has_positive and not has_negative:
        score = 9
    elif has_negative:
        score = 3
    elif insider_pct > 0.4:
        score = 8  # high promoter holding = alignment
    elif insider_pct > 0.2:
        score = 7
    else:
        score = 6

    return score, {
        "insider_holding_pct": round(insider_pct * 100, 1),
        "positive_actions": has_positive,
        "red_flags": has_negative,
    }


def _score_industry_events(sentiment: str, news_text: str) -> tuple[int, dict]:
    nt_lower = news_text.lower() if news_text else ""
    sector_kws = ["sector", "industry", "market", "trend", "demand", "supply", "export"]
    has_sector_news = any(kw in nt_lower for kw in sector_kws)

    if has_sector_news and sentiment == "POSITIVE":
        score = 8
    elif has_sector_news:
        score = 6
    else:
        score = 5
    return score, {"has_sector_news": has_sector_news}


def _score_global_events() -> tuple[int, dict]:
    # Static moderate score (requires real-time macro data for dynamic scoring)
    return 6, {"note": "Global events moderately favorable"}


def _score_event_risk(info: dict, news_text: str) -> tuple[int, dict]:
    """
    Score how calm the event calendar is RIGHT NOW.
    High score (9-10) = No major events upcoming = SAFE to enter.
    Low score (4-6) = Results / AGM / announcement coming = caution before entering.
    This is an OPPORTUNITY score, NOT a danger percentage.
    """
    nt_lower = news_text.lower() if news_text else ""
    risk_kws = ["result", "earnings", "agm", "board meeting", "quarterly", "announcement"]
    has_upcoming = any(kw in nt_lower for kw in risk_kws)

    if has_upcoming:
        score = 6   # upcoming event → some uncertainty, lower entry confidence
        label = "Upcoming event — wait for clarity"
        entry_advice = "Consider waiting until after the event before entering"
    else:
        score = 9   # no event risk → clean entry window
        label = "No major events — clean entry window"
        entry_advice = "No scheduled events creating uncertainty"

    return score, {
        "upcoming_events": has_upcoming,
        "meaning": label,
        "entry_advice": entry_advice,
        "note": "Higher score = SAFER to enter (fewer upcoming surprises). Lower score = wait for event to pass.",
    }
