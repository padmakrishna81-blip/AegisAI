import { useState, useMemo, useEffect, useRef } from 'react'
import {
  ComposedChart, Line, ReferenceLine, ReferenceDot, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import NseStockSearch from '../components/NseStockSearch'
import client from '../api/client'

// ─── Types ───────────────────────────────────────────────────────────────────

interface OptionLeg {
  id: string
  type: 'CE' | 'PE'
  strike: number
  premium: number
  lots: number
  lotSize: number
  exitPremium: string
  liveOptPrice: string  // current market price of this option leg (for IV calibration)
}

interface ShareLeg {
  id: string
  label: string
  qty: number
  buyPrice: number
  exitPrice: string
}

interface SavedStrategy {
  id: string
  name: string
  savedAt: string
  symbol: string
  symbolDisplay: string
  cmpStr: string
  ivStr: string
  dteStr: string
  defaultLotSize: number
  options: OptionLeg[]
  shares: ShareLeg[]
}

interface PredictionDay {
  day: number
  price_low: number
  price_point: number
  price_high: number
  sigma_pct: number
  pnl_low: number
  pnl_point: number
  pnl_high: number
  pnl_expiry_low: number
  pnl_expiry_point: number
  pnl_expiry_high: number
  opt_pnl: number
  sh_pnl: number
  prob_profit: number
  confidence: 'high' | 'medium' | 'low'
}

interface PredictResult {
  symbol: string
  cmp: number
  analysis: {
    tech_bias: number
    news_bias: number
    market_bias: number
    global_bias: number
    combined_bias: number
    outlook: string
    rsi: number
    sma20: number
    trend_5d: number
    tech_signals: string[]
    news_count: number
    news_summary: string
    top_headlines: string[]
    market_summary: string
    global_summary: string
    nifty_5d_pct: number
  }
  predictions: PredictionDay[]
}

// ─── P&L helpers ─────────────────────────────────────────────────────────────

function legOptionPnl(o: OptionLeg, price: number): number {
  const qty = o.lots * o.lotSize
  const ep = o.exitPremium !== '' ? +o.exitPremium : null
  if (ep != null && !isNaN(ep)) return Math.round((o.premium - ep) * qty)
  const intr = o.type === 'CE' ? Math.max(0, price - o.strike) : Math.max(0, o.strike - price)
  return Math.round((o.premium - intr) * qty)
}

function legOptionMidPnl(o: OptionLeg, price: number, tRem: number, iv: number): number {
  const qty = o.lots * o.lotSize
  const ep = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
  if (ep != null) return Math.round((o.premium - ep) * qty)
  return Math.round((o.premium - bsPrice(price, o.strike, iv, Math.max(0, tRem), o.type === 'CE')) * qty)
}

function legSharePnl(s: ShareLeg, price: number): number {
  const ep = s.exitPrice !== '' ? +s.exitPrice : null
  if (ep != null && !isNaN(ep)) return Math.round((ep - s.buyPrice) * s.qty)
  return Math.round((price - s.buyPrice) * s.qty)
}

function pnlAt(price: number, options: OptionLeg[], shares: ShareLeg[]) {
  const opPnl = options.reduce((s, o) => s + legOptionPnl(o, price), 0)
  const shPnl = shares.reduce((s, sh) => s + legSharePnl(sh, price), 0)
  return { opPnl, shPnl, total: opPnl + shPnl }
}

// livePrices: optionId → current market price; used instead of BS when provided
function midPnlAt(
  price: number, tRem: number, iv: number,
  options: OptionLeg[], shares: ShareLeg[],
  livePrices?: Record<string, number>,
): number {
  let total = 0
  for (const o of options) {
    const qty = o.lots * o.lotSize
    const ep = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
    if (ep != null) { total += Math.round((o.premium - ep) * qty); continue }
    const lp = livePrices?.[o.id]
    total += lp !== undefined
      ? Math.round((o.premium - lp) * qty)
      : Math.round((o.premium - bsPrice(price, o.strike, iv, Math.max(0, tRem), o.type === 'CE')) * qty)
  }
  for (const s of shares) {
    const ep = s.exitPrice !== '' && !isNaN(+s.exitPrice) ? +s.exitPrice : null
    total += ep != null
      ? Math.round((ep - s.buyPrice) * s.qty)
      : Math.round((price - s.buyPrice) * s.qty)
  }
  return total
}

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt = (n: number, dec = 0) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })

const fmtRs = (n: number, dec = 0) => n < 0 ? `-₹${fmt(Math.abs(n), dec)}` : `₹${fmt(n, dec)}`
const clr    = (v: number) => v >= 0 ? 'text-emerald-400' : 'text-red-400'

function xFmt(v: number) {
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`
  if (v >= 10000)  return `₹${(v / 1000).toFixed(0)}k`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
function yFmt(v: number) {
  const abs = Math.abs(v), sign = v < 0 ? '-' : '+'
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`
  if (abs >= 1000)   return `${sign}₹${(abs / 1000).toFixed(0)}k`
  return `${sign}₹${abs}`
}

// ─── Black-Scholes (client-side) ────────────────────────────────────────────

function _erf(x: number): number {
  const sign = x >= 0 ? 1 : -1; x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return sign * y
}
function _ncdf(x: number) { return (1 + _erf(x / Math.sqrt(2))) / 2 }
function _npdf(x: number) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) }
function _bsD1(S: number, K: number, iv: number, T: number, r = 0.065) {
  const sigma = iv / 100
  if (sigma <= 0 || T <= 0 || S <= 0 || K <= 0) return 0
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
}
function bsPrice(S: number, K: number, iv: number, T: number, isCall: boolean, r = 0.065): number {
  if (T <= 0) return isCall ? Math.max(0, S - K) : Math.max(0, K - S)
  const d1 = _bsD1(S, K, iv, T, r), d2 = d1 - (iv / 100) * Math.sqrt(T)
  return isCall
    ? S * _ncdf(d1) - K * Math.exp(-r * T) * _ncdf(d2)
    : K * Math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1)
}
function bsDelta(S: number, K: number, iv: number, T: number, isCall: boolean, r = 0.065): number {
  if (T <= 0) return isCall ? (S >= K ? 1 : 0) : (S <= K ? -1 : 0)
  const d1 = _bsD1(S, K, iv, T, r)
  return isCall ? _ncdf(d1) : _ncdf(d1) - 1
}
function bsGamma(S: number, K: number, iv: number, T: number, r = 0.065): number {
  if (T <= 0) return 0
  const d1 = _bsD1(S, K, iv, T, r)
  return _npdf(d1) / (S * (iv / 100) * Math.sqrt(T))
}
function bsTheta(S: number, K: number, iv: number, T: number, isCall: boolean, r = 0.065): number {
  if (T <= 0) return 0
  const sigma = iv / 100, d1 = _bsD1(S, K, iv, T, r), d2 = d1 - sigma * Math.sqrt(T)
  const base = -(S * _npdf(d1) * sigma) / (2 * Math.sqrt(T))
  return isCall
    ? (base - r * K * Math.exp(-r * T) * _ncdf(d2)) / 365
    : (base + r * K * Math.exp(-r * T) * _ncdf(-d2)) / 365
}
function bsVega(S: number, K: number, iv: number, T: number, r = 0.065): number {
  if (T <= 0) return 0
  return S * _npdf(_bsD1(S, K, iv, T, r)) * Math.sqrt(T) / 100
}
// Newton-Raphson implied vol solver — returns IV in % (same unit as ivStr), or null on failure
function impliedVol(S: number, K: number, T: number, target: number, isCall: boolean, r = 0.065): number | null {
  if (T <= 0 || S <= 0 || K <= 0 || target < 0) return null
  const intr = isCall ? Math.max(0, S - K) : Math.max(0, K - S)
  if (target < intr - 0.5) return null   // below intrinsic — impossible
  let iv = 30                             // start at 30% IV
  for (let i = 0; i < 100; i++) {
    const p = bsPrice(S, K, iv, T, isCall, r)
    const v = bsVega(S, K, iv, T, r)     // ₹ per 1% change in IV
    const d = p - target
    if (Math.abs(d) < 0.005) break
    iv = Math.max(1, Math.min(300, Math.abs(v) < 1e-8 ? iv + (d > 0 ? -1 : 1) : iv - d / v))
  }
  return Math.abs(bsPrice(S, K, iv, T, isCall, r) - target) < 0.5
    ? Math.round(iv * 10) / 10
    : null
}

