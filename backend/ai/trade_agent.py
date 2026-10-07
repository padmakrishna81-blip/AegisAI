"""AI Trade Agent — N-chunk equity campaign lifecycle: buy → average → trail → exit → repeat."""
from __future__ import annotations
import math
from datetime import datetime, timezone, timedelta
from typing import Any

from data.stock_trader_store import get_campaign, update_campaign, log_trade

# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULT_CHUNK_CONFIG = {
    "chunks": [
        {"n": 1, "fund_pct": 40},
        {"n": 2, "fund_pct": 40, "averaging_trigger_pct": -3.0, "min_hold_days": 3},
    ]
}
DEFAULT_EXIT_CONFIG = {
    "profit_target_pct": 2.0,
    "trailing_sl_gap_pct": 0.5,
}


def _chunk_config(campaign: dict) -> dict:
    cfg = campaign.get("chunk_config") or {}
    return {"chunks": cfg.get("chunks") or DEFAULT_CHUNK_CONFIG["chunks"]}


def _exit_config(campaign: dict) -> dict:
    return {**DEFAULT_EXIT_CONFIG, **(campaign.get("exit_config") or {})}


def _chunks_placed_count(stock: dict) -> int:
    """How many chunks have been placed for this stock."""
    placed = stock.get("chunks_placed")
    if placed is not None:
        return len(placed)
    # Legacy backward-compat
    status = stock.get("status", "watching")
    if status in ("chunk2_placed", "c2_placed"):
        return 2
    if status in ("chunk1_placed", "c1_placed"):
        return 1
    if status in ("trailing_sl", "exited"):
        # Assume at least chunk1 was placed
        return stock.get("_chunks_placed_count", 1)
    return 0


def _last_chunk_price_date(stock: dict) -> tuple[float, str | None]:
    """Return (price, date) of the last placed chunk."""
    placed = stock.get("chunks_placed")
    if placed:
        last = placed[-1]
        return float(last.get("price", 0)), last.get("date")
    n = _chunks_placed_count(stock)
    if n >= 2:
        return float(stock.get("chunk2_price", 0)), stock.get("chunk2_date")
    if n >= 1:
        return float(stock.get("chunk1_price", 0)), stock.get("chunk1_date")
    return 0.0, None


def _record_chunk(stock: dict, n: int, qty: int, price: float) -> dict:
    """Append a chunk record and recalculate avg_price / total_qty."""
    placed = list(stock.get("chunks_placed") or [])
    placed.append({"n": n, "qty": qty, "price": price,
                   "date": datetime.now(timezone.utc).isoformat()})
    old_qty   = int(stock.get("total_qty") or 0)
    old_avg   = float(stock.get("avg_price") or price)
    new_qty   = old_qty + qty
    new_avg   = (old_qty * old_avg + qty * price) / new_qty if new_qty else price
    return {
        **stock,
        "chunks_placed":       placed,
        "_chunks_placed_count": len(placed),
        "total_qty":           new_qty,
        "avg_price":           round(new_avg, 2),
        f"chunk{n}_qty":       qty,
        f"chunk{n}_price":     price,
        f"chunk{n}_date":      datetime.now(timezone.utc).isoformat(),
    }


# ── Market / broker helpers ───────────────────────────────────────────────────

def _is_market_open() -> bool:
    try:
        import pytz
        now = datetime.now(pytz.timezone("Asia/Kolkata"))
    except ImportError:
        now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    if now.weekday() >= 5:
        return False
    return now.replace(hour=9, minute=15, second=0, microsecond=0) <= now \
        <= now.replace(hour=15, minute=30, second=0, microsecond=0)


