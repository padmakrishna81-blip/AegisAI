"""Market endpoints — macro environment, sector strength, global indices, news."""

from fastapi import APIRouter, Path
from fastapi.responses import JSONResponse
from engines.macro_environment import calculate as calc_macro
from engines.sector_strength import calculate as calc_sector
from api.utils import clean_for_json
from data.indices import SECTOR_INDEX_MAP

router = APIRouter()


@router.get("/market/macro")
async def get_macro():
    """Get macro environment score and breakdown."""
    return JSONResponse(content=clean_for_json(calc_macro()))


@router.get("/market/sector-detail/{sector_name}")
async def get_sector_detail(sector_name: str):
    """
    Detailed view for a sector:
    - Top 5 stocks by AegisAI score
    - Sector trend (3M index return)
    - 3-month outlook (rule-based)
    - Recent sector-related news
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from data.indices import STOCK_SECTOR_MAP, SECTOR_INDEX_MAP
    from data.market_data import get_info, safe_get, get_index_history
    from engines.recommendation import calculate_full
    import urllib.parse

    sector = urllib.parse.unquote(sector_name).strip()

    # Stocks in this sector
    stocks = [sym for sym, sec in STOCK_SECTOR_MAP.items() if sec.lower() == sector.lower()]
    if not stocks:
        return JSONResponse(content={"error": f"Sector '{sector}' not found"}, status_code=404)

    from data.indices import NIFTY50
    nifty50_set = set(NIFTY50)

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=8)

    # Analyze ALL stocks in the sector (no limit), sorted by score
    async def score_one(sym):
        try:
            r = await loop.run_in_executor(executor, calculate_full, sym)
            cmp        = r.get("current_price") or 0
            prev_close = r.get("prev_close")
            change_pct = round((cmp / prev_close - 1) * 100, 2) if cmp and prev_close and prev_close > 0 else None
            return {
                "symbol":     sym.replace(".NS", ""),
                "name":       r.get("company_name", sym),
                "score":      r.get("overall_score", 50),
                "signal":     r.get("recommendation", "HOLD"),
                "cmp":        round(cmp, 2) if cmp else 0,
                "change_pct": change_pct,
                "nifty50":    sym in nifty50_set,
            }
        except Exception:
            return None

    tasks = [score_one(s) for s in stocks]
    results = await asyncio.gather(*tasks)
    all_stocks = sorted(
        [r for r in results if r],
        key=lambda x: x["score"],
        reverse=True
    )

    # Sector trend from index
    index_sym = SECTOR_INDEX_MAP.get(sector, SECTOR_INDEX_MAP.get(sector.title()))
    trend_3m = None
    trend_1y = None
    if index_sym:
        try:
            hist = get_index_history(index_sym, period="1y")
            if not hist.empty and len(hist) >= 63:
                c = hist["Close"]
                trend_3m = round((float(c.iloc[-1]) / float(c.iloc[-63]) - 1) * 100, 2)
                trend_1y = round((float(c.iloc[-1]) / float(c.iloc[0])  - 1) * 100, 2)
        except Exception:
            pass

    # Outlook — rule-based from sector score + trend
    sector_score = 50
    if all_stocks:
        sector_score = round(sum(s["score"] for s in all_stocks) / len(all_stocks))

    if sector_score >= 75 and (trend_3m or 0) > 3:
        outlook = "Bullish — sector showing strong momentum and high analyst scores. Consider adding exposure."
        outlook_label = "bullish"
    elif sector_score >= 60 or (trend_3m or 0) > 1:
        outlook = "Neutral-Positive — sector is stable with selective opportunities. Focus on top-scored stocks."
        outlook_label = "neutral_positive"
    elif sector_score < 45 or (trend_3m or 0) < -5:
        outlook = "Bearish — sector under pressure. Reduce exposure or wait for stabilization."
        outlook_label = "bearish"
    else:
        outlook = "Neutral — mixed signals. Monitor for a clearer trend before adding positions."
        outlook_label = "neutral"

    # Recent news — fetch from sector index or first stock
    news = []
    if stocks:
        try:
            from data.news_fetcher import fetch_stock_news
            news_sym = index_sym or stocks[0]
            raw = fetch_stock_news(news_sym)
            news = [{"title": n["title"], "source": n["source"], "published_at": n["published_at"]}
                    for n in raw[:5]]
        except Exception:
            pass

    return JSONResponse(content=clean_for_json({
        "sector":         sector,
        "sector_score":   sector_score,
        "index_symbol":   index_sym,
        "trend_3m_pct":   trend_3m,
        "trend_1y_pct":   trend_1y,
        "outlook":        outlook,
        "outlook_label":  outlook_label,
        "top5_stocks":    all_stocks,
        "news":           news,
        "stock_count":    len(all_stocks),
    }))


@router.get("/market/sector/{sector}")
async def get_sector_strength(sector: str = Path(...)):
    """Get sector strength score. Pass a stock symbol to get its sector."""
    from data.indices import get_sector, normalize_symbol
    from data.market_data import get_info, safe_get

    if sector.upper() in SECTOR_INDEX_MAP:
        actual_sector = sector.title()
    else:
        sym = normalize_symbol(sector)
        actual_sector = get_sector(sym)

    from data.indices import STOCK_SECTOR_MAP
    sector_sym = next((s for s, sec in STOCK_SECTOR_MAP.items() if sec == actual_sector), None)
    if sector_sym is None:
        sector_sym = sector

    return calc_sector(sector_sym)


@router.get("/market/sectors")
async def get_all_sectors():
    """Get strength scores for all major sectors."""
    from data.indices import STOCK_SECTOR_MAP
    from concurrent.futures import ThreadPoolExecutor
    import asyncio

    sector_rep = {}
    for sym, sec in STOCK_SECTOR_MAP.items():
        if sec not in sector_rep:
            sector_rep[sec] = sym

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=8)

    async def get_one(sec, sym):
        result = await loop.run_in_executor(executor, calc_sector, sym)
        return sec, result

    tasks = [get_one(sec, sym) for sec, sym in sector_rep.items()]
    results = await asyncio.gather(*tasks)

    return JSONResponse(content=clean_for_json({
        "sectors": [
            {"sector": sec, "score": r.get("score", 50), "breakdown": r.get("breakdown", {})}
            for sec, r in sorted(results, key=lambda x: x[1].get("score", 0), reverse=True)
        ]
    }))


# ─── Global Indices ────────────────────────────────────────────────────────────

GLOBAL_INDICES = [
    # Americas
    {"symbol": "^GSPC",    "name": "S&P 500",        "region": "Americas",  "country": "US",        "currency": "USD"},
    {"symbol": "^DJI",     "name": "Dow Jones",       "region": "Americas",  "country": "US",        "currency": "USD"},
    {"symbol": "^IXIC",    "name": "NASDAQ",          "region": "Americas",  "country": "US",        "currency": "USD"},
    {"symbol": "^RUT",     "name": "Russell 2000",    "region": "Americas",  "country": "US",        "currency": "USD"},
    {"symbol": "^BVSP",    "name": "Bovespa",         "region": "Americas",  "country": "Brazil",    "currency": "BRL"},
    # Europe
    {"symbol": "^FTSE",    "name": "FTSE 100",        "region": "Europe",    "country": "UK",        "currency": "GBP"},
    {"symbol": "^GDAXI",   "name": "DAX",             "region": "Europe",    "country": "Germany",   "currency": "EUR"},
    {"symbol": "^FCHI",    "name": "CAC 40",          "region": "Europe",    "country": "France",    "currency": "EUR"},
    {"symbol": "^STOXX50E","name": "Euro Stoxx 50",   "region": "Europe",    "country": "EU",        "currency": "EUR"},
    # Asia-Pacific
    {"symbol": "^NSEI",    "name": "NIFTY 50",        "region": "Asia",      "country": "India",     "currency": "INR"},
    {"symbol": "^BSESN",   "name": "Sensex",          "region": "Asia",      "country": "India",     "currency": "INR"},
    {"symbol": "^N225",    "name": "Nikkei 225",      "region": "Asia",      "country": "Japan",     "currency": "JPY"},
    {"symbol": "^HSI",     "name": "Hang Seng",       "region": "Asia",      "country": "HK",        "currency": "HKD"},
    {"symbol": "000001.SS","name": "Shanghai Comp.",  "region": "Asia",      "country": "China",     "currency": "CNY"},
    {"symbol": "^AXJO",    "name": "ASX 200",         "region": "Asia",      "country": "Australia", "currency": "AUD"},
    {"symbol": "^KS11",    "name": "KOSPI",           "region": "Asia",      "country": "S.Korea",   "currency": "KRW"},
    # Commodities / Others
    {"symbol": "GC=F",     "name": "Gold",            "region": "Commodity", "country": "Global",    "currency": "USD/oz"},
    {"symbol": "CL=F",     "name": "Crude Oil (WTI)", "region": "Commodity", "country": "Global",    "currency": "USD/bbl"},
    {"symbol": "DX-Y.NYB", "name": "US Dollar Index", "region": "Currency",  "country": "Global",    "currency": "Index"},
    {"symbol": "^VIX",     "name": "VIX Fear Index",  "region": "Volatility","country": "Global",    "currency": "Index"},
    # Forex vs INR
    {"symbol": "USDINR=X", "name": "USD / INR",       "region": "Forex ↔ INR","country": "Global",  "currency": "INR"},
    {"symbol": "EURINR=X", "name": "EUR / INR",       "region": "Forex ↔ INR","country": "Global",  "currency": "INR"},
    {"symbol": "GBPINR=X", "name": "GBP / INR",       "region": "Forex ↔ INR","country": "Global",  "currency": "INR"},
]


def _fetch_one_index(item: dict) -> dict:
    import yfinance as yf
    sym = item["symbol"]
    try:
        t = yf.Ticker(sym)
        fi = t.fast_info
        price = getattr(fi, "last_price", None)
        prev  = getattr(fi, "previous_close", None)
        if price is None or prev is None:
            hist = t.history(period="2d")
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
                prev  = float(hist["Close"].iloc[-2]) if len(hist) >= 2 else price
        price = round(float(price), 2) if price else None
        prev  = round(float(prev),  2) if prev  else None
        change_inr = round(price - prev, 2) if price and prev else None
        change_pct = round((price / prev - 1) * 100, 2) if price and prev else None
        return {
            **item,
            "price":      price,
            "prev_close": prev,
            "change":     change_inr,
            "change_pct": change_pct,
            "direction":  "up" if (change_inr or 0) >= 0 else "down",
        }
    except Exception as e:
        return {**item, "price": None, "prev_close": None,
                "change": None, "change_pct": None, "direction": "flat", "error": str(e)[:60]}


@router.get("/market/history/{symbol_key}")
async def get_index_history_data(symbol_key: str, sessions: int = 30):
    """
    Last N trading sessions OHLCV for an index.
    symbol_key: 'nifty' | 'banknifty' | 'sensex'
    Returns: Date, PrevClose, Open, GapUp/Down, Close, %Change, Volume
    Auto-fetches fresh data every call — no stale cache issues.
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import yfinance as yf
    import math

    SYMBOLS = {
        "nifty":     ("^NSEI",    "NIFTY 50"),
        "banknifty": ("^NSEBANK", "Bank Nifty"),
        "sensex":    ("^BSESN",   "Sensex"),
    }

    entry = SYMBOLS.get(symbol_key.lower())
    if not entry:
        return JSONResponse(content={"error": f"Unknown symbol key '{symbol_key}'. Use: nifty, banknifty, sensex"}, status_code=400)

    sym, name = entry

    def fetch():
        t    = yf.Ticker(sym)
        hist = t.history(period="3mo")   # fetch 3mo to guarantee 30+ sessions
        if hist.empty:
            return []

        hist = hist.dropna(subset=["Close"]).tail(sessions + 1)   # +1 to compute prev_close for first row
        rows = []
        closes = hist["Close"].tolist()
        opens  = hist["Open"].tolist()
        vols   = hist["Volume"].tolist()
        dates  = [str(d.date()) for d in hist.index]

        for i in range(1, len(closes)):
            prev_close = round(closes[i - 1], 2)
            open_px    = round(opens[i], 2)
            close_px   = round(closes[i], 2)
            vol        = int(vols[i]) if vols[i] and not math.isnan(vols[i]) else None

            gap        = round(open_px - prev_close, 2)
            gap_pct    = round(gap / prev_close * 100, 2) if prev_close else None
            chg_pct    = round((close_px / prev_close - 1) * 100, 2) if prev_close else None
            chg_pts    = round(close_px - prev_close, 2)

            rows.append({
                "date":           dates[i],
                "prev_close":     prev_close,
                "open":           open_px,
                "gap_pts":        gap,
                "gap_pct":        gap_pct,
                "gap_direction":  "up" if gap > 0 else "down" if gap < 0 else "flat",
                "close":          close_px,
                "change_pts":     chg_pts,
                "change_pct":     chg_pct,
                "direction":      "up" if (chg_pts or 0) >= 0 else "down",
                "volume":         vol,
            })

        rows.reverse()   # most recent first
        return rows

    loop = asyncio.get_event_loop()
    rows = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), fetch)

    return JSONResponse(content=clean_for_json({
        "symbol":  sym,
        "name":    name,
        "sessions": len(rows),
        "rows":    rows,
    }))


