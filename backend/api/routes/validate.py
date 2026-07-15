"""Stock validation + market quotes endpoint."""

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from data.market_data import get_info, normalize_symbol, safe_get
from concurrent.futures import ThreadPoolExecutor, as_completed
import yfinance as yf

router = APIRouter()


def _quote_for_symbol(symbol: str) -> dict:
    """
    Fetch CMP, prev close, 30-day high/low for a single symbol.
    Uses fast_info for CMP (fresh) + history for 30-day range.
    Retries once on failure to handle yfinance rate-limiting.
    """
    import time as _t
    sym = normalize_symbol(symbol)
    result = {"symbol": sym, "error": None}

    for attempt in range(2):   # retry once on failure
        try:
            ticker = yf.Ticker(sym)

            # Fresh CMP via fast_info
            fast = ticker.fast_info
            cmp = getattr(fast, "last_price", None) or getattr(fast, "regular_market_price", None)
            cmp = float(cmp) if cmp else None

            if cmp is None and attempt == 0:
                _t.sleep(0.5)
                continue   # retry

            # Prev close from info (cached is fine — it changes once a day)
            info = get_info(sym)
            prev_close = safe_get(info, "previousClose") or safe_get(info, "regularMarketPreviousClose")
            prev_close = float(prev_close) if prev_close else None

            # 30-day OHLC for high/low
            hist = ticker.history(period="1mo")
            if hist.empty and attempt == 0:
                _t.sleep(0.5)
                continue   # retry

            high_30d = float(hist["High"].max()) if not hist.empty else None
            low_30d  = float(hist["Low"].min())  if not hist.empty else None

            # 52W high/low — from fast_info (most reliable, no extra call)
            high_52w = float(getattr(fast, "year_high", None) or 0) or None
            low_52w  = float(getattr(fast, "year_low",  None) or 0) or None
            # Fallback to cached .info if fast_info returns nothing
            if not high_52w:
                high_52w = float(safe_get(get_info(sym), "fiftyTwoWeekHigh") or 0) or None
            if not low_52w:
                low_52w  = float(safe_get(get_info(sym), "fiftyTwoWeekLow")  or 0) or None

            # Derived values
            change_inr    = round(cmp - prev_close, 2) if cmp and prev_close else None
            change_pct    = round((cmp - prev_close) / prev_close * 100, 2) if cmp and prev_close and prev_close > 0 else None
            drop_from_30h = round((cmp - high_30d) / high_30d * 100, 2) if cmp and high_30d and high_30d > 0 else None
            lift_from_30l = round((cmp - low_30d) / low_30d * 100, 2) if cmp and low_30d and low_30d > 0 else None

            result.update({
                "cmp":                  round(cmp, 2) if cmp else None,
                "prev_close":           round(prev_close, 2) if prev_close else None,
                "change_inr":           change_inr,
                "change_pct":           change_pct,
                "high_30d":             round(high_30d, 2) if high_30d else None,
                "low_30d":              round(low_30d, 2) if low_30d else None,
                "drop_from_30d_high_pct": drop_from_30h,
                "lift_from_30d_low_pct":  lift_from_30l,
                "high_52w":             round(high_52w, 2) if high_52w else None,
                "low_52w":              round(low_52w,  2) if low_52w  else None,
            })
            return result   # success
        except Exception as e:
            if attempt == 0:
                _t.sleep(0.5)
                continue
            result["error"] = str(e)[:100]

    return result


@router.get("/watchlist/quotes")
async def watchlist_quotes(symbols: str = Query(..., description="Comma-separated symbols")):
    """
    Batch market data for watchlist:
    CMP, Prev Close, Change ₹/%, 30-day High/Low, Drop from 30H, Lift from 30L.
    """
    sym_list = [s.strip() for s in symbols.split(",") if s.strip()][:30]
    results = {}
    # Use 5 workers (not 10) to avoid yfinance rate-limiting on parallel calls
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_quote_for_symbol, s): s for s in sym_list}
        for future in as_completed(futures):
            data = future.result()
            results[data["symbol"]] = data
    return JSONResponse(content=results)


@router.get("/validate/{symbol}")
async def validate_symbol(symbol: str):
    """
    Validate whether a symbol is a real NSE-listed stock.
    Returns {valid, symbol, company_name, current_price, exchange, error?}
    """
    sym = normalize_symbol(symbol)
    info = get_info(sym)

    # A valid NSE stock must have at minimum: a name, a market price, and market cap
    company_name = safe_get(info, "longName", default=None) or safe_get(info, "shortName", default=None)
    price = safe_get(info, "currentPrice", default=None) or safe_get(info, "regularMarketPrice", default=None)
    market_cap = safe_get(info, "marketCap", default=None)
    exchange = safe_get(info, "exchange", default=None) or safe_get(info, "exchangeName", default=None)
    quote_type = safe_get(info, "quoteType", default=None)

    # Detect ETF-like instruments (yfinance sometimes misclassifies NSE ETFs as EQUITY)
    name_lower = (company_name or "").lower()
    is_etf_like = (
        (quote_type and quote_type.upper() == "ETF") or
        (market_cap is None and any(kw in name_lower for kw in ["etf", "bees", "fund", "index fund"]))
    )

    if is_etf_like:
        # ETFs don't have marketCap — valid if they have name + price
        is_valid = bool(company_name and price and price > 0)
    else:
        is_valid = bool(company_name and price and market_cap and price > 0)

    # Reject non-financial quote types
    if is_valid and quote_type and quote_type.upper() not in ("EQUITY", "ETF", "INDEX", "MUTUALFUND"):
        is_valid = False

    if not is_valid:
        return JSONResponse(
            status_code=422,
            content={
                "valid": False,
                "symbol": sym,
                "error": f"'{symbol}' is not a valid NSE-listed stock. Please enter a correct NSE symbol (e.g. RELIANCE, HDFCBANK, BEL).",
                "suggestions": _get_suggestions(symbol),
            },
        )

    # Compute prev close and % change
    prev_close = safe_get(info, "previousClose", default=None) or safe_get(info, "regularMarketPreviousClose", default=None)
    pct_change = None
    change_inr = None
    if price and prev_close and prev_close > 0:
        pct_change = round((float(price) - float(prev_close)) / float(prev_close) * 100, 2)
        change_inr = round(float(price) - float(prev_close), 2)

    return JSONResponse(content={
        "valid": True,
        "symbol": sym,
        "company_name": company_name,
        "current_price": round(float(price), 2),
        "prev_close": round(float(prev_close), 2) if prev_close else None,
        "change_inr": change_inr,
        "change_pct": pct_change,
        "exchange": exchange or "NSE",
        "quote_type": quote_type or "EQUITY",
        "market_cap": market_cap,
    })


def _get_suggestions(symbol: str) -> list[str]:
    """Return some guesses for common typos/partial names."""
    from data.indices import NIFTY50, NIFTY_BANK, NIFTY_IT
    all_sym = [s.replace(".NS", "") for s in NIFTY50 + NIFTY_BANK + NIFTY_IT]
    upper = symbol.upper()
    return [s for s in all_sym if s.startswith(upper[:3])][:5]
