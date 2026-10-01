import { useState, useMemo } from 'react'
import {
  ComposedChart, Line, ReferenceLine, ReferenceDot, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import NseStockSearch from '../components/NseStockSearch'
import client from '../api/client'
import AgentStrategyReview from '../components/AgentStrategyReview'
import type { StrategyLeg } from '../types'

// ─── Types ───────────────────────────────────────────────────────────────────

interface OptionLeg {
  id: string
  symbol: string
  symbolDisplay: string
  type: 'CE' | 'PE'
  direction: 'SHORT' | 'LONG'
  strike: number
  premium: number       // received (SHORT) or paid (LONG)
  lots: number
  lotSize: number
  entryCmp: number      // underlying CMP when entered — chart % axis anchor
  marketPrice: number   // current live underlying price
  targetPrice: number   // user's price target
  iv: number
  dte: number
  expiry: string
  exitPremium: string
}

interface ShareLeg {
  id: string
  symbol: string
  symbolDisplay: string
  label: string
  qty: number
  buyPrice: number
  marketPrice: number   // current CMP
  targetPrice: number   // user's price target
  exitPrice: string
}

interface AiScenario {
  label: 'Bullish' | 'Neutral' | 'Bearish'
  prob: number
  symPrices: Record<string, number>  // symbol → predicted price at DTE
  totalPnl: number
  analysis: string
  outlook: string
  confidence: string
}

// ─── P&L helpers ─────────────────────────────────────────────────────────────

// sign: SHORT=+1 (profit when price falls), LONG=−1
function _sign(o: OptionLeg) { return o.direction === 'SHORT' ? 1 : -1 }

// Expiry P&L at an absolute underlying price
function optExpiryPnlAtPrice(o: OptionLeg, price: number): number {
  const qty = o.lots * o.lotSize
  const ep  = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
  if (ep !== null) return _sign(o) * Math.round((o.premium - ep) * qty)
  const intr = o.type === 'CE' ? Math.max(0, price - o.strike) : Math.max(0, o.strike - price)
  return _sign(o) * Math.round((o.premium - intr) * qty)
}

// BS mid-price P&L at an absolute underlying price
function optTodayPnlAtPrice(o: OptionLeg, price: number, tDays: number): number {
  const qty  = o.lots * o.lotSize
  const ep   = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
  if (ep !== null) return _sign(o) * Math.round((o.premium - ep) * qty)
  const tRem = Math.max(0, (o.dte - tDays) / 365)
  return _sign(o) * Math.round((o.premium - bsPrice(price, o.strike, o.iv, tRem, o.type === 'CE')) * qty)
}

function sharePnlAtPrice(s: ShareLeg, price: number): number {
  const ep = s.exitPrice !== '' && !isNaN(+s.exitPrice) ? +s.exitPrice : null
  return ep !== null ? Math.round((ep - s.buyPrice) * s.qty) : Math.round((price - s.buyPrice) * s.qty)
}

// Chart helpers — x-axis is % move applied uniformly from entryCmp/buyPrice
function legOptExpiryPct(o: OptionLeg, pct: number): number {
  return optExpiryPnlAtPrice(o, o.entryCmp * (1 + pct / 100))
}
function legOptMidPct(o: OptionLeg, pct: number, tDays: number): number {
  return optTodayPnlAtPrice(o, o.entryCmp * (1 + pct / 100), tDays)
}
function legSharePct(s: ShareLeg, pct: number): number {
  const base = s.marketPrice > 0 ? s.marketPrice : s.buyPrice
  const ep = s.exitPrice !== '' && !isNaN(+s.exitPrice) ? +s.exitPrice : null
  return ep !== null ? Math.round((ep - s.buyPrice) * s.qty) : Math.round((base * (1 + pct / 100) - s.buyPrice) * s.qty)
}

// Totals at specific price maps (for table special rows and scenarios)
function totalAtPrices(
  options: OptionLeg[], shares: ShareLeg[],
  getPx: (id: string, sym: string, isSh: boolean) => number,
  timing: 'expiry' | 'today', tDays: number
): number {
  const o = options.reduce((s, o) => {
    const px = getPx(o.id, o.symbol, false)
    return s + (timing === 'expiry' ? optExpiryPnlAtPrice(o, px) : optTodayPnlAtPrice(o, px, tDays))
  }, 0)
  const sh = shares.reduce((s, sh) => s + sharePnlAtPrice(sh, getPx(sh.id, sh.symbol, true)), 0)
  return o + sh
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmt    = (n: number, d = 0) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtRs  = (n: number)        => n < 0 ? `-₹${fmt(Math.abs(n))}` : `₹${fmt(n)}`
const clr    = (v: number)        => v >= 0 ? 'text-emerald-400' : 'text-red-400'
const bgClr  = (v: number)        => v >= 0 ? 'bg-emerald-950/40' : 'bg-red-950/30'
const pctFmt = (p: number)        => `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`

function yFmt(v: number) {
  const a = Math.abs(v), s = v < 0 ? '-' : '+'
  if (a >= 100000) return `${s}₹${(a / 100000).toFixed(1)}L`
  if (a >= 1000)   return `${s}₹${(a / 1000).toFixed(0)}k`
  return `${s}₹${a}`
}

// ─── Black-Scholes ────────────────────────────────────────────────────────────

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
function bsDelta(S: number, K: number, iv: number, T: number, isCall: boolean, r = 0.065) {
  if (T <= 0) return isCall ? (S >= K ? 1 : 0) : (S <= K ? -1 : 0)
  return isCall ? _ncdf(_bsD1(S, K, iv, T, r)) : _ncdf(_bsD1(S, K, iv, T, r)) - 1
}
function bsTheta(S: number, K: number, iv: number, T: number, isCall: boolean, r = 0.065) {
  if (T <= 0) return 0
  const sigma = iv / 100, d1 = _bsD1(S, K, iv, T, r), d2 = d1 - sigma * Math.sqrt(T)
  const base = -(S * _npdf(d1) * sigma) / (2 * Math.sqrt(T))
  return isCall ? (base - r * K * Math.exp(-r * T) * _ncdf(d2)) / 365
                : (base + r * K * Math.exp(-r * T) * _ncdf(-d2)) / 365
}
function impliedVol(S: number, K: number, T: number, target: number, isCall: boolean, r = 0.065): number | null {
  if (T <= 0 || S <= 0 || K <= 0 || target < 0) return null
  const intr = isCall ? Math.max(0, S - K) : Math.max(0, K - S)
  if (target < intr - 0.5) return null
  let iv = 30
  for (let i = 0; i < 100; i++) {
    const p = bsPrice(S, K, iv, T, isCall, r)
    const v = S * _npdf(_bsD1(S, K, iv, T, r)) * Math.sqrt(T) / 100
    const d = p - target
    if (Math.abs(d) < 0.005) break
    iv = Math.max(1, Math.min(300, Math.abs(v) < 1e-8 ? iv + (d > 0 ? -1 : 1) : iv - d / v))
  }
  return Math.abs(bsPrice(S, K, iv, T, isCall, r) - target) < 0.5 ? Math.round(iv * 10) / 10 : null
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SymBadge({ sym, display }: { sym: string; display: string }) {
  const up = (sym + display).toUpperCase()
  const isIdx = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY'].some(i => up.includes(i))
  const isEtf = ['BEES', 'MON100', 'ICICIB', 'GOLDETF'].some(s => up.includes(s)) || up.endsWith('ETF')
  const cls = isIdx ? 'bg-violet-950 text-violet-300 border-violet-800/60'
    : isEtf ? 'bg-teal-950 text-teal-300 border-teal-800/60'
    : 'bg-slate-800 text-slate-300 border-slate-700/60'
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${cls} shrink-0`}>
      {display.replace('.NS', '').replace('^', '').slice(0, 14)}
    </span>
  )
}

function Inp({ label, value, onChange, placeholder, className = '' }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; className?: string
}) {
  return (
    <div className={className}>
      <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</label>
      <input type="number" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TABLE_PCTS = [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20]

export default function MultiBuilder() {
  const [options, setOptions] = useState<OptionLeg[]>([])
  const [shares,  setShares]  = useState<ShareLeg[]>([])
  const [targetDays, setTargetDays] = useState(0)
  const [tab, setTab] = useState<'chart' | 'table'>('chart')

  // Add option form
  const [addingOpt,    setAddingOpt]    = useState(false)
  const [newDir,       setNewDir]       = useState<'SHORT' | 'LONG'>('SHORT')
  const [newType,      setNewType]      = useState<'CE' | 'PE'>('PE')
  const [newSym,       setNewSym]       = useState('')
  const [newSymDisp,   setNewSymDisp]   = useState('')
  const [newCmp,       setNewCmp]       = useState('')
  const [newIv,        setNewIv]        = useState('')
  const [newDte,       setNewDte]       = useState('')
  const [newExpiry,    setNewExpiry]    = useState('')
  const [newStrike,    setNewStrike]    = useState('')
  const [newPrem,      setNewPrem]      = useState('')
  const [newLots,      setNewLots]      = useState('1')
  const [newLS,        setNewLS]        = useState('1')
  const [quoteLoading, setQuoteLoading] = useState(false)

  // Add share form
  const [addingSh,       setAddingSh]       = useState(false)
  const [newShSym,       setNewShSym]       = useState('')
  const [newShSymDisp,   setNewShSymDisp]   = useState('')
  const [newShCmp,       setNewShCmp]       = useState('')
  const [newShLabel,     setNewShLabel]     = useState('')
  const [newShQty,       setNewShQty]       = useState('')
  const [newShPrice,     setNewShPrice]     = useState('')
  const [shQuoteLoading, setShQuoteLoading] = useState(false)

  // AI scenarios
  const [scenarios,       setScenarios]       = useState<AiScenario[]>([])
  const [scenariosLoading,setScenariosLoading] = useState(false)
  const [scenariosError,  setScenariosError]   = useState<string | null>(null)

  const hasPositions = options.length > 0 || shares.length > 0
  const maxDte = options.length > 0 ? Math.max(...options.map(o => o.dte)) : 30

  // ── quote helpers ───────────────────────────────────────────────────────────
  async function fetchQuoteForOpt(sym: string) {
    setQuoteLoading(true)
    try {
      const r = await client.get(`/cushion-strangle/quote/${encodeURIComponent(sym)}`)
      setNewCmp(String(r.data.cmp)); setNewIv(String(r.data.iv)); setNewLS(String(r.data.lot_size))
    } catch {}
    setQuoteLoading(false)
  }
  async function fetchQuoteForShare(sym: string) {
    setShQuoteLoading(true)
    try {
      const r = await client.get(`/cushion-strangle/quote/${encodeURIComponent(sym)}`)
      setNewShCmp(String(r.data.cmp))
    } catch {}
    setShQuoteLoading(false)
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  function commitOption() {
    const strike = parseFloat(newStrike), premium = parseFloat(newPrem)
    if (!newSym || isNaN(strike) || isNaN(premium)) return
    const cmp = parseFloat(newCmp) || 0
    setOptions(p => [...p, {
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      symbol: newSym, symbolDisplay: newSymDisp, type: newType, direction: newDir,
      strike, premium, lots: parseInt(newLots) || 1, lotSize: parseInt(newLS) || 1,
      entryCmp: cmp, marketPrice: cmp, targetPrice: 0,
      iv: parseFloat(newIv) || 22, dte: parseInt(newDte) || 30, expiry: newExpiry,
      exitPremium: '',
    }])
    setAddingOpt(false)
    setNewSym(''); setNewSymDisp(''); setNewCmp(''); setNewIv('')
    setNewDte(''); setNewExpiry(''); setNewStrike(''); setNewPrem(''); setNewLots('1')
  }

  function commitShare() {
    const qty = parseInt(newShQty), buyPrice = parseFloat(newShPrice)
    if (!newShSym || isNaN(qty) || qty < 1 || isNaN(buyPrice)) return
    const cmp = parseFloat(newShCmp) || buyPrice
    setShares(p => [...p, {
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      symbol: newShSym, symbolDisplay: newShSymDisp,
      label: newShLabel.trim() || newShSymDisp || `Buy ${shares.length + 1}`,
      qty, buyPrice, marketPrice: cmp, targetPrice: 0, exitPrice: '',
    }])
    setAddingSh(false)
    setNewShSym(''); setNewShSymDisp(''); setNewShCmp(''); setNewShLabel(''); setNewShQty(''); setNewShPrice('')
  }

  // ── AI Scenarios ────────────────────────────────────────────────────────────
  async function fetchScenarios() {
    if (!hasPositions) return
    setScenariosLoading(true); setScenariosError(null); setScenarios([])

    // Collect unique symbols with their best CMP, IV, DTE
    const symMap = new Map<string, { cmp: number; iv: number; dte: number; clean: string }>()
    for (const o of options) {
      if (!symMap.has(o.symbol)) {
        const cmp = o.marketPrice > 0 ? o.marketPrice : o.entryCmp
        symMap.set(o.symbol, { cmp, iv: o.iv, dte: o.dte, clean: o.symbolDisplay.replace('.NS', '').replace('^', '') })
      }
    }
    for (const s of shares) {
      if (!symMap.has(s.symbol)) {
        const cmp = s.marketPrice > 0 ? s.marketPrice : s.buyPrice
        symMap.set(s.symbol, { cmp, iv: 20, dte: 30, clean: s.symbolDisplay.replace('.NS', '').replace('^', '') })
      }
    }

    // Call predict for each unique symbol (empty strategy — just for price range prediction)
    const bullPx: Record<string, number> = {}
    const neutPx: Record<string, number> = {}
    const bearPx: Record<string, number> = {}
    let totalBias = 0, biasCount = 0, combinedOutlook = '', combinedConf = 'medium'
    let newsSnippet = ''

    await Promise.allSettled([...symMap.entries()].map(async ([sym, { cmp, iv, dte, clean }]) => {
      try {
        const r = await client.post('/cushion-strangle/predict', {
          symbol: clean, cmp, iv, dte, rf: 0.065, options: [], shares: [],
        })
        const preds: any[] = r.data.predictions
        const analysis     = r.data.analysis
        // Use prediction at end of DTE (last day)
        const last = preds[preds.length - 1] ?? preds[0]
        bullPx[sym] = last.price_high
        neutPx[sym] = last.price_point
        bearPx[sym] = last.price_low
        totalBias += analysis.combined_bias ?? 0; biasCount++
        if (!combinedOutlook) combinedOutlook = analysis.outlook ?? ''
        if (!newsSnippet && analysis.news_summary) newsSnippet = analysis.news_summary
        if (analysis.confidence) combinedConf = analysis.confidence
      } catch {
        // Fallback: ±1.5σ based on IV
        const sigma = (iv / 100) * Math.sqrt(dte / 365)
        bullPx[sym] = Math.round(cmp * (1 + 1.5 * sigma) * 100) / 100
        neutPx[sym] = cmp
        bearPx[sym] = Math.round(cmp * (1 - 1.5 * sigma) * 100) / 100
      }
    }))

    const avgBias = biasCount > 0 ? totalBias / biasCount : 0
    let bullProb = 35, neutProb = 40, bearProb = 25
    if (avgBias > 0.25)       { bullProb = 50; neutProb = 35; bearProb = 15 }
    else if (avgBias > 0.1)   { bullProb = 42; neutProb = 38; bearProb = 20 }
    else if (avgBias < -0.25) { bullProb = 15; neutProb = 35; bearProb = 50 }
    else if (avgBias < -0.1)  { bullProb = 20; neutProb = 38; bearProb = 42 }

    function scenarioPnl(priceMap: Record<string, number>, timing: 'expiry' | 'today'): number {
      return totalAtPrices(options, shares,
        (_, sym, isSh) => {
          const px = priceMap[sym]
          if (px) return px
          // fallback: use market price
          if (isSh) return shares.find(s => s.symbol === sym)?.marketPrice ?? 0
          return options.find(o => o.symbol === sym)?.marketPrice ?? 0
        },
        timing, targetDays
      )
    }

    setScenarios([
      {
        label: 'Bullish', prob: bullProb,
        symPrices: bullPx,
        totalPnl: scenarioPnl(bullPx, 'expiry'),
        analysis: avgBias > 0.1 ? `RSI + news bias positive (${(avgBias * 100).toFixed(0)} score). ${newsSnippet.slice(0, 100)}` : 'Broad market rally scenario — all underlyings at upper price band.',
        outlook: combinedOutlook, confidence: combinedConf,
      },
      {
        label: 'Neutral', prob: neutProb,
        symPrices: neutPx,
        totalPnl: scenarioPnl(neutPx, 'expiry'),
        analysis: `Prices consolidate near base projections. Theta decay works in favour of short options.`,
        outlook: '', confidence: combinedConf,
      },
      {
        label: 'Bearish', prob: bearProb,
        symPrices: bearPx,
        totalPnl: scenarioPnl(bearPx, 'expiry'),
        analysis: avgBias < -0.1 ? `RSI + news bias negative (${(avgBias * 100).toFixed(0)} score). ${newsSnippet.slice(0, 100)}` : 'Broad market correction — all underlyings at lower price band.',
        outlook: combinedOutlook, confidence: combinedConf,
      },
    ])
    setScenariosLoading(false)
  }

  // ── computed data ───────────────────────────────────────────────────────────

  // Chart data (% move from entryCmp)
  const chartData = useMemo(() => {
    if (!hasPositions) return []
    return Array.from({ length: 201 }, (_, i) => {
      const pct = -25 + i * 0.25
      const expiry = options.reduce((s, o) => s + legOptExpiryPct(o, pct), 0)
               + shares.reduce((s, sh) => s + legSharePct(sh, pct), 0)
      const target = options.reduce((s, o) => s + legOptMidPct(o, pct, targetDays), 0)
               + shares.reduce((s, sh) => s + legSharePct(sh, pct), 0)
      return { pct: Math.round(pct * 10) / 10, expiry, target }
    })
  }, [options, shares, targetDays, hasPositions])

  // Current P&L at market prices (for reference lines)
  const mktPnl = useMemo(() => {
    if (!hasPositions) return null
    const expiry = totalAtPrices(options, shares,
      (id, sym, isSh) => {
        if (isSh) { const s = shares.find(x => x.id === id); return s?.marketPrice || s?.buyPrice || 0 }
        const o = options.find(x => x.id === id); return o?.marketPrice || o?.entryCmp || 0
      }, 'expiry', targetDays)
    const today = totalAtPrices(options, shares,
      (id, _, isSh) => {
        if (isSh) { const s = shares.find(x => x.id === id); return s?.marketPrice || s?.buyPrice || 0 }
        const o = options.find(x => x.id === id); return o?.marketPrice || o?.entryCmp || 0
      }, 'today', targetDays)
    return { expiry, today }
  }, [options, shares, targetDays, hasPositions])

  // Target P&L (when user's target prices are set)
  const targetPnl = useMemo(() => {
    const hasTargets = options.some(o => o.targetPrice > 0) || shares.some(s => s.targetPrice > 0)
    if (!hasPositions || !hasTargets) return null
    const expiry = totalAtPrices(options, shares,
      (id, _, isSh) => {
        if (isSh) {
          const s = shares.find(x => x.id === id)
          return (s?.targetPrice || 0) > 0 ? s!.targetPrice : (s?.marketPrice || s?.buyPrice || 0)
        }
        const o = options.find(x => x.id === id)
        return (o?.targetPrice || 0) > 0 ? o!.targetPrice : (o?.marketPrice || o?.entryCmp || 0)
      }, 'expiry', targetDays)
    return { expiry }
  }, [options, shares, targetDays, hasPositions])

  // Live portfolio metrics at market prices
  const liveMetrics = useMemo(() => {
    if (!hasPositions) return null
    const optMetrics = options.map(o => {
      const qty = o.lots * o.lotSize, sign = _sign(o), isCall = o.type === 'CE'
      const T = o.dte / 365
      const ep = o.exitPremium !== '' && !isNaN(+o.exitPremium) ? +o.exitPremium : null
      if (ep !== null) return { id: o.id, mtmPnl: sign * Math.round((o.premium - ep) * qty), delta: 0, theta: 0, exited: true }
      const px = o.marketPrice > 0 ? o.marketPrice : o.entryCmp
      const cv = bsPrice(px, o.strike, o.iv, T, isCall)
      const δ  = sign === 1 ? -bsDelta(px, o.strike, o.iv, T, isCall) * qty : bsDelta(px, o.strike, o.iv, T, isCall) * qty
      const θ  = sign * (-bsTheta(px, o.strike, o.iv, T, isCall)) * qty
      return { id: o.id, mtmPnl: sign * Math.round((o.premium - cv) * qty), delta: δ, theta: θ, exited: false }
    })
    const shareMetrics = shares.map(s => {
      const ep = s.exitPrice !== '' && !isNaN(+s.exitPrice) ? +s.exitPrice : null
      const px = s.marketPrice > 0 ? s.marketPrice : s.buyPrice
      return ep !== null
        ? { id: s.id, mtmPnl: Math.round((ep - s.buyPrice) * s.qty), delta: 0, exited: true }
        : { id: s.id, mtmPnl: Math.round((px - s.buyPrice) * s.qty), delta: s.qty, exited: false }
    })
    const totalMtm  = [...optMetrics, ...shareMetrics].reduce((a, m) => a + m.mtmPnl, 0)
    const netDelta  = [...optMetrics, ...shareMetrics].reduce((a, m) => a + m.delta,  0)
    const totalTheta = optMetrics.reduce((a, m) => a + m.theta, 0)
    return { optMetrics, shareMetrics, totalMtm, netDelta, totalTheta }
  }, [options, shares, hasPositions])

  const breakevens = useMemo(() => {
    const bes: number[] = []
    for (let i = 1; i < chartData.length; i++) {
      const a = chartData[i - 1], b = chartData[i]
      if (a.expiry * b.expiry <= 0 && a.expiry !== b.expiry) {
        const t = -a.expiry / (b.expiry - a.expiry)
        bes.push(Math.round((a.pct + (b.pct - a.pct) * t) * 10) / 10)
      }
    }
    return bes
  }, [chartData])

  const maxProfit  = chartData.length ? Math.max(...chartData.map(d => d.expiry)) : 0
  const maxLoss    = chartData.length ? Math.min(...chartData.map(d => d.expiry)) : 0
  const netIncome  = options.filter(o => o.direction === 'SHORT').reduce((s, o) => s + o.premium * o.lots * o.lotSize, 0)
                   - options.filter(o => o.direction === 'LONG') .reduce((s, o) => s + o.premium * o.lots * o.lotSize, 0)

  // ── P&L table rows ─────────────────────────────────────────────────────────
  const tableRows = useMemo(() => {
    if (!hasPositions) return []
    const rows = TABLE_PCTS.map(pct => ({
      label:  pct === 0 ? '0% (Entry CMP)' : pctFmt(pct),
      pct,
      expiry: options.reduce((s, o) => s + legOptExpiryPct(o, pct), 0) + shares.reduce((s, sh) => s + legSharePct(sh, pct), 0),
      today:  options.reduce((s, o) => s + legOptMidPct(o, pct, targetDays), 0) + shares.reduce((s, sh) => s + legSharePct(sh, pct), 0),
      special: false,
    }))
    // Special rows
    const hasMarket = options.some(o => o.marketPrice > 0 && o.marketPrice !== o.entryCmp)
                   || shares.some(s => s.marketPrice > 0 && s.marketPrice !== s.buyPrice)
    const hasTarget = options.some(o => o.targetPrice > 0) || shares.some(s => s.targetPrice > 0)
    if (hasMarket && mktPnl) {
      rows.push({ label: '@ Market Prices', pct: NaN, expiry: mktPnl.expiry, today: mktPnl.today, special: true })
    }
    if (hasTarget && targetPnl) {
      rows.push({ label: '@ Target Prices', pct: NaN, expiry: targetPnl.expiry, today: NaN, special: true })
    }
    return rows
  }, [options, shares, targetDays, hasPositions, mktPnl, targetPnl])

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Multi-Asset Strategy Builder</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Mix stocks · indices · ETFs · SHORT or LONG CE / PE · enter market + target prices per leg
          </p>
        </div>
        <div className="flex gap-2">
          {hasPositions && (
            <button onClick={fetchScenarios} disabled={scenariosLoading}
              className="text-xs bg-violet-950 border border-violet-800/60 text-violet-300 hover:bg-violet-900 disabled:opacity-40 disabled:cursor-wait px-3 py-1.5 rounded-lg font-medium">
              {scenariosLoading ? '⏳ Analysing…' : '🔮 AI Scenarios'}
            </button>
          )}
          {hasPositions && (
            <button onClick={() => { setOptions([]); setShares([]); setScenarios([]) }}
              className="text-xs border border-[#1e2d40] text-slate-500 hover:text-red-400 px-3 py-1.5 rounded-lg">
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* What-if slider */}
      {hasPositions && options.length > 0 && (
        <div className="bg-[#111827] border border-[#1e2d40] rounded-xl px-4 py-3 flex flex-wrap items-center gap-4">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider shrink-0">Simulate: Days Forward</span>
          <input type="range" min={0} max={maxDte} value={targetDays}
            onChange={e => setTargetDays(+e.target.value)} className="flex-1 min-w-32 accent-blue-500" />
          <span className="text-sm text-white font-medium tabular-nums shrink-0 w-10">+{targetDays}d</span>
          {targetDays > 0 && <button onClick={() => setTargetDays(0)} className="text-[10px] text-slate-500 hover:text-white">Reset</button>}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ── LEFT: position builder ─────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Options card */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-semibold text-white">Option Legs</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{options.length === 0 ? 'No legs' : `${options.length} leg${options.length > 1 ? 's' : ''}`}</div>
              </div>
              <button onClick={() => { setAddingOpt(v => !v); setAddingSh(false) }}
                className="text-[10px] bg-blue-950 border border-blue-800/60 text-blue-400 hover:bg-blue-900 px-2.5 py-1.5 rounded-lg">
                + Add Option Leg
              </button>
            </div>

            {options.length === 0 && !addingOpt && (
              <div className="text-center py-8 text-slate-600 text-xs">Add SHORT or LONG CE / PE from any stock, index, or ETF</div>
            )}

            <div className="space-y-2">
              {options.map(o => {
                const live = liveMetrics?.optMetrics.find(m => m.id === o.id)
                const px   = o.marketPrice > 0 ? o.marketPrice : o.entryCmp
                const itm  = o.type === 'CE' ? px > o.strike : px < o.strike
                return (
                  <div key={o.id} className="rounded-lg border border-[#1e2d40]/60 bg-[#0d1425] p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SymBadge sym={o.symbol} display={o.symbolDisplay} />
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${o.direction === 'SHORT' ? 'bg-orange-950 text-orange-400' : 'bg-emerald-950 text-emerald-400'}`}>{o.direction}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${o.type === 'CE' ? 'bg-amber-950 text-amber-400' : 'bg-red-950 text-red-400'}`}>{o.type}</span>
                        <span className="text-sm font-bold text-white">₹{fmt(o.strike)}</span>
                        <span className={`text-[9px] px-1 py-0.5 rounded ${itm ? 'text-orange-400' : 'text-slate-500'}`}>{itm ? 'ITM' : 'OTM'}</span>
                      </div>
                      <button onClick={() => setOptions(p => p.filter(x => x.id !== o.id))} className="text-slate-500 hover:text-red-400 text-xs ml-2 shrink-0">✕</button>
                    </div>
                    <div className="text-[10px] text-slate-400 mb-2 leading-5">
                      {o.lots}L × {o.lotSize} = <span className="text-white">{o.lots * o.lotSize}</span> qty
                      {' · '}premium <span className={o.direction === 'SHORT' ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>₹{o.premium}</span>
                      {' · '}entry CMP <span className="text-white">₹{fmt(o.entryCmp)}</span>
                      {' · '}IV <span className="text-cyan-400">{o.iv}%</span>
                      {' · '}{o.dte}d{o.expiry && ` · ${o.expiry}`}
                    </div>

                    {/* Market Price + Target Price */}
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#1e2d40]">
                      <div>
                        <label className="block text-[9px] text-slate-500 mb-1">Underlying Mkt ₹</label>
                        <input type="number"
                          value={o.marketPrice > 0 ? o.marketPrice : ''}
                          onChange={e => setOptions(p => p.map(x => x.id === o.id ? { ...x, marketPrice: parseFloat(e.target.value) || 0 } : x))}
                          placeholder={fmt(o.entryCmp)}
                          className="w-full bg-[#111827] border border-cyan-900/50 text-cyan-300 text-[10px] rounded px-2 py-1 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600" />
                      </div>
                      <div>
                        <label className="block text-[9px] text-slate-500 mb-1">Target Underlying ₹</label>
                        <input type="number"
                          value={o.targetPrice > 0 ? o.targetPrice : ''}
                          onChange={e => setOptions(p => p.map(x => x.id === o.id ? { ...x, targetPrice: parseFloat(e.target.value) || 0 } : x))}
                          placeholder="your target"
                          className="w-full bg-[#111827] border border-amber-900/50 text-amber-300 text-[10px] rounded px-2 py-1 focus:outline-none focus:border-amber-500 placeholder:text-slate-600" />
                      </div>
                    </div>

                    {/* Exit buyback */}
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] text-slate-500 shrink-0">Exit ₹:</span>
                      <input type="number" value={o.exitPremium}
                        onChange={e => setOptions(p => p.map(x => x.id === o.id ? { ...x, exitPremium: e.target.value } : x))}
                        placeholder="hold to expiry"
                        className="flex-1 min-w-0 bg-[#111827] border border-[#1e2d40] text-white text-[10px] rounded px-2 py-1 focus:outline-none focus:border-violet-500" />
                      {o.exitPremium !== '' && !isNaN(+o.exitPremium) && (
                        <span className={`text-[9px] font-bold shrink-0 ${clr(_sign(o) * (o.premium - +o.exitPremium))}`}>
                          locked {fmtRs(_sign(o) * Math.round((o.premium - +o.exitPremium) * o.lots * o.lotSize))}
                        </span>
                      )}
                    </div>

                    {/* Live Greeks */}
                    {live && !live.exited && (
                      <div className="mt-2 pt-2 border-t border-[#1e2d40] grid grid-cols-3 gap-1.5 text-[9px]">
                        <div><div className="text-slate-500">MTM P&L</div><div className={`font-bold ${clr(live.mtmPnl)}`}>{live.mtmPnl >= 0 ? '+' : ''}{fmtRs(live.mtmPnl)}</div></div>
                        <div><div className="text-slate-500">Δ</div><div className="text-blue-400 font-bold">{live.delta.toFixed(1)}</div></div>
                        <div><div className="text-slate-500">θ/day</div><div className={`font-bold ${live.theta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{live.theta >= 0 ? '+' : ''}{fmtRs(Math.round(live.theta))}</div></div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Add option form */}
            {addingOpt && (
              <div className="mt-3 p-3 rounded-lg border border-blue-800/40 bg-blue-950/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-blue-400">New Option Leg</span>
                  <button onClick={() => setAddingOpt(false)} className="text-slate-500 hover:text-white text-xs">✕</button>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <div>
                    <div className="text-[9px] text-slate-500 mb-1">Direction</div>
                    <div className="flex rounded-lg overflow-hidden border border-[#1e2d40] text-[10px]">
                      {(['SHORT', 'LONG'] as const).map(d => (
                        <button key={d} onClick={() => setNewDir(d)}
                          className={`px-3 py-1.5 font-bold transition-colors ${newDir === d ? (d === 'SHORT' ? 'bg-orange-600 text-white' : 'bg-emerald-600 text-white') : 'bg-[#0d1425] text-slate-400 hover:text-white'}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-slate-500 mb-1">Type</div>
                    <div className="flex rounded-lg overflow-hidden border border-[#1e2d40] text-[10px]">
                      {(['CE', 'PE'] as const).map(t => (
                        <button key={t} onClick={() => setNewType(t)}
                          className={`px-3 py-1.5 font-bold transition-colors ${newType === t ? (t === 'CE' ? 'bg-amber-500 text-black' : 'bg-red-600 text-white') : 'bg-[#0d1425] text-slate-400 hover:text-white'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Symbol (stock · index · ETF)</label>
                  <NseStockSearch includeEtfIndex placeholder={newSymDisp || 'Search INFY, NIFTY, NIFTYBEES…'}
                    onSelect={(sym, name) => { setNewSym(sym); setNewSymDisp(name || sym.replace('.NS','').replace('^','')); fetchQuoteForOpt(sym) }} />
                  {quoteLoading && <div className="text-[9px] text-cyan-600 mt-1">⟳ Fetching CMP…</div>}
                  {newSymDisp && !quoteLoading && newCmp && (
                    <div className="text-[9px] text-slate-500 mt-1">{newSymDisp} · <span className="text-white">CMP ₹{newCmp}</span>{newIv && <span className="text-cyan-400 ml-1.5">IV {newIv}%</span>}</div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Inp label="Strike ₹"   value={newStrike} onChange={setNewStrike} placeholder="24500" />
                  <Inp label={newDir === 'SHORT' ? 'Premium recv ₹' : 'Premium paid ₹'} value={newPrem} onChange={setNewPrem} placeholder="150" />
                  <Inp label="Lots"        value={newLots}   onChange={setNewLots}   placeholder="1" />
                  <Inp label="Lot size"    value={newLS}     onChange={setNewLS}     placeholder="25" />
                  <Inp label="CMP ₹"       value={newCmp}    onChange={setNewCmp}    placeholder="auto-filled" />
                  <Inp label="IV %"        value={newIv}     onChange={setNewIv}     placeholder="22" />
                  <Inp label="DTE"         value={newDte}    onChange={setNewDte}    placeholder="30" />
                  <div>
                    <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Expiry date</label>
                    <input type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)}
                      className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
                {newPrem && newLots && newLS && (
                  <div className={`text-[10px] font-semibold ${newDir === 'SHORT' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {newDir === 'SHORT' ? 'Income' : 'Cost'}: {fmtRs(Math.abs(parseFloat(newPrem||'0') * parseInt(newLots||'1') * parseInt(newLS||'1')))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={commitOption} className={`text-xs px-4 py-1.5 rounded-lg font-medium ${newDir === 'SHORT' ? 'bg-orange-600 hover:bg-orange-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}>
                    Add {newDir} {newType}
                  </button>
                  <button onClick={() => setAddingOpt(false)} className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-1.5 rounded-lg">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Shares & ETFs card */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-semibold text-white">Shares & ETFs</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{shares.length === 0 ? 'No positions' : `${shares.length} position${shares.length > 1 ? 's' : ''}`}</div>
              </div>
              <button onClick={() => { setAddingSh(v => !v); setAddingOpt(false) }}
                className="text-[10px] bg-teal-950 border border-teal-800/60 text-teal-400 hover:bg-teal-900 px-2.5 py-1.5 rounded-lg">
                + Add Share / ETF
              </button>
            </div>
            {shares.length === 0 && !addingSh && (
              <div className="text-center py-6 text-slate-600 text-xs">Add equity or ETF positions (INFY, NIFTYBEES, MON100…)</div>
            )}
            <div className="space-y-2">
              {shares.map(s => {
                const live = liveMetrics?.shareMetrics.find(m => m.id === s.id)
                const px   = s.marketPrice > 0 ? s.marketPrice : s.buyPrice
                return (
                  <div key={s.id} className="rounded-lg border border-[#1e2d40]/60 bg-[#0d1425] p-3">
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SymBadge sym={s.symbol} display={s.symbolDisplay} />
                        <span className="text-sm font-bold text-white">{s.label}</span>
                      </div>
                      <button onClick={() => setShares(p => p.filter(x => x.id !== s.id))} className="text-slate-500 hover:text-red-400 text-xs ml-2 shrink-0">✕</button>
                    </div>
                    <div className="text-[10px] text-slate-400 mb-2 leading-5">
                      {fmt(s.qty)} qty · buy <span className="text-white">₹{fmt(s.buyPrice)}</span>
                      {' · '}CMP <span className={px >= s.buyPrice ? 'text-emerald-400' : 'text-red-400'}>₹{fmt(px)}</span>
                      {live && <span className={`ml-2 font-bold ${clr(live.mtmPnl)}`}>{live.mtmPnl >= 0 ? '+' : ''}{fmtRs(live.mtmPnl)}</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#1e2d40]">
                      <div>
                        <label className="block text-[9px] text-slate-500 mb-1">Market CMP ₹</label>
                        <input type="number" value={s.marketPrice > 0 ? s.marketPrice : ''}
                          onChange={e => setShares(p => p.map(x => x.id === s.id ? { ...x, marketPrice: parseFloat(e.target.value) || 0 } : x))}
                          placeholder={fmt(s.buyPrice)}
                          className="w-full bg-[#111827] border border-cyan-900/50 text-cyan-300 text-[10px] rounded px-2 py-1 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600" />
                      </div>
                      <div>
                        <label className="block text-[9px] text-slate-500 mb-1">Target Price ₹</label>
                        <input type="number" value={s.targetPrice > 0 ? s.targetPrice : ''}
                          onChange={e => setShares(p => p.map(x => x.id === s.id ? { ...x, targetPrice: parseFloat(e.target.value) || 0 } : x))}
                          placeholder="your target"
                          className="w-full bg-[#111827] border border-amber-900/50 text-amber-300 text-[10px] rounded px-2 py-1 focus:outline-none focus:border-amber-500 placeholder:text-slate-600" />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Add share form */}
            {addingSh && (
              <div className="mt-3 p-3 rounded-lg border border-teal-800/40 bg-teal-950/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-teal-400">Add Share / ETF</span>
                  <button onClick={() => setAddingSh(false)} className="text-slate-500 hover:text-white text-xs">✕</button>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Symbol</label>
                  <NseStockSearch includeEtfIndex placeholder={newShSymDisp || 'Search INFY, NIFTYBEES, MON100…'}
                    onSelect={(sym, name) => { setNewShSym(sym); setNewShSymDisp(name || sym.replace('.NS','').replace('^','')); fetchQuoteForShare(sym) }} />
                  {shQuoteLoading && <div className="text-[9px] text-cyan-600 mt-1">⟳ Fetching CMP…</div>}
                  {newShCmp && <div className="text-[9px] text-slate-500 mt-1">CMP: <span className="text-white">₹{newShCmp}</span></div>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-slate-400 uppercase tracking-wider mb-1">Label (optional)</label>
                    <input type="text" value={newShLabel} onChange={e => setNewShLabel(e.target.value)} placeholder={newShSymDisp || 'e.g. NIFTYBEES hedge'}
                      className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500" />
                  </div>
                  <Inp label="Qty"   value={newShQty}   onChange={setNewShQty}   placeholder="100" />
                  <Inp label="Buy ₹" value={newShPrice} onChange={setNewShPrice} placeholder="250.50" />
                  <Inp label="CMP ₹" value={newShCmp}   onChange={setNewShCmp}   placeholder="auto-filled" />
                </div>
                {newShPrice && newShQty && (
                  <div className="text-[10px] text-slate-400">Cost: <span className="text-white font-semibold">{fmtRs(parseFloat(newShPrice||'0') * parseInt(newShQty||'0'))}</span></div>
                )}
                <div className="flex gap-2">
                  <button onClick={commitShare} className="text-xs bg-teal-600 hover:bg-teal-500 text-white px-4 py-1.5 rounded-lg font-medium">Add Position</button>
                  <button onClick={() => setAddingSh(false)} className="text-xs border border-[#1e2d40] text-slate-400 hover:text-white px-4 py-1.5 rounded-lg">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Snapshot */}
          {hasPositions && liveMetrics && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-3">Portfolio Snapshot</div>
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div className="col-span-2 bg-[#0d1425] rounded-lg p-2.5">
                  <div className="text-slate-500 mb-1">Live MTM P&L (@ market prices)</div>
                  <div className={`text-xl font-bold ${clr(liveMetrics.totalMtm)}`}>{liveMetrics.totalMtm >= 0 ? '+' : ''}{fmtRs(liveMetrics.totalMtm)}</div>
                </div>
                {[
                  { label: 'θ Decay/day', val: Math.round(liveMetrics.totalTheta), color: liveMetrics.totalTheta >= 0 ? 'text-emerald-400' : 'text-red-400', prefix: liveMetrics.totalTheta >= 0 ? '+' : '' },
                  { label: 'Net Δ',       val: parseFloat(liveMetrics.netDelta.toFixed(1)), color: 'text-blue-400', prefix: '' },
                  { label: 'Max Profit',  val: maxProfit, color: clr(maxProfit), prefix: maxProfit >= 0 ? '+' : '' },
                  { label: 'Max Loss',    val: maxLoss,   color: clr(maxLoss),   prefix: maxLoss >= 0 ? '+' : '' },
                ].map(({ label, val, color, prefix }) => (
                  <div key={label} className="bg-[#0d1425] rounded-lg p-2.5">
                    <div className="text-slate-500 mb-1">{label}</div>
                    <div className={`text-base font-bold ${color}`}>{prefix}{typeof val === 'number' && Number.isInteger(val) ? fmtRs(val) : val}</div>
                  </div>
                ))}
                {netIncome !== 0 && (
                  <div className={`bg-[#0d1425] rounded-lg p-2.5 ${netIncome >= 0 ? '' : 'col-span-1'}`}>
                    <div className="text-slate-500 mb-1">Net Premium</div>
                    <div className={`text-base font-bold ${clr(netIncome)}`}>{fmtRs(netIncome)}</div>
                  </div>
                )}
                {targetPnl && (
                  <div className="bg-amber-950/30 border border-amber-900/40 rounded-lg p-2.5">
                    <div className="text-amber-600 mb-1">@ Your Targets</div>
                    <div className={`text-base font-bold ${clr(targetPnl.expiry)}`}>{targetPnl.expiry >= 0 ? '+' : ''}{fmtRs(targetPnl.expiry)}</div>
                  </div>
                )}
              </div>
              {breakevens.length > 0 && (
                <div className="mt-3 text-[10px] text-slate-400">
                  Breakeven{breakevens.length > 1 ? 's' : ''} at:{' '}
                  {breakevens.map((be, i) => <span key={i} className="text-amber-400 font-semibold mr-2">{pctFmt(be)} move</span>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── RIGHT: chart + table ─────────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-4">

          {/* Tab toggle */}
          {hasPositions && (
            <div className="flex gap-1 bg-[#111827] border border-[#1e2d40] rounded-xl p-1 w-fit">
              {(['chart', 'table'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`text-xs px-4 py-1.5 rounded-lg font-medium transition-colors capitalize ${tab === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                  {t === 'chart' ? '📈 Chart' : '📋 P&L Table'}
                </button>
              ))}
            </div>
          )}

          {/* Chart */}
          {tab === 'chart' && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold text-white">P&L vs Correlated % Move</div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-emerald-500 inline-block rounded" /> At Expiry</span>
                  <span className="flex items-center gap-1.5"><span className="w-4 h-px border-t-2 border-dashed border-blue-500 inline-block" /> {targetDays > 0 ? `+${targetDays}d` : 'Today (BS)'}</span>
                </div>
              </div>
              <p className="text-[9px] text-slate-600 mb-4">X-axis = uniform % move applied to all underlyings from entry CMP · horizontal lines = @ market / target prices</p>
              {!hasPositions ? (
                <div className="flex items-center justify-center h-64 text-slate-600 text-sm">Add positions to see chart</div>
              ) : (
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                    <CartesianGrid stroke="#1e2d40" strokeDasharray="3 3" />
                    <XAxis dataKey="pct" type="number" domain={[-25, 25]} tickCount={11}
                      tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={p => `${p >= 0 ? '+' : ''}${p}%`}
                      label={{ value: '% Move', position: 'insideBottomRight', offset: -8, fill: '#475569', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={yFmt} width={64} />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      const exp = payload.find((p: any) => p.dataKey === 'expiry')?.value as number
                      const tgt = payload.find((p: any) => p.dataKey === 'target')?.value as number
                      return (
                        <div className="bg-[#0d1425] border border-[#1e2d40] rounded-xl px-3 py-2.5 text-xs shadow-2xl min-w-44">
                          <div className="text-white font-semibold mb-2">{label >= 0 ? '+' : ''}{label}% move</div>
                          {tgt != null && <div className="flex justify-between gap-6 mb-1.5"><span className="text-blue-400">{targetDays > 0 ? `+${targetDays}d` : 'Today'}</span><span className={`font-bold ${clr(tgt)}`}>{tgt >= 0 ? '+' : ''}{fmtRs(tgt)}</span></div>}
                          {exp != null && <div className="flex justify-between gap-6"><span className="text-emerald-400">At Expiry</span><span className={`font-bold ${clr(exp)}`}>{exp >= 0 ? '+' : ''}{fmtRs(exp)}</span></div>}
                        </div>
                      )
                    }} />
                    <ReferenceLine y={0} stroke="#334155" strokeWidth={1.5} />
                    <ReferenceLine x={0} stroke="#e2e8f0" strokeWidth={2}
                      label={{ value: 'Entry CMP', fill: '#e2e8f0', fontSize: 10, fontWeight: 600, position: 'insideTopRight' }} />
                    {breakevens.map((be, i) => (
                      <ReferenceLine key={i} x={be} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth={1}
                        label={{ value: pctFmt(be), fill: '#f59e0b', fontSize: 9, position: i % 2 === 0 ? 'insideTopLeft' : 'insideBottomLeft' }} />
                    ))}
                    {/* Horizontal reference lines for market and target P&L */}
                    {mktPnl && mktPnl.today !== 0 && (
                      <ReferenceLine y={mktPnl.today} stroke="#22d3ee" strokeDasharray="5 3" strokeWidth={1}
                        label={{ value: `Mkt Today: ${fmtRs(mktPnl.today)}`, fill: '#22d3ee', fontSize: 9, position: 'insideTopRight' }} />
                    )}
                    {targetPnl && (
                      <ReferenceLine y={targetPnl.expiry} stroke="#f59e0b" strokeDasharray="5 3" strokeWidth={1}
                        label={{ value: `@ Targets: ${fmtRs(targetPnl.expiry)}`, fill: '#f59e0b', fontSize: 9, position: 'insideBottomRight' }} />
                    )}
                    <Line dataKey="expiry" stroke="#10b981" strokeWidth={2.5} dot={false} name="At Expiry" />
                    <Line dataKey="target" stroke="#3b82f6" strokeWidth={1.5} dot={false} strokeDasharray="6 3" name="Today / Target" />
                    {liveMetrics && (
                      <ReferenceDot x={0} y={liveMetrics.totalMtm} r={6}
                        fill="#22d3ee" stroke="#0f172a" strokeWidth={2}
                        label={{ value: `${liveMetrics.totalMtm >= 0 ? '+' : ''}${fmtRs(liveMetrics.totalMtm)}`, fill: '#22d3ee', fontSize: 9, fontWeight: 600, position: 'top' }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          )}

          {/* P&L Table */}
          {tab === 'table' && hasPositions && (
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4 overflow-x-auto">
              <div className="text-xs font-semibold text-white mb-3">P&L Table — uniform % move across all underlyings</div>
              <table className="w-full text-[10px] border-collapse min-w-[340px]">
                <thead>
                  <tr className="border-b border-[#1e2d40]">
                    <th className="text-left text-slate-400 pb-2 pr-4 font-medium">Scenario</th>
                    <th className="text-right text-emerald-500 pb-2 px-3 font-medium">At Expiry</th>
                    <th className="text-right text-blue-400 pb-2 pl-3 font-medium">{targetDays > 0 ? `+${targetDays}d (BS)` : 'Today (BS)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, i) => {
                    const isCmp     = row.pct === 0
                    const isMkt     = row.label === '@ Market Prices'
                    const isTgt     = row.label === '@ Target Prices'
                    const rowBg     = isCmp ? 'bg-blue-950/30' : isMkt ? 'bg-cyan-950/30' : isTgt ? 'bg-amber-950/30' : i % 2 === 0 ? '' : 'bg-[#0d1425]/40'
                    const labelClr  = isCmp ? 'text-blue-300' : isMkt ? 'text-cyan-400' : isTgt ? 'text-amber-400' : 'text-slate-300'
                    return (
                      <tr key={row.label} className={`border-b border-[#1e2d40]/40 ${rowBg}`}>
                        <td className={`py-2 pr-4 font-medium ${labelClr}`}>
                          {row.label}
                          {isMkt && <span className="ml-1.5 text-[8px] text-slate-600">●</span>}
                          {isTgt && <span className="ml-1.5 text-[8px] text-amber-700">◆</span>}
                        </td>
                        <td className={`py-2 px-3 text-right font-bold tabular-nums ${clr(row.expiry)}`}>
                          {row.expiry >= 0 ? '+' : ''}{fmtRs(row.expiry)}
                        </td>
                        <td className={`py-2 pl-3 text-right font-bold tabular-nums ${isNaN(row.today) ? 'text-slate-600' : clr(row.today)}`}>
                          {isNaN(row.today) ? '—' : `${row.today >= 0 ? '+' : ''}${fmtRs(row.today)}`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="mt-3 flex gap-4 text-[9px] text-slate-600">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-950/60 inline-block" /> 0% = entry CMP</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-cyan-950/60 inline-block" /> @ Market = live prices</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-950/60 inline-block" /> @ Target = your targets</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── AI Scenarios ───────────────────────────────────────────────────── */}
      {(scenarios.length > 0 || scenariosLoading || scenariosError) && (
        <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
          <div className="text-xs font-semibold text-white mb-1">AI Scenario Analysis</div>
          <p className="text-[9px] text-slate-500 mb-4">Price targets derived from RSI, technical trend + news signals for each underlying · 3 proposal guesses</p>

          {scenariosLoading && (
            <div className="flex items-center justify-center py-10 text-slate-500 text-sm gap-3">
              <span className="animate-spin">⟳</span> Fetching signals for {[...new Set([...options.map(o => o.symbolDisplay), ...shares.map(s => s.symbolDisplay)])].join(', ')}…
            </div>
          )}
          {scenariosError && <div className="text-red-400 text-xs py-4">{scenariosError}</div>}

          {scenarios.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {scenarios.map(sc => {
                const brdClr = sc.label === 'Bullish' ? 'border-emerald-800/60' : sc.label === 'Bearish' ? 'border-red-800/60' : 'border-slate-700/60'
                const hdrClr = sc.label === 'Bullish' ? 'text-emerald-400' : sc.label === 'Bearish' ? 'text-red-400' : 'text-slate-300'
                const bgHdr  = sc.label === 'Bullish' ? 'bg-emerald-950/30' : sc.label === 'Bearish' ? 'bg-red-950/30' : 'bg-slate-800/30'
                const barClr = sc.label === 'Bullish' ? 'bg-emerald-500' : sc.label === 'Bearish' ? 'bg-red-500' : 'bg-slate-500'
                const icon   = sc.label === 'Bullish' ? '📈' : sc.label === 'Bearish' ? '📉' : '➡️'
                return (
                  <div key={sc.label} className={`rounded-xl border ${brdClr} overflow-hidden`}>
                    {/* Header */}
                    <div className={`${bgHdr} px-4 py-3`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-sm font-bold ${hdrClr}`}>{icon} {sc.label}</span>
                        <span className="text-xs text-slate-400 font-medium">{sc.prob}% probability</span>
                      </div>
                      {/* Probability bar */}
                      <div className="h-1.5 bg-[#0d1425] rounded-full overflow-hidden">
                        <div className={`h-full ${barClr} rounded-full transition-all`} style={{ width: `${sc.prob}%` }} />
                      </div>
                    </div>
                    <div className="p-4 space-y-3 bg-[#0d1425]">
                      {/* Price targets per symbol */}
                      <div className="space-y-1.5">
                        <div className="text-[9px] text-slate-500 uppercase tracking-wide mb-2">Price Targets</div>
                        {[...options.map(o => ({ sym: o.symbol, disp: o.symbolDisplay, cmp: o.marketPrice || o.entryCmp })),
                           ...shares.map(s => ({ sym: s.symbol, disp: s.symbolDisplay, cmp: s.marketPrice || s.buyPrice }))]
                          .reduce((acc: { sym: string; disp: string; cmp: number }[], item: { sym: string; disp: string; cmp: number }) => {
                            if (!acc.find(a => a.sym === item.sym)) acc.push(item); return acc
                          }, []).map(({ sym, disp, cmp }) => {
                          const px = sc.symPrices[sym] ?? cmp
                          const pct = cmp > 0 ? ((px - cmp) / cmp * 100) : 0
                          return (
                            <div key={sym} className="flex items-center justify-between">
                              <span className="text-[9px] text-slate-400 truncate max-w-24">{disp.replace('.NS','').replace('^','').slice(0,14)}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] text-white font-medium">₹{fmt(Math.round(px))}</span>
                                <span className={`text-[8px] font-bold ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pctFmt(pct)}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      {/* Strategy P&L */}
                      <div className={`rounded-lg px-3 py-2.5 ${bgClr(sc.totalPnl)} border ${sc.totalPnl >= 0 ? 'border-emerald-900/40' : 'border-red-900/40'}`}>
                        <div className="text-[9px] text-slate-400 mb-1">Strategy P&L (at expiry)</div>
                        <div className={`text-lg font-bold ${clr(sc.totalPnl)}`}>
                          {sc.totalPnl >= 0 ? '+' : ''}{fmtRs(sc.totalPnl)}
                        </div>
                      </div>
                      {/* Analysis text */}
                      <p className="text-[9px] text-slate-500 leading-4">{sc.analysis}</p>
                      {sc.outlook && <p className="text-[9px] text-slate-600 italic">{sc.outlook}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {/* ── Agent Strategy Review ────────────────────────────────────── */}
          {hasPositions && (() => {
            const agentLegs: StrategyLeg[] = [
              ...options.map(o => {
                const cmp = o.marketPrice > 0 ? o.marketPrice : o.entryCmp
                const T   = Math.max(0, (o.dte || 30)) / 365
                const curOptPx = bsPrice(cmp, o.strike, o.iv, T, o.type === 'CE')
                const qty  = o.lots * o.lotSize
                const sign = o.direction === 'SHORT' ? 1 : -1
                return {
                  id:            o.id,
                  type:          (o.direction === 'SHORT'
                                    ? (o.type === 'PE' ? 'short_put' : 'short_call')
                                    : (o.type === 'PE' ? 'long_put'  : 'long_call')) as StrategyLeg['type'],
                  symbol:        o.symbolDisplay || o.symbol,
                  strike:        o.strike,
                  expiry:        o.expiry || '',
                  dte:           o.dte,
                  entry_price:   o.premium,
                  current_price: curOptPx,
                  underlying_cmp: cmp,
                  lots:          o.lots,
                  lot_size:      o.lotSize,
                  pnl:           optTodayPnlAtPrice(o, cmp, 0),
                  is_short:      o.direction === 'SHORT',
                } satisfies StrategyLeg
              }),
              ...shares.map(s => {
                const cmp = s.marketPrice > 0 ? s.marketPrice : s.buyPrice
                return {
                  id:            s.id,
                  type:          'long_share' as const,
                  symbol:        s.symbolDisplay || s.symbol,
                  entry_price:   s.buyPrice,
                  current_price: cmp,
                  underlying_cmp: cmp,
                  qty:           s.qty,
                  pnl:           sharePnlAtPrice(s, cmp),
                  is_short:      false,
                } satisfies StrategyLeg
              }),
            ]
            const totalPnl = agentLegs.reduce((s, l) => s + l.pnl, 0)
            return (
              <AgentStrategyReview
                legs={agentLegs}
                strategyName={`MultiBuilder ${new Date().toLocaleDateString('en-IN')}`}
                totalPnl={totalPnl}
              />
            )
          })()}
        </div>
      )}
    </div>
  )
}