@router.get("/market/global-indices")
async def get_global_indices():
    """Fetch live price + prev-close change for major global indices."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=10)
    tasks = [loop.run_in_executor(executor, _fetch_one_index, item) for item in GLOBAL_INDICES]
    results = await asyncio.gather(*tasks)
    return JSONResponse(content=clean_for_json({"indices": list(results)}))


@router.get("/market/gift-nifty")
async def get_gift_nifty():
    """Live GIFT Nifty data scraped from equitypandit (real GIFT Nifty futures price)."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def fetch():
        import requests
        import re
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            }
            r = requests.get('https://www.equitypandit.com/giftnifty/', headers=headers, timeout=12)
            text = r.text

            def parse_num(s):
                if not s:
                    return None
                try:
                    return float(s.strip().replace(',', ''))
                except Exception:
                    return None

            price_m   = re.search(r'gift_Nifty_Live_Price[^>]*>([\d,. ]+)', text)
            change_m  = re.search(r'gift_Nifty_Live_Change[^>]+>([^<]+)', text)
            time_m    = re.search(r'gift_Nifty_Update_Time[^>]+>.*?<time[^>]+>([^<]+)</time>', text, re.DOTALL)
            high_m    = re.search(r"Today's High</small><br\s*/><span[^>]*>([\d,.]+)", text)
            low_m     = re.search(r"Today's Low</small><br\s*/><span[^>]*>([\d,.]+)", text)
            open_m    = re.search(r"Today's Open</small><br\s*/><span[^>]*>([\d,.]+)", text)
            prev_m    = re.search(r"Previous Close</small><br\s*/><span[^>]*>([\d,.]+)", text)

            price      = parse_num(price_m.group(1)) if price_m else None
            prev_close = parse_num(prev_m.group(1))  if prev_m  else None
            day_high   = parse_num(high_m.group(1))  if high_m  else None
            day_low    = parse_num(low_m.group(1))   if low_m   else None
            day_open   = parse_num(open_m.group(1))  if open_m  else None

            # Parse change string like "+37.50 (+0.16%)" or "-156.55 (-0.65%)"
            change = None
            change_pct = None
            if change_m:
                chg_str = change_m.group(1).strip()
                cm = re.search(r'([+-]?[\d,.]+)\s*\(([+-]?[\d,.]+)%\)', chg_str)
                if cm:
                    change     = parse_num(cm.group(1))
                    change_pct = parse_num(cm.group(2))

            last_updated = time_m.group(1).strip() if time_m else None

            gap_pts    = change
            gap_signal = "positive" if (change or 0) > 0 else "negative" if (change or 0) < 0 else "flat"

            return {
                "price":        price,
                "prev_close":   prev_close,
                "day_high":     day_high,
                "day_low":      day_low,
                "day_open":     day_open,
                "change":       change,
                "change_pct":   change_pct,
                "gap_pts":      gap_pts,
                "gap_signal":   gap_signal,
                "last_updated": last_updated,
                "source":       "equitypandit.com / NSE IX",
            }
        except Exception as e:
            return {"error": str(e)[:120]}

    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), fetch)
    return JSONResponse(content=clean_for_json(data))


