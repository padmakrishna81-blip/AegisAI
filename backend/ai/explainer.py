"""AI-powered explanations and investment verdicts."""

from ai.llm_client import call_llm, is_configured

SYSTEM_PROMPT = (
    "You are an expert Indian stock market analyst with deep knowledge of NSE-listed companies. "
    "Provide concise, actionable investment analysis for Indian retail investors. "
    "Always mention key risks. Be direct and specific."
)


def generate_verdict(symbol: str, company_name: str, scores: dict) -> dict:
    """Generate AI Investment Verdict card data."""
    overall = scores.get("overall", 50)
    ch = scores.get("company_health", 50)
    gt = scores.get("growth_trend", 50)
    tech = scores.get("technical", 50)
    sector = scores.get("sector", 50)
    events = scores.get("business_events", 50)
    macro = scores.get("macro", 50)
    current_price = scores.get("current_price", 0)

    # Rule-based defaults (used when LLM not configured)
    if overall >= 85:
        action, stars, confidence = "BUY", 5, min(95, overall)
    elif overall >= 70:
        action, stars, confidence = "BUY", 4, min(85, overall)
    elif overall >= 55:
        action, stars, confidence = "HOLD", 3, min(75, overall)
    else:
        action, stars, confidence = "SELL", 2, min(65, 100 - overall)

    entry_low = round(current_price * 0.98, 1) if current_price else 0
    entry_high = round(current_price * 1.02, 1) if current_price else 0
    target = round(current_price * (1 + (overall - 50) / 200), 1) if current_price else 0
    stop_loss = round(current_price * 0.93, 1) if current_price else 0

    reasons = _get_rule_based_reasons(ch, gt, tech, sector, events, macro)
    risks = _get_rule_based_risks(ch, gt, tech, overall)

    if is_configured():
        prompt = (
            f"Analyze {company_name} ({symbol}) for an Indian investor.\n"
            f"Scores: Overall={overall}/100, Company Health={ch}/100, "
            f"Growth Trend={gt}/100, Technical={tech}/100, Sector={sector}/100, "
            f"Business Events={events}/100, Macro={macro}/100\n"
            f"Current Price: ₹{current_price}\n\n"
            f"Provide a JSON response with these exact fields:\n"
            f'{{"action":"BUY/HOLD/SELL","confidence":0-100,"entry_low":float,'
            f'"entry_high":float,"target_price":float,"stop_loss":float,'
            f'"reasons":["reason1","reason2","reason3"],'
            f'"risks":["risk1","risk2"],'
            f'"summary":"2 sentence investment thesis"}}'
        )
        try:
            import json
            raw = call_llm(prompt, system=SYSTEM_PROMPT, max_tokens=400)
            # Extract JSON
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(raw[start:end])
                return {
                    "action": data.get("action", action),
                    "stars": stars,
                    "confidence": int(data.get("confidence", confidence)),
                    "entry_range": {
                        "low": float(data.get("entry_low", entry_low)),
                        "high": float(data.get("entry_high", entry_high)),
                    },
                    "target_price": float(data.get("target_price", target)),
                    "stop_loss": float(data.get("stop_loss", stop_loss)),
                    "reasons": list(data.get("reasons", reasons))[:3],
                    "risks": list(data.get("risks", risks))[:2],
                    "summary": str(data.get("summary", "")),
                    "ai_powered": True,
                }
        except Exception:
            pass

    return {
        "action": action,
        "stars": stars,
        "confidence": confidence,
        "entry_range": {"low": entry_low, "high": entry_high},
        "target_price": target,
        "stop_loss": stop_loss,
        "reasons": reasons,
        "risks": risks,
        "summary": f"{company_name} scores {overall}/100 overall. "
                   f"{'Strong fundamentals and positive momentum suggest a buy opportunity.' if overall >= 70 else 'Mixed signals — monitor for better entry.'}",
        "ai_powered": False,
    }