def _batch_prices(symbols: list[str]) -> dict[str, float]:
    if not symbols:
        return {}
    try:
        import yfinance as yf
        ns = [s + ".NS" for s in symbols]
        data = yf.download(ns, period="2d", auto_adjust=True,
                           progress=False, threads=True, group_by="ticker")
        out: dict[str, float] = {}
        for sym in symbols:
            try:
                col = sym + ".NS"
                if hasattr(data.columns, "get_level_values") and col in data.columns.get_level_values(0):
                    c = data[col]["Close"].dropna()
                elif "Close" in data.columns:
                    c = data["Close"].dropna()
                else:
                    continue
                if not c.empty:
                    v = float(c.iloc[-1])
                    if not math.isnan(v):
                        out[sym] = round(v, 2)
            except Exception:
                pass
        return out
    except Exception:
        return {}


def _check_funds(campaign: dict) -> dict:
    result: dict = {"available": False, "balance": 0.0, "error": None}
    try:
        from data.broker_creds import get_session
        from brokers import get_broker
        broker   = campaign.get("broker", "angelone")
        session  = get_session(campaign["username"], broker)
        if not session:
            result["error"] = f"Not connected to {broker}"
            return result
        funds = get_broker(broker, session, f"{campaign['username']}:{broker}").get_funds()
        bal   = float(funds.get("net_available", funds.get("available_cash", 0)))
        result.update(available=bal >= float(campaign["reserved_fund"]), balance=bal)
    except Exception as e:
        result["error"] = str(e)
    return result


def get_broker_balance(username: str, broker: str) -> dict:
    """Public helper used by the /broker-balance API endpoint."""
    try:
        from data.broker_creds import get_session
        from brokers import get_broker
        session = get_session(username, broker)
        if not session:
            return {"connected": False, "error": f"Not connected to {broker}"}
        funds = get_broker(broker, session, f"{username}:{broker}").get_funds()
        bal   = float(funds.get("net_available", funds.get("available_cash", 0)))
        return {"connected": True, "broker": broker, "balance": bal, "funds": funds}
    except Exception as e:
        return {"connected": False, "error": str(e)}


def _place_order(campaign: dict, symbol: str, qty: int, side: str = "BUY",
                 limit_price: float = 0.0, asset_type: str = "stock") -> dict:
    if not campaign.get("auto_trade", False):
        return {"success": True, "order_id": f"PAPER-{side}-{symbol}-{qty}", "paper": True}
    try:
        from data.broker_creds import get_session
        from brokers import get_broker
        broker  = campaign.get("broker", "angelone")
        session = get_session(campaign["username"], broker)
        if not session:
            return {"success": False, "error": f"Not connected to {broker}"}
        # Always use LIMIT at CMP — never MARKET
        # ETFs don't use -EQ suffix; stocks do (handled inside broker client)
        params = {
            "symbol": symbol, "token": "", "exchange": "NSE",
            "side": side, "qty": qty,
            "price": round(limit_price, 2) if limit_price > 0 else 0,
            "order_type": "LIMIT" if limit_price > 0 else "MARKET",
            "product": "DELIVERY",
            "asset_type": asset_type,
        }
        r = get_broker(broker, session, f"{campaign['username']}:{broker}").place_order(params)
        return {"success": True, "order_id": r.get("order_id", "")}
    except Exception as e:
        return {"success": False, "error": str(e)}


_BROKER_SESSION_PHRASES = (
    "session may have expired", "unauthorized",
    "invalid token", "token expired", "authentication", "login",
    "not logged in", "session expired",
)

# Errors that look like session errors but are NOT — don't prompt reconnect for these
_NOT_SESSION_PHRASES = (
    "registered ip", "not a registered ip", "ip not allowed",
    "market hours", "not open", "outside market",
)


def _is_session_error(msg: str) -> bool:
    low = (msg or "").lower()
    if any(p in low for p in _NOT_SESSION_PHRASES):
        return False
    return any(p in low for p in _BROKER_SESSION_PHRASES)