# ─── News Room ─────────────────────────────────────────────────────────────────

# Only fresh feeds — all return articles dated within hours, not weeks
NEWS_FEEDS = [
    ("Economic Times Markets",
     "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", 8),
    ("Economic Times Economy",
     "https://economictimes.indiatimes.com/economy/rssfeeds/1373380680.cms", 6),
    # Google News India Business topic feed (always fresh, NOT search)
    ("Google News India Biz",
     "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pKVGlnQVAB", 8),
    ("Livemint Markets",
     "https://www.livemint.com/rss/markets", 6),
]

_HIGH_IMPACT = [
    "rbi", "repo rate", "interest rate", "federal reserve", "fed", "inflation",
    "gdp", "budget", "fiscal", "crude oil", "rupee", "nifty", "sensex", "nse", "bse",
    "sebi", "ipo", "fii", "fpi", "foreign investment", "war", "sanctions", "recession",
    "trade war", "tariff", "china", "geopolit", "modi", "government", "tax",
    "export", "import", "current account", "forex", "dollar", "global market",
    "earnings", "quarterly", "results", "profit", "revenue",
]

_MAX_NEWS_AGE_SECONDS = 3 * 86400  # 3 days

# ── Sentiment word lists ──────────────────────────────────────────────────────
_POS_WORDS = [
    "surge", "jump", "rally", "gain", "rise", "climb", "boost", "strong",
    "growth", "record", "profit", "beat", "upgrade", "positive", "recovery",
    "expansion", "high", "top", "win", "approve", "cut rate", "rate cut",
    "stimulus", "surplus", "outperform", "bullish", "exceed",
]
_NEG_WORDS = [
    "fall", "drop", "plunge", "crash", "decline", "loss", "miss", "weak",
    "recession", "inflation", "sanction", "war", "conflict", "ban", "tariff",
    "downgrade", "bearish", "fear", "risk", "concern", "warn", "debt",
    "default", "rate hike", "hike", "slowdown", "negative", "cut jobs",
]

