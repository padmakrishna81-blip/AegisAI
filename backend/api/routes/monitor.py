"""Monitor endpoints — quarterly business tracker for Indian and Global stocks."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List

router = APIRouter()


# ── Request models ─────────────────────────────────────────────────────────────

class AddStockBody(BaseModel):
    section: str          # "indian" | "global"
    symbol: str
    name: str
    sector: Optional[str] = ""
    exchange: Optional[str] = ""

class QuarterBody(BaseModel):
    section: str
    symbol: str
    quarter: str          # e.g. "Q1FY27"
    kpis: Optional[dict] = {}
    notes: Optional[str] = ""

class KpiLabelsBody(BaseModel):
    section: str
    symbol: str
    labels: List[str]


# ── Helpers ────────────────────────────────────────────────────────────────────

def _quarter_label(date_str: str) -> str:
    """Convert a date like '2026-06-30' to 'Q1FY27'."""
    try:
        from datetime import datetime
        d = datetime.fromisoformat(str(date_str)[:10])
        # Indian FY: Apr-Jun=Q1, Jul-Sep=Q2, Oct-Dec=Q3, Jan-Mar=Q4
        m = d.month
        fy = d.year + 1 if m >= 4 else d.year
        q = {4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 1: 4, 2: 4, 3: 4}[m]
        return f"Q{q}FY{str(fy)[2:]}"
    except Exception:
        return str(date_str)[:10]


def _safe_float(val) -> Optional[float]:
    try:
        return round(float(val), 2)
    except Exception:
        return None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/monitor/list")
async def monitor_list():
    from data.monitor_store import load
    return JSONResponse(content=load())


@router.post("/monitor/add")
async def monitor_add(body: AddStockBody):
    if body.section not in ("indian", "global"):
        raise HTTPException(status_code=400, detail="section must be 'indian' or 'global'")
    from data.monitor_store import add_stock
    data = add_stock(body.section, {
        "symbol":   body.symbol.upper().strip(),
        "name":     body.name,
        "sector":   body.sector or "",
        "exchange": body.exchange or "",
    })
    return JSONResponse(content=data)


@router.delete("/monitor/{section}/{symbol}")
async def monitor_remove(section: str, symbol: str):
    if section not in ("indian", "global"):
        raise HTTPException(status_code=400, detail="section must be 'indian' or 'global'")
    from data.monitor_store import remove_stock
    data = remove_stock(section, symbol.upper())
    return JSONResponse(content=data)


@router.get("/monitor/financials/{symbol}")
async def monitor_financials(symbol: str):
    """Fetch last 4 quarters of financials via yfinance quarterly_financials."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def _fetch():
        import yfinance as yf
        sym = symbol.upper()
        if "." not in sym and not sym.startswith("^"):
            sym += ".NS"

        t = yf.Ticker(sym)
        info = t.info or {}
        is_indian = sym.endswith(".NS")

        # Quarterly income statement
        try:
            qf = t.quarterly_financials
        except Exception:
            qf = None

        # Quarterly balance sheet for debt
        try:
            qbs = t.quarterly_balance_sheet
        except Exception:
            qbs = None

        quarters = []
        if qf is not None and not qf.empty:
            for col in list(qf.columns)[:4]:  # last 4 quarters, newest first
                label = _quarter_label(str(col)[:10])
                row: dict = {"label": label, "date": str(col)[:10]}

                def _get(df, *names):
                    if df is None or df.empty:
                        return None
                    for name in names:
                        for idx in df.index:
                            if name.lower() in str(idx).lower():
                                try:
                                    v = df.loc[idx, col]
                                    if v is not None and str(v) not in ("nan", "None", ""):
                                        return float(v)
                                except Exception:
                                    pass
                    return None

                rev = _get(qf, "Total Revenue", "Revenue")
                pat = _get(qf, "Net Income")
                gross_profit = _get(qf, "Gross Profit")
                operating_income = _get(qf, "Operating Income", "EBIT")
                eps = _safe_float(info.get("trailingEps")) if len(quarters) == 0 else None

                if is_indian:
                    # Convert to crores (divide by 1e7)
                    row["revenue_cr"] = round(rev / 1e7, 2) if rev else None
                    row["pat_cr"]     = round(pat / 1e7, 2) if pat else None
                else:
                    # USD millions (divide by 1e6)
                    row["revenue_m"]  = round(rev / 1e6, 2) if rev else None
                    row["pat_m"]      = round(pat / 1e6, 2) if pat else None

                row["gross_margin_pct"] = round(gross_profit / rev * 100, 1) if gross_profit and rev else None
                row["op_margin_pct"]    = round(operating_income / rev * 100, 1) if operating_income and rev else None
                row["net_margin_pct"]   = round(pat / rev * 100, 1) if pat and rev else None
                row["eps"]              = eps

                quarters.append(row)

        # If yfinance has no quarterly data, fall back to info fields
        if not quarters:
            quarters = [{
                "label":          "TTM",
                "date":           None,
                "revenue_cr":     round(float(info["totalRevenue"]) / 1e7, 2) if is_indian and info.get("totalRevenue") else None,
                "revenue_m":      round(float(info["totalRevenue"]) / 1e6, 2) if not is_indian and info.get("totalRevenue") else None,
                "pat_cr":         round(float(info["netIncomeToCommon"]) / 1e7, 2) if is_indian and info.get("netIncomeToCommon") else None,
                "pat_m":          round(float(info["netIncomeToCommon"]) / 1e6, 2) if not is_indian and info.get("netIncomeToCommon") else None,
                "gross_margin_pct": round(float(info["grossMargins"]) * 100, 1) if info.get("grossMargins") else None,
                "op_margin_pct":  round(float(info["operatingMargins"]) * 100, 1) if info.get("operatingMargins") else None,
                "net_margin_pct": round(float(info["profitMargins"]) * 100, 1) if info.get("profitMargins") else None,
                "eps":            _safe_float(info.get("trailingEps")),
            }]

        return {
            "symbol":     symbol.upper(),
            "is_indian":  is_indian,
            "currency":   "INR" if is_indian else (info.get("currency") or "USD"),
            "quarters":   quarters,
        }

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), _fetch)
    return JSONResponse(content=result)