def _ensure_broker_session(campaign: dict) -> str | None:
    """Verify broker session; auto-reconnect using stored TOTP seed if expired.
    Returns error string only if reconnect also fails, else None."""
    if not campaign.get("auto_trade", False):
        return None
    try:
        from data.broker_creds import get_session, auto_reconnect, save_session
        from brokers import get_broker
        broker   = campaign.get("broker", "angelone")
        username = campaign["username"]
        session  = get_session(username, broker)

        if not session:
            session = auto_reconnect(username, broker)
            if not session:
                return f"Session expired and auto-reconnect failed — re-enter credentials in Settings."

        # Lightweight live verify
        try:
            get_broker(broker, session, f"{username}:{broker}").get_funds()
        except Exception as e:
            if _is_session_error(str(e)):
                session = auto_reconnect(username, broker)
                if not session:
                    return f"Session invalid and auto-reconnect failed — re-enter credentials in Settings."
            else:
                raise
        return None
    except Exception as e:
        return str(e)


def preview_chunk_orders(campaign_id: str) -> dict:
    """Return the planned orders (qty + limit price) for the next chunk without placing them."""
    campaign = get_campaign(campaign_id)
    if not campaign:
        return {"error": "Campaign not found"}

    cfg        = _chunk_config(campaign)
    chunks     = cfg.get("chunks", [])
    chunk_n    = _chunks_placed_count(campaign) + 1
    if chunk_n > len(chunks):
        return {"error": "All chunks already deployed"}

    chunk_def  = chunks[chunk_n - 1]
    fund_pct   = float(chunk_def.get("fund_pct", 40)) / 100

    # Split fund pool by asset class (backward compat: no split_config = 100% stocks)
    split        = campaign.get("split_config") or {}
    stocks_pct   = float(split.get("stocks_pct", 100)) / 100
    etfs_pct     = float(split.get("etfs_pct", 0)) / 100
    reserved     = float(campaign["reserved_fund"])
    stocks_chunk = reserved * stocks_pct * fund_pct
    etfs_chunk   = reserved * etfs_pct   * fund_pct

    watching = [s for s in campaign.get("stocks", []) if s.get("status") == "watching"]
    if not watching:
        return {"error": "No stocks in watching state"}

    symbols = [s["symbol"] for s in watching]

    # Try live LTP from broker first
    live_prices: dict[str, float] = {}
    if campaign.get("auto_trade", False):
        try:
            from data.broker_creds import get_session
            from brokers import get_broker
            broker  = campaign.get("broker", "angelone")
            session = get_session(campaign["username"], broker)
            if session:
                b = get_broker(broker, session, f"{campaign['username']}:{broker}")
                if hasattr(b, "prefetch_tokens"):
                    b.prefetch_tokens(symbols)
                if hasattr(b, "get_ltp_bulk"):
                    live_prices = b.get_ltp_bulk(symbols)
        except Exception:
            pass

    # Fallback to yfinance
    yf_syms = [s for s in symbols if s not in live_prices]
    if yf_syms:
        for sym, p in _batch_prices(yf_syms).items():
            if sym not in live_prices:
                live_prices[sym] = p

    orders = []
    total_value = 0.0
    for stock in watching:
        sym        = stock["symbol"]
        asset_type = stock.get("asset_type", "stock")
        chunk_val  = stocks_chunk if asset_type != "etf" else etfs_chunk
        alloc = float(stock.get("allocation_pct", 0)) / 100
        val   = chunk_val * alloc
        price = live_prices.get(sym)
        if not price:
            orders.append({"symbol": sym, "error": "Price unavailable"})
            continue
        qty = max(1, int(val / price))
        order_val = round(qty * price, 2)
        total_value += order_val
        orders.append({
            "symbol":      sym,
            "asset_type":  asset_type,
            "allocation":  f"{int(alloc * 100)}%",
            "fund":        round(val, 2),
            "ltp":         round(price, 2),
            "qty":         qty,
            "limit_price": round(price, 2),
            "order_value": order_val,
            "order_type":  "LIMIT",
            "price_source": "live" if sym in live_prices else "delayed",
        })

    return {
        "chunk":       chunk_n,
        "stocks_fund": round(stocks_chunk, 2),
        "etfs_fund":   round(etfs_chunk, 2),
        "chunk_fund":  round(stocks_chunk + etfs_chunk, 2),
        "orders":      orders,
        "total_value": round(total_value, 2),
        "note":        "Limit price = LTP at preview time. Actual order uses LTP at execution time.",
    }


