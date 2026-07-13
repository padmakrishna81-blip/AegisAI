"""
Paper Trade Engine — fully autonomous chunk-based trading simulator.

Concepts:
  Trade    = a configured plan for one symbol (N chunks)
  Chunk    = a tranche: entry price, allocation %, profit book %
  Order    = a simulated buy or sell triggered when price conditions are met
  Position = live holdings inside a trade (unrealised P&L)

The engine runs a background price-polling loop.
For each ACTIVE trade it checks:
  - Is chunk[n] not yet bought AND current_price <= chunk[n].entry_price?
    → Simulate BUY, record fill price, deduct from virtual cash
  - Is chunk[n] already bought AND current_price >= chunk[n].exit_price?
    → Simulate SELL, record fill price, add to virtual cash, realise P&L
"""

import json, math, os, time, threading
from datetime import datetime
from typing import Optional
import uuid

from data.market_data import get_info, safe_get

# ─── Data file ────────────────────────────────────────────────────────────────
_DATA_DIR  = os.path.join(os.path.dirname(__file__), "..", "..")
_DATA_FILE = os.path.join(_DATA_DIR, "paper_trades.json")

# ─── Per-user file helper ─────────────────────────────────────────────────────
import threading as _threading

_current_username = _threading.local()   # thread-local: set by API before each call


def set_current_user(username: str) -> None:
    """Call from API routes to set the active user for this request thread."""
    _current_username.value = username


def _get_current_user() -> str:
    return getattr(_current_username, "value", "")


def _current_data_file() -> str:
    u = _get_current_user()
    if u and u != "admin":
        return os.path.join(_DATA_DIR, f"paper_trades_{u}.json")
    return _DATA_FILE


def _user_data_file(username: str) -> str:
    if username and username != "admin":
        return os.path.join(_DATA_DIR, f"paper_trades_{username}.json")
    return _DATA_FILE


def load_user_state(username: str) -> None:
    """Reload the engine state from a specific user's data file."""
    global _state
    path = _user_data_file(username)
    with _lock:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    _state = json.load(f)
                return
            except Exception:
                pass
        # First time for this user — fresh state
        _state = {"virtual_cash": 1_000_000, "trades": {}, "orders": [], "positions": {}}


def get_user_summary_data(username: str) -> dict:
    """Return a fresh copy of state for a specific user without modifying _state."""
    path = _user_data_file(username)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {"virtual_cash": 1_000_000, "trades": {}, "orders": [], "positions": {}}

# ─── In-memory state (legacy — kept for backward compat with monitor loop) ────
_state: dict = {
    "virtual_cash": 1_000_000,
    "trades": {},
    "orders": [],
    "positions": {},
}

_lock = threading.Lock()
_monitor_thread: Optional[threading.Thread] = None
_running = False


# ─── Persistence (legacy) ─────────────────────────────────────────────────────

def _load():
    global _state
    if os.path.exists(_DATA_FILE):
        try:
            with open(_DATA_FILE) as f:
                _state = json.load(f)
        except Exception:
            pass


def _save():
    try:
        path = _current_data_file()
        with open(path, "w") as f:
            json.dump(_state, f, indent=2)
    except Exception:
        pass


_load()


# ─── Price fetch ──────────────────────────────────────────────────────────────

def _get_live_price(symbol: str) -> float:
    """Fetch live price bypassing the 15-min cache — used by the monitor loop."""
    import yfinance as yf
    try:
        # fast_info is much lighter than full .info and returns fresh data every call
        t = yf.Ticker(symbol)
        fast = t.fast_info
        price = getattr(fast, "last_price", None) or getattr(fast, "regular_market_price", None)
        if price and float(price) > 0:
            return float(price)
    except Exception:
        pass
    # Fallback to cached info
    from data.market_data import get_info, safe_get
    info = get_info(symbol)
    price = safe_get(info, "currentPrice") or safe_get(info, "regularMarketPrice") or 0
    return float(price)


# ─── Trade management ─────────────────────────────────────────────────────────

