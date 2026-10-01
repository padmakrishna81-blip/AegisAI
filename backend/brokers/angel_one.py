"""Angel One SmartAPI broker client."""

from __future__ import annotations
import logging
import time
from datetime import datetime, timezone, timedelta

import pyotp

from brokers import BrokerClient

logger = logging.getLogger(__name__)

# Module-level SmartConnect cache — survives across requests in the same process.
_sc_cache: dict[str, object] = {}

# Symbol token cache: "NSE:RELIANCE" → "2885"
_token_cache: dict[str, str] = {}
_last_scrip_call: float = 0.0   # epoch seconds of last searchScrip call
_SCRIP_MIN_INTERVAL = 1.1        # seconds between searchScrip calls (Angel One rate limit)


def _f(val, default: float = 0.0) -> float:
    """Safely convert Angel One response fields to float (handles None / empty string)."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _i(val, default: int = 0) -> int:
    try:
        return int(val) if val is not None else default
    except (ValueError, TypeError):
        return default


_PRODUCT_INTRADAY = "INTRADAY"
_PRODUCT_DELIVERY = "DELIVERY"
_PRODUCT_MARGIN   = "MARGIN"

_ORDER_VARIETY_NORMAL = "NORMAL"
_ORDER_MARKET  = "MARKET"
_ORDER_LIMIT   = "LIMIT"


def _make_smart_connect(api_key: str):
    from SmartApi import SmartConnect
    return SmartConnect(api_key=api_key)


class AngelOneClient(BrokerClient):
    """
    Angel One SmartAPI wrapper.

    creds keys: api_key, client_id, password, totp_secret (base32 TOTP seed)

    cache_key (e.g. "admin:angelone") keeps the live SmartConnect object across
    requests within the same process. On server restart the cache is empty and
    _ensure_connected() rebuilds from stored tokens + client_id.
    """

    def __init__(self, session: dict, cache_key: str = ""):
        self._session   = session
        self._cache_key = cache_key
        # Use cached live object if available
        self._obj = _sc_cache.get(cache_key) if cache_key else None

    def _ensure_connected(self):
        """Restore SmartConnect from cache or rebuild from stored tokens."""
        # 1. Cache hit — fastest path
        if self._cache_key and self._cache_key in _sc_cache:
            self._obj = _sc_cache[self._cache_key]
            return

        # 2. Rebuild from stored tokens (survives server restarts within token validity)
        auth_token = self._session.get("auth_token", "")
        api_key    = self._session.get("api_key", "")
        client_id  = self._session.get("client_id", "")

        if not auth_token or not api_key:
            return

        from SmartApi import SmartConnect
        obj = SmartConnect(api_key=api_key)
        obj.setSessionExpiryHook(lambda: None)
        # Strip "Bearer " prefix if present — SmartConnect adds it when building headers,
        # so access_token must be the raw JWT (no prefix).
        raw_token = auth_token[7:] if auth_token.startswith("Bearer ") else auth_token
        obj.access_token  = raw_token
        obj.refresh_token = self._session.get("refresh_token", "")
        obj.feed_token    = self._session.get("feed_token", "")
        # Angel One API requires client_id in X-ClientLocalIP / user context headers
        if client_id:
            obj.user_id    = client_id
            obj.userId     = client_id   # some library versions use this attribute name
            obj.clientCode = client_id
        self._obj = obj
        if self._cache_key:
            _sc_cache[self._cache_key] = obj

    def connect(self, creds: dict) -> dict:
        totp_code = pyotp.TOTP(creds["totp_secret"]).now()
        obj = _make_smart_connect(creds["api_key"])
        resp = obj.generateSession(creds["client_id"], creds["password"], totp_code)
        if not resp.get("status"):
            raise RuntimeError(f"Angel One login failed: {resp.get('message', 'unknown error')}")
        data = resp["data"]
        self._obj = obj
        # Cache the live object so subsequent requests in this process don't need token injection
        if self._cache_key:
            _sc_cache[self._cache_key] = obj
        expiry = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        session = {
            "api_key":       creds["api_key"],
            "client_id":     creds["client_id"],   # stored so _ensure_connected can set user_id
            "auth_token":    data.get("jwtToken", ""),
            "refresh_token": data.get("refreshToken", ""),
            "feed_token":    data.get("feedToken", ""),
            "expires_at":    expiry,
        }
        self._session = session
        return session

    def get_holdings(self) -> list[dict]:
        self._ensure_connected()
        if not self._obj:
            raise RuntimeError("Angel One not connected")
        resp = self._obj.holding()
        if resp is None or not resp.get("status"):
            msg = (resp or {}).get("message", "Invalid or expired session")
            raise RuntimeError(f"get_holdings failed: {msg}")
        raw = resp.get("data") or []
        return [
            {
                "broker":    "Angel One",
                "symbol":    h.get("tradingsymbol", ""),
                "token":     h.get("symboltoken", ""),
                "exchange":  h.get("exchange", "NSE"),
                "qty":       _i(h.get("quantity")),
                "avg_price": _f(h.get("averageprice")),
                "ltp":       _f(h.get("ltp")),
                "pnl":       _f(h.get("profitandloss")),
                "pnl_pct":   _f(h.get("pnlpercentage")),
                "product":   h.get("product", ""),
                "isin":      h.get("isin", ""),
            }
            for h in raw
        ]

    def get_funds(self) -> dict:
        self._ensure_connected()
        if not self._obj:
            raise RuntimeError("Angel One not connected")
        resp = self._obj.rmsLimit()
        if resp is None or not resp.get("status"):
            msg = (resp or {}).get("message", "Invalid or expired session")
            raise RuntimeError(f"get_funds failed: {msg}")
        d = resp.get("data") or {}
        return {
            "broker":         "Angel One",
            "available_cash": _f(d.get("availablecash")),
            "used_margin":    _f(d.get("utiliseddebits")),
            "net":            _f(d.get("net")),
            "total_margin":   _f(d.get("totaltradingpower")),
        }

    def _get_token(self, symbol: str, exchange: str = "NSE", is_etf: bool = False) -> str:
        """Look up Angel One numeric symbol token, cached in memory.
        For stocks: matches tradingsymbol = SYMBOL-EQ.
        For ETFs: matches tradingsymbol = SYMBOL (no -EQ).
        """
        global _last_scrip_call
        cache_key = f"{exchange}:{symbol}"
        if cache_key in _token_cache:
            return _token_cache[cache_key]
        self._ensure_connected()
        try:
            # Enforce rate limit between successive searchScrip calls
            elapsed = time.time() - _last_scrip_call
            if elapsed < _SCRIP_MIN_INTERVAL:
                time.sleep(_SCRIP_MIN_INTERVAL - elapsed)
            resp = self._obj.searchScrip(exchange, symbol)
            _last_scrip_call = time.time()
            if resp and resp.get("data"):
                target_eq  = symbol.upper() + "-EQ"
                target_raw = symbol.upper()
                for item in resp["data"]:
                    ts = item.get("tradingsymbol", "").upper()
                    # ETF: match raw symbol; stock: match SYMBOL-EQ
                    if (is_etf and ts == target_raw) or (not is_etf and ts == target_eq):
                        token = str(item["symboltoken"])
                        _token_cache[cache_key] = token
                        return token
                # Fallback: if is_etf and no raw match, try -EQ (some ETFs might use it)
                if is_etf:
                    for item in resp["data"]:
                        ts = item.get("tradingsymbol", "").upper()
                        if ts == target_eq:
                            token = str(item["symboltoken"])
                            _token_cache[cache_key] = token
                            return token
        except Exception as e:
            logger.warning("searchScrip failed for %s: %s", symbol, e)
        return ""

    def prefetch_tokens(self, symbols: list[str], exchange: str = "NSE") -> dict[str, str]:
        """Pre-fetch and cache tokens for a list of symbols (with rate limiting)."""
        result: dict[str, str] = {}
        for sym in symbols:
            result[sym] = self._get_token(sym, exchange)
        return result

    def get_ltp(self, symbol: str, exchange: str = "NSE") -> float | None:
        """Fetch real-time Last Traded Price for a symbol via Angel One ltpData API."""
        self._ensure_connected()
        if not self._obj:
            return None
        try:
            token = self._get_token(symbol, exchange)
            if not token:
                return None
            resp = self._obj.ltpData(exchange, symbol + "-EQ", token)
            if resp and resp.get("status") and resp.get("data"):
                ltp = resp["data"].get("ltp")
                return float(ltp) if ltp is not None else None
        except Exception as e:
            logger.warning("get_ltp failed for %s: %s", symbol, e)
        return None

    def get_ltp_bulk(self, symbols: list[str], exchange: str = "NSE") -> dict[str, float]:
        """Fetch LTP for multiple symbols (rate-limited between calls)."""
        result: dict[str, float] = {}
        for sym in symbols:
            ltp = self.get_ltp(sym, exchange)
            if ltp is not None:
                result[sym] = ltp
            time.sleep(0.3)  # small delay between LTP calls
        return result

    def place_order(self, params: dict) -> dict:
        """
        params: symbol, token, exchange, side (BUY/SELL), qty, price (0=market),
                order_type (MARKET/LIMIT), product (INTRADAY/DELIVERY/MARGIN),
                asset_type ("stock"|"etf") — ETFs don't get -EQ suffix
        """
        self._ensure_connected()
        if not self._obj:
            raise RuntimeError("Angel One not connected")
        exchange   = params.get("exchange", "NSE")
        is_etf     = params.get("asset_type") == "etf"
        raw_symbol = params["symbol"].replace("-EQ", "").replace("-eq", "")
        # Stocks: tradingsymbol = RELIANCE-EQ; ETFs: tradingsymbol = NIFTYBEES (no -EQ)
        tradingsymbol = raw_symbol if is_etf else raw_symbol + "-EQ"
        symbol_token  = params.get("token") or self._get_token(raw_symbol, exchange, is_etf=is_etf)
        order_params = {
            "variety":         _ORDER_VARIETY_NORMAL,
            "tradingsymbol":   tradingsymbol,
            "symboltoken":     symbol_token,
            "transactiontype": params["side"].upper(),
            "exchange":        exchange,
            "ordertype":       params.get("order_type", _ORDER_MARKET),
            "producttype":     params.get("product", _PRODUCT_DELIVERY),
            "duration":        "DAY",
            "price":           str(params.get("price", "0")),
            "squareoff":       "0",
            "stoploss":        "0",
            "quantity":        str(_i(params["qty"])),
        }
        # Use _postRequest directly so we always get the full response (including error messages).
        # placeOrder() discards the error body and returns None, hiding what actually failed.
        raw = self._obj._postRequest("api.order.place", order_params)
        ok = raw.get("status") or raw.get("success")
        if not ok:
            err_msg = raw.get("message") or raw.get("errorcode") or "Unknown error"
            raise RuntimeError(f"place_order failed for {raw_symbol}: {err_msg}")
        order_data = raw.get("data") or {}
        order_id = order_data if isinstance(order_data, str) else order_data.get("orderid", "")
        return {
            "order_id": str(order_id),
            "broker":   "Angel One",
            "status":   "placed",
            "message":  raw.get("message", "Order placed"),
        }

    def get_positions(self) -> list[dict]:
        self._ensure_connected()
        if not self._obj:
            raise RuntimeError("Angel One not connected")
        resp = self._obj.position()
        if resp is None:
            raise RuntimeError("Angel One returned no response for positions — reconnect")
        if not resp.get("status"):
            # Angel One returns status=false when there are no open positions
            if "no data" in (resp.get("message") or "").lower():
                return []
            raise RuntimeError(f"get_positions failed: {resp.get('message')}")
        raw = resp.get("data") or []
        positions = []
        for p in raw:
            net_qty = _i(p.get("netqty"))
            if net_qty == 0:
                continue  # flat position — skip
            avg_price = _f(p.get("netprice") or p.get("buyavgprice") if net_qty > 0 else p.get("sellavgprice"))
            ltp       = _f(p.get("ltp"))
            unrealised = _f(p.get("unrealised"))
            product   = p.get("producttype", "")
            positions.append({
                "broker":        "Angel One",
                "symbol":        p.get("tradingsymbol", ""),
                "token":         p.get("symboltoken", ""),
                "exchange":      p.get("exchange", "NFO"),
                "instrument":    p.get("instrumenttype", ""),   # OPTIDX, OPTSTK, FUTIDX …
                "strike":        p.get("strikeprice", ""),
                "option_type":   p.get("optiontype", ""),       # CE / PE / ""
                "expiry":        p.get("expirydate", ""),
                "lot_size":      _i(p.get("lotsize") or p.get("boardlotsize") or 1),
                "net_qty":       net_qty,                        # +ve = long, -ve = short
                "avg_price":     avg_price,
                "ltp":           ltp,
                "unrealised":    unrealised,
                "realised":      _f(p.get("realised")),
                "product":       product,
                "side":          "LONG" if net_qty > 0 else "SHORT",
                "close_side":    "SELL" if net_qty > 0 else "BUY",
                "close_qty":     abs(net_qty),
            })
        return positions

    def get_orders(self) -> list[dict]:
        self._ensure_connected()
        if not self._obj:
            raise RuntimeError("Angel One not connected")
        resp = self._obj.orderBook()
        if resp is None or not resp.get("status"):
            return []
        raw = resp.get("data") or []
        return [
            {
                "order_id":   o.get("orderid", ""),
                "broker":     "Angel One",
                "symbol":     o.get("tradingsymbol", ""),
                "exchange":   o.get("exchange", ""),
                "side":       o.get("transactiontype", ""),
                "qty":        _i(o.get("quantity")),
                "price":      _f(o.get("price")),
                "order_type": o.get("ordertype", ""),
                "status":     o.get("orderstatus", ""),
                "time":       o.get("updatetime", ""),
            }
            for o in raw
        ]

    def disconnect(self) -> None:
        if self._cache_key:
            _sc_cache.pop(self._cache_key, None)
        if self._obj:
            try:
                self._obj.terminateSession(self._session.get("client_id", ""))
            except Exception:
                pass
            self._obj = None
        self._session = {}