# ── Policy/decision signals ───────────────────────────────────────────────────
_POLICY_TRIGGERS = [
    ("rbi", "rbi policy"), ("repo rate",), ("rate cut", "rate hike"),
    ("federal reserve", "fed"), ("budget",), ("rbi meeting",),
    ("monetary policy",), ("fiscal policy",), ("sebi",), ("rate decision",),
    ("trade deal", "trade agreement"), ("tariff",), ("election",), ("gst council",),
]

# NSE impact of policy decisions: (positive_keywords → "Up"), (negative_keywords → "Down")
_POLICY_IMPACT = {
    "rate cut": ("Up — cheaper borrowing boosts equities", 0.75),
    "rate hike": ("Down — tighter liquidity, high-beta stocks hit", 0.72),
    "repo rate cut": ("Up — rate-sensitive sectors rally", 0.78),
    "repo rate hike": ("Down — NBFCs, realty under pressure", 0.74),
    "stimulus": ("Up — broader market sentiment improves", 0.70),
    "budget": ("Mixed — depends on sector allocation", 0.60),
    "tariff": ("Down — export-heavy IT, pharma may face headwinds", 0.65),
    "trade deal": ("Up — export sectors benefit", 0.68),
    "election": ("Volatile — uncertainty until results", 0.55),
    "sanction": ("Down — global risk-off sentiment", 0.70),
    "default": ("Down — credit risk spreads widen", 0.80),
    "rate cut": ("Up — cheaper borrowing boosts equities", 0.75),
}