def create_trade(
    symbol: str,
    company_name: str,
    total_allocation: float,
    chunks: list[dict],
    notes: str = "",
    mtm_target_pct: float | None = None,
    mtm_target_inr: float | None = None,
) -> dict:
    """
    Create a new paper trade.

    chunks: list of dicts, each:
      {
        "chunk_no": 1,
        "allocation_pct": 40,       # % of total_allocation for this chunk
        "entry_price": 330.0,       # buy if price <= this
        "profit_pct": 8.0,          # sell if price >= entry * (1 + profit_pct/100)
      }
    Returns the trade dict.
    """
    trade_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()

    # Compute entry/exit prices and quantities for each chunk
    enriched_chunks = []
    for c in chunks:
        alloc_amount = total_allocation * c["allocation_pct"] / 100
        entry = float(c["entry_price"])
        profit = float(c["profit_pct"])
        exit_price = round(entry * (1 + profit / 100), 2)
        qty = max(1, math.floor(alloc_amount / entry))
        actual_cost = round(qty * entry, 2)

        enriched_chunks.append({
            "chunk_no": int(c["chunk_no"]),
            "allocation_pct": float(c["allocation_pct"]),
            "allocation_amount": round(alloc_amount, 2),
            "actual_cost": actual_cost,
            "entry_price": entry,
            "exit_price": exit_price,
            "profit_pct": profit,
            "quantity": qty,
            "status": "WAITING",     # WAITING | BOUGHT | SOLD | CANCELLED
            "buy_order_id": None,
            "sell_order_id": None,
            "buy_price": None,
            "sell_price": None,
            "buy_time": None,
            "sell_time": None,
            "realised_pnl": None,
        })

    trade = {
        "trade_id": trade_id,
        "symbol": symbol,
        "company_name": company_name,
        "total_allocation": round(total_allocation, 2),
        "chunks": enriched_chunks,
        "notes": notes,
        "status": "ACTIVE",          # ACTIVE | COMPLETED | CANCELLED | PAUSED
        "created_at": now,
        "started_at": None,
        "completed_at": None,
        "total_realised_pnl": 0.0,
        "mtm_target_pct": round(float(mtm_target_pct), 4) if mtm_target_pct is not None else None,
        "mtm_target_inr": round(float(mtm_target_inr), 2) if mtm_target_inr is not None else None,
    }

    with _lock:
        # Block the full allocation immediately — reserves cash for WAITING chunks
        available = _state["virtual_cash"]
        if available < total_allocation:
            raise ValueError(
                f"Insufficient virtual cash. Available: ₹{available:,.0f}, Required: ₹{total_allocation:,.0f}"
            )
        _state["virtual_cash"] = round(available - total_allocation, 2)
        _state["trades"][trade_id] = trade
        _save()

    return trade


def start_trade(trade_id: str) -> dict:
    """Mark a trade as started — engine begins monitoring."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        trade["status"] = "ACTIVE"
        trade["started_at"] = datetime.now().isoformat()
        _save()
    _ensure_monitor_running()
    return trade


def pause_trade(trade_id: str) -> dict:
    with _lock:
        trade = _state["trades"].get(trade_id)
        if trade:
            trade["status"] = "PAUSED"
            _save()
        return trade


def cancel_trade(trade_id: str) -> dict:
    with _lock:
        trade = _state["trades"].get(trade_id)
        if trade:
            # Protect: cannot cancel if any chunk is already BOUGHT
            bought_chunks = [c for c in trade.get("chunks", []) if c["status"] == "BOUGHT"]
            if bought_chunks:
                raise ValueError(
                    f"Cannot cancel — {len(bought_chunks)} chunk(s) already executed (BOUGHT). "
                    "Exit those positions first, then cancel."
                )
            # Refund the allocation for all WAITING chunks (cash was blocked on creation)
            refund = 0.0
            for c in trade.get("chunks", []):
                if c["status"] == "WAITING":
                    c["status"] = "CANCELLED"
                    refund += float(c.get("allocation_amount", c.get("actual_cost", 0)))
            if refund > 0:
                _state["virtual_cash"] = round(_state["virtual_cash"] + refund, 2)
            trade["status"] = "CANCELLED"
            trade["completed_at"] = datetime.now().isoformat()
            _save()
        return trade


def delete_trade(trade_id: str) -> None:
    """Permanently delete a CANCELLED trade."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        if trade["status"] != "CANCELLED":
            raise ValueError("Only CANCELLED trades can be deleted")
        del _state["trades"][trade_id]
        # Remove associated orders
        _state["orders"] = [o for o in _state["orders"] if o.get("trade_id") != trade_id]
        _save()


