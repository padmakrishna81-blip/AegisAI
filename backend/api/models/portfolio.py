"""Pydantic models for portfolio."""

from pydantic import BaseModel
import uuid


class Holding(BaseModel):
    id: str = ""
    symbol: str
    company_name: str = ""
    quantity: int
    avg_price: float
    current_price: float = 0
    pnl: float = 0
    pnl_pct: float = 0
    health_score: int = 0
    guidance: str = "HOLD"
    covered_call_eligible: bool = False


class HoldingInput(BaseModel):
    symbol: str
    quantity: int
    avg_price: float


class Portfolio(BaseModel):
    holdings: list[Holding] = []
    total_value: float = 0
    total_invested: float = 0
    total_pnl: float = 0
    total_pnl_pct: float = 0
    cash_available: float = 0
    monthly_income_target: float = 30000
    monthly_income_achieved: float = 0


class MonthlyIncomeUpdate(BaseModel):
    amount: float
