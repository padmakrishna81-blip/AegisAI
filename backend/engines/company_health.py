"""Level 1 — Company Health Score (0-100).

Weights: Revenue Growth 15, Profit Growth 15, Margins 10, Cash Flow 10,
Debt 10, Efficiency 10, Valuation 10, Institutional Interest 10,
Management 5, Business Quality 5.
"""

from data.market_data import (
    get_info, get_financials, get_balance_sheet, get_cashflow,
    get_recommendations, get_dataframe_row, pct_change, safe_get
)


def calculate(symbol: str) -> dict:
    info = get_info(symbol)
    financials = get_financials(symbol)
    balance_sheet = get_balance_sheet(symbol)
    cashflow = get_cashflow(symbol)
    recommendations = get_recommendations(symbol)

    breakdown = {}

    # 1. Revenue Growth (weight 15)
    rev_row = get_dataframe_row(financials, "Total Revenue")
    rev_score, rev_details = _score_revenue_growth(info, rev_row)
    breakdown["revenue_growth"] = {"score": rev_score, "weight": 15, "details": rev_details}

    # 2. Profit Growth (weight 15)
    ni_row = get_dataframe_row(financials, "Net Income")
    profit_score, profit_details = _score_profit_growth(info, ni_row)
    breakdown["profit_growth"] = {"score": profit_score, "weight": 15, "details": profit_details}

    # 3. Margins (weight 10)
    margin_score, margin_details = _score_margins(info)
    breakdown["margins"] = {"score": margin_score, "weight": 10, "details": margin_details}

    # 4. Cash Flow (weight 10)
    fcf_row = get_dataframe_row(cashflow, "Free Cash Flow")
    ocf_row = get_dataframe_row(cashflow, "Operating Cash Flow")
    cf_score, cf_details = _score_cash_flow(info, fcf_row, ocf_row)
    breakdown["cash_flow"] = {"score": cf_score, "weight": 10, "details": cf_details}

    # 5. Debt (weight 10)
    debt_score, debt_details = _score_debt(info)
    breakdown["debt"] = {"score": debt_score, "weight": 10, "details": debt_details}

    # 6. Efficiency (weight 10)
    eff_score, eff_details = _score_efficiency(info)
    breakdown["efficiency"] = {"score": eff_score, "weight": 10, "details": eff_details}

    # 7. Valuation (weight 10)
    val_score, val_details = _score_valuation(info)
    breakdown["valuation"] = {"score": val_score, "weight": 10, "details": val_details}

    # 8. Institutional Interest (weight 10)
    inst_score, inst_details = _score_institutional(info, recommendations)
    breakdown["institutional_interest"] = {"score": inst_score, "weight": 10, "details": inst_details}

    # 9. Management (weight 5)
    mgmt_score, mgmt_details = _score_management(info)
    breakdown["management"] = {"score": mgmt_score, "weight": 5, "details": mgmt_details}

    # 10. Business Quality (weight 5)
    bq_score, bq_details = _score_business_quality(info)
    breakdown["business_quality"] = {"score": bq_score, "weight": 5, "details": bq_details}

    # Weighted final score: each sub-score is 0-10, weighted sum / 10 → 0-100
    total = sum(v["score"] * v["weight"] for v in breakdown.values())
    final_score = min(100, max(0, round(total / 10)))

    return {"score": final_score, "breakdown": breakdown}


def _score_revenue_growth(info: dict, rev_row) -> tuple[int, dict]:
    growth = safe_get(info, "revenueGrowth", default=None)
    growth_pct = (growth * 100) if growth is not None else None

    # Try to compute from financials
    if growth_pct is None and rev_row is not None:
        vals = [v for v in rev_row.values if v and v > 0]
        if len(vals) >= 2:
            growth_pct = pct_change(vals[0], vals[1])

    score = _growth_score(growth_pct)
    return score, {"ttm_growth_pct": round(growth_pct, 1) if growth_pct is not None else None,
                   "trend": "positive" if (growth_pct or 0) > 0 else "negative"}