def update_chunks(trade_id: str, chunks: list[dict]) -> dict:
    """Modify WAITING chunks only. BOUGHT/SOLD chunks are unchanged."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        if trade["status"] == "CANCELLED":
            raise ValueError("Cannot modify a cancelled trade")

        total_alloc = trade["total_allocation"]
        chunk_map = {c["chunk_no"]: c for c in trade["chunks"]}

        for upd in chunks:
            cn = int(upd["chunk_no"])
            chunk = chunk_map.get(cn)
            if not chunk or chunk["status"] != "WAITING":
                continue
            entry = float(upd.get("entry_price", chunk["entry_price"]))
            profit = float(upd.get("profit_pct", chunk["profit_pct"]))
            alloc_pct = float(upd.get("allocation_pct", chunk["allocation_pct"]))
            alloc_amount = total_alloc * alloc_pct / 100
            qty = max(1, math.floor(alloc_amount / entry))
            chunk.update({
                "entry_price": entry,
                "profit_pct": profit,
                "allocation_pct": alloc_pct,
                "allocation_amount": round(alloc_amount, 2),
                "actual_cost": round(qty * entry, 2),
                "exit_price": round(entry * (1 + profit / 100), 2),
                "quantity": qty,
            })
        _save()
        return trade


def set_mtm_target(trade_id: str,
                   mtm_pct: float | None = None,
                   mtm_inr: float | None = None) -> dict:
    """
    Set a trade-level MTM exit target that overrides individual chunk exit prices.
    mtm_pct: exit all BOUGHT chunks when MTM% of invested cost hits this (negative = stop loss)
    mtm_inr: exit all BOUGHT chunks when MTM in ₹ hits this (negative = stop loss)
    INR takes priority if both set. Set both None to clear (revert to per-chunk exits).
    """
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        trade["mtm_target_pct"] = round(float(mtm_pct), 4) if mtm_pct is not None else None
        trade["mtm_target_inr"] = round(float(mtm_inr), 2) if mtm_inr is not None else None
        _save()
        return trade


def update_chunk_exit_price(trade_id: str, chunk_no: int, new_exit_price: float) -> dict:
    """Edit exit price of a BOUGHT chunk — works even after execution."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        chunk = next((c for c in trade["chunks"] if c["chunk_no"] == chunk_no), None)
        if not chunk:
            raise ValueError(f"Chunk {chunk_no} not found")
        if chunk["status"] not in ("BOUGHT", "WAITING"):
            raise ValueError(f"Chunk {chunk_no} is {chunk['status']} — can only edit BOUGHT or WAITING chunks")
        chunk["exit_price"] = round(float(new_exit_price), 2)
        # Also update profit_pct to reflect the new target
        buy_ref = chunk.get("buy_price") or chunk["entry_price"]
        if buy_ref and buy_ref > 0:
            chunk["profit_pct"] = round((new_exit_price - buy_ref) / buy_ref * 100, 4)
        _save()
        return trade


def manual_buy_chunk(trade_id: str, chunk_no: int) -> dict:
    """Immediately buy a WAITING chunk at current CMP (market buy)."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        chunk = next((c for c in trade["chunks"] if c["chunk_no"] == chunk_no), None)
        if not chunk:
            raise ValueError(f"Chunk {chunk_no} not found")
        if chunk["status"] != "WAITING":
            raise ValueError(f"Chunk {chunk_no} is {chunk['status']} — only WAITING chunks can be manually bought")

    # Get live price outside lock
    cmp = _get_live_price(trade["symbol"])
    if cmp <= 0:
        raise ValueError(f"Could not get live price for {trade['symbol']}")

    with _lock:
        trade = _state["trades"][trade_id]
        chunk = next(c for c in trade["chunks"] if c["chunk_no"] == chunk_no)
        order = _simulate_buy(trade, chunk, cmp)
        _save()
    return {"order": order, "trade": trade}


def manual_exit_chunk(trade_id: str, chunk_no: int) -> dict:
    """Immediately exit a single BOUGHT chunk at current CMP."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        chunk = next((c for c in trade["chunks"] if c["chunk_no"] == chunk_no), None)
        if not chunk:
            raise ValueError(f"Chunk {chunk_no} not found")
        if chunk["status"] != "BOUGHT":
            raise ValueError(f"Chunk {chunk_no} is {chunk['status']} — only BOUGHT chunks can be exited")

    cmp = _get_live_price(trade["symbol"])
    if cmp <= 0:
        raise ValueError(f"Could not get live price for {trade['symbol']}")

    with _lock:
        trade = _state["trades"][trade_id]
        chunk = next(c for c in trade["chunks"] if c["chunk_no"] == chunk_no)
        order = _simulate_sell(trade, chunk, cmp)
        _save()
    return {"order": order, "trade": trade}