def _entry_condition_met(campaign: dict) -> bool:
    ct = campaign.get("entry_condition", {}).get("type", "manual")
    if ct == "immediately": return True
    if ct == "market_open": return _is_market_open()
    if ct == "manual":      return bool(campaign.get("manual_trigger", False))
    return False


# ── Chunk deployment ──────────────────────────────────────────────────────────

def deploy_chunk(campaign: dict, chunk_n: int = 1,
                 target_symbols: list[str] | None = None) -> dict:
    """
    Deploy chunk_n for all watching stocks (chunk_n=1) or target_symbols (chunk_n>1).
    chunk_n is 1-based.
    """
    cfg     = _chunk_config(campaign)
    chunks  = cfg["chunks"]
    if chunk_n > len(chunks):
        return {"error": f"Campaign only has {len(chunks)} chunk(s) configured"}

    # Pre-check broker session before touching any stock status
    session_err = _ensure_broker_session(campaign)
    if session_err:
        return {"error": "broker_session_expired", "message": session_err}

    chunk_def  = chunks[chunk_n - 1]
    fund_pct   = float(chunk_def.get("fund_pct", 40)) / 100

    # Split fund pool by asset class (backward compat: no split_config = 100% stocks)
    split        = campaign.get("split_config") or {}
    stocks_pct   = float(split.get("stocks_pct", 100)) / 100
    etfs_pct     = float(split.get("etfs_pct", 0)) / 100
    reserved     = float(campaign["reserved_fund"])
    stocks_chunk = reserved * stocks_pct * fund_pct
    etfs_chunk   = reserved * etfs_pct   * fund_pct

    stocks  = campaign.get("stocks", [])
    # For chunk 1: all watching stocks; for chunk N>1: only target_symbols
    if chunk_n == 1:
        to_deploy = [s for s in stocks if s.get("status") == "watching"]
    else:
        to_deploy = [s for s in stocks if s["symbol"] in (target_symbols or [])
                     and s.get("status") not in ("watching", "exited", "error")]

    if not to_deploy:
        return {"deployed": 0, "count": 0, "message": "Nothing to deploy"}

    symbols = [s["symbol"] for s in to_deploy]

    # Fetch live LTP from Angel One broker (real-time); fall back to yfinance
    live_prices: dict[str, float] = {}
    broker_client = None
    if campaign.get("auto_trade", False):
        try:
            from data.broker_creds import get_session
            from brokers import get_broker
            broker  = campaign.get("broker", "angelone")
            session = get_session(campaign["username"], broker)
            if session:
                broker_client = get_broker(broker, session, f"{campaign['username']}:{broker}")
                if hasattr(broker_client, "prefetch_tokens"):
                    broker_client.prefetch_tokens(symbols)
                if hasattr(broker_client, "get_ltp_bulk"):
                    live_prices = broker_client.get_ltp_bulk(symbols)
        except Exception:
            pass

    # Fall back to yfinance for any symbols not resolved via LTP
    yf_symbols = [s for s in symbols if s not in live_prices]
    if yf_symbols:
        yf_prices = _batch_prices(yf_symbols)
        for sym, p in yf_prices.items():
            if sym not in live_prices:
                live_prices[sym] = p

    # Build order preview (qty + limit price per stock)
    preview: list[dict] = []
    for stock in to_deploy:
        sym        = stock["symbol"]
        asset_type = stock.get("asset_type", "stock")
        chunk_val  = stocks_chunk if asset_type != "etf" else etfs_chunk
        alloc = float(stock.get("allocation_pct", 0)) / 100
        val   = chunk_val * alloc
        price = live_prices.get(sym)
        if price:
            qty = max(1, int(val / price))
            preview.append({
                "symbol":      sym,
                "asset_type":  asset_type,
                "allocation":  f"{int(alloc * 100)}%",
                "fund":        round(val, 2),
                "ltp":         round(price, 2),
                "qty":         qty,
                "limit_price": round(price, 2),
                "order_value": round(qty * price, 2),
                "order_type":  "LIMIT",
            })

    total_deployed = 0.0
    updated = list(stocks)

    for i, stock in enumerate(stocks):
        if stock["symbol"] not in symbols:
            continue
        sym        = stock["symbol"]
        asset_type = stock.get("asset_type", "stock")
        chunk_val  = stocks_chunk if asset_type != "etf" else etfs_chunk
        alloc = float(stock.get("allocation_pct", 0)) / 100
        val   = chunk_val * alloc
        price = live_prices.get(sym)
        if not price:
            continue
        qty = max(1, int(val / price))

        order = _place_order(campaign, sym, qty, limit_price=price, asset_type=asset_type)
        if order["success"]:
            total_deployed  += qty * price
            status_label     = f"c{chunk_n}_placed"
            updated[i]       = _record_chunk(stock, chunk_n, qty, price)
            updated[i].update({
                "status":        status_label,
                "current_price": price,
                "pnl":           0.0,
                "pnl_pct":       0.0,
                "sl_price":      0.0,
            })
            log_trade(campaign["id"], {
                "action":   f"CHUNK{chunk_n}_BUY",
                "symbol":   sym,
                "qty":      qty,
                "price":    price,
                "value":    round(qty * price, 2),
                "order_id": order.get("order_id"),
                "paper":    order.get("paper", False),
                "order_type": "LIMIT",
            })
        else:
            err_msg = order.get("error", "")
            if _is_session_error(err_msg):
                update_campaign(campaign["id"], {"stocks": updated})
                return {"error": "broker_session_expired", "message": err_msg}
            updated[i] = {**stock, "status": "error", "error": err_msg}

    # Update campaign
    patch: dict = {
        "stocks":          updated,
        "manual_trigger":  False,
        f"chunk{chunk_n}_deployed": True,
        f"chunk{chunk_n}_date":     datetime.now(timezone.utc).isoformat(),
    }
    if chunk_n == 1:
        existing = float(campaign.get("chunk1_deployed") or 0)
        patch["chunk1_deployed"] = round(existing + total_deployed, 2)
    update_campaign(campaign["id"], patch)
    placed_count = len([s for s in updated if s.get("status") == f"c{chunk_n}_placed"])
    return {
        "deployed":    round(total_deployed, 2),
        "count":       placed_count,
        "chunk":       chunk_n,
        "order_preview": preview,
    }