// ─── Chart tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, options, shares, cmp, targetDays, ivStr, dteStr, calibratedIv }: any) {
  if (!active || !payload?.length) return null
  const price  = label as number
  const iv     = (calibratedIv as number | null) ?? (parseFloat(ivStr) || 22)
  const dte    = parseInt(dteStr)  || 37
  const tRem   = Math.max(0, (dte - (targetDays ?? 0)) / 365)

  // Per-leg rows using BS mid-cycle (matches the blue "On Target Date" line)
  const optRows = options.map((o: OptionLeg) => ({
    label: `${o.type} ${fmt(o.strike)} ×${o.lots * o.lotSize}`,
    val: legOptionMidPnl(o, price, tRem, iv),
  }))
  const shRows = shares.map((s: ShareLeg) => ({ label: s.label, val: legSharePnl(s, price) }))

  // Both totals from the chart data payload
  const targetPnl = payload.find((p: any) => p.dataKey === 'target')?.value as number | undefined
  const expiryPnl = payload.find((p: any) => p.dataKey === 'total')?.value  as number | undefined

  // Price % change from CMP
  const pricePct = !isNaN(cmp) && cmp > 0 ? ((price - cmp) / cmp * 100) : null

  // Target date label
  const today  = new Date()
  const tDate  = new Date(today); tDate.setDate(today.getDate() + (targetDays ?? 0))
  const fmtD   = (d: Date) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  const expDate = new Date(today); expDate.setDate(today.getDate() + dte)

  return (
    <div className="bg-[#0d1425] border border-[#1e2d40] rounded-xl px-4 py-3 text-xs shadow-2xl min-w-52">
      {/* Header */}
      <div className="flex items-baseline gap-2 mb-2.5">
        <span className="text-white font-semibold text-sm">₹{fmt(price)}</span>
        {pricePct != null && (
          <span className={`text-[10px] font-medium tabular-nums ${pricePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pricePct >= 0 ? '+' : ''}{pricePct.toFixed(2)}%
          </span>
        )}
      </div>
      {/* Per-leg breakdown */}
      {optRows.map((r: any, i: number) => (
        <div key={i} className="flex justify-between gap-4 mb-1">
          <span className="text-slate-400">{r.label}</span>
          <span className={`font-bold ${clr(r.val)}`}>{fmtRs(r.val)}</span>
        </div>
      ))}
      {shRows.map((r: any, i: number) => (
        <div key={i} className="flex justify-between gap-4 mb-1">
          <span className="text-slate-400">{r.label}</span>
          <span className={`font-bold ${clr(r.val)}`}>{fmtRs(r.val)}</span>
        </div>
      ))}
      {/* Expected P&L — both dates */}
      <div className="border-t border-[#1e2d40] mt-2 pt-2 space-y-1.5">
        <div className="text-[9px] text-slate-500 uppercase tracking-wide mb-1.5">Expected P&L on</div>
        {targetPnl != null && (
          <div className="flex justify-between gap-4 items-center">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-0.5 bg-blue-500 rounded" />
              <span className="text-blue-400 font-medium">{fmtD(tDate)}</span>
            </div>
            <span className={`font-bold text-sm ${clr(targetPnl)}`}>
              {targetPnl >= 0 ? '+' : ''}{fmtRs(targetPnl)}
            </span>
          </div>
        )}
        {expiryPnl != null && (
          <div className="flex justify-between gap-4 items-center">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-0.5 bg-emerald-500 rounded" />
              <span className="text-emerald-400 font-medium">{fmtD(expDate)}</span>
            </div>
            <span className={`font-bold text-sm ${clr(expiryPnl)}`}>
              {expiryPnl >= 0 ? '+' : ''}{fmtRs(expiryPnl)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Reusable number input ────────────────────────────────────────────────────

function Inp({ label, value, onChange, placeholder, className = '' }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; className?: string
}) {
  return (
    <div className={className}>
      <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
      />
    </div>
  )
}

// ─── AI prediction sub-components ────────────────────────────────────────────

function BiasChip({ bias }: { bias: number }) {
  if (bias > 0.15) return <span className="text-[9px] bg-emerald-950 border border-emerald-800/60 text-emerald-400 px-1.5 py-0.5 rounded-full">Bullish</span>
  if (bias < -0.15) return <span className="text-[9px] bg-red-950 border border-red-800/60 text-red-400 px-1.5 py-0.5 rounded-full">Bearish</span>
  return <span className="text-[9px] bg-slate-800 border border-slate-600/60 text-slate-400 px-1.5 py-0.5 rounded-full">Neutral</span>
}

function BiasBar({ bias }: { bias: number }) {
  const pct = ((bias + 1) / 2 * 100).toFixed(1)
  const dot = bias > 0.15 ? 'bg-emerald-400' : bias < -0.15 ? 'bg-red-400' : 'bg-slate-400'
  return (
    <div className="relative h-1.5 bg-[#1e2d40] rounded-full mt-2 mb-1">
      <div className="absolute top-1/2 left-1/2 -translate-x-px -translate-y-1/2 w-px h-2.5 bg-slate-600" />
      <div className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${dot} border-2 border-[#0d1425]`}
        style={{ left: `calc(${pct}% - 6px)` }} />
    </div>
  )
}

function PredCard({ p }: { p: PredictionDay }) {
  const confClr = p.confidence === 'high' ? 'text-emerald-400' : p.confidence === 'medium' ? 'text-amber-400' : 'text-slate-500'
  const popClr  = p.prob_profit >= 60 ? 'text-emerald-400' : p.prob_profit >= 40 ? 'text-amber-400' : 'text-red-400'
  const popBorder = p.prob_profit >= 60 ? 'border-emerald-800/40 bg-emerald-950/30' : p.prob_profit >= 40 ? 'border-amber-800/40 bg-amber-950/30' : 'border-red-800/40 bg-red-950/20'
  const rows = [
    { icon: '↑', label: 'High', price: p.price_high,  pnl: p.pnl_high,  exp: p.pnl_expiry_high,  bg: 'bg-emerald-950/15', pc: 'text-emerald-400' },
    { icon: '●', label: 'Base', price: p.price_point, pnl: p.pnl_point, exp: p.pnl_expiry_point, bg: 'bg-slate-800/20',   pc: 'text-white'       },
    { icon: '↓', label: 'Low',  price: p.price_low,   pnl: p.pnl_low,   exp: p.pnl_expiry_low,   bg: 'bg-red-950/15',     pc: 'text-red-400'     },
  ]
  return (
    <div className="min-w-[215px] max-w-[240px] bg-[#0d1425] border border-[#1e2d40] rounded-xl p-3 shrink-0">
      {/* Title row */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-sm font-bold text-white">Day {p.day}</span>
        <span className={`text-[9px] uppercase tracking-wide ${confClr}`}>{p.confidence}</span>
      </div>
      <div className="text-[9px] text-slate-500 mb-2">±{p.sigma_pct}% σ range</div>

      {/* Probability of profit */}
      <div className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 mb-3 border ${popBorder}`}>
        <span className="text-[9px] text-slate-400">Prob. Profit</span>
        <span className={`text-sm font-bold ${popClr}`}>{p.prob_profit}%</span>
      </div>

      {/* Column headers */}
      <div className="flex justify-end gap-3 text-[8px] text-slate-600 mb-1 pr-0.5">
        <span className="w-[52px] text-right">MTM</span>
        <span className="w-[52px] text-right">Expiry</span>
      </div>

      {/* Scenario rows */}
      <div className="space-y-1.5 mb-3">
        {rows.map(r => (
          <div key={r.label} className={`${r.bg} rounded-lg px-2 py-1.5`}>
            <div className="flex items-start justify-between gap-1">
              <div className="shrink-0">
                <div className={`text-[10px] font-medium ${r.pc}`}>{r.icon} {r.label}</div>
                <div className={`text-[11px] font-bold ${r.pc}`}>{fmtRs(r.price)}</div>
              </div>
              <div className="flex gap-3">
                <div className="w-[52px] text-right">
                  <span className={`text-[10px] font-bold ${r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.pnl >= 0 ? '+' : ''}{fmtRs(r.pnl)}
                  </span>
                </div>
                <div className="w-[52px] text-right">
                  <span className={`text-[10px] font-bold ${r.exp >= 0 ? 'text-slate-300' : 'text-red-400'}`}>
                    {r.exp >= 0 ? '+' : ''}{fmtRs(r.exp)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Breakdown at base */}
      {(p.opt_pnl !== 0 || p.sh_pnl !== 0) && (
        <div className="border-t border-[#1e2d40] pt-2 space-y-1">
          <div className="text-[8px] text-slate-600 mb-1">MTM breakdown at base</div>
          {p.opt_pnl !== 0 && (
            <div className="flex justify-between text-[9px]">
              <span className="text-slate-400">Options (θ)</span>
              <span className={`font-bold ${p.opt_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{p.opt_pnl >= 0 ? '+' : ''}{fmtRs(p.opt_pnl)}</span>
            </div>
          )}
          {p.sh_pnl !== 0 && (
            <div className="flex justify-between text-[9px]">
              <span className="text-slate-400">Shares</span>
              <span className={`font-bold ${p.sh_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{p.sh_pnl >= 0 ? '+' : ''}{fmtRs(p.sh_pnl)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── localStorage helpers ────────────────────────────────────────────────────

const LS_KEY = 'aegisai_cs_strategies'

function loadFromStorage(): SavedStrategy[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function saveToStorage(list: SavedStrategy[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function CustomStrangle() {
  // Setup
  const [symbolDisplay, setSymbolDisplay] = useState('')
  const [symbol, setSymbol]               = useState('')
  const [cmpStr, setCmpStr]               = useState('')
  const [ivStr, setIvStr]                 = useState('22')
  const [dteStr, setDteStr]               = useState('37')
  const [defaultLotSize, setDefaultLotSize] = useState(1)
  const [quoteLoading, setQuoteLoading]   = useState(false)
  const [cmpRefreshing, setCmpRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Live option prices — auto-fetch from NSE
  const [expiryDate, setExpiryDate] = useState('')
  const [optPricesLoading, setOptPricesLoading] = useState(false)
  const [lastOptPriceRefreshed, setLastOptPriceRefreshed] = useState<Date | null>(null)
  const optPriceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fetchOptPricesRef = useRef<(() => Promise<void>) | null>(null)

  // Positions
  const [options, setOptions] = useState<OptionLeg[]>([])
  const [shares, setShares]   = useState<ShareLeg[]>([])

  // Add-option form
  const [addingOpt, setAddingOpt]       = useState<'CE' | 'PE' | null>(null)
  const [newOptStrike, setNewOptStrike] = useState('')
  const [newOptPrem, setNewOptPrem]     = useState('')
  const [newOptLots, setNewOptLots]     = useState('1')
  const [newOptLS, setNewOptLS]         = useState('')

  // Edit-option form — null = not editing
  const [editOpt, setEditOpt] = useState<{
    id: string; strike: string; premium: string; lots: string; lotSize: string
  } | null>(null)

  // Add-share form
  const [addingSh, setAddingSh]     = useState(false)
  const [newShLabel, setNewShLabel] = useState('')
  const [newShQty, setNewShQty]     = useState('')
  const [newShPrice, setNewShPrice] = useState('')

  // Edit-share form — null = not editing
  const [editSh, setEditSh] = useState<{
    id: string; label: string; qty: string; price: string
  } | null>(null)

  // View
  const [tab, setTab]                     = useState<'chart' | 'table'>('chart')
  const [showComponents, setShowComponents] = useState(true)
  const [tableInterval, setTableInterval] = useState(50)

  // What-If scenario sliders
  const [targetPrice, setTargetPrice] = useState<number | null>(null)
  const [targetDays, setTargetDays]   = useState(0)

  // Save / load
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>(loadFromStorage)
  const [showSaved, setShowSaved]             = useState(false)
  const [showSaveForm, setShowSaveForm]       = useState(false)
  const [saveName, setSaveName]               = useState('')

  // Prediction
  const [prediction, setPrediction] = useState<PredictResult | null>(null)
  const [predicting, setPredicting] = useState(false)
  const [predError, setPredError]   = useState<string | null>(null)

  const cmp         = cmpStr !== '' ? parseFloat(cmpStr) : NaN
  const hasPositions = options.length > 0 || shares.length > 0

  // ── fetch quote ────────────────────────────────────────────────────────────
  async function fetchQuote(sym: string) {
    setQuoteLoading(true)
    try {
      const r = await client.get(`/cushion-strangle/quote/${encodeURIComponent(sym)}`)
      setCmpStr(String(r.data.cmp))
      setIvStr(String(r.data.iv))
      setDefaultLotSize(r.data.lot_size)
      setNewOptLS(String(r.data.lot_size))
      setLastRefreshed(new Date())
    } catch { /* let user type manually */ }
    setQuoteLoading(false)
  }

  // Refresh just the underlying CMP (not IV — user may have calibrated it)
  async function refreshCmp() {
    if (!symbol || cmpRefreshing) return
    setCmpRefreshing(true)
    try {
      const r = await client.get(`/cushion-strangle/quote/${encodeURIComponent(symbol)}`)
      if (r.data.cmp) { setCmpStr(String(r.data.cmp)); setLastRefreshed(new Date()) }
    } catch {}
    setCmpRefreshing(false)
  }

  // Auto-refresh underlying CMP every 30s when a symbol is selected
  useEffect(() => {
    if (!symbol) return
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    refreshTimerRef.current = setInterval(refreshCmp, 30000)
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current) }
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch live option prices from NSE for all open legs
  async function fetchOptionPricesForLegs() {
    if (!symbol || options.length === 0 || !expiryDate) return
    setOptPricesLoading(true)
    const updates: Record<string, string> = {}
    await Promise.all(options.map(async (o) => {
      if (o.exitPremium !== '') return  // already exited
      try {
        const r = await client.get(
          `/cushion-strangle/option-price/${encodeURIComponent(symbol)}`,
          { params: { strike: o.strike, expiry: expiryDate, opt_type: o.type } }
        )
        if (r.data?.ltp > 0) updates[o.id] = String(r.data.ltp)
      } catch {}
    }))
    if (Object.keys(updates).length > 0) {
      setOptions(p => p.map(o => o.id in updates ? { ...o, liveOptPrice: updates[o.id] } : o))
      setLastOptPriceRefreshed(new Date())
    }
    setOptPricesLoading(false)
  }

  // Keep ref current so the interval always uses the latest state
  fetchOptPricesRef.current = fetchOptionPricesForLegs

  // Auto-refresh option prices every 60s when symbol + expiry are both set
  useEffect(() => {
    if (!symbol || !expiryDate) {
      if (optPriceTimerRef.current) clearInterval(optPriceTimerRef.current)
      return
    }
    fetchOptPricesRef.current?.()  // immediate on first set
    if (optPriceTimerRef.current) clearInterval(optPriceTimerRef.current)
    optPriceTimerRef.current = setInterval(() => fetchOptPricesRef.current?.(), 60000)
    return () => { if (optPriceTimerRef.current) clearInterval(optPriceTimerRef.current) }
  }, [symbol, expiryDate]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── option CRUD ────────────────────────────────────────────────────────────
  function commitOption(type: 'CE' | 'PE') {
    const strike  = parseFloat(newOptStrike)
    const premium = parseFloat(newOptPrem)
    const lots    = parseInt(newOptLots)
    const ls      = parseInt(newOptLS) || defaultLotSize || 1
    if (isNaN(strike) || isNaN(premium) || isNaN(lots) || lots < 1) return
    setOptions(p => [...p, {
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      type, strike, premium, lots, lotSize: ls, exitPremium: '', liveOptPrice: '',
    }])
    setAddingOpt(null)
    setNewOptStrike(''); setNewOptPrem(''); setNewOptLots('1')
  }

  function startEditOpt(o: OptionLeg) {
    setEditOpt({ id: o.id, strike: String(o.strike), premium: String(o.premium), lots: String(o.lots), lotSize: String(o.lotSize) })
    setAddingOpt(null)
  }

  function saveEditOpt() {
    if (!editOpt) return
    const strike  = parseFloat(editOpt.strike)
    const premium = parseFloat(editOpt.premium)
    const lots    = parseInt(editOpt.lots)
    const ls      = parseInt(editOpt.lotSize) || defaultLotSize || 1
    if (isNaN(strike) || isNaN(premium) || isNaN(lots) || lots < 1) return
    setOptions(p => p.map(o => o.id === editOpt.id ? { ...o, strike, premium, lots, lotSize: ls } : o))
    setEditOpt(null)
  }

  // ── share CRUD ─────────────────────────────────────────────────────────────
  function commitShare() {
    const qty      = parseFloat(newShQty)
    const buyPrice = parseFloat(newShPrice)
    if (!newShQty.trim() || !newShPrice.trim()) return
    if (isNaN(qty) || qty < 1 || isNaN(buyPrice)) return
    const label = newShLabel.trim() || `Buy ${shares.length + 1}`
    setShares(p => [...p, {
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      label, qty: Math.round(qty), buyPrice, exitPrice: '',
    }])
    setAddingSh(false)
    setNewShLabel(''); setNewShQty(''); setNewShPrice('')
  }

  function startEditSh(s: ShareLeg) {
    setEditSh({ id: s.id, label: s.label, qty: String(s.qty), price: String(s.buyPrice) })
    setAddingSh(false)
  }

  function saveEditSh() {
    if (!editSh) return
    const qty      = parseInt(editSh.qty)
    const buyPrice = parseFloat(editSh.price)
    if (isNaN(qty) || qty < 1 || isNaN(buyPrice) || buyPrice <= 0) return
    const label = editSh.label.trim() || `Buy`
    setShares(p => p.map(s => s.id === editSh.id ? { ...s, label, qty, buyPrice } : s))
    setEditSh(null)
  }

  // ── save / load ────────────────────────────────────────────────────────────
  function saveStrategy() {
    if (!saveName.trim()) return
    const strat: SavedStrategy = {
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      name: saveName.trim(),
      savedAt: new Date().toISOString(),
      symbol, symbolDisplay, cmpStr, ivStr, dteStr, defaultLotSize,
      options, shares,
    }
    const updated = [strat, ...savedStrategies]
    setSavedStrategies(updated)
    saveToStorage(updated)
    setSaveName('')
    setShowSaveForm(false)
  }

  function loadStrategy(s: SavedStrategy) {
    setSymbol(s.symbol)
    setSymbolDisplay(s.symbolDisplay)
    setCmpStr(s.cmpStr)
    setIvStr(s.ivStr)
    setDteStr(s.dteStr)
    setDefaultLotSize(s.defaultLotSize)
    setOptions(s.options.map(o => ({ ...o })))
    setShares(s.shares.map(sh => ({ ...sh })))
    setEditOpt(null); setEditSh(null)
    setAddingOpt(null); setAddingSh(false)
    setShowSaved(false)
  }

  function deleteStrategy(id: string) {
    const updated = savedStrategies.filter(s => s.id !== id)
    setSavedStrategies(updated)
    saveToStorage(updated)
  }

  // ── AI prediction ──────────────────────────────────────────────────────────
  async function runPrediction() {
    if (!symbol || !hasPositions) return
    setPredicting(true); setPredError(null); setPrediction(null)
    try {
      const r = await client.post('/cushion-strangle/predict', {
        symbol,
        cmp:     parseFloat(cmpStr) || 0,
        iv:      parseFloat(ivStr)  || 22,
        dte:     parseInt(dteStr)   || 37,
        rf:      0.065,
        options: options.map(o => ({
          type: o.type, strike: o.strike, premium: o.premium,
          lots: o.lots, lot_size: o.lotSize,
          exit_premium: o.exitPremium !== '' ? parseFloat(o.exitPremium) : null,
        })),
        shares: shares.map(s => ({
          qty: s.qty, buy_price: s.buyPrice,
          exit_price: s.exitPrice !== '' ? parseFloat(s.exitPrice) : null,
        })),
      })
      setPrediction(r.data)
    } catch (e: any) {
      setPredError(e?.response?.data?.detail || 'Prediction failed — check symbol and try again')
    }
    setPredicting(false)
  }

  // ── computed data ──────────────────────────────────────────────────────────
  // Wide BEs from strategy structure only (no cmp needed) — used to set chart range
  const wideBreakevens = useMemo(() => {
    if (options.length === 0 && shares.length === 0) return []
    const prices = [
      ...options.map(o => o.strike),
      ...shares.map(s => s.buyPrice),
    ]
    if (!prices.length) return []
    const lo2 = Math.min(...prices) * 0.45
    const hi2 = Math.max(...prices) * 1.60
    const pts = Array.from({ length: 400 }, (_, i) => {
      const p2 = lo2 + (hi2 - lo2) * i / 399
      return { p2, total: pnlAt(p2, options, shares).total }
    })
    const bes: number[] = []
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i-1], b = pts[i]
      if (a.total * b.total <= 0 && a.total !== b.total) {
        const t = -a.total / (b.total - a.total)
        bes.push(Math.round(a.p2 + (b.p2 - a.p2) * t))
      }
    }
    return bes
  }, [options, shares])

  // Back-solve implied vol from live option prices entered per leg.
  // Must be declared before chartData (which uses it).
  const calibratedIv = useMemo(() => {
    const dte = parseInt(dteStr)
    if (isNaN(cmp) || cmp <= 0 || isNaN(dte) || dte <= 0) return null
    const T = dte / 365
    const ivVals: number[] = []
    for (const o of options) {
      const lp = o.liveOptPrice !== '' && !isNaN(+o.liveOptPrice) ? +o.liveOptPrice : null
      if (lp === null) continue
      const iv = impliedVol(cmp, o.strike, T, lp, o.type === 'CE')
      if (iv !== null) ivVals.push(iv)
    }
    return ivVals.length
      ? Math.round(ivVals.reduce((a, b) => a + b, 0) / ivVals.length * 10) / 10
      : null
  }, [options, cmp, dteStr])

  const chartData = useMemo(() => {
    if (options.length === 0 && shares.length === 0) return []
    const allPrices = [
      ...(!isNaN(cmp) && cmp > 0 ? [cmp] : []),
      ...options.map(o => o.strike),
      ...shares.map(s => s.buyPrice),
    ]
    if (allPrices.length === 0) return []
    let lo: number, hi: number
    if (wideBreakevens.length >= 2) {
      const beMin = Math.min(...wideBreakevens)
      const beMax = Math.max(...wideBreakevens)
      lo = Math.min(beMin * 0.90, Math.min(...allPrices) * 0.92)
      hi = Math.max(beMax * 1.10, Math.max(...allPrices) * 1.08)
    } else if (wideBreakevens.length === 1) {
      const be1 = wideBreakevens[0]
      lo = Math.min(be1 * 0.92, Math.min(...allPrices) * 0.92)
      hi = Math.max(be1 * 1.08, Math.max(...allPrices) * 1.10)
      // Don't go more than 12% below CMP — avoids the chart being swamped by deep losses
      if (!isNaN(cmp) && cmp > 0) lo = Math.max(lo, cmp * 0.88)
    } else {
      lo = Math.min(...allPrices) * 0.82
      hi = Math.max(...allPrices) * 1.22
    }
    const iv    = calibratedIv ?? (parseFloat(ivStr) || 22)
    const dte   = parseInt(dteStr) || 37
    const tRem  = Math.max(0, (dte - targetDays) / 365)

    // Build live-price map for legs that have a current market price entered.
    // Used to anchor the "On Target Date" line at the exact known MTM at CMP.
    const livePriceMap: Record<string, number> = {}
    for (const o of options) {
      const lp = o.liveOptPrice !== '' && !isNaN(+o.liveOptPrice) ? +o.liveOptPrice : null
      if (lp !== null) livePriceMap[o.id] = lp
    }
    const hasLivePrices = Object.keys(livePriceMap).length > 0

    // Basis correction: shift the blue line so it passes through the exact MTM at CMP.
    // This anchors the curve to reality even when the entered IV is stale.
    // Applied only when we have live prices AND a valid CMP (targetDays = 0 baseline).
    let basisAdj = 0
    if (hasLivePrices && !isNaN(cmp) && cmp > 0) {
      const bsAtCmp   = midPnlAt(cmp, dte / 365, iv, options, shares)
      const liveAtCmp = midPnlAt(cmp, dte / 365, iv, options, shares, livePriceMap)
      basisAdj = liveAtCmp - bsAtCmp
    }

    return Array.from({ length: 301 }, (_, i) => {
      const price = lo + (hi - lo) * i / 300
      const { opPnl, shPnl, total } = pnlAt(price, options, shares)
      const target = midPnlAt(price, tRem, iv, options, shares) + basisAdj
      return { price: Math.round(price * 10) / 10, options: opPnl, shares: shPnl, total, target }
    })
  }, [options, shares, cmp, wideBreakevens, targetDays, ivStr, dteStr, calibratedIv])

  const breakevens = useMemo(() => {
    const bes: number[] = []
    for (let i = 1; i < chartData.length; i++) {
      const p = chartData[i - 1], c = chartData[i]
      if (p.total * c.total <= 0 && p.total !== c.total) {
        const t = -p.total / (c.total - p.total)
        bes.push(Math.round(p.price + (c.price - p.price) * t))
      }
    }
    return bes
  }, [chartData])

  const targetBreakevens = useMemo(() => {
    const bes: number[] = []
    for (let i = 1; i < chartData.length; i++) {
      const p = chartData[i - 1], c = chartData[i]
      if (p.target * c.target <= 0 && p.target !== c.target) {
        const t = -p.target / (c.target - p.target)
        bes.push(Math.round(p.price + (c.price - p.price) * t))
      }
    }
    return bes
  }, [chartData])

  const metrics = useMemo(() => {
    if (chartData.length === 0) return null
    const totals = chartData.map(d => d.total)
    return {
      maxProfit:   Math.max(...totals),
      maxLoss:     Math.min(...totals),
      totalIncome: options.reduce((s, o) => s + o.premium * o.lots * o.lotSize, 0),
      totalCost:   shares.reduce((s, sh) => s + sh.buyPrice * sh.qty, 0),
    }
  }, [chartData, options, shares])

  const tablePrices = useMemo(() => {
    const mid = !isNaN(cmp) && cmp > 0 ? cmp
      : options.length > 0 ? options[0].strike
      : shares.length > 0 ? shares[0].buyPrice : 100
    const lo  = Math.round((mid * 0.70) / tableInterval) * tableInterval
    const hi  = Math.round((mid * 1.30) / tableInterval) * tableInterval
    const pts: number[] = []
    for (let p = lo; p <= hi; p += tableInterval) pts.push(p)
    // Always include strikes + breakevens as special rows
    const extras = [...options.map(o => o.strike), ...shares.map(s => Math.round(s.buyPrice)), ...breakevens]
    return [...new Set([...pts, ...extras])].sort((a, b) => a - b)
  }, [cmp, options, shares, breakevens, tableInterval])

  // Back-solve implied vol from live option prices entered per leg.
  // Returns average calibrated IV (in %) or null if no live prices entered.

  const liveMetrics = useMemo(() => {
    const iv  = calibratedIv ?? parseFloat(ivStr)
    const dte = parseInt(dteStr)
    if (!hasPositions || isNaN(cmp) || cmp <= 0 || isNaN(iv) || iv <= 0 || isNaN(dte) || dte <= 0) return null
    const T = dte / 365
    const optMetrics = options.map(o => {
      const qty = o.lots * o.lotSize
      const isCall = o.type === 'CE'
      const ep = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
      if (ep != null) {
        return { id: o.id, currentValue: ep, mtmPnl: Math.round((o.premium - ep) * qty), delta: 0, theta: 0, vega: 0, exited: true }
      }
      const lp = o.liveOptPrice !== '' && !isNaN(+o.liveOptPrice) ? +o.liveOptPrice : null
      const cv    = lp !== null ? lp : bsPrice(cmp, o.strike, iv, T, isCall)
      const delta = -bsDelta(cmp, o.strike, iv, T, isCall) * qty
      const theta = -bsTheta(cmp, o.strike, iv, T, isCall) * qty  // positive = earned per day
      const vega  = -bsVega(cmp, o.strike, iv, T) * qty           // negative for short options
      return {
        id: o.id,
        currentValue: Math.round(cv * 100) / 100,
        mtmPnl: Math.round((o.premium - cv) * qty),
        delta, theta, vega,
        exited: false,
        isLivePrice: lp !== null,
      }
    })

    const shareMetrics = shares.map(s => {
      const ep = s.exitPrice !== '' && !isNaN(+s.exitPrice) ? +s.exitPrice : null
      if (ep != null) return { id: s.id, mtmPnl: Math.round((ep - s.buyPrice) * s.qty), delta: 0, exited: true }
      return { id: s.id, mtmPnl: Math.round((cmp - s.buyPrice) * s.qty), delta: s.qty, exited: false }
    })

    const totalMtmPnl = [...optMetrics, ...shareMetrics].reduce((a, m) => a + m.mtmPnl, 0)
    const netDelta    = [...optMetrics, ...shareMetrics].reduce((a, m) => a + m.delta, 0)
    const totalTheta  = optMetrics.reduce((a, m) => a + m.theta, 0)
    const totalVega   = optMetrics.reduce((a, m) => a + m.vega, 0)

    return { optMetrics, shareMetrics, totalMtmPnl, netDelta, totalTheta, totalVega }
  }, [options, shares, cmp, ivStr, dteStr, hasPositions, calibratedIv])

  // ─── render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Custom Strategy Builder</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Short any CE / PE strikes · add multiple buy orders · edit or exit any leg · save for later
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasPositions && (
            <button
              onClick={() => { setShowSaveForm(s => !s); setSaveName('') }}
              className="text-xs bg-emerald-950 border border-emerald-800/60 text-emerald-400 hover:bg-emerald-900 px-3 py-1.5 rounded-lg"
            >
              💾 Save strategy
            </button>
          )}
          <button
            onClick={() => setShowSaved(s => !s)}
            className={`text-xs border px-3 py-1.5 rounded-lg transition-colors ${showSaved ? 'bg-blue-600 border-blue-500 text-white' : 'border-[#1e2d40] text-slate-400 hover:text-white'}`}
          >
            📂 Saved ({savedStrategies.length})
          </button>
          {hasPositions && (
            <button
              onClick={() => { setOptions([]); setShares([]); setEditOpt(null); setEditSh(null) }}
              className="text-xs border border-[#1e2d40] text-slate-500 hover:text-red-400 px-3 py-1.5 rounded-lg"
            >
              Clear all
            </button>
          )}
          {hasPositions && symbol && (
            <button
              onClick={runPrediction}
              disabled={predicting}
              className="text-xs bg-violet-950 border border-violet-800/60 text-violet-300 hover:bg-violet-900 disabled:opacity-40 disabled:cursor-wait px-3 py-1.5 rounded-lg font-medium"
            >
              {predicting ? '⏳ Predicting…' : '🔮 AI Predict'}
            </button>
          )}
        </div>
      </div>

      {/* Inline save form */}
      {showSaveForm && (
        <div className="bg-[#111827] border border-emerald-800/40 rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-52">
            <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Strategy name</label>
            <input
              type="text"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveStrategy()}
              placeholder="e.g. NIFTY strangle Sep 2026"
              autoFocus
              className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="text-[10px] text-slate-500 self-center">
            {options.length} option leg{options.length !== 1 ? 's' : ''} · {shares.length} share order{shares.length !== 1 ? 's' : ''}
            {symbolDisplay && ` · ${symbolDisplay}`}
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveStrategy}
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium"
            >
              Save
            </button>
            <button
              onClick={() => setShowSaveForm(false)}
              className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-2 rounded-lg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Saved strategies panel */}
      {showSaved && (
        <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
          <div className="text-xs font-semibold text-white mb-3">Saved Strategies</div>
          {savedStrategies.length === 0 ? (
            <div className="text-center py-6 text-slate-600 text-xs">No saved strategies yet · build a strategy and click "Save"</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {savedStrategies.map(s => {
                const date = new Date(s.savedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                const optIncome = s.options.reduce((sum, o) => sum + o.premium * o.lots * o.lotSize, 0)
                const shCost    = s.shares.reduce((sum, sh) => sum + sh.buyPrice * sh.qty, 0)
                return (
                  <div key={s.id} className="bg-[#0d1425] border border-[#1e2d40]/80 rounded-xl p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="text-sm font-bold text-white">{s.name}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{date}</div>
                      </div>
                      <button
                        onClick={() => deleteStrategy(s.id)}
                        className="text-slate-600 hover:text-red-400 text-xs ml-2 shrink-0"
                        title="Delete"
                      >✕</button>
                    </div>
                    <div className="space-y-1 mb-3 text-[10px] text-slate-400">
                      {s.symbolDisplay && <div><span className="text-slate-300">{s.symbolDisplay}</span>{s.cmpStr && ` · ₹${s.cmpStr}`}</div>}
                      <div>
                        {s.options.length > 0 && <span>{s.options.length} option leg{s.options.length !== 1 ? 's' : ''}</span>}
                        {s.options.length > 0 && s.shares.length > 0 && <span> · </span>}
                        {s.shares.length > 0 && <span>{s.shares.length} share order{s.shares.length !== 1 ? 's' : ''}</span>}
                      </div>
                      {optIncome > 0 && <div>Income: <span className="text-emerald-400 font-semibold">{fmtRs(optIncome)}</span></div>}
                      {shCost > 0 && <div>Share cost: <span className="text-blue-400 font-semibold">{fmtRs(shCost)}</span></div>}
                    </div>
                    <button
                      onClick={() => loadStrategy(s)}
                      className="w-full text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-1.5 font-medium"
                    >
                      Load strategy
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Setup bar */}
      <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-52">
            <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Symbol (optional — auto-fills CMP)</label>
            <NseStockSearch
              includeEtfIndex
              placeholder={symbolDisplay || 'Search symbol…'}
              onSelect={(sym, name) => {
                setSymbol(sym)
                setSymbolDisplay(name || sym.replace('.NS', '').replace('^', ''))
                fetchQuote(sym)
              }}
            />
          </div>
          <div className="flex items-end gap-1">
            <Inp label="CMP ₹" value={cmpStr} onChange={setCmpStr} placeholder={quoteLoading ? 'Loading…' : '₹'} className="w-28" />
            {symbol && (
              <button
                onClick={refreshCmp}
                disabled={cmpRefreshing}
                title="Refresh underlying price"
                className="mb-0.5 text-slate-400 hover:text-cyan-400 disabled:opacity-40 text-sm px-1 py-1.5"
              >
                {cmpRefreshing ? '⟳' : '↺'}
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Inp label="IV %" value={ivStr} onChange={setIvStr} placeholder="22" className="w-24" />
            {calibratedIv !== null && (
              <div className="text-[9px] text-cyan-400 bg-cyan-950/40 px-1.5 py-0.5 rounded text-center">
                Calib: {calibratedIv}%
              </div>
            )}
          </div>
          <Inp label="DTE" value={dteStr} onChange={setDteStr} placeholder="37" className="w-20" />
          <div className="w-24">
            <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Lot size</label>
            <input
              type="number"
              value={defaultLotSize}
              onChange={e => setDefaultLotSize(+e.target.value || 1)}
              className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Expiry date — enables live option price fetching */}
          <div className="flex flex-col gap-1">
            <div>
              <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Expiry date</label>
              <input
                type="date"
                value={expiryDate}
                onChange={e => setExpiryDate(e.target.value)}
                className="w-36 bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500"
              />
            </div>
            {expiryDate && symbol && options.length > 0 && (
              <button
                onClick={() => fetchOptPricesRef.current?.()}
                disabled={optPricesLoading}
                className="text-[10px] bg-cyan-950 border border-cyan-800/60 text-cyan-400 hover:bg-cyan-900 disabled:opacity-40 disabled:cursor-wait px-2 py-1 rounded-lg font-medium"
              >
                {optPricesLoading ? '⟳ Fetching…' : '⬇ Fetch option prices'}
              </button>
            )}
          </div>
        </div>
        {(lastRefreshed || calibratedIv !== null || lastOptPriceRefreshed) && (
          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
            {lastRefreshed && (
              <span>↺ CMP refreshed {Math.round((Date.now() - lastRefreshed.getTime()) / 1000)}s ago</span>
            )}
            {lastOptPriceRefreshed && (
              <span className="text-cyan-600">● Option prices fetched {Math.round((Date.now() - lastOptPriceRefreshed.getTime()) / 1000)}s ago · auto-refresh every 60s</span>
            )}
            {calibratedIv !== null && (
              <span className="text-cyan-500">IV calibrated from live option prices → {calibratedIv}% (entered {ivStr}%)</span>
            )}
          </div>
        )}
      </div>

      {/* Main two-column */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ── LEFT: position builder ─────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Options card */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-semibold text-white">Short Options</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {options.length === 0
                    ? 'No legs added'
                    : `${options.length} leg${options.length > 1 ? 's' : ''} · income ${fmtRs(options.reduce((s, o) => s + o.premium * o.lots * o.lotSize, 0))}`}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setAddingOpt('PE'); setNewOptLS(String(defaultLotSize)); setEditOpt(null) }}
                  className="text-[10px] bg-red-950 border border-red-800/60 text-red-400 hover:bg-red-900 px-2.5 py-1.5 rounded-lg"
                >+ Short PE</button>
                <button
                  onClick={() => { setAddingOpt('CE'); setNewOptLS(String(defaultLotSize)); setEditOpt(null) }}
                  className="text-[10px] bg-amber-950 border border-amber-800/60 text-amber-400 hover:bg-amber-900 px-2.5 py-1.5 rounded-lg"
                >+ Short CE</button>
              </div>
            </div>

            {options.length === 0 && !addingOpt && (
              <div className="text-center py-8 text-slate-600 text-xs">Add CE or PE legs above</div>
            )}

            <div className="space-y-2">
              {options.map(o => (
                <div key={o.id} className={`rounded-lg border ${editOpt?.id === o.id ? 'border-blue-700/60 bg-blue-950/10' : 'border-[#1e2d40]/60 bg-[#0d1425]'}`}>
                  {editOpt?.id === o.id ? (
                    /* ── Inline edit form ── */
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold text-blue-400">Edit {o.type} leg</span>
                        <button onClick={() => setEditOpt(null)} className="text-slate-500 hover:text-white text-xs">✕</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Strike ₹</label>
                          <input type="number" value={editOpt.strike} onChange={e => setEditOpt(p => p && ({ ...p, strike: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Premium received ₹</label>
                          <input type="number" value={editOpt.premium} onChange={e => setEditOpt(p => p && ({ ...p, premium: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Lots</label>
                          <input type="number" value={editOpt.lots} onChange={e => setEditOpt(p => p && ({ ...p, lots: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Lot size</label>
                          <input type="number" value={editOpt.lotSize} onChange={e => setEditOpt(p => p && ({ ...p, lotSize: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                      </div>
                      {editOpt.premium && editOpt.lots && editOpt.lotSize && (
                        <div className="text-[10px] text-emerald-400 mb-3">
                          Income: {fmtRs(parseFloat(editOpt.premium || '0') * parseInt(editOpt.lots || '1') * parseInt(editOpt.lotSize || '1'))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={saveEditOpt} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium">
                          Update
                        </button>
                        <button onClick={() => setEditOpt(null)} className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-1.5 rounded-lg">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ── Display card ── */
                    <div className="p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${o.type === 'CE' ? 'bg-amber-950 text-amber-400' : 'bg-red-950 text-red-400'}`}>
                              Short {o.type}
                            </span>
                            <span className="text-sm font-bold text-white">₹{fmt(o.strike)}</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {o.lots} lot{o.lots > 1 ? 's' : ''} × {o.lotSize} = <span className="text-white">{o.lots * o.lotSize}</span> qty
                            {' · '}premium <span className="text-emerald-400 font-semibold">₹{o.premium}</span>
                            {' · '}income <span className="text-emerald-400 font-semibold">{fmtRs(o.premium * o.lots * o.lotSize)}</span>
                          </div>
                        </div>
                        <div className="flex gap-2 ml-2 shrink-0">
                          <button onClick={() => startEditOpt(o)} className="text-slate-500 hover:text-blue-400 text-xs" title="Edit">✎</button>
                          <button onClick={() => setOptions(p => p.filter(x => x.id !== o.id))} className="text-slate-500 hover:text-red-400 text-xs" title="Delete">✕</button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#1e2d40]">
                        <span className="text-[10px] text-slate-500 shrink-0">Exit buyback ₹:</span>
                        <input
                          type="number"
                          value={o.exitPremium}
                          onChange={e => setOptions(p => p.map(x => x.id === o.id ? { ...x, exitPremium: e.target.value } : x))}
                          placeholder="hold to expiry"
                          className="flex-1 min-w-0 bg-[#111827] border border-[#1e2d40] text-white text-[10px] rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                        />
                        {o.exitPremium !== '' && !isNaN(+o.exitPremium) && (
                          <span className={`text-[9px] font-bold shrink-0 ${(o.premium - +o.exitPremium) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            locked {fmtRs((o.premium - +o.exitPremium) * o.lots * o.lotSize)}
                          </span>
                        )}
                      </div>
                      {/* Live market price input for IV calibration */}
                      {o.exitPremium === '' && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[10px] text-slate-500 shrink-0">Mkt price ₹:</span>
                          <input
                            type="number"
                            value={o.liveOptPrice}
                            onChange={e => setOptions(p => p.map(x => x.id === o.id ? { ...x, liveOptPrice: e.target.value } : x))}
                            placeholder="current option CMP"
                            className="flex-1 min-w-0 bg-[#0d1425] border border-cyan-900/60 text-cyan-300 text-[10px] rounded px-2 py-1 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600"
                          />
                          {/* Per-leg fetch button — only when expiry is set */}
                          {symbol && expiryDate && (
                            <button
                              disabled={optPricesLoading}
                              onClick={async () => {
                                setOptPricesLoading(true)
                                try {
                                  const r = await client.get(
                                    `/cushion-strangle/option-price/${encodeURIComponent(symbol)}`,
                                    { params: { strike: o.strike, expiry: expiryDate, opt_type: o.type } }
                                  )
                                  if (r.data?.ltp > 0) {
                                    setOptions(p => p.map(x => x.id === o.id ? { ...x, liveOptPrice: String(r.data.ltp) } : x))
                                    setLastOptPriceRefreshed(new Date())
                                  }
                                } catch {}
                                setOptPricesLoading(false)
                              }}
                              className="text-[9px] text-cyan-700 hover:text-cyan-400 disabled:opacity-40 shrink-0 px-1"
                              title="Fetch live price from NSE"
                            >⬇</button>
                          )}
                          {o.liveOptPrice !== '' && !isNaN(+o.liveOptPrice) && !isNaN(cmp) && cmp > 0 && (() => {
                            const T   = (parseInt(dteStr) || 37) / 365
                            const iv  = impliedVol(cmp, o.strike, T, +o.liveOptPrice, o.type === 'CE')
                            const pnl = Math.round((o.premium - +o.liveOptPrice) * o.lots * o.lotSize)
                            return (
                              <div className="flex items-center gap-1.5 shrink-0">
                                {iv !== null && <span className="text-[9px] text-cyan-400">IV: {iv}%</span>}
                                <span className={`text-[9px] font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pnl >= 0 ? '+' : ''}{fmtRs(pnl)}
                                </span>
                              </div>
                            )
                          })()}
                        </div>
                      )}
                      {/* Live BS pricing row */}
                      {(() => {
                        const live = liveMetrics?.optMetrics.find(m => m.id === o.id)
                        if (!live) return null
                        const itm = o.type === 'CE' ? cmp > o.strike : cmp < o.strike
                        const moneyPct = Math.abs((cmp - o.strike) / o.strike * 100).toFixed(1)
                        return (
                          <div className="mt-2 pt-2 border-t border-[#1e2d40]">
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${itm ? 'bg-orange-950 text-orange-400' : 'bg-slate-800 text-slate-500'}`}>
                                {itm ? 'ITM' : 'OTM'} {moneyPct}%
                              </span>
                              {live.exited && <span className="text-[9px] text-slate-600">exited · P&L fixed</span>}
                            </div>
                            <div className="grid grid-cols-4 gap-1.5 text-[9px]">
                              {!live.exited && (
                                <div>
                                  <div className="text-slate-500 flex items-center gap-1">
                                    Live val
                                    {live.isLivePrice && <span className="text-cyan-500" title="From entered Mkt price">●</span>}
                                  </div>
                                  <div className={`font-bold ${live.isLivePrice ? 'text-cyan-300' : 'text-white'}`}>₹{live.currentValue}</div>
                                </div>
                              )}
                              <div className={live.exited ? 'col-span-2' : ''}>
                                <div className="text-slate-500">MTM P&L</div>
                                <div className={`font-bold ${live.mtmPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {live.mtmPnl >= 0 ? '+' : ''}{fmtRs(live.mtmPnl)}
                                </div>
                              </div>
                              {!live.exited && <>
                                <div>
                                  <div className="text-slate-500">Δ (net)</div>
                                  <div className="text-blue-400 font-bold">{live.delta.toFixed(1)}</div>
                                </div>
                                <div>
                                  <div className="text-slate-500">θ/day</div>
                                  <div className="text-emerald-400 font-bold">+{fmtRs(Math.round(live.theta))}</div>
                                </div>
                              </>}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add option form */}
            {addingOpt && (
              <div className={`mt-3 p-3 rounded-lg border ${addingOpt === 'CE' ? 'border-amber-800/40 bg-amber-950/10' : 'border-red-800/40 bg-red-950/10'}`}>
                <div className="text-xs font-semibold text-white mb-3">Short {addingOpt} — enter details</div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <Inp label="Strike ₹"           value={newOptStrike} onChange={setNewOptStrike} placeholder="24500" />
                  <Inp label="Premium received ₹" value={newOptPrem}   onChange={setNewOptPrem}   placeholder="150"   />
                  <Inp label="Lots"                value={newOptLots}   onChange={setNewOptLots}   placeholder="1"     />
                  <Inp label="Lot size"            value={newOptLS}     onChange={setNewOptLS}     placeholder={String(defaultLotSize)} />
                </div>
                {newOptPrem && newOptLots && newOptLS && (
                  <div className="text-[10px] text-emerald-400 mb-3">
                    Income: {fmtRs(parseFloat(newOptPrem || '0') * parseInt(newOptLots || '1') * parseInt(newOptLS || '1'))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => commitOption(addingOpt)}
                    className={`text-xs px-4 py-1.5 rounded-lg font-medium ${addingOpt === 'CE' ? 'bg-amber-600 hover:bg-amber-500 text-black' : 'bg-red-600 hover:bg-red-500 text-white'}`}>
                    Add Short {addingOpt}
                  </button>
                  <button onClick={() => setAddingOpt(null)}
                    className="text-xs px-4 py-1.5 rounded-lg border border-[#1e2d40] text-slate-400 hover:text-white">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Shares card */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-semibold text-white">Share Buy Orders</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {shares.length === 0
                    ? 'No positions added'
                    : `${shares.length} order${shares.length > 1 ? 's' : ''} · cost ${fmtRs(shares.reduce((s, sh) => s + sh.buyPrice * sh.qty, 0))}`}
                </div>
              </div>
              <button
                onClick={() => {
                  setAddingSh(true); setEditSh(null)
                  setNewShLabel(''); setNewShQty('')
                  setNewShPrice(!isNaN(cmp) && cmp > 0 ? String(cmp) : '')
                }}
                className="text-[10px] bg-blue-950 border border-blue-800/60 text-blue-400 hover:bg-blue-900 px-2.5 py-1.5 rounded-lg"
              >+ Add Buy</button>
            </div>

            {shares.length === 0 && !addingSh && (
              <div className="text-center py-8 text-slate-600 text-xs">Add share buy orders above</div>
            )}

            <div className="space-y-2">
              {shares.map(s => (
                <div key={s.id} className={`rounded-lg border ${editSh?.id === s.id ? 'border-blue-700/60 bg-blue-950/10' : 'border-[#1e2d40]/60 bg-[#0d1425]'}`}>
                  {editSh?.id === s.id ? (
                    /* ── Inline edit form ── */
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold text-blue-400">Edit share order</span>
                        <button onClick={() => setEditSh(null)} className="text-slate-500 hover:text-white text-xs">✕</button>
                      </div>
                      <div className="mb-2">
                        <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Label</label>
                        <input type="text" value={editSh.label}
                          onChange={e => setEditSh(p => p && ({ ...p, label: e.target.value }))}
                          className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Quantity</label>
                          <input type="number" value={editSh.qty}
                            onChange={e => setEditSh(p => p && ({ ...p, qty: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Buy price ₹</label>
                          <input type="number" value={editSh.price}
                            onChange={e => setEditSh(p => p && ({ ...p, price: e.target.value }))}
                            className="w-full bg-[#111827] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                        </div>
                      </div>
                      {editSh.qty && editSh.price && (
                        <div className="text-[10px] text-blue-400 mb-3">
                          Cost: {fmtRs(parseFloat(editSh.price || '0') * parseInt(editSh.qty || '1'))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={saveEditSh} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium">
                          Update
                        </button>
                        <button onClick={() => setEditSh(null)} className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-1.5 rounded-lg">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ── Display card ── */
                    <div className="p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-950 text-blue-400">Buy</span>
                            <span className="text-sm font-bold text-white">{s.label}</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {fmt(s.qty)} shares @ <span className="text-white">₹{fmt(s.buyPrice, 2)}</span>
                            {' · '}cost <span className="text-blue-400 font-semibold">{fmtRs(s.buyPrice * s.qty)}</span>
                          </div>
                        </div>
                        <div className="flex gap-2 ml-2 shrink-0">
                          <button onClick={() => startEditSh(s)} className="text-slate-500 hover:text-blue-400 text-xs" title="Edit">✎</button>
                          <button onClick={() => setShares(p => p.filter(x => x.id !== s.id))} className="text-slate-500 hover:text-red-400 text-xs" title="Delete">✕</button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#1e2d40]">
                        <span className="text-[10px] text-slate-500 shrink-0">Exit sell ₹:</span>
                        <input
                          type="number"
                          value={s.exitPrice}
                          onChange={e => setShares(p => p.map(x => x.id === s.id ? { ...x, exitPrice: e.target.value } : x))}
                          placeholder="hold"
                          className="flex-1 min-w-0 bg-[#111827] border border-[#1e2d40] text-white text-[10px] rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                        />
                        {s.exitPrice !== '' && !isNaN(+s.exitPrice) && (
                          <span className={`text-[9px] font-bold shrink-0 ${(+s.exitPrice - s.buyPrice) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            locked {fmtRs((+s.exitPrice - s.buyPrice) * s.qty)}
                          </span>
                        )}
                      </div>
                      {/* Live share MTM */}
                      {(() => {
                        const live = liveMetrics?.shareMetrics.find(m => m.id === s.id)
                        if (!live) return null
                        const chgPct = !live.exited && s.buyPrice > 0 ? ((cmp - s.buyPrice) / s.buyPrice * 100).toFixed(2) : null
                        return (
                          <div className="mt-2 pt-2 border-t border-[#1e2d40] flex items-center justify-between text-[9px]">
                            <div>
                              <div className="text-slate-500">MTM P&L</div>
                              <div className={`font-bold ${live.mtmPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {live.mtmPnl >= 0 ? '+' : ''}{fmtRs(live.mtmPnl)}
                              </div>
                            </div>
                            {!live.exited && (
                              <div className="text-right">
                                <div className="text-slate-500">Δ (shares)</div>
                                <div className="text-blue-400 font-bold">+{fmt(live.delta)}</div>
                              </div>
                            )}
                            {chgPct != null && (
                              <div className="text-right">
                                <div className="text-slate-500">CMP vs buy</div>
                                <div className={`font-bold ${parseFloat(chgPct) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {parseFloat(chgPct) >= 0 ? '+' : ''}{chgPct}%
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add share form */}
            {addingSh && (
              <div className="mt-3 p-3 rounded-lg border border-blue-800/40 bg-blue-950/10">
                <div className="text-xs font-semibold text-white mb-3">Buy Order — enter details</div>
                <div className="mb-2">
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Label (optional)</label>
                  <input type="text" value={newShLabel} onChange={e => setNewShLabel(e.target.value)}
                    placeholder={`Buy ${shares.length + 1}`}
                    className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <Inp label="Quantity"    value={newShQty}   onChange={setNewShQty}   placeholder="100"         />
                  <Inp label="Buy price ₹" value={newShPrice} onChange={setNewShPrice} placeholder={cmpStr || '₹'} />
                </div>
                {newShQty && newShPrice && (
                  <div className="text-[10px] text-blue-400 mb-3">
                    Cost: {fmtRs(parseFloat(newShPrice || '0') * parseInt(newShQty || '1'))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={commitShare}
                    disabled={!newShQty.trim() || !newShPrice.trim()}
                    className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded-lg font-medium"
                  >
                    Add Buy Order
                  </button>
                  <button onClick={() => setAddingSh(false)} className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-1.5 rounded-lg">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Summary */}
          {metrics && hasPositions && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-3">Strategy Summary</div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Max Profit',    val: metrics.maxProfit,   color: 'text-emerald-400' },
                  { label: 'Max Loss',      val: metrics.maxLoss,     color: 'text-red-400'     },
                  { label: 'Option Income', val: metrics.totalIncome, color: 'text-emerald-400' },
                  { label: 'Share Cost',    val: metrics.totalCost,   color: 'text-blue-400'    },
                ].map(({ label, val, color }) => (
                  <div key={label} className="bg-[#0d1425] rounded-lg p-3">
                    <div className="text-[10px] text-slate-400 mb-1">{label}</div>
                    <div className={`text-base font-bold ${color}`}>{fmtRs(val)}</div>
                  </div>
                ))}
                {breakevens.length > 0 && (
                  <div className="col-span-2 bg-[#0d1425] rounded-lg p-3">
                    <div className="text-[10px] text-slate-400 mb-2">Breakeven{breakevens.length > 1 ? 's' : ''}</div>
                    <div className="flex flex-wrap gap-3">
                      {breakevens.map((be, i) => (
                        <span key={i} className="text-yellow-400 font-bold text-sm">{fmtRs(be)}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Live Greeks & MTM — updates live as CMP / IV / DTE change */}
          {liveMetrics && hasPositions && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-semibold text-white">Live Greeks & MTM</div>
                <span className="text-[9px] text-slate-500">@ ₹{fmt(cmp)} · {dteStr}d · IV {ivStr}%</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="bg-[#0d1425] rounded-lg p-3">
                  <div className="text-[10px] text-slate-400 mb-0.5">Total MTM P&L</div>
                  <div className={`text-base font-bold ${liveMetrics.totalMtmPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {liveMetrics.totalMtmPnl >= 0 ? '+' : ''}{fmtRs(liveMetrics.totalMtmPnl)}
                  </div>
                </div>
                <div className="bg-[#0d1425] rounded-lg p-3">
                  <div className="text-[10px] text-slate-400 mb-0.5">Net Delta Δ</div>
                  <div className={`text-base font-bold ${Math.abs(liveMetrics.netDelta) < 10 ? 'text-white' : liveMetrics.netDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {liveMetrics.netDelta.toFixed(1)}
                  </div>
                  <div className="text-[9px] text-slate-500">{fmtRs(Math.round(Math.abs(liveMetrics.netDelta)))} per ₹1 move</div>
                </div>
                <div className="bg-[#0d1425] rounded-lg p-3">
                  <div className="text-[10px] text-slate-400 mb-0.5">Daily Theta θ</div>
                  <div className="text-base font-bold text-emerald-400">+{fmtRs(Math.round(liveMetrics.totalTheta))}</div>
                  <div className="text-[9px] text-slate-500">earned per day</div>
                </div>
                <div className="bg-[#0d1425] rounded-lg p-3">
                  <div className="text-[10px] text-slate-400 mb-0.5">Vega ν</div>
                  <div className={`text-base font-bold ${liveMetrics.totalVega >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {liveMetrics.totalVega >= 0 ? '+' : ''}{fmtRs(Math.round(liveMetrics.totalVega))}
                  </div>
                  <div className="text-[9px] text-slate-500">per 1% IV change</div>
                </div>
              </div>
              <div className={`text-[10px] rounded-lg px-3 py-2 ${Math.abs(liveMetrics.netDelta) < 15 ? 'bg-emerald-950/30 text-emerald-400' : liveMetrics.netDelta > 0 ? 'bg-blue-950/30 text-blue-400' : 'bg-red-950/30 text-red-400'}`}>
                {Math.abs(liveMetrics.netDelta) < 15
                  ? 'Delta-neutral · balanced directional exposure'
                  : liveMetrics.netDelta > 0
                    ? `Bullish bias · portfolio gains ₹${Math.abs(Math.round(liveMetrics.netDelta))} per ₹1 rise`
                    : `Bearish bias · portfolio gains ₹${Math.abs(Math.round(liveMetrics.netDelta))} per ₹1 fall`}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: chart + table ───────────────────────────────────────── */}
        <div className="lg:col-span-3">
          {!hasPositions ? (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl h-96 flex items-center justify-center">
              <div className="text-center">
                <div className="text-5xl mb-4">📊</div>
                <div className="text-sm font-medium text-white mb-2">No positions yet</div>
                <div className="text-xs text-slate-400">Add CE / PE short legs or share buy orders<br />to see the combined P&L profile</div>
              </div>
            </div>
          ) : (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-xs font-semibold text-white">P&L Profile</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">At expiry for open positions · locked P&L for exited legs</div>
                </div>
                <div className="flex items-center gap-3">
                  {tab === 'chart' && options.length > 0 && shares.length > 0 && (
                    <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
                      <input type="checkbox" checked={showComponents} onChange={e => setShowComponents(e.target.checked)} className="accent-blue-500 w-3 h-3" />
                      Components
                    </label>
                  )}
                  {tab === 'table' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-400">Interval</span>
                      <div className="flex bg-[#0d1425] border border-[#1e2d40] rounded-lg overflow-hidden">
                        {[20, 50, 100, 200].map(v => (
                          <button key={v} onClick={() => setTableInterval(v)}
                            className={`text-[10px] px-2.5 py-1 transition-colors ${tableInterval === v ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}>
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex bg-[#0d1425] rounded-lg p-0.5">
                    {(['chart', 'table'] as const).map(t => (
                      <button key={t} onClick={() => setTab(t)}
                        className={`text-[10px] px-3 py-1.5 rounded-md transition-colors ${tab === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                        {t === 'chart' ? '📈 Chart' : '📋 Table'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {tab === 'chart' ? (
                <>
                  <ResponsiveContainer width="100%" height={360}>
                    <ComposedChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2d40" />
                      <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']}
                        tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={xFmt} tickCount={8} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={yFmt} width={64} />
                      <Tooltip content={<ChartTooltip options={options} shares={shares} cmp={cmp} targetDays={targetDays} ivStr={ivStr} dteStr={dteStr} calibratedIv={calibratedIv} />} />
                      <ReferenceLine y={0} stroke="#475569" strokeWidth={1.5} />
                      {!isNaN(cmp) && cmp > 0 && (
                        <ReferenceLine x={cmp} stroke="#e2e8f0" strokeWidth={2}
                          label={{ value: `₹${fmt(cmp)}`, fill: '#e2e8f0', fontSize: 10, fontWeight: 600, position: 'insideTopLeft' }} />
                      )}
                      {/* Target price line */}
                      {targetPrice != null && Math.abs(targetPrice - cmp) > 0.5 && (
                        <ReferenceLine x={Math.round(targetPrice * 10) / 10} stroke="#22d3ee" strokeWidth={1.5}
                          label={{ value: `Target ₹${fmt(Math.round(targetPrice))}`, fill: '#22d3ee', fontSize: 8, position: 'insideTopRight' }} />
                      )}
                      {options.map(o => (
                        <ReferenceLine key={o.id} x={o.strike}
                          stroke={o.type === 'CE' ? '#f59e0b' : '#ef4444'} strokeDasharray="3 3"
                          label={{ value: `${o.type} ${fmt(o.strike)}`, fill: o.type === 'CE' ? '#f59e0b' : '#ef4444', fontSize: 8, position: 'insideTopRight' }} />
                      ))}
                      {shares.map(s => (
                        <ReferenceLine key={s.id} x={s.buyPrice} stroke="#3b82f6" strokeDasharray="2 3"
                          label={{ value: s.label, fill: '#3b82f6', fontSize: 8, position: 'insideBottomRight' }} />
                      ))}
                      {breakevens.map((be, i) => (
                        <ReferenceLine key={`be-${i}`} x={be} stroke="#facc15" strokeDasharray="2 2"
                          label={{ value: 'BE', fill: '#facc15', fontSize: 8, position: 'top' }} />
                      ))}
                      {showComponents && options.length > 0 && shares.length > 0 && (
                        <Line type="monotone" dataKey="options" stroke="#10b981" strokeWidth={1.5} dot={false} strokeDasharray="5 3" name="Options" />
                      )}
                      {showComponents && options.length > 0 && shares.length > 0 && (
                        <Line type="monotone" dataKey="shares" stroke="#60a5fa" strokeWidth={1.5} dot={false} strokeDasharray="5 3" name="Shares" />
                      )}
                      <Line type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2.5} dot={false} name="On Expiry" />
                      <Line type="monotone" dataKey="target" stroke="#3b82f6" strokeWidth={2} dot={false} name="On Target Date" />
                      {/* Current-state dot — marks exactly where the position stands today */}
                      {liveMetrics && !isNaN(cmp) && cmp > 0 && (() => {
                        const mtm = liveMetrics.totalMtmPnl
                        const hasLive = options.some(o => o.liveOptPrice !== '' && !isNaN(+o.liveOptPrice))
                        return (
                          <ReferenceDot
                            x={Math.round(cmp * 10) / 10}
                            y={mtm}
                            r={6}
                            fill={hasLive ? '#22d3ee' : '#64748b'}
                            stroke="#0f172a"
                            strokeWidth={2}
                            label={{
                              value: `Today: ${mtm >= 0 ? '+' : ''}${fmtRs(mtm)}`,
                              fill: hasLive ? '#22d3ee' : '#94a3b8',
                              fontSize: 9, fontWeight: 600,
                              position: mtm >= 0 ? 'top' : 'bottom',
                            }}
                          />
                        )
                      })()}
                    </ComposedChart>
                  </ResponsiveContainer>

                  {/* ── What-If Sliders ── */}
                  {hasPositions && !isNaN(cmp) && cmp > 0 && (() => {
                    const iv   = parseFloat(ivStr) || 22
                    const dte  = parseInt(dteStr) || 37
                    const tRem = Math.max(0, (dte - targetDays) / 365)
                    const tp   = targetPrice ?? cmp
                    const projPnl  = midPnlAt(tp, tRem, iv, options, shares)
                    const pricePct = ((tp - cmp) / cmp * 100)
                    const sliderMin = Math.round(cmp * 0.70)
                    const sliderMax = Math.round(cmp * 1.30)
                    const today      = new Date()
                    const expiryDate = new Date(today); expiryDate.setDate(today.getDate() + dte)
                    const targetDate = new Date(today); targetDate.setDate(today.getDate() + targetDays)
                    const fmtD = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    const daysLeft = dte - targetDays
                    return (
                      <div className="mt-3 pt-3 border-t border-[#1e2d40] space-y-4">
                        {/* Projected P&L badge */}
                        <div className="flex items-center justify-center">
                          <div className={`text-sm font-bold px-5 py-1.5 rounded-full border ${projPnl >= 0 ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' : 'bg-red-950/60 text-red-400 border-red-800/50'}`}>
                            Projected P&L: {projPnl >= 0 ? '+' : ''}{fmtRs(projPnl)}
                          </div>
                        </div>

                        {/* Breakevens for both lines */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-[#0d1425] rounded-lg px-3 py-2">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <div className="w-3 border-t-2 border-blue-500" />
                              <span className="text-[9px] text-slate-400 font-medium">On Target Date BE</span>
                            </div>
                            {targetBreakevens.length === 0
                              ? <span className="text-[10px] text-slate-600">—</span>
                              : <div className="flex flex-wrap gap-2">
                                  {targetBreakevens.map((be, i) => (
                                    <span key={i} className="text-[11px] font-bold text-blue-400">₹{fmt(be)}</span>
                                  ))}
                                </div>
                            }
                          </div>
                          <div className="bg-[#0d1425] rounded-lg px-3 py-2">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <div className="w-3 border-t-2 border-emerald-500" />
                              <span className="text-[9px] text-slate-400 font-medium">On Expiry BE</span>
                            </div>
                            {breakevens.length === 0
                              ? <span className="text-[10px] text-slate-600">—</span>
                              : <div className="flex flex-wrap gap-2">
                                  {breakevens.map((be, i) => (
                                    <span key={i} className="text-[11px] font-bold text-emerald-400">₹{fmt(be)}</span>
                                  ))}
                                </div>
                            }
                          </div>
                        </div>
                        {/* Price slider */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-slate-400 font-medium">{symbolDisplay || symbol || 'Target'}</span>
                              <span className={`text-[10px] font-bold tabular-nums ${pricePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {pricePct >= 0 ? '+' : ''}{pricePct.toFixed(1)}%
                              </span>
                              <div className="flex items-center gap-1">
                                <button onClick={() => setTargetPrice(p => Math.max(sliderMin, Math.round((p ?? cmp) - 1)))}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-[#1e2d40] text-slate-400 hover:text-white text-sm leading-none">−</button>
                                <span className="text-[10px] text-white font-mono w-20 text-center">₹{fmt(Math.round(tp))}</span>
                                <button onClick={() => setTargetPrice(p => Math.min(sliderMax, Math.round((p ?? cmp) + 1)))}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-[#1e2d40] text-slate-400 hover:text-white text-sm leading-none">+</button>
                              </div>
                            </div>
                            <button onClick={() => setTargetPrice(null)} className="text-[10px] text-blue-400 hover:text-blue-300">Reset</button>
                          </div>
                          <input type="range" min={sliderMin} max={sliderMax} step={1}
                            value={Math.round(tp)}
                            onChange={e => setTargetPrice(+e.target.value)}
                            className="w-full h-1.5 cursor-pointer accent-cyan-400" />
                          <div className="flex justify-between text-[9px] text-slate-600 mt-1">
                            <span>−30%</span><span className="text-slate-500">CMP ₹{fmt(cmp)}</span><span>+30%</span>
                          </div>
                        </div>
                        {/* Date slider */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-slate-400 font-medium">Date</span>
                              <span className="text-[10px] text-white tabular-nums">{daysLeft}D to expiry</span>
                              <div className="flex items-center gap-1">
                                <button onClick={() => setTargetDays(d => Math.max(0, d - 1))}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-[#1e2d40] text-slate-400 hover:text-white text-xs leading-none">‹</button>
                                <span className="text-[10px] text-white font-mono w-20 text-center">{fmtD(targetDate)}</span>
                                <button onClick={() => setTargetDays(d => Math.min(dte, d + 1))}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-[#1e2d40] text-slate-400 hover:text-white text-xs leading-none">›</button>
                              </div>
                            </div>
                            <button onClick={() => setTargetDays(0)} className="text-[10px] text-blue-400 hover:text-blue-300">Reset</button>
                          </div>
                          <input type="range" min={0} max={dte} step={1}
                            value={targetDays}
                            onChange={e => setTargetDays(+e.target.value)}
                            className="w-full h-1.5 cursor-pointer accent-blue-500" />
                          <div className="flex justify-between text-[9px] text-slate-600 mt-1">
                            <span>{fmtD(today)}</span><span>{fmtD(expiryDate)}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                </>
              ) : (
                <div className="overflow-x-auto max-h-[540px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-[#111827] z-10">
                      <tr className="border-b-2 border-[#1e2d40]">
                        <th className="text-left py-2.5 pr-3 text-slate-400 font-medium min-w-24">Target</th>
                        {options.map(o => (
                          <th key={o.id} className={`py-2.5 px-2 text-right font-medium whitespace-nowrap ${o.type === 'CE' ? 'text-amber-400' : 'text-red-400'}`}>
                            {o.type} {fmt(o.strike)}<br />
                            <span className="text-[9px] font-normal text-slate-500">×{o.lots * o.lotSize} · BS</span>
                          </th>
                        ))}
                        {shares.map(s => (
                          <th key={s.id} className="py-2.5 px-2 text-right text-blue-400 font-medium whitespace-nowrap">
                            {s.label}<br />
                            <span className="text-[9px] font-normal text-slate-500">{fmt(s.qty)} sh</span>
                          </th>
                        ))}
                        <th className="py-2.5 px-2 text-right font-bold text-blue-400 min-w-24 whitespace-nowrap">
                          On Target Date<br />
                          <span className="text-[9px] font-normal text-slate-500">{(() => {
                            const dte = parseInt(dteStr) || 37
                            const d = new Date(); d.setDate(d.getDate() + targetDays)
                            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                          })()}</span>
                        </th>
                        <th className="py-2.5 pl-2 text-right text-emerald-400 font-bold min-w-24 whitespace-nowrap">
                          On Expiry<br />
                          <span className="text-[9px] font-normal text-slate-500">{(() => {
                            const dte = parseInt(dteStr) || 37
                            const d = new Date(); d.setDate(d.getDate() + dte)
                            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                          })()}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tablePrices.map(price => {
                        const iv   = parseFloat(ivStr) || 22
                        const dte  = parseInt(dteStr) || 37
                        const tRem = Math.max(0, (dte - targetDays) / 365)
                        // Per-leg: BS mid-cycle (dynamic with date + price sliders)
                        const perOpt  = options.map(o => legOptionMidPnl(o, price, tRem, iv))
                        const perSh   = shares.map(s => legSharePnl(s, price))
                        // On Target Date total = sum of mid-cycle legs
                        const midTotal = [...perOpt, ...perSh].reduce((a, b) => a + b, 0)
                        // On Expiry total = intrinsic (separate, not shown per-leg)
                        const total   = options.reduce((s, o) => s + legOptionPnl(o, price), 0)
                                      + perSh.reduce((a, b) => a + b, 0)
                        const isCmp   = !isNaN(cmp) && cmp > 0 && Math.abs(price - cmp) / cmp < 0.007
                        const isBe    = breakevens.some(be => Math.abs(price - be) <= 1)
                        const isStr   = options.some(o => o.strike === price)
                        const isTgt   = targetPrice != null && Math.abs(price - targetPrice) / (targetPrice || 1) < 0.007
                        let rowBg = 'hover:bg-[#0d1425]/50'
                        if (isTgt) rowBg = 'bg-cyan-950/30'
                        else if (isCmp) rowBg = 'bg-blue-950/25'
                        else if (isBe) rowBg = 'bg-yellow-950/25'
                        else if (isStr) rowBg = 'bg-slate-800/20'
                        return (
                          <tr key={price} className={`border-b border-[#1e2d40]/50 transition-colors ${rowBg}`}>
                            <td className="py-2.5 pr-3">
                              <div className="font-medium text-white">₹{fmt(price)}</div>
                              {!isNaN(cmp) && cmp > 0 && price !== Math.round(cmp) && (
                                <div className={`text-[9px] tabular-nums font-medium ${price > cmp ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {((price - cmp) / cmp * 100) >= 0 ? '+' : ''}{((price - cmp) / cmp * 100).toFixed(1)}%
                                </div>
                              )}
                              <div className="flex gap-1 mt-0.5 flex-wrap">
                                {isTgt && <span className="text-[9px] text-cyan-400">target</span>}
                                {isCmp && <span className="text-[9px] text-blue-400">CMP</span>}
                                {isBe  && <span className="text-[9px] text-yellow-400">breakeven</span>}
                                {isStr && <span className="text-[9px] text-slate-400">strike</span>}
                              </div>
                            </td>
                            {perOpt.map((v, i) => (
                              <td key={i} className={`py-2.5 px-2 text-right font-semibold ${clr(v)}`}>
                                {v >= 0 ? '+' : ''}{fmtRs(v)}
                              </td>
                            ))}
                            {perSh.map((v, i) => (
                              <td key={i} className={`py-2.5 px-2 text-right font-semibold ${clr(v)}`}>
                                {v >= 0 ? '+' : ''}{fmtRs(v)}
                              </td>
                            ))}
                            <td className={`py-2.5 px-2 text-right font-bold text-base ${clr(midTotal)}`}>
                              {midTotal >= 0 ? '+' : ''}{fmtRs(midTotal)}
                            </td>
                            <td className={`py-2.5 pl-2 text-right font-bold text-base ${clr(total)}`}>
                              {total >= 0 ? '+' : ''}{fmtRs(total)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'chart' && (
                <div className="flex flex-wrap gap-4 mt-2 pt-2 border-t border-[#1e2d40]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 border-t-2 border-emerald-500" />
                    <span className="text-[10px] text-slate-400">On Expiry</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 border-t-2 border-blue-500" />
                    <span className="text-[10px] text-slate-400">On Target Date</span>
                  </div>
                  {showComponents && options.length > 0 && shares.length > 0 && <>
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 border-t-2 border-dashed border-emerald-500" />
                      <span className="text-[10px] text-slate-400">Options</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 border-t-2 border-dashed border-blue-400" />
                      <span className="text-[10px] text-slate-400">Shares</span>
                    </div>
                  </>}
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 border-t border-dashed border-yellow-400" />
                    <span className="text-[10px] text-slate-400">Breakeven</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── AI Prediction section ───────────────────────────────────────────── */}
      {(prediction !== null || predicting || predError) && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[#1e2d40] pb-3">
            <span className="text-base">🔮</span>
            <div>
              <div className="text-sm font-semibold text-white">Rule-Based AI Prediction</div>
              <div className="text-[10px] text-slate-500">
                Technical indicators · news sentiment · market conditions · Black-Scholes theta
              </div>
            </div>
            <button
              onClick={() => { setPrediction(null); setPredError(null) }}
              className="ml-auto text-slate-500 hover:text-white text-xs shrink-0"
            >✕ Close</button>
          </div>

          {predError && (
            <div className="bg-red-950/30 border border-red-800/40 rounded-xl p-3 text-xs text-red-400">
              {predError}
            </div>
          )}

          {predicting && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-10 text-center">
              <div className="text-3xl mb-3 animate-pulse">🔮</div>
              <div className="text-sm font-medium text-white mb-1">
                Analysing {symbolDisplay || symbol}…
              </div>
              <div className="text-[10px] text-slate-500">
                Fetching news · computing technical indicators · checking market sentiment
              </div>
            </div>
          )}

          {prediction && !predicting && (
            <>
              {/* Analysis cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Technical */}
                <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold text-white">📊 Technical</span>
                    <BiasChip bias={prediction.analysis.tech_bias} />
                  </div>
                  <BiasBar bias={prediction.analysis.tech_bias} />
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] mb-3">
                    <div>
                      <div className="text-slate-500">RSI</div>
                      <div className="text-white font-bold">{prediction.analysis.rsi}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">SMA20</div>
                      <div className="text-white font-bold">₹{fmt(prediction.analysis.sma20)}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">5-day</div>
                      <div className={`font-bold ${prediction.analysis.trend_5d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {prediction.analysis.trend_5d >= 0 ? '+' : ''}{prediction.analysis.trend_5d}%
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {prediction.analysis.tech_signals.slice(0, 4).map((s, i) => (
                      <div key={i} className="text-[9px] text-slate-500 leading-snug">• {s}</div>
                    ))}
                  </div>
                </div>

                {/* News */}
                <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold text-white">📰 News Sentiment</span>
                    <BiasChip bias={prediction.analysis.news_bias} />
                  </div>
                  <BiasBar bias={prediction.analysis.news_bias} />
                  <div className="mt-3 text-[10px] text-slate-400 mb-3">
                    {prediction.analysis.news_count > 0
                      ? prediction.analysis.news_summary
                      : 'No recent headlines found'}
                  </div>
                  {prediction.analysis.top_headlines.length > 0 && (
                    <div className="space-y-1.5">
                      {prediction.analysis.top_headlines.slice(0, 2).map((h, i) => (
                        <div key={i} className="text-[9px] text-slate-500 leading-snug">• {h}</div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Market + combined */}
                <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold text-white">🌐 Market</span>
                    <BiasChip bias={prediction.analysis.market_bias} />
                  </div>
                  <BiasBar bias={prediction.analysis.market_bias} />
                  <div className="mt-3 text-[10px] text-slate-400 space-y-1.5 mb-3">
                    <div>{prediction.analysis.market_summary}</div>
                    {prediction.analysis.global_summary && (
                      <div className="text-slate-500">{prediction.analysis.global_summary}</div>
                    )}
                  </div>
                  <div className="p-2.5 bg-[#0d1425] rounded-lg">
                    <div className="text-[9px] text-slate-500 mb-1">Combined directional bias</div>
                    <BiasBar bias={prediction.analysis.combined_bias} />
                    <div className="text-[10px] text-white font-medium mt-2">{prediction.analysis.outlook}</div>
                  </div>
                </div>
              </div>

              {/* Prediction timeline */}
              <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
                <div className="mb-4">
                  <div className="text-xs font-semibold text-white">Predicted Price & P&L by Target Date</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    MTM = close on target day (BS) · Expiry = hold to expiry at predicted price · PoP = probability of profit
                  </div>
                </div>
                {prediction.predictions.length === 0 ? (
                  <div className="text-center py-6 text-slate-600 text-xs">
                    All target dates exceed DTE — enter a larger DTE to see predictions
                  </div>
                ) : (
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {prediction.predictions.map(p => (
                      <PredCard key={p.day} p={p} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

    </div>
  )
}