def manual_exit_all(trade_id: str) -> dict:
    """Exit ALL BOUGHT chunks in a trade at current CMP."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError(f"Trade {trade_id} not found")
        bought = [c for c in trade["chunks"] if c["status"] == "BOUGHT"]
        if not bought:
            raise ValueError("No executed chunks to exit")
        sym = trade["symbol"]

    cmp = _get_live_price(sym)
    if cmp <= 0:
        raise ValueError(f"Could not get live price for {sym}")

    with _lock:
        trade = _state["trades"][trade_id]
        bought = [c for c in trade["chunks"] if c["status"] == "BOUGHT"]
        orders = [_simulate_sell(trade, chunk, cmp) for chunk in bought]
        _save()
    return {"orders": orders, "trade": trade}


def get_all_trades() -> list[dict]:
    with _lock:
        return list(_state["trades"].values())


def get_trade(trade_id: str) -> dict | None:
    with _lock:
        return _state["trades"].get(trade_id)


def get_orders() -> list[dict]:
    with _lock:
        return list(_state["orders"])


def get_virtual_cash() -> float:
    with _lock:
        return _state["virtual_cash"]


def set_virtual_cash(amount: float) -> None:
    with _lock:
        _state["virtual_cash"] = float(amount)
        _save()


# ─── Simulated order placement ────────────────────────────────────────────────

def _simulate_buy(trade: dict, chunk: dict, fill_price: float) -> dict:
    order_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    qty = chunk["quantity"]
    cost = round(qty * fill_price, 2)

    order = {
        "order_id": order_id,
        "trade_id": trade["trade_id"],
        "symbol": trade["symbol"],
        "side": "BUY",
        "chunk_no": chunk["chunk_no"],
        "quantity": qty,
        "trigger_price": chunk["entry_price"],
        "fill_price": round(fill_price, 2),
        "amount": cost,
        "status": "FILLED",
        "timestamp": now,
    }

    chunk["status"] = "BOUGHT"
    chunk["buy_order_id"] = order_id
    chunk["buy_price"] = round(fill_price, 2)
    chunk["buy_time"] = now
    # Recompute exit based on actual fill price
    chunk["exit_price"] = round(fill_price * (1 + chunk["profit_pct"] / 100), 2)

    # Cash was already blocked when the trade was created (total_allocation deducted).
    # Adjust for any difference between allocated amount and actual fill cost.
    allocated = round(chunk.get("allocation_amount", chunk["actual_cost"]), 2)
    adjustment = round(allocated - cost, 2)  # positive = over-blocked, refund; negative = under-blocked, deduct more
    _state["virtual_cash"] = round(_state["virtual_cash"] + adjustment, 2)
    _state["orders"].append(order)
    return order


def _simulate_sell(trade: dict, chunk: dict, fill_price: float) -> dict:
    order_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    qty = chunk["quantity"]
    proceeds = round(qty * fill_price, 2)
    cost_basis = round(qty * chunk["buy_price"], 2)
    pnl = round(proceeds - cost_basis, 2)
    pnl_pct = round((fill_price / chunk["buy_price"] - 1) * 100, 2)

    order = {
        "order_id": order_id,
        "trade_id": trade["trade_id"],
        "symbol": trade["symbol"],
        "side": "SELL",
        "chunk_no": chunk["chunk_no"],
        "quantity": qty,
        "trigger_price": chunk["exit_price"],
        "fill_price": round(fill_price, 2),
        "amount": proceeds,
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "status": "FILLED",
        "timestamp": now,
    }

    chunk["status"] = "SOLD"
    chunk["sell_order_id"] = order_id
    chunk["sell_price"] = round(fill_price, 2)
    chunk["sell_time"] = now
    chunk["realised_pnl"] = pnl

    _state["virtual_cash"] = round(_state["virtual_cash"] + proceeds, 2)
    _state["orders"].append(order)

    # Update trade total P&L
    trade["total_realised_pnl"] = round(
        sum(c.get("realised_pnl") or 0 for c in trade["chunks"]), 2
    )

    # Check if all chunks are sold → complete the trade
    all_done = all(c["status"] in ("SOLD", "CANCELLED") for c in trade["chunks"])
    if all_done:
        trade["status"] = "COMPLETED"
        trade["completed_at"] = now

    return order


# ─── Monitor loop ─────────────────────────────────────────────────────────────

def _monitor_loop():
    """Background thread: checks prices and fires simulated orders."""
    global _running
    while _running:
        try:
            _tick()
        except Exception:
            pass
        time.sleep(6)  # poll every 6 seconds


def _tick():
    with _lock:
        active_trades = [
            t for t in _state["trades"].values()
            if t["status"] == "ACTIVE"
        ]

    if not active_trades:
        return

    symbols = list({t["symbol"] for t in active_trades})
    prices: dict[str, float] = {}
    for sym in symbols:
        try:
            prices[sym] = _get_live_price(sym)
        except Exception:
            pass

    with _lock:
        for trade in active_trades:
            sym = trade["symbol"]
            price = prices.get(sym)
            if not price:
                continue

            mtm_target_inr = trade.get("mtm_target_inr")
            mtm_target_pct = trade.get("mtm_target_pct")
            has_mtm_target = (mtm_target_inr is not None) or (mtm_target_pct is not None)

            # ── Compute live MTM across all currently BOUGHT chunks ───────────
            bought_chunks = [c for c in trade["chunks"] if c["status"] == "BOUGHT" and c.get("buy_price")]
            if has_mtm_target and bought_chunks:
                total_invested = sum(c["quantity"] * c["buy_price"] for c in bought_chunks)
                total_current  = sum(c["quantity"] * price          for c in bought_chunks)
                live_mtm_inr   = total_current - total_invested
                live_mtm_pct   = (live_mtm_inr / total_invested * 100) if total_invested else 0

                # Check if MTM target is hit (works for profit AND stop-loss)
                mtm_hit = False
                if mtm_target_inr is not None:
                    # Positive target: exit when gain ≥ target
                    # Negative target: exit when loss ≤ target (stop loss)
                    mtm_hit = (live_mtm_inr >= mtm_target_inr) if mtm_target_inr >= 0 \
                              else (live_mtm_inr <= mtm_target_inr)
                elif mtm_target_pct is not None:
                    mtm_hit = (live_mtm_pct >= mtm_target_pct) if mtm_target_pct >= 0 \
                              else (live_mtm_pct <= mtm_target_pct)

                if mtm_hit:
                    # Exit all BOUGHT chunks at current price
                    for chunk in bought_chunks:
                        _simulate_sell(trade, chunk, price)
                    continue  # skip per-chunk exit check for this trade

            # ── Per-chunk entry and exit logic ────────────────────────────────
            for chunk in trade["chunks"]:
                if chunk["status"] == "WAITING":
                    if price <= chunk["entry_price"]:
                        _simulate_buy(trade, chunk, price)

                elif chunk["status"] == "BOUGHT":
                    if price >= chunk["exit_price"]:
                        _simulate_sell(trade, chunk, price)

        _save()


# ─── Covered Call trade creation ──────────────────────────────────────────────

def create_covered_call_trade(
    symbol: str,
    company_name: str,
    phase1_qty: int,
    phase1_limit: float,
    phase2_qty: int,
    phase2_limit: float,
    phase2_trigger: float,
    strike: float,
    expiry: str,
    sell_premium: float,
    premium_income: float,
    lots: int,
    lot_size: int,
    avg_pct: float = 3.0,
    notes: str = "",
) -> dict:
    """
    Create a Covered Call paper trade.
    Phase 1 and Phase 2 are two buy chunks with limit prices.
    Stock exits are MANUAL only (profit_pct=999 prevents auto-exit).
    The short CE option is tracked as metadata only.
    """
    trade_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()

    total_allocation = round(phase1_qty * phase1_limit + phase2_qty * phase2_limit, 2)
    alloc1_pct = round(phase1_qty * phase1_limit / total_allocation * 100, 2)
    alloc2_pct = round(100 - alloc1_pct, 2)

    chunks = [
        {
            "chunk_no": 1,
            "allocation_pct": alloc1_pct,
            "allocation_amount": round(phase1_qty * phase1_limit, 2),
            "actual_cost": round(phase1_qty * phase1_limit, 2),
            "entry_price": round(phase1_limit, 2),
            "exit_price": round(phase1_limit * 999, 2),  # effectively no auto-exit
            "profit_pct": 999.0,
            "quantity": phase1_qty,
            "status": "WAITING",
            "buy_order_id": None, "sell_order_id": None,
            "buy_price": None, "sell_price": None,
            "buy_time": None, "sell_time": None,
            "realised_pnl": None,
            "label": "Phase 1 Entry",
        },
        {
            "chunk_no": 2,
            "allocation_pct": alloc2_pct,
            "allocation_amount": round(phase2_qty * phase2_limit, 2),
            "actual_cost": round(phase2_qty * phase2_limit, 2),
            "entry_price": round(phase2_limit, 2),
            "exit_price": round(phase2_limit * 999, 2),
            "profit_pct": 999.0,
            "quantity": phase2_qty,
            "status": "WAITING",
            "buy_order_id": None, "sell_order_id": None,
            "buy_price": None, "sell_price": None,
            "buy_time": None, "sell_time": None,
            "realised_pnl": None,
            "label": f"Phase 2 Entry (avg trigger ₹{phase2_trigger:.2f})",
        },
    ]

    option_symbol = f"{symbol.replace('.NS','')}{int(strike)}CE"

    trade = {
        "trade_id": trade_id,
        "symbol": symbol,
        "company_name": company_name,
        "total_allocation": total_allocation,
        "chunks": chunks,
        "notes": notes or f"Covered Call — Sell {option_symbol} {expiry}",
        "status": "ACTIVE",
        "trade_type": "COVERED_CALL",
        "created_at": now,
        "started_at": now,
        "completed_at": None,
        "total_realised_pnl": 0.0,
        "mtm_target_pct": None,
        "mtm_target_inr": None,
        "cc_option": {
            "option_symbol": option_symbol,
            "underlying": symbol,
            "strike": strike,
            "expiry": expiry,
            "sell_premium": round(sell_premium, 2),
            "premium_income": round(premium_income, 2),
            "lots": lots,
            "lot_size": lot_size,
            "avg_pct": avg_pct,
            "status": "OPEN",      # OPEN | CLOSED | EXPIRED
            "opened_at": now,
            "closed_at": None,
            "close_premium": None,
            "option_pnl": None,
        },
    }

    with _lock:
        available = _state["virtual_cash"]
        if available < total_allocation:
            raise ValueError(f"Insufficient virtual cash. Available: ₹{available:,.0f}, Required: ₹{total_allocation:,.0f}")
        _state["virtual_cash"] = round(available - total_allocation, 2)
        _state["trades"][trade_id] = trade
        _save()

    return trade


def close_cc_option(trade_id: str, close_premium: float) -> dict:
    """Buy back the short option (CE or PE) at close_premium to close the position."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError("Trade not found")
        tt = trade.get("trade_type")
        wp = trade.get("wheel_phase")
        if tt == "COVERED_CALL":
            opt = trade["cc_option"]
        elif tt == "WHEEL" and wp == "PUT":
            opt = trade["put_option"]
        elif tt == "WHEEL":
            opt = trade.get("cc_option") or {}
        else:
            raise ValueError("Not a covered call or wheel trade")
        if not opt or opt.get("status") != "OPEN":
            raise ValueError("Option position is already closed or not found")
        close_cost = round(close_premium * opt["lots"] * opt["lot_size"], 2)
        pnl = round(opt["premium_income"] - close_cost, 2)
        opt.update({
            "status": "CLOSED",
            "closed_at": datetime.now().isoformat(),
            "close_premium": round(close_premium, 2),
            "option_pnl": pnl,
        })
        _save()
    return trade