# ── Monitoring cycle ──────────────────────────────────────────────────────────

def monitor_and_act(campaign: dict) -> list[dict]:
    """One monitoring cycle: update prices, apply averaging / trailing SL / exit."""
    stocks = campaign.get("stocks", [])
    active = [s for s in stocks if s.get("status") not in ("watching", "exited", "error")]
    if not active:
        return []

    cfg       = _chunk_config(campaign)
    ecfg      = _exit_config(campaign)
    max_chunks = len(cfg["chunks"])
    profit_tgt = float(ecfg.get("profit_target_pct", 2.0))
    sl_gap     = float(ecfg.get("trailing_sl_gap_pct", 0.5))

    prices  = _batch_prices([s["symbol"] for s in active])
    actions: list[dict] = []
    updated = list(stocks)

    # Collect stocks that need next chunk
    need_next_chunk: dict[int, list[str]] = {}  # chunk_n -> [symbols]

    for i, stock in enumerate(stocks):
        if stock.get("status") in ("watching", "exited", "error"):
            continue

        sym     = stock["symbol"]
        price   = prices.get(sym)
        if not price:
            continue

        n_placed = _chunks_placed_count(stock)
        avg      = float(stock.get("avg_price") or 0)
        total_q  = int(stock.get("total_qty") or 0)
        if avg <= 0 or total_q <= 0:
            continue

        pnl_pct = (price - avg) / avg * 100
        updated[i] = {
            **stock,
            "current_price": price,
            "pnl_pct":       round(pnl_pct, 2),
            "pnl":           round((price - avg) * total_q, 2),
            "last_checked":  datetime.now(timezone.utc).isoformat(),
        }
        stock = updated[i]
        status = stock.get("status", "")

        # ── Trailing SL: hit → exit ──────────────────────────────────────
        if status == "trailing_sl":
            sl = float(stock.get("sl_price") or 0)
            if sl and price <= sl:
                order = _place_order(campaign, sym, total_q, "SELL")
                if order["success"]:
                    booked = (price - avg) * total_q
                    updated[i] = {**stock, "status": "exited",
                                  "exit_price": price,
                                  "exit_date":  datetime.now(timezone.utc).isoformat(),
                                  "booked_pnl": round(booked, 2)}
                    log_trade(campaign["id"], {
                        "action": "TRAILING_SL_EXIT", "symbol": sym,
                        "qty": total_q, "price": price,
                        "pnl": round(booked, 2), "order_id": order.get("order_id"),
                    })
                    actions.append({"symbol": sym, "action": "EXITED_TRAILING_SL",
                                    "price": price, "pnl_pct": round(pnl_pct, 2)})
                continue
            # Ratchet SL upward
            new_sl = round(max(float(stock.get("sl_price") or 0), price * (1 - sl_gap / 100)), 2)
            if new_sl > float(stock.get("sl_price") or 0):
                updated[i] = {**stock, "sl_price": new_sl}
            continue

        # ── Profit ≥ target → switch to trailing SL ─────────────────────
        if pnl_pct >= profit_tgt:
            # SL = max(avg × (1 + (profit_tgt - sl_gap)/100), price × (1 - sl_gap/100))
            min_lock = avg * (1 + (profit_tgt - sl_gap) / 100)
            sl_price = round(max(min_lock, price * (1 - sl_gap / 100)), 2)
            updated[i] = {**stock, "status": "trailing_sl", "sl_price": sl_price}
            log_trade(campaign["id"], {
                "action": "TRAILING_SL_SET", "symbol": sym,
                "sl_price": sl_price, "current_price": price,
                "pnl_pct": round(pnl_pct, 2),
            })
            actions.append({"symbol": sym, "action": "TRAILING_SL_SET",
                             "sl_price": sl_price, "pnl_pct": round(pnl_pct, 2)})
            continue

        # ── Check if next chunk needed ───────────────────────────────────
        if n_placed < max_chunks:
            next_chunk_def = cfg["chunks"][n_placed]   # 0-indexed = chunk n_placed+1
            trig_pct  = float(next_chunk_def.get("averaging_trigger_pct", -3.0))
            min_days  = int(next_chunk_def.get("min_hold_days", 3))

            last_price, last_date = _last_chunk_price_date(stock)
            if last_price and last_date:
                try:
                    dt   = datetime.fromisoformat(last_date.replace("Z", "+00:00"))
                    days = (datetime.now(timezone.utc) - dt).days
                except Exception:
                    days = 0
                pct_from_last = (price - last_price) / last_price * 100
                if days >= min_days and pct_from_last <= trig_pct:
                    chunk_n = n_placed + 1
                    need_next_chunk.setdefault(chunk_n, []).append(sym)
                    actions.append({"symbol": sym, "action": "FLAGGED_FOR_AVERAGING",
                                    "chunk": chunk_n, "drop_pct": round(pct_from_last, 2)})

    # ── Deploy next chunks for flagged stocks ─────────────────────────────
    for chunk_n, syms in need_next_chunk.items():
        result = deploy_chunk(get_campaign(campaign["id"]), chunk_n=chunk_n, target_symbols=syms)
        for sym in syms:
            actions.append({"symbol": sym, "action": f"CHUNK{chunk_n}_DEPLOYED", **result})
        # Reload campaign after deployment updates
        campaign = get_campaign(campaign["id"]) or campaign
        updated = list(campaign.get("stocks", updated))

    # ── Cycle complete? All placed stocks exited ──────────────────────────
    placed = [s for s in updated if _chunks_placed_count(s) > 0]
    exited = [s for s in placed if s.get("status") == "exited"]
    if placed and len(exited) == len(placed):
        booked = sum(float(s.get("booked_pnl") or 0) for s in exited)
        cycle  = int(campaign.get("cycle") or 1)
        log_trade(campaign["id"], {"action": "CYCLE_COMPLETE", "cycle": cycle,
                                    "booked_pnl": round(booked, 2)})
        reset = [{
            "symbol":       s["symbol"], "display": s.get("display", s["symbol"]),
            "sector":       s.get("sector", ""), "allocation_pct": s.get("allocation_pct", 0),
            "justification": s.get("justification", ""), "conviction": s.get("conviction", ""),
            "asset_type":   s.get("asset_type", "stock"),
            "status":       "watching",
            "chunks_placed": [], "total_qty": 0, "avg_price": 0.0,
            "chunk1_qty": 0, "chunk1_price": 0.0,
            "chunk2_qty": 0, "chunk2_price": 0.0,
            "sl_price": 0.0, "current_price": float(s.get("current_price") or 0),
            "pnl": 0.0, "pnl_pct": 0.0,
        } for s in updated]
        update_campaign(campaign["id"], {
            "stocks": reset, "cycle": cycle + 1,
            "chunk1_deployed": 0, "chunk2_deployed": False,
            "last_cycle_booked_pnl": round(booked, 2),
            "last_cycle_completed":  datetime.now(timezone.utc).isoformat(),
        })
        actions.append({"action": "CYCLE_COMPLETE", "cycle": cycle, "booked_pnl": round(booked, 2)})
        return actions

    update_campaign(campaign["id"], {"stocks": updated})
    return actions


