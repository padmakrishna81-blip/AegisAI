"""FastAPI application entry point."""

import math
import threading
import time
import numpy as np
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
import json


def convert_numpy(obj):
    """Recursively convert numpy types to Python natives."""
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy(v) for v in obj]
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        v = float(obj)
        return None if (math.isnan(v) or math.isinf(v)) else v
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj

from api.routes import analyze, discover, portfolio, covered_calls, market, ai_advisor, settings, validate, etf, paper_trade, global_stocks, nse_search, cc_strategy, predict, predict_constituents, monitor, strategies, holdings as holdings_routes
from api.routes import auth as auth_routes
from api.routes import cushion_strangle as cushion_strangle_routes
from api.routes import wheel_agent as wheel_agent_routes
from api.routes import broker as broker_routes
from api.routes import market_brain as market_brain_routes
from api.routes import stock_trader as stock_trader_routes
from api.routes import wheel_v2 as wheel_v2_routes

app = FastAPI(
    title="AegisAI",
    description="AI-Powered Investment Intelligence Platform",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analyze.router, prefix="/api", tags=["analyze"])
app.include_router(discover.router, prefix="/api", tags=["discover"])
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
app.include_router(cc_strategy.router, prefix="/api", tags=["cc-strategy"])  # must be before covered_calls
app.include_router(covered_calls.router, prefix="/api", tags=["covered-calls"])
app.include_router(market.router, prefix="/api", tags=["market"])
app.include_router(ai_advisor.router, prefix="/api", tags=["ai"])
app.include_router(settings.router, prefix="/api", tags=["settings"])
app.include_router(validate.router, prefix="/api", tags=["validate"])
app.include_router(etf.router, prefix="/api", tags=["etf"])
app.include_router(paper_trade.router, prefix="/api", tags=["paper-trade"])
app.include_router(auth_routes.router, prefix="/api", tags=["auth"])
app.include_router(global_stocks.router, prefix="/api", tags=["global-stocks"])
app.include_router(nse_search.router, prefix="/api", tags=["nse-search"])
app.include_router(predict.router, prefix="/api", tags=["predict"])
app.include_router(predict_constituents.router, prefix="/api", tags=["predict-constituents"])
app.include_router(monitor.router, prefix="/api", tags=["monitor"])
app.include_router(holdings_routes.router, prefix="/api", tags=["holdings"])
app.include_router(strategies.router, prefix="/api", tags=["strategies"])
app.include_router(cushion_strangle_routes.router, prefix="/api", tags=["cushion-strangle"])
app.include_router(wheel_agent_routes.router, prefix="/api", tags=["wheel-agent"])
app.include_router(broker_routes.router, prefix="/api", tags=["broker"])
app.include_router(market_brain_routes.router, prefix="/api", tags=["market-brain"])
app.include_router(stock_trader_routes.router, prefix="/api", tags=["stock-trader"])
app.include_router(wheel_v2_routes.router,    prefix="/api", tags=["wheel-v2"])


# ── Database initialisation ───────────────────────────────────────────────────

@app.on_event("startup")
async def _startup():
    try:
        from data.db import init_db
        init_db()
    except Exception as e:
        import logging
        logging.getLogger("aegisai").warning(f"DB init skipped: {e}")


# ── Auto-fill actuals scheduler ───────────────────────────────────────────────
# Fires at 15:45 IST (10:15 UTC) on weekdays to evaluate predictions
# against actual closing prices from that session.

IST = timezone(timedelta(hours=5, minutes=30))
_last_fill_date: str = ""


def _auto_fill_loop():
    global _last_fill_date
    while True:
        try:
            now = datetime.now(IST)
            # Only run on weekdays (Mon=0 … Fri=4)
            if now.weekday() < 5:
                h, m = now.hour, now.minute
                # Window: 15:45–16:00 IST — run once per session day
                today = now.date().isoformat()
                if h == 15 and 45 <= m < 60 and _last_fill_date != today:
                    from api.routes.predict import fill_actuals
                    count = fill_actuals(today)
                    _last_fill_date = today
                    print(f"[scheduler] fill_actuals({today}): {count} predictions evaluated")
        except Exception as e:
            print(f"[scheduler] error: {e}")
        time.sleep(60)  # check every minute


_scheduler_thread = threading.Thread(target=_auto_fill_loop, daemon=True)
_scheduler_thread.start()


def _monitor_loop():
    """Check saved strategies every 30 min during NSE market hours (9:15–15:30 IST)."""
    while True:
        try:
            now = datetime.now(IST)
            if now.weekday() < 5:
                h, m = now.hour, now.minute
                if (9 <= h < 15 or (h == 15 and m <= 30)) and m in (0, 30):
                    from data.strategy_monitor import run_monitor_checks
                    results = run_monitor_checks()
                    if results:
                        print(f"[monitor] checked {len(results)} strategies")
        except Exception as e:
            print(f"[monitor] error: {e}")
        time.sleep(60)


threading.Thread(target=_monitor_loop, daemon=True).start()


def _wheel_v2_monitor_loop():
    """Check Smart Wheel V2 positions every 15 min during NSE market hours (9:15–15:30 IST)."""
    import time as _time
    _last_wheel_check = ""
    while True:
        try:
            now = datetime.now(IST)
            if now.weekday() < 5:
                h, m = now.hour, now.minute
                in_market = (9 < h < 15) or (h == 9 and m >= 15) or (h == 15 and m <= 30)
                slot = f"{now.date()}_{h}_{(m // 15) * 15}"
                if in_market and slot != _last_wheel_check:
                    _last_wheel_check = slot
                    from data.wheel_positions import _load_pos
                    data = _load_pos()
                    for username in data:
                        try:
                            from ai.wheel_v2_agent import monitor_all
                            results = monitor_all(username)
                            if results:
                                print(f"[wheel-v2] {username}: {len(results)} position(s) checked")
                        except Exception as ue:
                            print(f"[wheel-v2] {username} error: {ue}")
        except Exception as e:
            print(f"[wheel-v2-monitor] error: {e}")
        _time.sleep(60)


threading.Thread(target=_wheel_v2_monitor_loop, daemon=True).start()


@app.get("/")
async def root():
    return {"message": "AegisAI Investment Intelligence Platform", "version": "1.0.0"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/api/admin/flush-cache")
async def flush_cache():
    """Flush the in-memory yfinance cache. Use when data appears stale or blank after a system cache clear."""
    from data.market_data import flush_cache as _flush
    count = _flush()
    return {"message": f"Cache flushed — {count} entries cleared. Data will reload on next request."}


@app.post("/api/admin/fill-actuals")
async def manual_fill_actuals(session_date: str = ""):
    """Manually trigger fill-actuals for a date (YYYY-MM-DD). Defaults to today."""
    from api.routes.predict import fill_actuals
    from datetime import date
    if not session_date:
        session_date = date.today().isoformat()
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_event_loop()
    count = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), fill_actuals, session_date)
    global _last_fill_date
    _last_fill_date = session_date
    return {"updated": count, "session_date": session_date, "message": f"Filled actuals for {count} predictions"}
