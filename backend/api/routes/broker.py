"""Broker API endpoints — Angel One SmartAPI + Kotak Neo."""

from __future__ import annotations
import asyncio
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.routes.auth import get_current_user

router = APIRouter()

# In-memory order log: {username: [order_dict, ...]}
_order_log: dict[str, list[dict]] = {}


def _log_order(username: str, order: dict) -> None:
    _order_log.setdefault(username, []).append({
        **order,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def _in_thread(fn):
    """Run a synchronous (blocking) function in a thread pool so it doesn't block the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn)


# ── Pydantic models ───────────────────────────────────────────────────────────

class SaveCredsInput(BaseModel):
    broker: str                     # "angelone" or "kotak"
    creds: dict[str, Any]


class ConnectInput(BaseModel):
    broker: str


class PlaceOrderInput(BaseModel):
    broker: str
    symbol: str
    token: str = ""
    exchange: str = "NSE"
    side: str                       # BUY or SELL
    qty: int
    price: float = 0.0
    order_type: str = "MARKET"      # MARKET or LIMIT
    product: str = "DELIVERY"       # DELIVERY or INTRADAY or CARRYFORWARD


class ClosePositionInput(BaseModel):
    broker: str
    symbol: str
    token: str = ""
    exchange: str = "NFO"
    qty: int                         # abs quantity to close
    side: str                        # BUY or SELL (counter to current position)
    product: str = "CARRYFORWARD"    # CARRYFORWARD for F&O overnight, INTRADAY for MIS


# ── Save credentials (no connect) ─────────────────────────────────────────────

@router.post("/broker/save-credentials")
async def save_credentials(body: SaveCredsInput, user=Depends(get_current_user)):
    from data.broker_creds import save_creds
    if body.broker not in ("angelone", "kotak"):
        return JSONResponse({"error": "broker must be 'angelone' or 'kotak'"}, status_code=400)
    save_creds(user["username"], body.broker, body.creds)
    return {"message": f"Credentials saved for {body.broker}"}


# ── Connect (TOTP login) ───────────────────────────────────────────────────────

@router.post("/broker/connect")
async def connect_broker(body: ConnectInput, user=Depends(get_current_user)):
    from data.broker_creds import get_raw_creds, save_session
    if body.broker not in ("angelone", "kotak"):
        return JSONResponse({"error": "broker must be 'angelone' or 'kotak'"}, status_code=400)

    creds = get_raw_creds(user["username"], body.broker)
    if not creds:
        return JSONResponse(
            {"error": f"No credentials saved for {body.broker}. Save credentials first."},
            status_code=400,
        )

    try:
        broker_name = body.broker
        if broker_name == "angelone":
            from brokers.angel_one import AngelOneClient
            c = AngelOneClient({}, cache_key=f"{user['username']}:{broker_name}")
        else:
            from brokers.kotak_neo import KotakNeoClient
            c = KotakNeoClient({}, cache_key=f"{user['username']}:{broker_name}")

        # connect() makes blocking HTTP calls — run in thread
        session = await _in_thread(lambda: c.connect(creds))
        save_session(user["username"], broker_name, session)
        return {
            "connected": True,
            "broker":    broker_name,
            "expires_at": session.get("expires_at"),
            "message":   f"Connected to {broker_name}",
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ── Status ────────────────────────────────────────────────────────────────────

@router.get("/broker/status")
async def broker_status(user=Depends(get_current_user)):
    from data.broker_creds import get_status
    return get_status(user["username"])


# ── Holdings ──────────────────────────────────────────────────────────────────

@router.get("/broker/holdings")
async def broker_holdings(user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    all_holdings: list[dict] = []
    errors: list[str] = []

    for broker_name in ("angelone", "kotak"):
        session = get_session(user["username"], broker_name)
        if not session:
            continue
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            holdings = await _in_thread(lambda: get_broker(bn, sess, ck).get_holdings())
            all_holdings.extend(holdings)
        except Exception as e:
            errors.append(f"{broker_name}: {e}")

    if not all_holdings and errors:
        return JSONResponse({"error": "; ".join(errors)}, status_code=400)
    return {"holdings": all_holdings, "errors": errors}


# ── Funds ─────────────────────────────────────────────────────────────────────

@router.get("/broker/funds")
async def broker_funds(user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    funds: dict[str, Any] = {}
    errors: list[str] = []

    for broker_name in ("angelone", "kotak"):
        session = get_session(user["username"], broker_name)
        if not session:
            continue
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            funds[broker_name] = await _in_thread(lambda: get_broker(bn, sess, ck).get_funds())
        except Exception as e:
            errors.append(f"{broker_name}: {e}")

    return {"funds": funds, "errors": errors}


# ── Place order ───────────────────────────────────────────────────────────────

@router.post("/broker/place-order")
async def place_order(body: PlaceOrderInput, user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    session = get_session(user["username"], body.broker)
    if not session:
        return JSONResponse(
            {"error": f"Not connected to {body.broker}. Please connect first."},
            status_code=400,
        )

    try:
        bn, sess, ck = body.broker, session, f"{user['username']}:{body.broker}"
        params = {
            "symbol":     body.symbol,
            "token":      body.token,
            "exchange":   body.exchange,
            "side":       body.side,
            "qty":        body.qty,
            "price":      body.price,
            "order_type": body.order_type,
            "product":    body.product,
        }
        result = await _in_thread(lambda: get_broker(bn, sess, ck).place_order(params))
        _log_order(user["username"], result)
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ── Order history (today / this session) ─────────────────────────────────────

@router.get("/broker/orders")
async def broker_orders(user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    all_orders: list[dict] = list(_order_log.get(user["username"], []))

    # Also fetch live order book from connected brokers
    for broker_name in ("angelone", "kotak"):
        session = get_session(user["username"], broker_name)
        if not session:
            continue
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            live = await _in_thread(lambda: get_broker(bn, sess, ck).get_orders())
            all_orders.extend(live)
        except Exception:
            pass

    # Deduplicate by order_id
    seen: set[str] = set()
    deduped: list[dict] = []
    for o in all_orders:
        oid = o.get("order_id", "")
        if oid and oid in seen:
            continue
        if oid:
            seen.add(oid)
        deduped.append(o)

    return {"orders": sorted(deduped, key=lambda x: x.get("time", x.get("timestamp", "")), reverse=True)}


# ── Positions (F&O / intraday) ────────────────────────────────────────────────

@router.get("/broker/positions")
async def broker_positions(user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    all_positions: list[dict] = []
    errors: list[str] = []

    for broker_name in ("angelone", "kotak"):
        session = get_session(user["username"], broker_name)
        if not session:
            continue
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            positions = await _in_thread(lambda: get_broker(bn, sess, ck).get_positions())
            all_positions.extend(positions)
        except Exception as e:
            errors.append(f"{broker_name}: {e}")

    return {"positions": all_positions, "errors": errors}


# ── Close a position (market order, auto-determines side) ─────────────────────

@router.post("/broker/close-position")
async def close_position(body: ClosePositionInput, user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker

    session = get_session(user["username"], body.broker)
    if not session:
        return JSONResponse(
            {"error": f"Not connected to {body.broker}. Please connect first."},
            status_code=400,
        )

    try:
        bn, sess, ck = body.broker, session, f"{user['username']}:{body.broker}"
        params = {
            "symbol":     body.symbol,
            "token":      body.token,
            "exchange":   body.exchange,
            "side":       body.side,
            "qty":        body.qty,
            "price":      0,
            "order_type": "MARKET",
            "product":    body.product,
        }
        result = await _in_thread(lambda: get_broker(bn, sess, ck).place_order(params))
        _log_order(user["username"], {**result, "action": "close_position"})
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ── Sync broker holdings → AegisAI manual holdings ───────────────────────────

@router.post("/broker/sync-to-holdings")
async def sync_to_holdings(user=Depends(get_current_user)):
    from data.broker_creds import get_session
    from brokers import get_broker
    from data.holdings_store import bulk_add

    synced = 0
    for broker_name in ("angelone", "kotak"):
        session = get_session(user["username"], broker_name)
        if not session:
            continue
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            holdings = await _in_thread(lambda: get_broker(bn, sess, ck).get_holdings())
            entries = []
            for h in holdings:
                sym = h["symbol"].replace("-EQ", "")
                entries.append({
                    "symbol":          sym + ".NS",
                    "display_symbol":  sym,
                    "name":            sym,
                    "exchange":        h.get("exchange", "NSE"),
                    "broker":          h["broker"],
                    "account_holder":  "Self",
                    "qty":             h["qty"],
                    "avg_cost":        h["avg_price"],
                    "currency":        "INR",
                    "buy_date":        "",
                    "notes":           f"Synced from {h['broker']}",
                    "is_esop":         False,
                })
            bulk_add(entries)
            synced += len(entries)
        except Exception:
            pass

    return {"synced": synced, "message": f"Synced {synced} holdings to AegisAI"}


# ── Disconnect ────────────────────────────────────────────────────────────────

@router.delete("/broker/disconnect/{broker_name}")
async def disconnect_broker(broker_name: str, user=Depends(get_current_user)):
    from data.broker_creds import get_session, clear_session
    from brokers import get_broker

    if broker_name not in ("angelone", "kotak"):
        return JSONResponse({"error": "Invalid broker name"}, status_code=400)

    session = get_session(user["username"], broker_name)
    if session:
        try:
            bn, sess, ck = broker_name, session, f"{user['username']}:{broker_name}"
            await _in_thread(lambda: get_broker(bn, sess, ck).disconnect())
        except Exception:
            pass
    clear_session(user["username"], broker_name)
    return {"disconnected": broker_name}


# ── NSE Option Chain (index + F&O equity) ────────────────────────────────────

# NSE index symbols — recognised by NSELive.index_option_chain()
_NSE_INDICES = {
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50",
    "SENSEX", "BANKEX", "NIFTY50",
}

# 5-min cache:  key = "SYMBOL"  →  {_ts, data}
_oc_cache: dict[str, dict] = {}
_OC_TTL = 300


def _fetch_chain_raw(symbol: str) -> dict:
    """Return raw NSELive option chain dict for index or equity."""
    import time
    key = symbol.upper()
    cached = _oc_cache.get(key)
    if cached and time.time() - cached["_ts"] < _OC_TTL:
        return cached["data"]

    from jugaad_data.nse import NSELive
    nse = NSELive()
    sym = key.replace("NIFTY 50", "NIFTY").replace("NIFTY50", "NIFTY")
    if sym in _NSE_INDICES:
        data = nse.index_option_chain(sym)
    else:
        data = nse.equities_option_chain(sym)

    _oc_cache[key] = {"_ts": __import__("time").time(), "data": data}
    return data


def _build_chain_response(symbol: str, raw: dict, expiry: str) -> dict:
    """Parse raw NSELive dict into a clean, frontend-friendly response."""
    records = raw.get("records", {})
    all_expiries: list[str] = records.get("expiryDates", [])
    spot = float(records.get("underlyingValue") or 0)

    # Fallback spot from first data row
    if not spot:
        for row in (records.get("data") or []):
            for side in ("CE", "PE"):
                val = row.get(side, {}).get("underlyingValue") or 0
                if val:
                    spot = float(val)
                    break
            if spot:
                break

    # Default expiry = nearest future expiry
    if not expiry and all_expiries:
        expiry = all_expiries[0]

    # Collect strike rows for the chosen expiry
    rows: dict[float, dict] = {}
    for row in (records.get("data") or []):
        if expiry and row.get("expiryDate") != expiry:
            continue
        sk = float(row.get("strikePrice") or 0)
        if sk <= 0:
            continue
        rows.setdefault(sk, {"strike": sk, "CE": None, "PE": None})
        for side in ("CE", "PE"):
            entry = row.get(side)
            if not entry:
                continue
            rows[sk][side] = {
                "ltp":   round(float(entry.get("lastPrice") or 0), 2),
                "iv":    round(float(entry.get("impliedVolatility") or 0), 1),
                "oi":    int(entry.get("openInterest") or 0),
                "oi_chg": int(entry.get("changeinOpenInterest") or 0),
                "vol":   int(entry.get("totalTradedVolume") or 0),
                "bid":   round(float(entry.get("bidprice") or entry.get("bid_price") or 0), 2),
                "ask":   round(float(entry.get("askPrice") or entry.get("ask_price") or 0), 2),
                "pchg":  round(float(entry.get("pChange") or 0), 2),
            }

    sorted_strikes = sorted(rows.values(), key=lambda r: r["strike"])

    # ATM = strike nearest to spot
    if spot and sorted_strikes:
        atm = min(sorted_strikes, key=lambda r: abs(r["strike"] - spot))["strike"]
    elif sorted_strikes:
        atm = sorted_strikes[len(sorted_strikes) // 2]["strike"]
    else:
        atm = 0

    for r in sorted_strikes:
        r["is_atm"] = r["strike"] == atm

    ce_ois = [r["CE"]["oi"] for r in sorted_strikes if r["CE"]]
    pe_ois = [r["PE"]["oi"] for r in sorted_strikes if r["PE"]]

    return {
        "symbol":   symbol.upper(),
        "spot":     spot,
        "expiry":   expiry,
        "expiries": all_expiries,
        "atm":      atm,
        "ce_max_oi": max(ce_ois) if ce_ois else 1,
        "pe_max_oi": max(pe_ois) if pe_ois else 1,
        "strikes":  sorted_strikes,
    }


@router.get("/broker/option-chain")
async def option_chain(
    symbol: str,
    expiry: str = "",
    user=Depends(get_current_user),
):
    """
    Fetch NSE option chain for a given index or F&O equity symbol.
    Returns expiry list, spot, and per-strike CE/PE data.
    """
    try:
        raw  = await _in_thread(lambda: _fetch_chain_raw(symbol))
        data = _build_chain_response(symbol, raw, expiry)
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
