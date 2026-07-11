// All TypeScript interfaces for AegisAI

export interface ScoreBreakdown {
  score: number
  weight: number
  details: Record<string, unknown>
}

export interface TechnicalIndicators {
  sma20: number
  sma50: number
  sma200: number
  rsi: number
  macd: number
  atr_pct: number
}

export interface EntryRange {
  low: number
  high: number
}

export interface Verdict {
  action: 'BUY' | 'HOLD' | 'SELL'
  stars: number
  confidence: number
  entry_range: EntryRange
  target_price: number
  stop_loss: number
  reasons: string[]
  risks: string[]
  summary: string
  ai_powered: boolean
}

export interface Scores {
  company_health: number
  growth_trend: number
  technical_strength: number
  sector_strength: number
  business_events: number
  macro_environment: number
}

export interface NewsItem {
  title: string
  source: string
}

export interface StockAnalysis {
  symbol: string
  company_name: string
  current_price: number
  overall_score: number
  recommendation: 'BUY' | 'HOLD' | 'SELL'
  market_mode: string
  reason: string
  verdict: Verdict
  scores: Scores
  breakdowns: Record<string, Record<string, ScoreBreakdown>>
  technical_indicators: TechnicalIndicators
  entry_range: EntryRange
  recent_news: NewsItem[]
}

export interface ScanResult {
  rank: number
  symbol: string
  company_name: string
  current_price: number
  overall_score: number
  recommendation: string
  reason: string
  scores: Partial<Scores>
}

export interface CompareResult {
  symbols: string[]
  results: StockAnalysis[]
  ai_summary: string
}

export interface Holding {
  id: string
  symbol: string
  company_name: string
  quantity: number
  avg_price: number
  current_price: number
  pnl: number
  pnl_pct: number
  health_score?: number
  guidance?: string
  covered_call_eligible: boolean
}

export interface Portfolio {
  holdings: Holding[]
  total_value: number
  total_invested: number
  total_pnl: number
  total_pnl_pct: number
  cash_available: number
  monthly_income_target: number
  monthly_income_achieved: number
}

export interface MacroResult {
  score: number
  market_mode: string
  breakdown: Record<string, ScoreBreakdown>
}

export interface SectorResult {
  score: number
  sector: string
  breakdown: Record<string, ScoreBreakdown>
}

export interface CoveredCallSuggestion {
  strike: number
  strike_pct_above_spot: number
  premium: number
  premium_per_lot: number
  probability_otm_pct: number
  monthly_yield_pct: number
  days_to_expiry: number
  expiry_date: string
  label: string
  recommendation: string
}

export interface CoveredCallResult {
  symbol: string
  company_name: string
  current_price: number
  implied_volatility_pct: number
  next_expiry: string
  days_to_expiry: number
  suggestions: CoveredCallSuggestion[]
}

export interface AppSettings {
  llm_provider: string
  anthropic_configured: boolean
  openai_configured: boolean
  llm_ready: boolean
}

export type MarketMode = 'STRONG BULL' | 'BULLISH' | 'NEUTRAL' | 'DEFENSIVE' | 'CAPITAL PRESERVATION'