def _analyze_news_impact(title: str, summary: str) -> dict:
    """Rule-based sentiment + policy impact analysis. Uses LLM if configured."""
    text = (title + " " + summary).lower()

    # Rule-based sentiment
    pos = sum(1 for w in _POS_WORDS if w in text)
    neg = sum(1 for w in _NEG_WORDS if w in text)
    if pos > neg:
        sentiment = "positive"
    elif neg > pos:
        sentiment = "negative"
    else:
        sentiment = "neutral"

    # Detect policy type
    policy_type = None
    for trigger_group in _POLICY_TRIGGERS:
        if any(t in text for t in trigger_group):
            policy_type = trigger_group[0]
            break

    # Get policy prediction if applicable
    prediction = None
    if policy_type:
        for key, (impact, prob) in _POLICY_IMPACT.items():
            if key in text:
                prediction = {
                    "decision": key.replace("_", " ").title(),
                    "nse_impact": impact,
                    "probability": prob,
                }
                break
        if not prediction:
            # Generic policy
            prediction = {
                "decision": policy_type.replace("_", " ").title() + " decision pending",
                "nse_impact": "Uncertain — watch official announcement",
                "probability": 0.5,
            }

    # Try LLM if configured (async-safe: runs in thread executor anyway)
    try:
        from ai.llm_client import is_configured, call_llm
        import json as _json
        if is_configured():
            policy_extra = f"\nThis may be a policy news item about: {policy_type}" if policy_type else ""
            prompt = (
                f"Analyze this financial news for NSE market impact.\n"
                f"Title: {title}\nSummary: {summary[:300]}{policy_extra}\n\n"
                f"Respond with JSON only:\n"
                f'{{ "sentiment": "positive|negative|neutral", '
                f'"nse_impact": "brief 1-line NSE impact", '
                f'"direction": "Up|Down|Mixed|Neutral"'
                + (', "policy_decision": "what decision is likely", "probability": 0.0-1.0, "if_decided_impact": "impact on NSE"' if policy_type else '')
                + ' }'
            )
            raw = call_llm(prompt, max_tokens=200)
            start, end = raw.find("{"), raw.rfind("}") + 1
            if start >= 0 and end > start:
                data = _json.loads(raw[start:end])
                return {
                    "sentiment": data.get("sentiment", sentiment),
                    "nse_impact": data.get("nse_impact", ""),
                    "direction": data.get("direction", "Neutral"),
                    "ai_powered": True,
                    "prediction": {
                        "decision": data.get("policy_decision", ""),
                        "probability": float(data.get("probability", 0.5)),
                        "nse_impact": data.get("if_decided_impact", ""),
                    } if policy_type and data.get("policy_decision") else None,
                }
    except Exception:
        pass

    # Fallback: rule-based
    direction = "Up" if sentiment == "positive" else "Down" if sentiment == "negative" else "Neutral"
    impact_line = ""
    for w in _POS_WORDS:
        if w in text:
            impact_line = f"Positive cue ({w}) — may lift NSE sentiment"
            break
    for w in _NEG_WORDS:
        if w in text:
            impact_line = f"Negative cue ({w}) — may weigh on NSE"
            break
    if not impact_line:
        impact_line = "Neutral — no strong directional signal"

    return {
        "sentiment": sentiment,
        "nse_impact": impact_line,
        "direction": direction,
        "ai_powered": False,
        "prediction": prediction,
    }