def _score_profit_growth(info: dict, ni_row) -> tuple[int, dict]:
    earnings_growth = safe_get(info, "earningsGrowth", default=None)
    growth_pct = (earnings_growth * 100) if earnings_growth is not None else None

    if growth_pct is None and ni_row is not None:
        vals = [v for v in ni_row.values if v is not None]
        if len(vals) >= 2 and vals[1] != 0:
            growth_pct = pct_change(vals[0], vals[1])

    score = _growth_score(growth_pct)
    net_margin = safe_get(info, "profitMargins", default=None)
    return score, {
        "net_income_growth_pct": round(growth_pct, 1) if growth_pct is not None else None,
        "quarterly_growth_pct": round(safe_get(info, "earningsQuarterlyGrowth", default=0) * 100, 1),
        "net_margin_pct": round((net_margin or 0) * 100, 1),
    }


def _score_margins(info: dict) -> tuple[int, dict]:
    gross = safe_get(info, "grossMargins", default=0) or 0
    operating = safe_get(info, "operatingMargins", default=0) or 0
    net = safe_get(info, "profitMargins", default=0) or 0

    def margin_to_score(m):
        m_pct = m * 100
        if m_pct > 30:
            return 10
        elif m_pct > 20:
            return 8
        elif m_pct > 10:
            return 6
        elif m_pct > 5:
            return 4
        return 2

    score = round((margin_to_score(gross) + margin_to_score(operating) + margin_to_score(net)) / 3)
    return score, {
        "gross_margin_pct": round(gross * 100, 1),
        "operating_margin_pct": round(operating * 100, 1),
        "net_margin_pct": round(net * 100, 1),
    }


def _score_cash_flow(info: dict, fcf_row, ocf_row) -> tuple[int, dict]:
    fcf = safe_get(info, "freeCashflow", default=None)
    market_cap = safe_get(info, "marketCap", default=None)

    if fcf is None and fcf_row is not None:
        vals = [v for v in fcf_row.values if v is not None]
        fcf = vals[0] if vals else None

    fcf_yield = None
    if fcf and market_cap and market_cap > 0:
        fcf_yield = fcf / market_cap * 100

    if fcf_yield is not None:
        if fcf_yield > 5:
            score = 10
        elif fcf_yield > 3:
            score = 8
        elif fcf_yield > 1:
            score = 6
        elif fcf_yield > 0:
            score = 4
        else:
            score = 2
    else:
        score = 5  # neutral when data unavailable

    return score, {
        "free_cash_flow": fcf,
        "fcf_yield_pct": round(fcf_yield, 2) if fcf_yield is not None else None,
        "fcf_positive": (fcf or 0) > 0,
    }


def _score_debt(info: dict) -> tuple[int, dict]:
    de = safe_get(info, "debtToEquity", default=None)
    current_ratio = safe_get(info, "currentRatio", default=None)
    quick_ratio = safe_get(info, "quickRatio", default=None)

    if de is not None:
        # yfinance returns D/E as percentage sometimes (e.g., 45.2 means 0.452)
        de_norm = de / 100 if de > 10 else de
        if de_norm < 0.3:
            score = 10
        elif de_norm < 0.5:
            score = 8
        elif de_norm < 1.0:
            score = 6
        elif de_norm < 2.0:
            score = 4
        else:
            score = 2
    else:
        score = 5

    # Bonus for strong liquidity
    if current_ratio and current_ratio > 2:
        score = min(10, score + 1)
    elif current_ratio and current_ratio < 1:
        score = max(1, score - 1)

    return score, {
        "debt_to_equity": round(de, 2) if de is not None else None,
        "current_ratio": round(current_ratio, 2) if current_ratio is not None else None,
        "quick_ratio": round(quick_ratio, 2) if quick_ratio is not None else None,
    }


def _score_efficiency(info: dict) -> tuple[int, dict]:
    roe = safe_get(info, "returnOnEquity", default=None)
    roa = safe_get(info, "returnOnAssets", default=None)

    def ratio_score(val):
        if val is None:
            return 5
        pct = val * 100
        if pct > 25:
            return 10
        elif pct > 20:
            return 9
        elif pct > 15:
            return 8
        elif pct > 10:
            return 6
        elif pct > 5:
            return 4
        return 2

    score = round((ratio_score(roe) + ratio_score(roa)) / 2)
    return score, {
        "roe_pct": round((roe or 0) * 100, 1),
        "roa_pct": round((roa or 0) * 100, 1),
    }


