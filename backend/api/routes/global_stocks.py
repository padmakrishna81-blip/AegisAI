"""Global stocks — search NASDAQ/NYSE/XETRA, store watchlist, fetch live prices."""

import json
import os
from datetime import datetime, timezone
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from api.utils import clean_for_json

def _news_sentiment(text: str) -> str:
    """Rule-based sentiment: positive / negative / neutral."""
    t = text.lower()
    pos = ["beat", "beats", "record", "growth", "profit", "surge", "rally", "upgrade",
           "strong", "raise", "raised", "exceed", "exceeds", "outperform", "buy",
           "bullish", "wins", "gain", "gains", "breakthrough", "partnership", "deal",
           "dividend", "buyback", "expansion", "revenue growth", "earnings beat",
           "all-time high", "new high", "positive", "recovery", "momentum"]
    neg = ["miss", "misses", "loss", "losses", "drop", "drops", "fell", "fall",
           "decline", "declines", "cut", "cuts", "downgrade", "downgraded", "sell",
           "bearish", "warn", "warning", "weak", "layoff", "layoffs", "sue", "sues",
           "fraud", "investigation", "recall", "disappoints", "below expectations",
           "profit warning", "revenue miss", "debt", "bankruptcy", "concern", "risk",
           "negative", "slump", "crash", "halt", "suspend", "fine", "penalty"]
    pos_score = sum(1 for w in pos if w in t)
    neg_score = sum(1 for w in neg if w in t)
    if pos_score > neg_score:
        return "positive"
    if neg_score > pos_score:
        return "negative"
    return "neutral"


router = APIRouter()

_STORE_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "global_stocks.json")

# Exchange code → display name mapping
_EXCHANGE_MAP = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NIM": "NASDAQ",
    "NYQ": "NYSE",   "PCX": "NYSE",   "ASE": "NYSE",
    "GER": "XETRA",  "FRA": "Frankfurt", "BER": "Berlin",
    "HAM": "Hamburg", "MUN": "Munich",
}
_ALLOWED_EXCHANGES = set(_EXCHANGE_MAP.keys())


def _load_store() -> list[dict]:
    if os.path.exists(_STORE_FILE):
        try:
            with open(_STORE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _save_store(items: list[dict]) -> None:
    with open(_STORE_FILE, "w") as f:
        json.dump(items, f, indent=2)


def _fetch_price(symbol: str) -> dict:
    import yfinance as yf
    try:
        t = yf.Ticker(symbol)
        fi = t.fast_info
        price = getattr(fi, "last_price", None)
        prev  = getattr(fi, "previous_close", None)
        currency = getattr(fi, "currency", None)
        if price is None or prev is None:
            hist = t.history(period="2d")
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
                prev  = float(hist["Close"].iloc[-2]) if len(hist) >= 2 else price
        price = round(float(price), 2) if price else None
        prev  = round(float(prev),  2) if prev  else None
        change     = round(price - prev, 2)      if price and prev else None
        change_pct = round((price / prev - 1) * 100, 2) if price and prev else None
        return {
            "price": price,
            "prev_close": prev,
            "change": change,
            "change_pct": change_pct,
            "currency": currency or "USD",
            "direction": "up" if (change or 0) >= 0 else "down",
        }
    except Exception as e:
        return {"price": None, "prev_close": None, "change": None,
                "change_pct": None, "currency": "USD", "direction": "flat", "error": str(e)[:60]}


@router.get("/global-stocks/search")
async def search_global_stocks(q: str):
    """Search NASDAQ/NYSE/XETRA stocks by name or symbol (min 3 chars)."""
    if len(q.strip()) < 3:
        return JSONResponse(content={"results": []})
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import yfinance as yf

    def do_search():
        try:
            s = yf.Search(q.strip(), max_results=20)
            results = []
            for r in s.quotes:
                ex = r.get("exchange", "")
                if r.get("quoteType") != "EQUITY" or ex not in _ALLOWED_EXCHANGES:
                    continue
                results.append({
                    "symbol":   r.get("symbol", ""),
                    "name":     r.get("shortname") or r.get("longname", ""),
                    "exchange": _EXCHANGE_MAP.get(ex, ex),
                    "exchange_code": ex,
                    "sector":   r.get("sectorDisp", ""),
                })
            return results[:8]
        except Exception:
            return []

    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), do_search)
    return JSONResponse(content={"results": results})