def _get_rule_based_reasons(ch, gt, tech, sector, events, macro) -> list[str]:
    reasons = []
    if ch >= 80:
        reasons.append("Strong company fundamentals with healthy financials")
    elif ch >= 65:
        reasons.append("Decent company health with room for improvement")
    if gt >= 80:
        reasons.append("Strong future growth expected by analysts")
    if tech >= 75:
        reasons.append("Positive technical setup with good entry point")
    if sector >= 80:
        reasons.append("Sector tailwinds support long-term performance")
    if events >= 75:
        reasons.append("Recent business events are positive for the stock")
    if not reasons:
        reasons.append("Monitoring required before entry")
    return reasons[:3]


def _get_rule_based_risks(ch, gt, tech, overall) -> list[str]:
    risks = []
    if ch < 60:
        risks.append("Weak fundamentals pose downside risk")
    if tech < 50:
        risks.append("Bearish technical trend — momentum unfavorable")
    if gt < 55:
        risks.append("Analyst growth expectations are subdued")
    if overall < 60:
        risks.append("Overall score below threshold — capital at risk")
    if not risks:
        risks.append("General market volatility may impact short-term price")
    return risks[:2]


def generate_score_explanation(symbol: str, level: str, score: int, breakdown: dict) -> str:
    """Generate 2-3 sentence explanation for a specific score level."""
    if not is_configured():
        return _rule_based_score_explanation(level, score)

    top_items = sorted(breakdown.items(), key=lambda x: x[1].get("score", 0), reverse=True)[:3]
    top_str = ", ".join(f"{k}={v.get('score', 0)}" for k, v in top_items)

    prompt = (
        f"Explain the {level.replace('_', ' ').title()} score of {score}/100 for {symbol} "
        f"in 2-3 sentences. Top sub-scores: {top_str}. Be specific and actionable."
    )
    return call_llm(prompt, system=SYSTEM_PROMPT, max_tokens=150)


def _rule_based_score_explanation(level: str, score: int) -> str:
    quality = "excellent" if score >= 85 else "good" if score >= 70 else "moderate" if score >= 55 else "weak"
    return f"The {level.replace('_', ' ')} score of {score}/100 indicates {quality} performance in this dimension. {'This is a positive signal for investors.' if score >= 65 else 'Investors should monitor this area closely.'}"


def generate_morning_briefing(portfolio: list[dict], top_opportunities: list[dict], market_mode: str) -> dict:
    """Generate daily morning briefing."""
    best_action = None
    if top_opportunities:
        best = top_opportunities[0]
        best_action = {
            "symbol": best.get("symbol", ""),
            "action": best.get("recommendation", "HOLD"),
            "reason": best.get("reason", "Strong overall score"),
            "score": best.get("overall_score", 0),
        }

    if not is_configured():
        return {
            "best_action": best_action,
            "market_outlook": f"Market is in {market_mode} mode. Invest accordingly.",
            "portfolio_note": f"You have {len(portfolio)} holdings. Review covered call opportunities.",
            "ai_powered": False,
        }

    portfolio_summary = f"{len(portfolio)} holdings"
    opp_str = ", ".join(o.get("symbol", "") for o in top_opportunities[:3])

    prompt = (
        f"Generate a brief morning briefing for an Indian stock investor.\n"
        f"Market Mode: {market_mode}\n"
        f"Portfolio: {portfolio_summary}\n"
        f"Top opportunities today: {opp_str}\n\n"
        f"Respond with JSON: "
        f'{{"market_outlook":"2 sentences","portfolio_note":"1 sentence"}}'
    )

    try:
        import json
        raw = call_llm(prompt, system=SYSTEM_PROMPT, max_tokens=200)
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(raw[start:end])
            return {
                "best_action": best_action,
                "market_outlook": data.get("market_outlook", ""),
                "portfolio_note": data.get("portfolio_note", ""),
                "ai_powered": True,
            }
    except Exception:
        pass

    return {
        "best_action": best_action,
        "market_outlook": f"Market is in {market_mode} mode.",
        "portfolio_note": "Review your holdings and covered call opportunities.",
        "ai_powered": False,
    }