def _score_news_item(title: str, summary: str) -> int:
    text = (title + " " + summary).lower()
    return sum(1 for kw in _HIGH_IMPACT if kw in text)


def _fetch_news() -> list[dict]:
    import feedparser, ssl, urllib.request, time, re
    from email.utils import parsedate_to_datetime

    ctx = ssl._create_unverified_context()
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
    seen_titles: set[str] = set()
    all_items: list[dict] = []
    now = time.time()

    for source_name, url, max_take in NEWS_FEEDS:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8, context=ctx) as r:
                content = r.read()
            feed = feedparser.parse(content)
            taken = 0
            for entry in feed.entries:
                if taken >= max_take:
                    break
                title = entry.get("title", "").strip()
                title = re.sub(r"\s+-\s+\S.*$", "", title).strip()
                if not title or title.lower() in seen_titles:
                    continue

                pub = entry.get("published", "")
                try:
                    ts = int(parsedate_to_datetime(pub).timestamp()) if pub else int(now)
                except Exception:
                    ts = int(now)

                # Skip anything older than 3 days
                if now - ts > _MAX_NEWS_AGE_SECONDS:
                    continue

                seen_titles.add(title.lower())
                summary = re.sub(r"<[^>]+>", "", entry.get("summary", "")).strip()[:200]
                link = entry.get("link", "")
                impact = _score_news_item(title, summary)
                analysis = _analyze_news_impact(title, summary)
                all_items.append({
                    "title": title,
                    "summary": summary,
                    "link": link,
                    "published": pub,
                    "timestamp": ts,
                    "source": source_name,
                    "impact_score": impact,
                    "sentiment": analysis["sentiment"],
                    "nse_impact": analysis["nse_impact"],
                    "direction": analysis["direction"],
                    "ai_powered": analysis["ai_powered"],
                    "prediction": analysis["prediction"],
                })
                taken += 1
        except Exception:
            continue

    # Sort: impact desc, then recency desc
    all_items.sort(key=lambda x: (-x["impact_score"], -x["timestamp"]))
    return all_items[:12]


