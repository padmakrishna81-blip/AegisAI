import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import client from '../api/client'

// ── Black-Scholes (copied from MultiBuilder) ──────────────────────────────────
function _erf(x: number): number {
  const sign = x >= 0 ? 1 : -1; x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x)
  return sign * y
}
function _ncdf(x: number) { return (1 + _erf(x / Math.sqrt(2))) / 2 }
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

const api = {
  get:  (url: string, params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : ''
    return client.get(url + q).then(r => r.data)
  },
  post: (url: string, body?: unknown) => client.post(url, body).then(r => r.data),
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DirectionResult {
  bullish_score:  number
  up_prob:        number
  down_prob:      number
  sideways_prob:  number
  direction:      'UP' | 'DOWN' | 'SIDEWAYS'
  nifty_spot:     number
  vix:            number
  signals: {
    technical: { score: number; rsi: number; macd: number; above_sma50: boolean; above_sma200: boolean; summary: string; error?: string }
    oi:        { score: number; spot: number; pcr: number; pcr_signal: string; max_pain: number; max_pain_bias: string; summary: string; error?: string }
    macro:     { score: number; market_mode: string; vix: number; summary: string; error?: string }
  }
  timestamp: string
}

interface Strike {
  strike:       number
  type:         'PE' | 'CE'
  ltp:          number
  bid:          number
  ask:          number
  delta:        number
  theta:        number
  iv:           number
  oi:           number
  otm_pct:      number
  lot_size:     number
  premium_1lot: number
}

interface ChainResult {
  spot:      number
  expiry:    string
  dte:       number
  direction: string
  iv_base:   number
  strikes:   Strike[]
  all_pe:    Strike[]
  all_ce:    Strike[]
}

interface Expiry { expiry: string; dte: number }

interface OptionPosition {
  id:              string
  direction:       string
  type:            'PE' | 'CE'
  strike:          number
  expiry:          string
  premium_sold:    number
  lots:            number
  lot_size:        number
  status:          string
  broker_order_id: string | null
  entered_at:      string
  exited_at:       string | null
  exit_price:      number | null
  pnl:             number | null
}

interface MtmItem {
  id:             string
  spot:           number
  current_price:  number
  pnl:            number
  pnl_pct:        number
  dte:            number
  profit_booking: boolean
  risk_alert:     boolean
  error?:         string
}

interface Cycle {
  cycle_num:    number
  status:       'pending' | 'active' | 'completed'
  buy1_qty:     number
  buy1_price:   number | null
  buy1_date:    string | null
  buy1_order_id:string | null
  buy2_qty:     number
  buy2_price:   number | null
  buy2_date:    string | null
  buy2_order_id:string | null
  started_at:   string | null
  completed_at: string | null
}

interface AppState {
  phase:                   number
  niftybees_total_units:   number
  niftybees_avg_price:     number
  cycles:                  Cycle[]
  option_positions:        OptionPosition[]
  direction_history:       HistoryEntry[]
}

interface HistoryEntry {
  date:             string
  nifty_spot:       number
  up_prob:          number
  down_prob:        number
  sideways_prob:    number
  direction:        string
  bullish_score:    number
  actual_direction: string | null
  key_signals:      Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const dirColor = (d: string) =>
  d === 'UP' ? 'text-emerald-400' : d === 'DOWN' ? 'text-red-400' : 'text-amber-400'

const dirBg = (d: string) =>
  d === 'UP' ? 'bg-emerald-900/40 border-emerald-700' : d === 'DOWN' ? 'bg-red-900/40 border-red-700' : 'bg-amber-900/40 border-amber-700'

const pnlClr = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300'

const fmt = (n: number | null | undefined, dec = 2) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—'

// ── Main component ────────────────────────────────────────────────────────────

export default function NiftyWheel() {
  const [tab, setTab] = useState<'dashboard' | 'positions' | 'cycles' | 'history'>('dashboard')
  const [appState, setAppState]           = useState<AppState | null>(null)
  const [direction, setDirection]         = useState<DirectionResult | null>(null)
  const [loadingDir, setLoadingDir]       = useState(false)
  const [expiries, setExpiries]           = useState<Expiry[]>([])
  const [mtm, setMtm]                     = useState<MtmItem[]>([])
  const [margin, setMargin]               = useState<{ connected: boolean; available_cash: number | null } | null>(null)
  const [history, setHistory]             = useState<{ history: HistoryEntry[]; accuracy: number | null; graded: number; correct: number } | null>(null)
  const [loadingState, setLoadingState]   = useState(false)
  const [err, setErr]                     = useState<string | null>(null)
  const [priceHistory, setPriceHistory]   = useState<any[]>([])
  const [chartTab, setChartTab]           = useState<'points' | 'pct'>('points')

  // Order flow modal state
  const [showModal, setShowModal]         = useState(false)
  const [modalStep, setModalStep]         = useState<'expiry' | 'chain' | 'confirm'>('expiry')
  const [selExpiry, setSelExpiry]         = useState<string>('')
  const [chainData, setChainData]         = useState<ChainResult | null>(null)
  const [loadingChain, setLoadingChain]   = useState(false)
  const [selStrike, setSelStrike]         = useState<Strike | null>(null)
  const [orderLots, setOrderLots]         = useState(1)
  const [orderPrice, setOrderPrice]       = useState('')
  const [placing, setPlacing]             = useState(false)
  const [chainTab, setChainTab]           = useState<'PE' | 'CE'>('PE')
  const [chainPage, setChainPage]         = useState(0)
  const PAGE_SIZE = 12

  // Exit modal
  const [exitPos, setExitPos]             = useState<OptionPosition | null>(null)
  const [exitPrice, setExitPrice]         = useState('')
  const [exitBroker, setExitBroker]       = useState(true)
  const [saving, setSaving]               = useState(false)

  // ETF buy modal
  const [etfModal, setEtfModal]           = useState<{ cycle: Cycle; tranche: 1 | 2 } | null>(null)
  const [etfQty, setEtfQty]               = useState('')
  const [etfPrice, setEtfPrice]           = useState('')
  const [etfBroker, setEtfBroker]         = useState(true)

  const loadAll = useCallback(async () => {
    setLoadingState(true)
    try {
      const [st, ex, mg, hist] = await Promise.all([
        api.get('/nifty-wheel/state'),
        api.get('/nifty-wheel/expiries'),
        api.get('/nifty-wheel/margin'),
        api.get('/nifty-wheel/history'),
      ])
      setAppState(st)
      setExpiries(ex)
      setMargin(mg)
      setHistory(hist)
      // load price chart separately (slower)
      api.get('/nifty-wheel/price-history').then(setPriceHistory).catch(() => {})
    } catch (e: unknown) {
      setErr((e as any)?.response?.data?.error || 'Failed to load state')
    }
    setLoadingState(false)
  }, [])

  const loadMtm = useCallback(async () => {
    try {
      const res = await api.get('/nifty-wheel/monitor')
      setMtm(res.positions || [])
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    if (tab === 'positions') loadMtm()
    if (tab === 'history') api.get('/nifty-wheel/history').then(setHistory).catch(() => {})
  }, [tab, loadMtm])

  const runDirection = async () => {
    setLoadingDir(true)
    setErr(null)
    try {
      const res = await api.get('/nifty-wheel/direction')
      setDirection(res)
    } catch (e: unknown) {
      setErr((e as any)?.response?.data?.error || 'Direction analysis failed')
    }
    setLoadingDir(false)
  }

  const openOrderModal = () => {
    setModalStep('expiry')
    setSelExpiry('')
    setChainData(null)
    setSelStrike(null)
    setOrderLots(1)
    setOrderPrice('')
    setShowModal(true)
  }

  const loadChain = async () => {
    if (!selExpiry || !direction) return
    setLoadingChain(true)
    try {
      const res = await api.get('/nifty-wheel/option-chain', {
        direction: direction.direction,
        expiry: selExpiry,
      })
      setChainData(res)
      setChainTab(direction?.direction === 'DOWN' ? 'CE' : 'PE')
      setChainPage(0)
      setModalStep('chain')
    } catch (e: unknown) {
      setErr((e as any)?.response?.data?.error || 'Failed to load option chain')
    }
    setLoadingChain(false)
  }

  const placeOrder = async () => {
    if (!selStrike || !selExpiry || !direction) return
    setPlacing(true)
    try {
      const body = {
        direction: direction.direction,
        type:       selStrike.type,
        strike:     selStrike.strike,
        expiry:     selExpiry,
        lots:       orderLots,
        limit_price: orderPrice ? parseFloat(orderPrice) : null,
        use_broker: true,
      }
      const res = await api.post('/nifty-wheel/option-positions', body)
      setShowModal(false)
      if (res.broker_order_id) alert(`✅ Order placed. ID: ${res.broker_order_id}`)
      else if (res.broker_error) alert(`⚠️ App updated, broker error: ${res.broker_error}`)
      await loadAll()
    } catch (e: unknown) {
      alert((e as any)?.response?.data?.error || 'Order failed')
    }
    setPlacing(false)
  }

  const doExit = async () => {
    if (!exitPos) return
    setSaving(true)
    try {
      const body = {
        exit_price: exitPrice ? parseFloat(exitPrice) : null,
        use_broker: exitBroker,
      }
      const res = await api.post(`/nifty-wheel/option-positions/${exitPos.id}/exit`, body)
      setExitPos(null)
      setExitPrice('')
      if (res.broker_order_id) alert(`✅ Exit order placed. ID: ${res.broker_order_id}`)
      else if (res.broker_error) alert(`⚠️ App updated, broker error: ${res.broker_error}`)
      await loadAll()
      loadMtm()
    } catch (e: unknown) {
      alert((e as any)?.response?.data?.error || 'Exit failed')
    }
    setSaving(false)
  }

  const doMarkFilled = async (pos: OptionPosition, filledPrice?: string) => {
    try {
      await api.post(`/nifty-wheel/option-positions/${pos.id}/mark-filled`, {
        filled_price: filledPrice ? parseFloat(filledPrice) : null,
      })
      await loadAll()
      loadMtm()
    } catch (e: unknown) {
      alert((e as any)?.response?.data?.error || 'Failed to mark as filled')
    }
  }

  const doDelete = async (pos: OptionPosition) => {
    if (!confirm(`Delete record-only position: ${pos.direction} ${pos.type} ${pos.strike.toLocaleString('en-IN')}? This cannot be undone.`)) return
    try {
      await client.delete(`/api/nifty-wheel/option-positions/${pos.id}`)
      await loadAll()
    } catch (e: unknown) {
      alert((e as any)?.response?.data?.error || 'Delete failed')
    }
  }

  const doEtfBuy = async () => {
    if (!etfModal || !etfQty) return
    setSaving(true)
    try {
      const body = {
        cycle_num:  etfModal.cycle.cycle_num,
        tranche:    etfModal.tranche,
        qty:        parseInt(etfQty),
        price:      etfPrice ? parseFloat(etfPrice) : null,
        use_broker: etfBroker,
      }
      const res = await api.post('/nifty-wheel/etf/buy', body)
      setEtfModal(null)
      setEtfQty('')
      setEtfPrice('')
      if (res.broker_order_id) alert(`✅ NIFTYBEES order placed. ID: ${res.broker_order_id}`)
      else if (res.broker_error) alert(`⚠️ App updated, broker error: ${res.broker_error}`)
      await loadAll()
    } catch (e: unknown) {
      alert((e as any)?.response?.data?.error || 'ETF buy failed')
    }
    setSaving(false)
  }

  const positions = appState?.option_positions || []
  const pendingPos = positions.filter(p => p.status === 'pending')
  const activePos  = positions.filter(p => p.status === 'active')
  const closedPos  = positions.filter(p => p.status !== 'active' && p.status !== 'pending')

  // P&L payoff chart data for active positions
  const spot0 = direction?.nifty_spot || priceHistory[priceHistory.length - 1]?.nifty || 25000
  const payoffData = useMemo(() => {
    if (activePos.length === 0) return []
    const POINTS = 120
    const lo = spot0 * 0.85, hi = spot0 * 1.15
    return Array.from({ length: POINTS + 1 }, (_, i) => {
      const S = lo + (hi - lo) * i / POINTS
      let expiry = 0, today = 0
      for (const p of activePos) {
        const isCall = p.type === 'CE'
        const qty    = p.lot_size * p.lots
        const sold   = p.premium_sold || 0
        const m      = mtm.find(x => x.id === p.id)
        const iv     = m ? (m.current_price > 0 ? 18 : 18) : 18  // use 18% IV default
        const dte    = m?.dte ?? 30
        const T      = Math.max(dte, 1) / 365
        // at expiry: intrinsic only
        const intrinsic = isCall ? Math.max(0, S - p.strike) : Math.max(0, p.strike - S)
        expiry += (sold - intrinsic) * qty
        // today via BS
        const bsPx = bsPrice(S, p.strike, iv, T, isCall)
        today += (sold - bsPx) * qty
      }
      return { spot: Math.round(S), expiry: Math.round(expiry), today: Math.round(today) }
    })
  }, [activePos, spot0, mtm])
  const cycles    = appState?.cycles || []

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 pb-16 md:pb-0">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">NIFTY Wheel + NIFTYBEES</h1>
        <p className="text-sm text-slate-400 mt-1">
          Rule-based direction analysis · OTM option selling · NIFTYBEES accumulation over 4 cycles
        </p>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm">
          {err}
          <button onClick={() => setErr(null)} className="ml-3 text-red-400 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-slate-700">
        {(['dashboard', 'positions', 'cycles', 'history'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'text-blue-400 border-b-2 border-blue-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'dashboard' ? 'Dashboard' : t === 'positions' ? 'Positions' : t === 'cycles' ? 'Cycles' : 'History'}
          </button>
        ))}
      </div>

      {/* ── Dashboard tab ──────────────────────────────────────────────────── */}
      {tab === 'dashboard' && (
        <div className="space-y-6">
          {/* Action bar */}
          <div className="flex flex-wrap gap-3 items-center">
            <button
              onClick={runDirection}
              disabled={loadingDir}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              {loadingDir ? 'Analysing…' : '🔄 Refresh Analysis'}
            </button>
            {direction && (
              <button
                onClick={openOrderModal}
                className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-sm font-medium"
              >
                ⚡ Enter NIFTY Wheel
              </button>
            )}
            {margin && (
              <span className="text-xs text-slate-400">
                {margin.connected
                  ? `💰 Margin: ₹${fmt(margin.available_cash, 0)}`
                  : '⚠️ Broker not connected'}
              </span>
            )}
          </div>

          {/* Direction probabilities */}
          {direction ? (
            <>
              <div className={`rounded-lg border p-4 ${dirBg(direction.direction)}`}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-slate-300">
                    NIFTY @ <span className="font-semibold text-slate-100">₹{fmt(direction.nifty_spot, 0)}</span>
                    &nbsp;· VIX {direction.vix}
                  </span>
                  <span className={`text-lg font-bold ${dirColor(direction.direction)}`}>
                    {direction.direction === 'UP' ? '↑ BULLISH' : direction.direction === 'DOWN' ? '↓ BEARISH' : '→ SIDEWAYS'}
                  </span>
                </div>
                {/* Probability bar */}
                <div className="flex rounded overflow-hidden h-5 mb-3 text-xs font-medium">
                  <div style={{ width: `${direction.up_prob}%` }} className="bg-emerald-600 flex items-center justify-center text-white">
                    {direction.up_prob}%
                  </div>
                  <div style={{ width: `${direction.sideways_prob}%` }} className="bg-amber-600 flex items-center justify-center text-white">
                    {direction.sideways_prob}%
                  </div>
                  <div style={{ width: `${direction.down_prob}%` }} className="bg-red-600 flex items-center justify-center text-white">
                    {direction.down_prob}%
                  </div>
                </div>
                <div className="flex gap-4 text-xs text-slate-300">
                  <span className="text-emerald-400">▲ UP {direction.up_prob}%</span>
                  <span className="text-amber-400">→ SIDEWAYS {direction.sideways_prob}%</span>
                  <span className="text-red-400">▼ DOWN {direction.down_prob}%</span>
                </div>
              </div>

              {/* Recommendation banner */}
              <div className="p-3 bg-slate-800 rounded border border-slate-700 text-sm text-slate-200">
                {direction.direction === 'UP' && '💡 Market leaning UP — Consider selling OTM PE (below spot) with delta 0.20–0.30'}
                {direction.direction === 'DOWN' && '💡 Market leaning DOWN — Consider selling OTM CE (above spot) with delta 0.20–0.30'}
                {direction.direction === 'SIDEWAYS' && '💡 Range-bound market — Consider selling both OTM PE + CE with delta 0.20–0.30 (Iron Condor style)'}
              </div>

              {/* Signal details */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Technical */}
                <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-slate-400 uppercase tracking-wide">Technical (30%)</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction.signals.technical.summary === 'BULLISH' ? 'bg-emerald-900 text-emerald-400' : direction.signals.technical.summary === 'BEARISH' ? 'bg-red-900 text-red-400' : 'bg-slate-700 text-slate-300'}`}>
                      {direction.signals.technical.summary}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-slate-100 mb-2">{direction.signals.technical.score}</div>
                  {direction.signals.technical.error ? (
                    <p className="text-xs text-red-400">{direction.signals.technical.error}</p>
                  ) : (
                    <table className="text-xs w-full">
                      <tbody>
                        <tr><td className="text-slate-400 pr-2">RSI</td><td className="text-slate-200">{direction.signals.technical.rsi?.toFixed(1) ?? '—'}</td></tr>
                        <tr><td className="text-slate-400 pr-2">MACD</td><td className="text-slate-200">{direction.signals.technical.macd}</td></tr>
                        <tr><td className="text-slate-400 pr-2">Above SMA50</td><td>{direction.signals.technical.above_sma50 ? '✅' : '❌'}</td></tr>
                        <tr><td className="text-slate-400 pr-2">Above SMA200</td><td>{direction.signals.technical.above_sma200 ? '✅' : '❌'}</td></tr>
                      </tbody>
                    </table>
                  )}
                </div>

                {/* OI/Options */}
                <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-slate-400 uppercase tracking-wide">OI/Options (40%)</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction.signals.oi.summary === 'BULLISH' ? 'bg-emerald-900 text-emerald-400' : direction.signals.oi.summary === 'BEARISH' ? 'bg-red-900 text-red-400' : 'bg-slate-700 text-slate-300'}`}>
                      {direction.signals.oi.summary}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-slate-100 mb-2">{direction.signals.oi.score}</div>
                  {direction.signals.oi.error ? (
                    <p className="text-xs text-red-400">{direction.signals.oi.error}</p>
                  ) : (
                    <table className="text-xs w-full">
                      <tbody>
                        <tr><td className="text-slate-400 pr-2">PCR</td><td className="text-slate-200">{direction.signals.oi.pcr?.toFixed(3) ?? '—'} ({direction.signals.oi.pcr_signal})</td></tr>
                        <tr><td className="text-slate-400 pr-2">Max Pain</td><td className="text-slate-200">₹{fmt(direction.signals.oi.max_pain, 0)}</td></tr>
                        <tr><td className="text-slate-400 pr-2">MP vs Spot</td><td className="text-slate-200">{direction.signals.oi.max_pain_bias}</td></tr>
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Macro */}
                <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-slate-400 uppercase tracking-wide">Macro (30%)</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${direction.signals.macro.summary === 'BULLISH' ? 'bg-emerald-900 text-emerald-400' : direction.signals.macro.summary === 'BEARISH' ? 'bg-red-900 text-red-400' : 'bg-slate-700 text-slate-300'}`}>
                      {direction.signals.macro.summary}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-slate-100 mb-2">{direction.signals.macro.score}</div>
                  {direction.signals.macro.error ? (
                    <p className="text-xs text-red-400">{direction.signals.macro.error}</p>
                  ) : (
                    <table className="text-xs w-full">
                      <tbody>
                        <tr><td className="text-slate-400 pr-2">VIX</td><td className="text-slate-200">{direction.signals.macro.vix}</td></tr>
                        <tr><td className="text-slate-400 pr-2">Mode</td><td className="text-slate-200">{direction.signals.macro.market_mode}</td></tr>
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <div className="text-4xl mb-3">🎯</div>
              <p className="text-lg font-medium text-slate-300 mb-1">Run Direction Analysis</p>
              <p className="text-sm">Click "Refresh Analysis" to assess NIFTY direction based on technical, OI, and macro signals.</p>
            </div>
          )}

          {/* Price history chart */}
          {priceHistory.length > 0 && (
            <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-200">Last 15 Sessions — NIFTY 50 &amp; NIFTYBEES</h3>
                <div className="flex rounded-md border border-slate-600 overflow-hidden text-xs">
                  <button
                    onClick={() => setChartTab('points')}
                    className={`px-3 py-1 transition-colors ${chartTab === 'points' ? 'bg-blue-700 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                  >Points</button>
                  <button
                    onClick={() => setChartTab('pct')}
                    className={`px-3 py-1 transition-colors ${chartTab === 'pct' ? 'bg-blue-700 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                  >% Return</button>
                </div>
              </div>

              {chartTab === 'points' ? (
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={priceHistory} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis
                      yAxisId="nifty"
                      orientation="left"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      tickFormatter={(v) => (v / 1000).toFixed(0) + 'k'}
                      domain={['auto', 'auto']}
                    />
                    <YAxis
                      yAxisId="nb"
                      orientation="right"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      tickFormatter={(v) => '₹' + v}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
                      labelStyle={{ color: '#e2e8f0', fontSize: 12 }}
                      formatter={(val: number, name: string) => [
                        name === 'NIFTY 50' ? val?.toLocaleString('en-IN') :
                        name === 'NIFTYBEES' ? '₹' + val : val,
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                    <Line
                      yAxisId="nifty"
                      type="monotone"
                      dataKey="nifty"
                      name="NIFTY 50"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="nb"
                      type="monotone"
                      dataKey="niftybees"
                      name="NIFTYBEES"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={priceHistory} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      tickFormatter={(v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
                      labelStyle={{ color: '#e2e8f0', fontSize: 12 }}
                      formatter={(val: number, name: string) => [
                        val != null ? (val >= 0 ? '+' : '') + val.toFixed(2) + '%' : '—',
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                    <Line
                      type="monotone"
                      dataKey="nifty_pct"
                      name="NIFTY 50"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="niftybees_pct"
                      name="NIFTYBEES"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}

              {/* CMP tiles */}
              <div className="grid grid-cols-2 gap-3 mt-3">
                {[
                  {
                    label:   'NIFTY 50',
                    cmp:     priceHistory[priceHistory.length - 1]?.nifty,
                    pts:     priceHistory[priceHistory.length - 1]?.nifty_pts_chg,
                    pct:     priceHistory[priceHistory.length - 1]?.nifty_chg,
                    fmtCmp:  (v: number) => v?.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                    fmtPts:  (v: number) => (v >= 0 ? '+' : '') + v?.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                  },
                  {
                    label:   'NIFTYBEES',
                    cmp:     priceHistory[priceHistory.length - 1]?.niftybees,
                    pts:     priceHistory[priceHistory.length - 1]?.niftybees_pts_chg,
                    pct:     priceHistory[priceHistory.length - 1]?.niftybees_chg,
                    fmtCmp:  (v: number) => '₹' + v?.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                    fmtPts:  (v: number) => (v >= 0 ? '+₹' : '-₹') + Math.abs(v)?.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                  },
                ].map(({ label, cmp, pts, pct, fmtCmp, fmtPts }) => {
                  const up   = (pct ?? 0) > 0
                  const down = (pct ?? 0) < 0
                  const clr  = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-slate-400'
                  const bg   = up ? 'bg-emerald-950/40 border-emerald-800/40' : down ? 'bg-red-950/40 border-red-800/40' : 'bg-slate-700/30 border-slate-600/40'
                  return (
                    <div key={label} className={`rounded-lg border p-3 ${bg}`}>
                      <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</div>
                      <div className="text-lg font-bold font-mono text-slate-100">
                        {cmp != null ? fmtCmp(cmp) : '—'}
                      </div>
                      {pts != null && pct != null ? (
                        <div className={`text-xs font-semibold mt-0.5 ${clr}`}>
                          {fmtPts(pts)} &nbsp;({(pct >= 0 ? '+' : '') + pct?.toFixed(2)}%)
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500 mt-0.5">prev day change unavailable</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* NIFTYBEES summary */}
          {appState && (
            <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-200 mb-3">NIFTYBEES Accumulation</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div>
                  <div className="text-xl font-bold text-slate-100">{appState.niftybees_total_units.toLocaleString('en-IN')}</div>
                  <div className="text-xs text-slate-400">Total Units</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-slate-100">6,400</div>
                  <div className="text-xs text-slate-400">Target Units</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-slate-100">₹{fmt(appState.niftybees_avg_price, 2)}</div>
                  <div className="text-xs text-slate-400">Avg Price</div>
                </div>
                <div>
                  <div className={`text-xl font-bold ${appState.phase === 2 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    Phase {appState.phase}
                  </div>
                  <div className="text-xs text-slate-400">{appState.phase === 1 ? 'Accumulating' : 'Income Mode'}</div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="mt-3">
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>{appState.niftybees_total_units.toLocaleString('en-IN')} / 6,400 units</span>
                  <span>{Math.round(appState.niftybees_total_units / 64)}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded"
                    style={{ width: `${Math.min(100, appState.niftybees_total_units / 64)}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Positions tab ───────────────────────────────────────────────────── */}
      {tab === 'positions' && (
        <div className="space-y-6">
          {/* MTM header */}
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-400">
              {mtm.length > 0 && (
                <span>
                  Total unrealised P&L:{' '}
                  <span className={`font-semibold ${pnlClr(mtm.reduce((s, m) => s + (m.pnl || 0), 0))}`}>
                    ₹{fmt(mtm.reduce((s, m) => s + (m.pnl || 0), 0), 0)}
                  </span>
                </span>
              )}
            </div>
            <button onClick={loadMtm} className="text-xs text-blue-400 hover:text-blue-300">↻ Refresh MTM</button>
          </div>

          {/* Pending limit orders */}
          {pendingPos.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-semibold text-slate-300">Pending Limit Orders ({pendingPos.length})</h3>
                <span className="text-[10px] px-2 py-0.5 bg-amber-900/60 text-amber-300 rounded-full">Awaiting fill confirmation</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700">
                      {['Type', 'Strike', 'Expiry', 'Limit Price', 'Order ID', 'Actions'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pendingPos.map(p => (
                      <tr key={p.id} className="border-b border-slate-800 bg-amber-950/10">
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${p.type === 'PE' ? 'bg-emerald-900 text-emerald-400' : 'bg-red-900 text-red-400'}`}>
                            {p.direction} {p.type}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-200">{fmt(p.strike, 0)}</td>
                        <td className="px-3 py-2 text-slate-300">{p.expiry}</td>
                        <td className="px-3 py-2 font-mono text-amber-300">₹{fmt(p.premium_sold)}</td>
                        <td className="px-3 py-2 text-slate-400 font-mono text-[10px]">
                          {p.broker_order_id ?? '—'}
                        </td>
                        <td className="px-3 py-2 flex gap-1">
                          <button
                            onClick={() => {
                              const price = prompt(`Filled at what price? (leave blank to use limit price ₹${fmt(p.premium_sold)})`)
                              if (price !== null) doMarkFilled(p, price || '')
                            }}
                            className="text-xs px-2 py-1 bg-emerald-800 hover:bg-emerald-700 text-emerald-200 rounded"
                          >
                            ✓ Mark Filled
                          </button>
                          {!p.broker_order_id && (
                            <button onClick={() => doDelete(p)}
                              className="text-xs px-2 py-1 bg-slate-800 hover:bg-red-900 text-slate-500 hover:text-red-300 rounded" title="Delete record — no trace">
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* P&L payoff chart */}
          {payoffData.length > 0 && (
            <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
              <div className="text-xs font-semibold text-slate-200 mb-1">P&L at Expiry vs NIFTY Spot</div>
              <p className="text-[10px] text-slate-500 mb-3">Green area = profit · Red area = loss · Dashed = today (BS est.) · Vertical = current spot</p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={payoffData} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="spot" tick={{ fill: '#94a3b8', fontSize: 10 }}
                    tickFormatter={v => (v/1000).toFixed(0) + 'k'} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }}
                    tickFormatter={v => v >= 0 ? '+' + (v/1000).toFixed(0) + 'k' : (v/1000).toFixed(0) + 'k'}
                    domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 6 }}
                    formatter={(val: number, name: string) => [
                      `${val >= 0 ? '+' : ''}₹${val.toLocaleString('en-IN')}`,
                      name === 'expiry' ? 'At Expiry' : 'Today (BS)',
                    ]}
                    labelFormatter={v => `NIFTY ${Number(v).toLocaleString('en-IN')}`}
                  />
                  <ReferenceLine y={0} stroke="#475569" strokeWidth={1.5} />
                  <ReferenceLine x={Math.round(spot0)} stroke="#e2e8f0" strokeDasharray="4 2" strokeWidth={1.5}
                    label={{ value: 'CMP', position: 'top', fill: '#94a3b8', fontSize: 9 }} />
                  <Area type="monotone" dataKey="expiry" name="expiry"
                    stroke="#22c55e" strokeWidth={2} fill="#22c55e" fillOpacity={0.12}
                    dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="today" name="today"
                    stroke="#60a5fa" strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Active positions */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">Active Positions ({activePos.length})</h3>
            {activePos.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">No active positions</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700">
                      {['Type', 'Strike', 'Expiry', 'DTE', 'Source', 'Sold @', 'Current', 'P&L', 'P&L%', 'Actions'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activePos.map(p => {
                      const m = mtm.find(x => x.id === p.id)
                      const isBroker = !!p.broker_order_id
                      return (
                        <tr key={p.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${p.type === 'PE' ? 'bg-emerald-900 text-emerald-400' : 'bg-red-900 text-red-400'}`}>
                              {p.direction} {p.type}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-200">{fmt(p.strike, 0)}</td>
                          <td className="px-3 py-2 text-slate-300">{p.expiry}</td>
                          <td className="px-3 py-2 text-slate-300">{m?.dte ?? '—'}</td>
                          <td className="px-3 py-2">
                            {isBroker
                              ? <span className="text-[10px] px-1.5 py-0.5 bg-blue-900/60 text-blue-300 rounded" title={p.broker_order_id!}>Angel One</span>
                              : <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded">Manual</span>}
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-200">₹{fmt(p.premium_sold)}</td>
                          <td className="px-3 py-2 font-mono text-slate-200">{m ? `₹${fmt(m.current_price)}` : '—'}</td>
                          <td className={`px-3 py-2 font-mono ${m ? pnlClr(m.pnl) : 'text-slate-400'}`}>
                            {m ? `₹${fmt(m.pnl, 0)}` : '—'}
                            {m?.profit_booking && <span className="ml-1 text-emerald-400">★</span>}
                            {m?.risk_alert && <span className="ml-1 text-red-400">⚠</span>}
                          </td>
                          <td className={`px-3 py-2 font-mono ${m ? pnlClr(m.pnl_pct) : 'text-slate-400'}`}>
                            {m ? `${m.pnl_pct.toFixed(1)}%` : '—'}
                          </td>
                          <td className="px-3 py-2 flex gap-1">
                            {isBroker ? (
                              <button onClick={() => { setExitPos(p); setExitPrice(''); setExitBroker(true) }}
                                className="text-xs px-2 py-1 bg-red-800 hover:bg-red-700 text-red-200 rounded">
                                Exit
                              </button>
                            ) : (
                              <>
                                <button onClick={() => { setExitPos(p); setExitPrice(''); setExitBroker(false) }}
                                  className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded">
                                  Close
                                </button>
                                <button onClick={() => doDelete(p)}
                                  className="text-xs px-2 py-1 bg-slate-800 hover:bg-red-900 text-slate-500 hover:text-red-300 rounded" title="Delete record — no trace">
                                  ×
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Closed positions */}
          {closedPos.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Closed Positions ({closedPos.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700">
                      {['Type', 'Strike', 'Expiry', 'Source', 'Sold @', 'Exit @', 'P&L', 'Exited'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {closedPos.map(p => (
                      <tr key={p.id} className="border-b border-slate-800 opacity-70">
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${p.type === 'PE' ? 'bg-emerald-900/50 text-emerald-500' : 'bg-red-900/50 text-red-500'}`}>
                            {p.direction} {p.type}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-300">{fmt(p.strike, 0)}</td>
                        <td className="px-3 py-2 text-slate-400">{p.expiry}</td>
                        <td className="px-3 py-2">
                          {p.broker_order_id
                            ? <span className="text-[10px] px-1.5 py-0.5 bg-blue-900/40 text-blue-400 rounded">Angel One</span>
                            : <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-500 rounded">Manual</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-300">₹{fmt(p.premium_sold)}</td>
                        <td className="px-3 py-2 font-mono text-slate-300">{p.exit_price != null ? `₹${fmt(p.exit_price)}` : '—'}</td>
                        <td className={`px-3 py-2 font-mono ${p.pnl != null ? pnlClr(p.pnl) : 'text-slate-400'}`}>
                          {p.pnl != null ? `₹${fmt(p.pnl, 0)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-400">{fmtDate(p.exited_at)}</td>
                        <td className="px-3 py-2">
                          {!p.broker_order_id && (
                            <button onClick={() => doDelete(p)}
                              className="text-[10px] px-1.5 py-0.5 text-slate-600 hover:text-red-400 hover:bg-red-950/30 rounded" title="Delete record — no trace">
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Margin card */}
          {margin && (
            <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 flex items-center gap-4">
              <div className="text-2xl">💰</div>
              <div>
                <div className="text-xs text-slate-400 mb-0.5">Available Margin (Angel One)</div>
                <div className="text-xl font-bold text-slate-100">
                  {margin.connected ? `₹${fmt(margin.available_cash, 0)}` : 'Broker not connected'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Cycles tab ──────────────────────────────────────────────────────── */}
      {tab === 'cycles' && (
        <div className="space-y-4">
          {appState && (
            <div className="flex items-center gap-3 mb-2">
              <span className={`text-sm font-semibold px-3 py-1 rounded-full ${appState.phase === 1 ? 'bg-blue-900 text-blue-300' : 'bg-emerald-900 text-emerald-300'}`}>
                Phase {appState.phase}: {appState.phase === 1 ? `Accumulating (${appState.niftybees_total_units.toLocaleString('en-IN')} / 6,400 units)` : 'Income Mode — All units accumulated'}
              </span>
            </div>
          )}

          {cycles.map(cyc => {
            const canBuy1 = cyc.status !== 'completed' && !cyc.buy1_qty
            const canBuy2 = (cyc.status === 'active' || cyc.status === 'completed') && cyc.buy1_qty > 0 && !cyc.buy2_qty
            const isActive = cyc.status === 'active' || (cyc.cycle_num === 1 && cyc.status === 'pending' && (!cycles[0] || cycles[0].status === 'pending'))
            return (
              <div key={cyc.cycle_num} className={`bg-slate-800 rounded-lg border p-4 ${cyc.status === 'completed' ? 'border-emerald-800' : cyc.status === 'active' ? 'border-blue-700' : 'border-slate-700'}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-slate-100">Cycle {cyc.cycle_num}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${cyc.status === 'completed' ? 'bg-emerald-900 text-emerald-400' : cyc.status === 'active' ? 'bg-blue-900 text-blue-400' : 'bg-slate-700 text-slate-400'}`}>
                      {cyc.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Target: 1,000 + 600 = 1,600 units
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Buy 1 */}
                  <div className="bg-slate-700/40 rounded p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-slate-300">Tranche 1 (1,000 units)</span>
                      {canBuy1 && (
                        <button
                          onClick={() => { setEtfModal({ cycle: cyc, tranche: 1 }); setEtfQty('1000'); setEtfPrice(''); setEtfBroker(true) }}
                          className="text-xs px-2 py-0.5 bg-blue-700 hover:bg-blue-600 text-white rounded"
                        >
                          + Buy
                        </button>
                      )}
                    </div>
                    {cyc.buy1_qty ? (
                      <div className="text-xs space-y-0.5">
                        <div className="flex justify-between"><span className="text-slate-400">Qty</span><span className="text-slate-200">{cyc.buy1_qty.toLocaleString('en-IN')}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Price</span><span className="text-slate-200">₹{fmt(cyc.buy1_price)}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Date</span><span className="text-slate-200">{cyc.buy1_date}</span></div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">Not purchased yet</div>
                    )}
                  </div>

                  {/* Buy 2 */}
                  <div className="bg-slate-700/40 rounded p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-slate-300">Tranche 2 (600 units)</span>
                      {canBuy2 && (
                        <button
                          onClick={() => { setEtfModal({ cycle: cyc, tranche: 2 }); setEtfQty('600'); setEtfPrice(''); setEtfBroker(true) }}
                          className="text-xs px-2 py-0.5 bg-blue-700 hover:bg-blue-600 text-white rounded"
                        >
                          + Buy
                        </button>
                      )}
                    </div>
                    {cyc.buy2_qty ? (
                      <div className="text-xs space-y-0.5">
                        <div className="flex justify-between"><span className="text-slate-400">Qty</span><span className="text-slate-200">{cyc.buy2_qty.toLocaleString('en-IN')}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Price</span><span className="text-slate-200">₹{fmt(cyc.buy2_price)}</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Date</span><span className="text-slate-200">{cyc.buy2_date}</span></div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">Not purchased yet</div>
                    )}
                  </div>
                </div>

                {(cyc.buy1_qty || cyc.buy2_qty) ? (
                  <div className="mt-2 pt-2 border-t border-slate-700 flex justify-between text-xs">
                    <span className="text-slate-400">Cycle total</span>
                    <span className="font-semibold text-slate-200">
                      {((cyc.buy1_qty || 0) + (cyc.buy2_qty || 0)).toLocaleString('en-IN')} units
                    </span>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-4">
          {history && (
            <div className="flex gap-4 text-sm">
              <div className="bg-slate-800 rounded p-3 border border-slate-700 text-center min-w-[100px]">
                <div className="text-xl font-bold text-slate-100">{history.accuracy != null ? `${history.accuracy}%` : '—'}</div>
                <div className="text-xs text-slate-400">Accuracy</div>
              </div>
              <div className="bg-slate-800 rounded p-3 border border-slate-700 text-center min-w-[100px]">
                <div className="text-xl font-bold text-emerald-400">{history.correct}</div>
                <div className="text-xs text-slate-400">Correct</div>
              </div>
              <div className="bg-slate-800 rounded p-3 border border-slate-700 text-center min-w-[100px]">
                <div className="text-xl font-bold text-slate-100">{history.graded}</div>
                <div className="text-xs text-slate-400">Graded</div>
              </div>
            </div>
          )}

          {history && history.history.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700">
                    {['Date', 'NIFTY', 'UP%', 'DOWN%', 'SIDEWAYS%', 'Predicted', 'Actual', '✓'].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.history.map((h, i) => (
                    <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/40">
                      <td className="px-3 py-2 text-slate-300">{h.date}</td>
                      <td className="px-3 py-2 font-mono text-slate-200">₹{fmt(h.nifty_spot, 0)}</td>
                      <td className="px-3 py-2 text-emerald-400">{h.up_prob}%</td>
                      <td className="px-3 py-2 text-red-400">{h.down_prob}%</td>
                      <td className="px-3 py-2 text-amber-400">{h.sideways_prob}%</td>
                      <td className={`px-3 py-2 font-semibold ${dirColor(h.direction)}`}>{h.direction}</td>
                      <td className={`px-3 py-2 ${h.actual_direction ? dirColor(h.actual_direction) : 'text-slate-500'}`}>
                        {h.actual_direction || '—'}
                      </td>
                      <td className="px-3 py-2">
                        {h.actual_direction
                          ? (h.actual_direction === h.direction ? '✅' : '❌')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-slate-500 text-sm">No history yet. Run direction analysis to start tracking.</div>
          )}
        </div>
      )}

      {/* ── Order flow modal ────────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-slate-100">
                {modalStep === 'expiry' ? 'Select Expiry' : modalStep === 'chain' ? 'Select Strike' : 'Confirm Order'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-200 text-xl">✕</button>
            </div>

            {/* Step 1: expiry */}
            {modalStep === 'expiry' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-400">Select an expiry for the option you want to sell:</p>
                <div className="grid grid-cols-3 gap-2">
                  {expiries.map(e => (
                    <button
                      key={e.expiry}
                      onClick={() => setSelExpiry(e.expiry)}
                      className={`p-3 rounded border text-sm text-center transition-colors ${
                        selExpiry === e.expiry
                          ? 'border-blue-500 bg-blue-900/40 text-blue-300'
                          : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      <div className="font-medium">{e.expiry}</div>
                      <div className="text-xs text-slate-400">{e.dte}d</div>
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
                  <button
                    onClick={loadChain}
                    disabled={!selExpiry || loadingChain}
                    className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded text-sm disabled:opacity-50"
                  >
                    {loadingChain ? 'Loading…' : 'Next →'}
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: chain */}
            {modalStep === 'chain' && chainData && (
              <div className="space-y-3">
                <div className="text-sm text-slate-400 mb-2">
                  NIFTY @ ₹{fmt(chainData.spot, 0)} · Expiry: {chainData.expiry} · {chainData.dte}d · IV: {chainData.iv_base}%
                </div>
                <p className="text-sm text-slate-400 mb-2">
                  Suggested: <span className={`font-semibold ${dirColor(chainData.direction)}`}>{chainData.direction}</span>
                  {chainData.direction === 'UP' ? ' → Sell OTM PE' : chainData.direction === 'DOWN' ? ' → Sell OTM CE' : ' → Sell PE or CE'}
                </p>
                {/* PE / CE tabs */}
                <div className="flex gap-1 border-b border-slate-700 mb-2">
                  {(['PE', 'CE'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => { setChainTab(t); setChainPage(0) }}
                      className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                        chainTab === t
                          ? (t === 'PE' ? 'text-emerald-400 border-b-2 border-emerald-400 -mb-px' : 'text-red-400 border-b-2 border-red-400 -mb-px')
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t === 'PE' ? 'PUT (PE) — Sell if Bullish' : 'CALL (CE) — Sell if Bearish'}
                    </button>
                  ))}
                </div>
                {(() => {
                  const allRows = chainTab === 'PE' ? chainData.all_pe : chainData.all_ce
                  const total   = allRows.length
                  const pageRows = allRows.slice(chainPage * PAGE_SIZE, (chainPage + 1) * PAGE_SIZE)
                  const totalPages = Math.ceil(total / PAGE_SIZE)
                  return (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-700">
                              {['Strike', 'LTP', 'Delta', 'Theta', 'IV', 'OI', 'Premium/lot', ''].map(h => (
                                <th key={h} className="px-2 py-2 text-left text-slate-400 font-medium">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map(s => (
                              <tr
                                key={`${s.type}-${s.strike}`}
                                className={`border-b border-slate-800 cursor-pointer transition-colors ${
                                  selStrike?.strike === s.strike && selStrike?.type === s.type
                                    ? 'bg-blue-900/30'
                                    : 'hover:bg-slate-800/50'
                                }`}
                                onClick={() => { setSelStrike(s); setOrderPrice(s.ltp.toFixed(2)); setModalStep('confirm') }}
                              >
                                <td className="px-2 py-2 font-mono text-slate-200">{fmt(s.strike, 0)}</td>
                                <td className="px-2 py-2 font-mono text-slate-200">₹{fmt(s.ltp)}</td>
                                <td className="px-2 py-2 text-slate-300">{Math.abs(s.delta).toFixed(2)}</td>
                                <td className="px-2 py-2 text-slate-300">{s.theta.toFixed(2)}</td>
                                <td className="px-2 py-2 text-slate-300">{s.iv}%</td>
                                <td className="px-2 py-2 text-slate-300">{(s.oi / 1000).toFixed(0)}K</td>
                                <td className="px-2 py-2 font-mono text-amber-300">₹{fmt(s.premium_1lot, 0)}</td>
                                <td className="px-2 py-2 text-blue-400 text-xs">Select →</td>
                              </tr>
                            ))}
                            {pageRows.length === 0 && (
                              <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No strikes found in ±1,200 range</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                          <button
                            onClick={() => setChainPage(p => Math.max(0, p - 1))}
                            disabled={chainPage === 0}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded disabled:opacity-40"
                          >
                            ← Prev
                          </button>
                          <span>Page {chainPage + 1} of {totalPages} &nbsp;·&nbsp; {total} strikes</span>
                          <button
                            onClick={() => setChainPage(p => Math.min(totalPages - 1, p + 1))}
                            disabled={chainPage >= totalPages - 1}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded disabled:opacity-40"
                          >
                            Next →
                          </button>
                        </div>
                      )}
                    </>
                  )
                })()}
                <div className="flex justify-start gap-2 mt-4">
                  <button onClick={() => setModalStep('expiry')} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">← Back</button>
                </div>
              </div>
            )}

            {/* Step 3: confirm */}
            {modalStep === 'confirm' && selStrike && (
              <div className="space-y-4">
                <div className={`rounded-lg border p-4 ${selStrike.type === 'PE' ? 'bg-emerald-900/20 border-emerald-800' : 'bg-red-900/20 border-red-800'}`}>
                  <div className="text-lg font-bold text-slate-100 mb-1">
                    SELL {orderLots} lot{orderLots > 1 ? 's' : ''} NIFTY {fmt(selStrike.strike, 0)} {selStrike.type}
                  </div>
                  <div className="text-sm text-slate-300">Expiry: {selExpiry} · Delta {Math.abs(selStrike.delta).toFixed(2)} · IV {selStrike.iv}%</div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Lots</label>
                    <input
                      type="number"
                      min={1}
                      value={orderLots}
                      onChange={e => setOrderLots(parseInt(e.target.value) || 1)}
                      className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Limit Price (₹) — blank = MARKET</label>
                    <input
                      type="number"
                      step="0.05"
                      value={orderPrice}
                      onChange={e => setOrderPrice(e.target.value)}
                      placeholder="Market order"
                      className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                    />
                  </div>
                </div>

                <div className="bg-slate-800 rounded p-3 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-slate-400">Premium/lot</span><span className="text-amber-300">₹{fmt(selStrike.premium_1lot, 0)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Total premium ({orderLots} lots)</span><span className="text-amber-300 font-semibold">₹{fmt(selStrike.premium_1lot * orderLots, 0)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Lot size</span><span className="text-slate-200">75</span></div>
                </div>

                <div className="flex justify-between gap-2 mt-4">
                  <button onClick={() => setModalStep('chain')} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">← Back</button>
                  <button
                    onClick={placeOrder}
                    disabled={placing}
                    className="px-6 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-sm font-medium disabled:opacity-50"
                  >
                    {placing ? 'Placing…' : '✓ Place Sell Order'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Exit modal ──────────────────────────────────────────────────────── */}
      {exitPos && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-slate-100">Exit Position</h2>
              <button onClick={() => setExitPos(null)} className="text-slate-400 hover:text-slate-200 text-xl">✕</button>
            </div>
            <div className="bg-slate-800 rounded p-3 mb-4 text-sm text-slate-200">
              NIFTY {fmt(exitPos.strike, 0)} {exitPos.type} · Sold @ ₹{fmt(exitPos.premium_sold)} · {exitPos.expiry}
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Exit Price (₹) — blank = use current LTP</label>
                <input
                  type="number"
                  step="0.05"
                  value={exitPrice}
                  onChange={e => setExitPrice(e.target.value)}
                  placeholder="Leave blank for market"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => { setExitBroker(true); doExit() }}
                  disabled={saving}
                  className="flex-1 py-2 bg-red-700 hover:bg-red-600 text-white rounded text-sm font-medium disabled:opacity-50"
                >
                  {saving ? 'Exiting…' : '🔴 Exit via Angel One'}
                </button>
                <button
                  onClick={() => { setExitBroker(false); doExit() }}
                  disabled={saving}
                  className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm disabled:opacity-50"
                >
                  Record Only
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ETF buy modal ───────────────────────────────────────────────────── */}
      {etfModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-slate-100">
                Buy NIFTYBEES — Cycle {etfModal.cycle.cycle_num} Tranche {etfModal.tranche}
              </h2>
              <button onClick={() => setEtfModal(null)} className="text-slate-400 hover:text-slate-200 text-xl">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Quantity (units)</label>
                <input
                  type="number"
                  value={etfQty}
                  onChange={e => setEtfQty(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Limit Price (₹) — blank = MARKET</label>
                <input
                  type="number"
                  step="0.01"
                  value={etfPrice}
                  onChange={e => setEtfPrice(e.target.value)}
                  placeholder="Market order"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                />
              </div>
              {etfPrice && etfQty && (
                <div className="bg-slate-800 rounded p-2 text-xs text-slate-300">
                  Estimated cost: ₹{fmt(parseFloat(etfPrice) * parseInt(etfQty), 0)}
                </div>
              )}
              <div className="flex gap-3 mt-2">
                <button
                  onClick={doEtfBuy}
                  disabled={saving || !etfQty}
                  className="flex-1 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
                >
                  {saving ? 'Placing…' : '📈 Buy via Angel One'}
                </button>
                <button
                  onClick={() => { setEtfBroker(false); doEtfBuy() }}
                  disabled={saving || !etfQty}
                  className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm disabled:opacity-50"
                >
                  Record Only
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
