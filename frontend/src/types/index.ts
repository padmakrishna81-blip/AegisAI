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
  high_52w: number | null
  low_52w: number | null
  prev_close?: number | null
  change_inr?: number | null
  change_pct?: number | null
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
  groq_configured: boolean
  llm_ready: boolean
}

export interface StrategyLeg {
  id: string
  type: 'short_put' | 'short_call' | 'long_put' | 'long_call' | 'long_share'
  symbol: string
  strike?: number
  expiry?: string
  dte?: number
  entry_price: number
  current_price: number
  underlying_cmp: number
  lots?: number
  lot_size?: number
  qty?: number
  pnl: number
  is_short: boolean
}

export interface LegAction {
  id: string
  type: string
  symbol: string
  strike: number | null
  action: 'hold' | 'close' | 'roll'
  pnl: number
  pnl_pct: number
  reason: string
}

export interface StrategyReviewResult {
  mode: 'strategy_review'
  strategy_name: string
  overall_action: 'hold' | 'partial_close' | 'close_all' | 'roll' | 'add_hedge'
  confidence: 'high' | 'medium' | 'low'
  total_pnl: number
  pct_of_max: number | null
  leg_actions: LegAction[]
  risk_flags: string[]
  next_trigger: string
  reasoning: string[]
}

export interface MonitoredStrategy {
  id: string
  name: string
  legs: StrategyLeg[]
  saved_at: string
  updated_at: string
  last_checked: string | null
  last_alert: StrategyReviewResult | null
}

export type MarketMode = 'STRONG BULL' | 'BULLISH' | 'NEUTRAL' | 'DEFENSIVE' | 'CAPITAL PRESERVATION'

export interface BrokerHolding {
  broker: string
  symbol: string
  token: string
  exchange: string
  qty: number
  avg_price: number
  ltp: number
  pnl: number
  pnl_pct: number
  product: string
  isin: string
}

export interface BrokerFunds {
  broker: string
  available_cash: number
  used_margin: number
  net: number
  total_margin: number
}

export interface BrokerOrder {
  order_id: string
  broker: string
  symbol: string
  exchange: string
  side: string
  qty: number
  price: number
  order_type: string
  status: string
  time?: string
  timestamp?: string
}

export interface BrokerPosition {
  broker: string
  symbol: string
  token: string
  exchange: string
  instrument: string    // OPTIDX, OPTSTK, FUTIDX, "" for equity intraday
  strike: string
  option_type: string   // CE / PE / ""
  expiry: string
  lot_size: number
  net_qty: number       // positive = long, negative = short
  avg_price: number
  ltp: number
  unrealised: number
  realised: number
  product: string
  side: 'LONG' | 'SHORT'
  close_side: 'BUY' | 'SELL'
  close_qty: number
}

export interface BrokerConnectionStatus {
  configured: boolean
  connected: boolean
  expires_at: string | null
}

export type BrokerStatus = {
  angelone?: BrokerConnectionStatus
  kotak?: BrokerConnectionStatus
}