def reset_campaign_errors(campaign_id: str) -> dict:
    """Move all 'error' stocks back to 'watching' so the agent can retry them."""
    campaign = get_campaign(campaign_id)
    if not campaign:
        return {"error": "Campaign not found"}
    updated = []
    count = 0
    for s in campaign.get("stocks", []):
        if s.get("status") == "error":
            updated.append({**s, "status": "watching", "error": None,
                            "chunks_placed": [], "total_qty": 0,
                            "avg_price": 0.0, "sl_price": 0.0,
                            "pnl": 0.0, "pnl_pct": 0.0})
            count += 1
        else:
            updated.append(s)
    update_campaign(campaign_id, {"stocks": updated})
    return {"reset": count}


# ── Fundamentals check ────────────────────────────────────────────────────────

def check_fundamentals(symbol: str) -> dict:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol + ".NS").info
        d2e  = info.get("debtToEquity")
        pm   = info.get("profitMargins")
        eg   = info.get("earningsGrowth")
        concern = bool(
            (d2e and float(d2e) > 200) or
            (pm  and float(pm)  < -0.05) or
            (eg  and float(eg)  < -0.30)
        )
        return {
            "symbol": symbol, "pe_ratio": info.get("trailingPE"),
            "pb_ratio": info.get("priceToBook"), "debt_to_equity": d2e,
            "profit_margins": pm, "earnings_growth": eg,
            "revenue_growth":  info.get("revenueGrowth"),
            "recommendation":  info.get("recommendationKey"),
            "fundamental_concern": concern,
        }
    except Exception as e:
        return {"symbol": symbol, "error": str(e), "fundamental_concern": None}


