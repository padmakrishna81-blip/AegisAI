"""Global stocks — search NASDAQ/NYSE/XETRA, store watchlist, fetch live prices."""

import json
import os
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from api.utils import clean_for_json

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
