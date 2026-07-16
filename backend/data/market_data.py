"""yfinance wrapper with 15-minute in-memory cache."""

import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import pandas as pd
import yfinance as yf

_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 900  # 15 minutes


def _get_cached(key: str) -> Any:
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (time.time() - entry["ts"]) < CACHE_TTL:
            return entry["data"]
    return None


def _set_cached(key: str, data: Any) -> None:
    with _cache_lock:
        _cache[key] = {"data": data, "ts": time.time()}


def normalize_symbol(symbol: str) -> str:
    s = symbol.strip().upper()
    if s.startswith("^") or "." in s:
        return s
    return s + ".NS"


def get_ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(normalize_symbol(symbol))


_CRITICAL_INFO_FIELDS = ("previousClose", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "currentPrice")


def get_info(symbol: str) -> dict:
    sym = normalize_symbol(symbol)
    key = f"info:{sym}"
    cached = _get_cached(key)
    # If cached but missing critical fields, bust the cache and re-fetch
    if cached is not None:
        if any(cached.get(f) for f in _CRITICAL_INFO_FIELDS):
            return cached
        # Critical fields all missing — stale/partial cache, re-fetch
        with _cache_lock:
            _cache.pop(key, None)
    try:
        data = yf.Ticker(sym).info or {}
    except Exception:
        data = {}
    _set_cached(key, data)
    return data


def get_history(symbol: str, period: str = "1y") -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"history:{sym}:{period}"
    cached = _get_cached(key)
    if cached is not None and not cached.empty:   # never serve cached empty — same guard as get_index_history
        return cached
    try:
        df = yf.Ticker(sym).history(period=period)
    except Exception:
        df = pd.DataFrame()
    if not df.empty:   # never cache empty
        _set_cached(key, df)
    return df


def get_financials(symbol: str) -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"financials:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(sym).financials
    except Exception:
        df = pd.DataFrame()
    _set_cached(key, df)
    return df


def get_quarterly_financials(symbol: str) -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"q_financials:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(sym).quarterly_financials
    except Exception:
        df = pd.DataFrame()
    _set_cached(key, df)
    return df


def get_balance_sheet(symbol: str) -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"balance_sheet:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(sym).balance_sheet
    except Exception:
        df = pd.DataFrame()
    _set_cached(key, df)
    return df


def get_cashflow(symbol: str) -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"cashflow:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(sym).cashflow
    except Exception:
        df = pd.DataFrame()
    _set_cached(key, df)
    return df


def get_recommendations(symbol: str) -> pd.DataFrame:
    sym = normalize_symbol(symbol)
    key = f"recommendations:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(sym).recommendations
        if df is None:
            df = pd.DataFrame()
    except Exception:
        df = pd.DataFrame()
    _set_cached(key, df)
    return df


def get_news(symbol: str) -> list[dict]:
    sym = normalize_symbol(symbol)
    key = f"news:{sym}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        items = yf.Ticker(sym).news or []
    except Exception:
        items = []
    _set_cached(key, items)
    return items


def get_index_history(ticker_sym: str, period: str = "3mo") -> pd.DataFrame:
    key = f"idx:{ticker_sym}:{period}"
    cached = _get_cached(key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(ticker_sym).history(period=period)
    except Exception:
        df = pd.DataFrame()
    if not df.empty:   # never cache empty — parallel calls can get empty due to rate limiting
        _set_cached(key, df)
    return df


def get_nifty_history(period: str = "1y") -> pd.DataFrame:
    return get_index_history("^NSEI", period)


def batch_get_info(symbols: list[str]) -> dict[str, dict]:
    result = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(get_info, s): s for s in symbols}
        for future in as_completed(futures):
            sym = futures[future]
            try:
                result[sym] = future.result()
            except Exception:
                result[sym] = {}
    return result


def flush_cache() -> int:
    """Clear all in-memory cache entries. Call after yfinance errors to force re-fetch."""
    with _cache_lock:
        count = len(_cache)
        _cache.clear()
    return count


def safe_get(d: dict, *keys, default=None):
    """Safely navigate nested dict."""
    val = d
    for k in keys:
        if not isinstance(val, dict):
            return default
        val = val.get(k)
        if val is None:
            return default
    return val if val is not None else default


def get_dataframe_row(df: pd.DataFrame, row_name: str) -> pd.Series | None:
    """Get a row from a financials DataFrame by partial name match."""
    if df is None or df.empty:
        return None
    for idx in df.index:
        if row_name.lower() in str(idx).lower():
            return df.loc[idx]
    return None


def pct_change(new_val: float, old_val: float) -> float | None:
    """Safe percentage change calculation."""
    if old_val and old_val != 0:
        return (new_val - old_val) / abs(old_val) * 100
    return None
