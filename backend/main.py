"""FastAPI application entry point."""

import math
import numpy as np
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

from api.routes import analyze, discover, portfolio, covered_calls, market, ai_advisor, settings, validate, etf, paper_trade, global_stocks, nse_search, cc_strategy
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
# cc_strategy already registered above before covered_calls


@app.get("/")
async def root():
    return {"message": "AegisAI Investment Intelligence Platform", "version": "1.0.0"}


@app.get("/health")
async def health():
    return {"status": "healthy"}