@router.get("/global-stocks/list")
async def list_global_stocks():
    """Return stored global stocks watchlist with refreshed prices."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    items = _load_store()
    if not items:
        return JSONResponse(content={"stocks": []})

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=8)

    async def enrich(item):
        prices = await loop.run_in_executor(executor, _fetch_price, item["symbol"])
        return {**item, **prices}

    enriched = await asyncio.gather(*[enrich(i) for i in items])
    return JSONResponse(content=clean_for_json({"stocks": list(enriched)}))


@router.post("/global-stocks/add")
async def add_global_stock(body: dict):
    """Add a stock to the global stocks watchlist."""
    symbol = (body.get("symbol") or "").strip().upper()
    name   = (body.get("name") or symbol).strip()
    exchange = (body.get("exchange") or "").strip()
    sector   = (body.get("sector") or "").strip()
    if not symbol:
        return JSONResponse(content={"error": "symbol required"}, status_code=400)

    items = _load_store()
    if any(s["symbol"] == symbol for s in items):
        return JSONResponse(content={"message": "Already in watchlist"})

    items.append({"symbol": symbol, "name": name, "exchange": exchange, "sector": sector})
    _save_store(items)
    return JSONResponse(content={"message": f"{symbol} added", "count": len(items)})


@router.delete("/global-stocks/{symbol}")
async def remove_global_stock(symbol: str):
    """Remove a stock from the global stocks watchlist."""
    items = _load_store()
    items = [s for s in items if s["symbol"] != symbol.upper()]
    _save_store(items)
    return JSONResponse(content={"message": f"{symbol} removed", "count": len(items)})


@router.get("/global-stocks/refresh")
async def refresh_global_stocks():
    """Refresh prices for all stored global stocks."""
    return await list_global_stocks()


@router.get("/global-stocks/{symbol}/detail")
async def global_stock_detail(symbol: str):
    """Get detailed info for a global stock: news, analyst expectations, earnings date, 3-year targets."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import yfinance as yf

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=4)

    def fetch_detail():
        t = yf.Ticker(symbol)
        result = {
            "symbol": symbol,
            "name": "",
            "news": [],
            "analyst": None,
            "earnings_date": None,
            "year_end_targets": None,
        }

        # --- Info & Analyst data ---
        try:
            info = t.info or {}
            result["name"] = info.get("shortName") or info.get("longName") or symbol
            current_price = info.get("currentPrice") or info.get("regularMarketPrice")
            target_mean = info.get("targetMeanPrice")
            target_high = info.get("targetHighPrice")
            target_low = info.get("targetLowPrice")
            recommendation = info.get("recommendationKey", "")
            num_analysts = info.get("numberOfAnalystOpinions", 0)
            sector = info.get("sector", "")
            industry = info.get("industry", "")
            currency = info.get("currency") or info.get("financialCurrency") or "USD"

            if target_mean or recommendation:
                result["analyst"] = {
                    "recommendation": recommendation,
                    "target_mean": round(float(target_mean), 2) if target_mean else None,
                    "target_high": round(float(target_high), 2) if target_high else None,
                    "target_low": round(float(target_low), 2) if target_low else None,
                    "num_analysts": num_analysts,
                    "current_price": round(float(current_price), 2) if current_price else None,
                    "currency": currency,
                }
            result["currency"] = currency
        except Exception:
            info = {}
            current_price = None
            target_mean = None
            target_high = None
            target_low = None
            sector = ""
            industry = ""
            currency = "USD"
            result["currency"] = currency

        # --- News ---
        try:
            raw_news = t.news or []
            cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
            news_items = []
            for item in raw_news[:15]:
                try:
                    content = item.get("content", item)
                    title = content.get("title", "") or item.get("title", "")
                    summary = content.get("summary", "") or item.get("summary", "")
                    pub_date = content.get("pubDate", "") or item.get("providerPublishTime", "")

                    ts = None
                    if isinstance(pub_date, (int, float)):
                        ts = float(pub_date)
                    elif isinstance(pub_date, str) and pub_date:
                        try:
                            dt = datetime.fromisoformat(pub_date.replace("Z", "+00:00"))
                            ts = dt.timestamp()
                        except ValueError:
                            pass

                    if ts and ts < cutoff:
                        continue

                    url = ""
                    if isinstance(content.get("canonicalUrl"), dict):
                        url = content["canonicalUrl"].get("url", "")
                    elif isinstance(item.get("link"), str):
                        url = item["link"]

                    source = "Unknown"
                    if isinstance(content.get("provider"), dict):
                        source = content["provider"].get("displayName", "Unknown")

                    if title:
                        sentiment = _news_sentiment(title + " " + (summary or ""))
                        news_items.append({
                            "title": title,
                            "summary": summary[:200] if summary else "",
                            "url": url,
                            "published_at": ts,
                            "source": source,
                            "sentiment": sentiment,
                        })
                except Exception:
                    continue
            result["news"] = news_items[:10]
        except Exception:
            pass

        # --- Earnings Date ---
        try:
            cal = t.calendar
            if cal is not None:
                if isinstance(cal, dict):
                    earnings = cal.get("Earnings Date") or cal.get("earnings_date")
                    if earnings:
                        if isinstance(earnings, list) and len(earnings) > 0:
                            result["earnings_date"] = str(earnings[0])[:10]
                        elif isinstance(earnings, str):
                            result["earnings_date"] = earnings[:10]
                else:
                    # DataFrame format
                    import pandas as pd
                    if isinstance(cal, pd.DataFrame) and not cal.empty:
                        for col in cal.columns:
                            if "earning" in str(col).lower():
                                val = cal[col].iloc[0] if len(cal[col]) > 0 else None
                                if val is not None:
                                    result["earnings_date"] = str(val)[:10]
                                break
        except Exception:
            pass

        # --- Year-end targets via LLM ---
        try:
            from ai.llm_client import call_llm, is_configured
            if is_configured() and current_price:
                now_year = datetime.now().year
                prompt = f"""You are a financial analyst. Given the following data about {symbol} ({result['name']}):
- Current Price: {current_price}
- Sector: {sector}, Industry: {industry}
- Analyst Target Mean: {target_mean}, High: {target_high}, Low: {target_low}
- Number of Analysts: {info.get('numberOfAnalystOpinions', 'N/A')}
- Revenue Growth: {info.get('revenueGrowth', 'N/A')}
- Earnings Growth: {info.get('earningsGrowth', 'N/A')}
- Profit Margins: {info.get('profitMargins', 'N/A')}
- Forward PE: {info.get('forwardPE', 'N/A')}
- Trailing PE: {info.get('trailingPE', 'N/A')}

Provide year-end price targets for the next 3 years ({now_year}, {now_year+1}, {now_year+2}).
For each year, provide LOW (bear case), BASE (most likely), and HIGH (bull case) estimates.

Reply ONLY in this exact JSON format, no other text:
{{"methodology": "brief 1-line explanation", "targets": [{{"year": {now_year}, "low": X, "base": Y, "high": Z}}, {{"year": {now_year+1}, "low": X, "base": Y, "high": Z}}, {{"year": {now_year+2}, "low": X, "base": Y, "high": Z}}]}}"""

                response = call_llm(prompt, system="You are a concise financial analyst. Reply only with valid JSON.", max_tokens=300)
                # Try to parse JSON from response
                import re
                json_match = re.search(r'\{.*\}', response, re.DOTALL)
                if json_match:
                    targets_data = json.loads(json_match.group())
                    result["year_end_targets"] = targets_data
        except Exception:
            pass

        return result

    detail = await loop.run_in_executor(executor, fetch_detail)
    return JSONResponse(content=clean_for_json(detail))