def expire_cc_option(trade_id: str) -> dict:
    """Mark option as expired worthless — full premium income is P&L."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError("Trade not found")
        tt = trade.get("trade_type")
        wp = trade.get("wheel_phase")
        if tt == "COVERED_CALL":
            opt = trade["cc_option"]
        elif tt == "WHEEL" and wp == "PUT":
            opt = trade["put_option"]
        elif tt == "WHEEL":
            opt = trade.get("cc_option") or {}
        else:
            raise ValueError("Not a covered call or wheel trade")
        if not opt or opt.get("status") != "OPEN":
            raise ValueError("Option position is already closed or not found")
        opt.update({
            "status": "EXPIRED",
            "closed_at": datetime.now().isoformat(),
            "close_premium": 0.0,
            "option_pnl": opt["premium_income"],
        })
        _save()
    return trade


# ─── Wheel Strategy trade creation ────────────────────────────────────────────

def create_wheel_trade(
    symbol: str, company_name: str,
    put_strike: float, put_expiry: str,
    put_premium: float, put_premium_income: float,
    lots: int, lot_size: int,
    planned_call_strike: float, planned_call_expiry: str, planned_call_premium: float,
    assignment_limit: float, phase2_pct: float = 3.0, notes: str = "",
) -> dict:
    """
    Phase 1 (CSP): Sell put → collect premium.
    Phase 2 (CC):  If assigned, own stock → sell covered call.
    """
    trade_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    total_contract_value = round(put_strike * lots * lot_size, 2)
    effective_buy = round(put_strike - put_premium, 2)
    half_qty = (lots * lot_size) // 2
    phase2_trigger = round(effective_buy * (1 - phase2_pct / 100), 2)

    trade = {
        "trade_id": trade_id, "symbol": symbol, "company_name": company_name,
        "total_allocation": total_contract_value,
        "chunks": [],
        "notes": notes or f"Wheel — Sell {symbol.replace('.NS','')}{int(put_strike)}PE {put_expiry}",
        "status": "ACTIVE", "trade_type": "WHEEL", "wheel_phase": "PUT",
        "created_at": now, "started_at": now, "completed_at": None,
        "total_realised_pnl": 0.0, "mtm_target_pct": None, "mtm_target_inr": None,
        "put_option": {
            "option_symbol": f"{symbol.replace('.NS','')}{int(put_strike)}PE",
            "underlying": symbol, "strike": put_strike, "expiry": put_expiry,
            "sell_premium": round(put_premium, 2),
            "premium_income": round(put_premium_income, 2),
            "lots": lots, "lot_size": lot_size,
            "status": "OPEN", "opened_at": now, "closed_at": None,
            "close_premium": None, "option_pnl": None,
        },
        "planned_cc": {
            "strike": planned_call_strike, "expiry": planned_call_expiry,
            "premium": planned_call_premium,
        },
        "stock_config": {
            "assignment_limit": assignment_limit, "effective_buy": effective_buy,
            "half_qty": half_qty, "phase2_trigger": phase2_trigger, "phase2_pct": phase2_pct,
        },
        "cc_option": None,
        "total_put_premium": round(put_premium_income, 2),
        "total_call_premium": 0.0,
    }
    with _lock:
        available = _state["virtual_cash"]
        # For Wheel, block margin (SPAN ~12%) not full contract value
        # User's total_allocation is the margin needed for the short put
        margin_block = round(put_strike * lots * lot_size * 0.12, 2)
        if available < margin_block:
            raise ValueError(f"Insufficient virtual cash for margin. Available: ₹{available:,.0f}, Required: ₹{margin_block:,.0f}")
        _state["virtual_cash"] = round(available - margin_block, 2)
        trade["margin_blocked"] = margin_block
        _state["trades"][trade_id] = trade
        _save()
    return trade


def wheel_assign_put(trade_id: str, call_strike: float, call_expiry: str, call_premium: float) -> dict:
    """Trigger PUT assignment → create stock chunks + open CC leg."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade or trade.get("trade_type") != "WHEEL":
            raise ValueError("Not a wheel trade")
        if trade["wheel_phase"] != "PUT":
            raise ValueError("Wheel is not in PUT phase")
        now = datetime.now().isoformat()
        cfg = trade["stock_config"]
        lots = trade["put_option"]["lots"]
        lot_size = trade["put_option"]["lot_size"]
        half_qty = cfg["half_qty"]
        remaining_qty = lots * lot_size - half_qty
        effective_buy = cfg["effective_buy"]
        phase2_trigger = cfg["phase2_trigger"]

        trade["put_option"].update({"status": "ASSIGNED", "closed_at": now,
                                    "option_pnl": trade["put_option"]["premium_income"]})
        total_alloc = round(half_qty * effective_buy + remaining_qty * phase2_trigger, 2)
        alloc1_pct = round(half_qty * effective_buy / total_alloc * 100, 2)
        alloc2_pct = round(100 - alloc1_pct, 2)
        trade["chunks"] = [
            {"chunk_no": 1, "label": "Phase 1 (Put Assigned)",
             "allocation_pct": alloc1_pct, "allocation_amount": round(half_qty * effective_buy, 2),
             "actual_cost": round(half_qty * effective_buy, 2), "entry_price": round(effective_buy, 2),
             "exit_price": round(effective_buy * 999, 2), "profit_pct": 999.0, "quantity": half_qty,
             "status": "WAITING", "buy_order_id": None, "sell_order_id": None,
             "buy_price": None, "sell_price": None, "buy_time": None, "sell_time": None, "realised_pnl": None},
            {"chunk_no": 2, "label": f"Phase 2 (avg ₹{phase2_trigger:.2f})",
             "allocation_pct": alloc2_pct, "allocation_amount": round(remaining_qty * phase2_trigger, 2),
             "actual_cost": round(remaining_qty * phase2_trigger, 2), "entry_price": round(phase2_trigger, 2),
             "exit_price": round(phase2_trigger * 999, 2), "profit_pct": 999.0, "quantity": remaining_qty,
             "status": "WAITING", "buy_order_id": None, "sell_order_id": None,
             "buy_price": None, "sell_price": None, "buy_time": None, "sell_time": None, "realised_pnl": None},
        ]
        trade["total_allocation"] = total_alloc
        prem_income = round(call_premium * lots * lot_size, 2)
        trade["cc_option"] = {
            "option_symbol": f"{trade['symbol'].replace('.NS','')}{int(call_strike)}CE",
            "underlying": trade["symbol"], "strike": call_strike, "expiry": call_expiry,
            "sell_premium": round(call_premium, 2), "premium_income": prem_income,
            "lots": lots, "lot_size": lot_size,
            "status": "OPEN", "opened_at": now, "closed_at": None, "close_premium": None, "option_pnl": None,
        }
        trade["total_call_premium"] = round(trade.get("total_call_premium", 0) + prem_income, 2)
        trade["wheel_phase"] = "COVERED_CALL"
        _save()
    return trade