# ── Monthly report ────────────────────────────────────────────────────────────

def generate_monthly_report(username: str) -> dict:
    from data.stock_trader_store import list_campaigns, get_trade_log, save_monthly_report
    from ai.llm_client import call_llm

    campaigns = list_campaigns(username)
    summary, all_logs = [], []
    for c in campaigns:
        logs = get_trade_log(c["id"])
        all_logs.extend(logs[-30:])
        stocks  = c.get("stocks", [])
        booked  = sum(float(s.get("booked_pnl") or 0) for s in stocks if s.get("status") == "exited")
        unreal  = sum(float(s.get("pnl") or 0) for s in stocks if s.get("status") not in ("exited", "watching", "error"))
        summary.append({
            "name": c.get("name", c["id"]), "status": c.get("status"),
            "reserved_fund": c.get("reserved_fund", 0),
            "cycle": c.get("cycle", 1),
            "booked_pnl": round(booked, 2), "unrealised_pnl": round(unreal, 2),
            "active_positions": len([s for s in stocks if s.get("status") not in ("exited", "watching", "error")]),
        })

    today = datetime.now()
    ym    = today.strftime("%Y-%m")
    mn    = today.strftime("%B %Y")

    prompt = f"""Generate a monthly equity portfolio report for {mn}.
Campaign summary: {summary}
Recent trades (last 20): {all_logs[-20:]}

Write a professional, data-driven monthly report covering:
1. Executive Summary  2. Portfolio Performance  3. Strategy Effectiveness
4. Market Conditions Impact  5. Pending Actions  6. Outlook for next month
Use ₹ for currency. Format with clear headings."""

    try:
        text = call_llm(prompt,
                        system="You are a portfolio analyst. Write a professional monthly report.",
                        max_tokens=2000)
    except Exception as e:
        text = f"Report generation failed: {e}"

    report = {"year_month": ym, "month_name": mn, "campaigns": summary, "report_text": text}
    save_monthly_report(username, ym, report)
    return report


