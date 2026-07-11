"""Pydantic models for stock analysis responses."""

from pydantic import BaseModel
from typing import Any


class ScoreBreakdown(BaseModel):
    score: int
    weight: int
    details: dict[str, Any] = {}


class TechnicalIndicators(BaseModel):
    sma20: float = 0
    sma50: float = 0
    sma200: float = 0
    rsi: float = 0
    macd: float = 0
    atr_pct: float = 0


class EntryRange(BaseModel):
    low: float = 0
    high: float = 0


class VerdictModel(BaseModel):
    action: str = "HOLD"
    stars: int = 3
    confidence: int = 60
    entry_range: EntryRange = EntryRange()
    target_price: float = 0
    stop_loss: float = 0
    reasons: list[str] = []
    risks: list[str] = []
    summary: str = ""
    ai_powered: bool = False


class NewsItem(BaseModel):
    title: str = ""
    source: str = ""


class StockAnalysis(BaseModel):
    symbol: str
    company_name: str = ""
    current_price: float = 0
    overall_score: int = 0
    recommendation: str = "HOLD"
    market_mode: str = "NEUTRAL"
    reason: str = ""
    verdict: VerdictModel = VerdictModel()
    scores: dict[str, int] = {}
    breakdowns: dict[str, dict[str, ScoreBreakdown]] = {}
    technical_indicators: TechnicalIndicators = TechnicalIndicators()
    entry_range: EntryRange = EntryRange()
    recent_news: list[NewsItem] = []


class ScanResult(BaseModel):
    rank: int
    symbol: str
    company_name: str = ""
    current_price: float = 0
    overall_score: int
    recommendation: str
    reason: str = ""
    scores: dict[str, int] = {}


class CompareResult(BaseModel):
    symbols: list[str]
    results: list[ScanResult]
    ai_summary: str = ""