def cancel_wheel_put(trade_id: str) -> dict:
    """Cancel a WHEEL trade that is still in PUT phase (no stock bought yet).
    Refunds the margin cash that was blocked on creation and marks trade CANCELLED.
    """
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade:
            raise ValueError("Trade not found")
        if trade.get("trade_type") != "WHEEL":
            raise ValueError("Not a wheel trade")
        if trade.get("wheel_phase") != "PUT":
            raise ValueError("Can only cancel while in PUT phase — stock already assigned, exit manually")
        opt = trade.get("put_option", {})
        if opt.get("status") != "OPEN":
            raise ValueError("Put is not OPEN — already closed or expired")
        # Refund the blocked margin (total_allocation was blocked on creation)
        refund = float(trade.get("total_allocation", 0))
        if refund > 0:
            _state["virtual_cash"] = round(_state["virtual_cash"] + refund, 2)
        opt["status"] = "CANCELLED"
        trade["status"] = "CANCELLED"
        trade["completed_at"] = datetime.now().isoformat()
        _save()
    return trade


def wheel_expire_put(trade_id: str) -> dict:
    """Put expires worthless → keep premium, reset to PUT phase for next spin."""
    with _lock:
        trade = _state["trades"].get(trade_id)
        if not trade or trade.get("trade_type") != "WHEEL":
            raise ValueError("Not a wheel trade")
        opt = trade["put_option"]
        if opt["status"] != "OPEN":
            raise ValueError("Put is not OPEN")
        now = datetime.now().isoformat()
        opt.update({"status": "EXPIRED", "closed_at": now, "close_premium": 0.0,
                    "option_pnl": opt["premium_income"]})
        trade["total_realised_pnl"] = round(trade.get("total_realised_pnl", 0) + opt["premium_income"], 2)
        trade["wheel_phase"] = "PUT"
        _save()
    return trade


def _ensure_monitor_running():
    global _monitor_thread, _running
    if _monitor_thread and _monitor_thread.is_alive():
        return
    _running = True
    _monitor_thread = threading.Thread(target=_monitor_loop, daemon=True)
    _monitor_thread.start()


def stop_monitor():
    global _running
    _running = False


# Start monitor on import if there are active trades
if any(t.get("status") == "ACTIVE" for t in _state.get("trades", {}).values()):
    _ensure_monitor_running()