_news_cache: dict = {"data": None, "ts": 0.0}


@router.get("/market/news")
async def get_market_news():
    """Fetch top fresh (≤3 days) market-moving news relevant to NSE. Cached 30 min."""
    import asyncio, time
    from concurrent.futures import ThreadPoolExecutor

    cache = _news_cache
    if cache["data"] and (time.time() - cache["ts"]) < 1800:
        return JSONResponse(content=clean_for_json({"news": cache["data"], "count": len(cache["data"])}))

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    items = await loop.run_in_executor(executor, _fetch_news)
    _news_cache["data"] = items
    _news_cache["ts"] = time.time()
    return JSONResponse(content=clean_for_json({"news": items, "count": len(items)}))


# ─── Quarterly Results Calendar ───────────────────────────────────────────────

_RESULTS_CACHE: dict = {"data": None, "ts": 0.0}


def _fetch_results_calendar() -> list[dict]:
    """Fetch upcoming board meetings / quarterly results from NSE event calendar."""
    import ssl, urllib.request, json, time
    from datetime import datetime, timedelta

    ctx = ssl._create_unverified_context()
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
        "Referer": "https://www.nseindia.com",
    }
    url = "https://www.nseindia.com/api/event-calendar"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            events = json.load(r)
    except Exception as e:
        return []

    today = datetime.now().date()
    window_start = today - timedelta(days=1)   # include yesterday in case of late announcements
    window_end   = today + timedelta(days=5)

    results = []
    for ev in events:
        date_str = ev.get("date", "")
        purpose  = ev.get("purpose", "")
        if not date_str or not purpose:
            continue
        # Only keep results / board meetings
        if not any(kw in purpose for kw in ("Financial Results", "Board Meeting", "Dividend")):
            continue
        try:
            ev_date = datetime.strptime(date_str, "%d-%b-%Y").date()
        except Exception:
            try:
                ev_date = datetime.strptime(date_str, "%d-%m-%Y").date()
            except Exception:
                continue
        if not (window_start <= ev_date <= window_end):
            continue

        days_diff = (ev_date - today).days
        if days_diff < 0:
            when = "Yesterday"
        elif days_diff == 0:
            when = "Today"
        elif days_diff == 1:
            when = "Tomorrow"
        else:
            when = ev_date.strftime("%a, %d %b")

        results.append({
            "symbol":  ev.get("symbol", ""),
            "company": ev.get("company", ""),
            "purpose": purpose,
            "description": ev.get("bm_desc", ""),
            "date": date_str,
            "date_iso": ev_date.isoformat(),
            "when": when,
            "days_from_today": days_diff,
        })

    results.sort(key=lambda x: x["days_from_today"])
    return results


@router.get("/market/results-calendar")
async def get_results_calendar():
    """Upcoming quarterly results and board meetings (today ±5 days). Cached 1 hour."""
    import asyncio, time
    from concurrent.futures import ThreadPoolExecutor

    cache = _RESULTS_CACHE
    if cache["data"] is not None and (time.time() - cache["ts"]) < 3600:
        return JSONResponse(content=clean_for_json({"events": cache["data"], "count": len(cache["data"])}))

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    items = await loop.run_in_executor(executor, _fetch_results_calendar)
    _RESULTS_CACHE["data"] = items
    _RESULTS_CACHE["ts"] = time.time()
    return JSONResponse(content=clean_for_json({"events": items, "count": len(items)}))
