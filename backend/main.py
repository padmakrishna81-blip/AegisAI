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

from api.routes import analyze, discover, portfolio, covered_calls, market, ai_advisor, settings, validate, etf, paper_trade, global_stocks, nse_search, cc_strategy, predict
from api.routes import auth as auth_routes

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