# ── Main entry ────────────────────────────────────────────────────────────────

def run_campaign(campaign_id: str) -> dict:
    """One agent cycle: entry → chunk1 deployment OR monitor existing positions."""
    campaign = get_campaign(campaign_id)
    if not campaign:
        return {"error": "Campaign not found"}

    # Refresh broker session once per cycle — auto-reconnects with stored TOTP seed if expired
    if campaign.get("auto_trade", False):
        session_err = _ensure_broker_session(campaign)
        if session_err:
            return {"error": "broker_session_expired", "message": session_err}

    stocks   = campaign.get("stocks", [])
    watching = [s for s in stocks if s.get("status") == "watching"]
    active   = [s for s in stocks if s.get("status") not in ("watching", "exited", "error")]

    if watching:
        if not active:
            # First deployment — check entry condition and funds
            if not _entry_condition_met(campaign):
                return {"message": "Entry condition not met yet", "actions": []}
            check = _check_funds(campaign)
            if not check["available"] and campaign.get("auto_trade", False):
                if check.get("error") and _is_session_error(check["error"]):
                    return {"error": "broker_session_expired", "message": check["error"]}
                return {"error": f"Insufficient funds. Balance ₹{check['balance']:.0f}, "
                                 f"required ₹{campaign['reserved_fund']:.0f}"}
        # Deploy chunk 1 for all watching stocks (initial or replacement top-up)
        result = deploy_chunk(campaign, chunk_n=1)
        if not active:
            return {"campaign_id": campaign_id, "action": "CHUNK1_DEPLOYED", **result}
        # Refresh campaign so monitoring sees the newly placed stocks
        campaign = get_campaign(campaign_id)
        active   = [s for s in campaign.get("stocks", [])
                    if s.get("status") not in ("watching", "exited", "error")]
        actions  = monitor_and_act(campaign) if active else []
        return {"campaign_id": campaign_id,
                "action": "CHUNK1_TOPUP_AND_MONITOR",
                "chunk1_result": result, "monitor_actions": actions}

    if active:
        actions = monitor_and_act(campaign)
        return {"campaign_id": campaign_id, "actions": actions}

    return {"message": "No active stocks", "actions": []}