@router.post("/monitor/quarter")
async def monitor_upsert_quarter(body: QuarterBody):
    if body.section not in ("indian", "global"):
        raise HTTPException(status_code=400, detail="section must be 'indian' or 'global'")
    from data.monitor_store import upsert_quarter
    data = upsert_quarter(body.section, body.symbol.upper(), body.quarter, {
        "kpis":  body.kpis or {},
        "notes": body.notes or "",
    })
    return JSONResponse(content=data)


@router.put("/monitor/kpi-labels")
async def monitor_update_kpi_labels(body: KpiLabelsBody):
    if body.section not in ("indian", "global"):
        raise HTTPException(status_code=400, detail="section must be 'indian' or 'global'")
    from data.monitor_store import update_kpi_labels
    data = update_kpi_labels(body.section, body.symbol.upper(), body.labels)
    return JSONResponse(content=data)


@router.get("/monitor/outlook/{symbol}")
async def monitor_outlook(symbol: str):
    """Fetch recent news and tag by category — rule-based, no LLM."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    TAGS = {
        "results":    ["result", "earnings", "profit", "revenue", "quarterly", "q1", "q2", "q3", "q4", "pat", "ebitda"],
        "order":      ["order", "contract", "win", "award", "deal", "agreement", "tender", "bid"],
        "expansion":  ["expansion", "capacity", "plant", "new facility", "launch", "enters", "opens", "greenfield"],
        "guidance":   ["guidance", "outlook", "forecast", "targets", "expects", "projected", "pipeline"],
        "management": ["ceo", "cfo", "appoints", "resigns", "board", "agm", "promoter", "insider"],
        "policy":     ["government", "ministry", "pli", "budget", "rbi", "sebi", "regulation", "policy"],
        "global":     ["us", "global", "international", "export", "fed", "dollar", "crude", "tariff"],
    }

    def _tag(title: str) -> str:
        tl = title.lower()
        for tag, kws in TAGS.items():
            if any(k in tl for k in kws):
                return tag
        return "general"

    def _fetch():
        import yfinance as yf
        from datetime import datetime, timezone
        sym = symbol.upper()
        if "." not in sym and not sym.startswith("^"):
            sym += ".NS"
        try:
            raw = yf.Ticker(sym).news or []
        except Exception:
            raw = []

        now_ts = datetime.now(timezone.utc).timestamp()
        items = []
        for n in raw[:15]:
            title = n.get("title", "")
            pub   = n.get("providerPublishTime") or n.get("published", 0)
            age_d = (now_ts - pub) / 86400 if pub else 999
            if age_d > 45:
                continue
            items.append({
                "title":     title,
                "source":    n.get("publisher", ""),
                "link":      n.get("link", ""),
                "published": pub,
                "tag":       _tag(title),
            })

        # Build a short summary from top 3 unique tags
        seen_tags = set()
        summary_lines = []
        for item in items:
            if item["tag"] not in seen_tags and len(summary_lines) < 3:
                seen_tags.add(item["tag"])
                summary_lines.append(f"[{item['tag'].upper()}] {item['title'][:80]}")

        return {
            "symbol":   symbol.upper(),
            "headlines": items[:8],
            "summary":  " · ".join(summary_lines) if summary_lines else "No recent news found.",
        }

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), _fetch)
    return JSONResponse(content=result)