def _score_valuation(info: dict) -> tuple[int, dict]:
    pe = safe_get(info, "trailingPE", default=None)
    fpe = safe_get(info, "forwardPE", default=None)
    peg = safe_get(info, "pegRatio", default=None)
    ev_ebitda = safe_get(info, "enterpriseToEbitda", default=None)
    pb = safe_get(info, "priceToBook", default=None)

    if pe is not None and pe > 0:
        if pe < 15:
            score = 10
        elif pe < 25:
            score = 8
        elif pe < 35:
            score = 6
        elif pe < 50:
            score = 4
        else:
            score = 2
    else:
        score = 5

    # PEG bonus/penalty
    if peg is not None:
        if peg < 1:
            score = min(10, score + 1)
        elif peg > 2:
            score = max(1, score - 1)

    # Forward PE growing earnings bonus
    if pe and fpe and fpe < pe:
        score = min(10, score + 1)

    return score, {
        "trailing_pe": round(pe, 1) if pe else None,
        "forward_pe": round(fpe, 1) if fpe else None,
        "price_to_book": round(pb, 1) if pb else None,
        "peg_ratio": round(peg, 2) if peg else None,
        "ev_ebitda": round(ev_ebitda, 1) if ev_ebitda else None,
    }


def _score_institutional(info: dict, recommendations) -> tuple[int, dict]:
    inst_pct = safe_get(info, "heldPercentInstitutions", default=0) or 0
    insider_pct = safe_get(info, "heldPercentInsiders", default=0) or 0

    if inst_pct > 0.5:
        score = 9
    elif inst_pct > 0.3:
        score = 7
    elif inst_pct > 0.1:
        score = 5
    else:
        score = 3

    # Analyst consensus
    buy_ratio = 0
    analyst_count = 0
    try:
        rec_mean = safe_get(info, "recommendationMean", default=3.0) or 3.0
        analyst_count = safe_get(info, "numberOfAnalystOpinions", default=0) or 0
        # 1=strong buy, 5=strong sell
        if rec_mean <= 1.5:
            buy_ratio = 0.9
        elif rec_mean <= 2.0:
            buy_ratio = 0.75
        elif rec_mean <= 2.5:
            buy_ratio = 0.6
        elif rec_mean <= 3.0:
            buy_ratio = 0.45
        else:
            buy_ratio = 0.3
        if buy_ratio > 0.6 and analyst_count > 3:
            score = min(10, score + 1)
    except Exception:
        pass

    return score, {
        "institutional_pct": round(inst_pct * 100, 1),
        "insider_pct": round(insider_pct * 100, 1),
        "analyst_buy_ratio": round(buy_ratio, 2),
        "analyst_count": analyst_count,
    }


def _score_management(info: dict) -> tuple[int, dict]:
    audit = safe_get(info, "auditRisk", default=5) or 5
    board = safe_get(info, "boardRisk", default=5) or 5
    comp = safe_get(info, "compensationRisk", default=5) or 5
    overall = safe_get(info, "overallRisk", default=5) or 5

    avg_risk = (audit + board + comp + overall) / 4
    if avg_risk <= 3:
        score = 10
    elif avg_risk <= 5:
        score = 7
    elif avg_risk <= 7:
        score = 5
    else:
        score = 2

    return score, {
        "audit_risk": audit,
        "board_risk": board,
        "compensation_risk": comp,
        "overall_risk": overall,
    }


def _score_business_quality(info: dict) -> tuple[int, dict]:
    beta = safe_get(info, "beta", default=1.0) or 1.0
    w52_change = safe_get(info, "52WeekChange", default=0) or 0
    sp52 = safe_get(info, "SandP52WeekChange", default=0) or 0

    # Beta sweet spot 0.5-1.2
    if 0.5 <= beta <= 1.2:
        score = 10
    elif beta < 0.5:
        score = 7  # defensive
    elif beta <= 1.5:
        score = 6
    else:
        score = 4  # too volatile

    # Alpha bonus
    alpha = w52_change - sp52
    if alpha > 0.1:  # 10% outperformance
        score = min(10, score + 1)

    return score, {
        "beta": round(beta, 2),
        "week52_change_pct": round(w52_change * 100, 1),
        "alpha_vs_sp500": round(alpha * 100, 1),
    }


def _growth_score(growth_pct) -> int:
    """Convert growth percentage to 0-10 score."""
    if growth_pct is None:
        return 5
    if growth_pct > 25:
        return 10
    elif growth_pct > 20:
        return 9
    elif growth_pct > 15:
        return 8
    elif growth_pct > 10:
        return 7
    elif growth_pct > 5:
        return 6
    elif growth_pct > 0:
        return 4
    elif growth_pct > -5:
        return 2
    return 1
