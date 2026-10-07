import React, { useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

// axios convenience wrappers that return .data directly
const api = {
  get:    (url: string)             => client.get(url).then(r => r.data),
  post:   (url: string, body: any)  => client.post(url, body).then(r => r.data),
  patch:  (url: string, body: any)  => client.patch(url, body).then(r => r.data),
  delete: (url: string)             => client.delete(url).then(r => r.data),
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AIPick {
  symbol: string
  sector: string
  cap_type: string
  conviction: 'HIGH' | 'MEDIUM' | 'LOW'
  current_price: number
  pct_from_52w_high: number
  decline_reason: string
  recovery_catalyst: string
  risks: string
  justification: string
  hold_horizon: string
  prob_2pct_1w?: number
  prob_reasoning?: string
}

interface ETFPick {
  symbol: string
  etf_type?: string
  theme?: string
  screen_type: 'bounce' | 'momentum'
  conviction: 'HIGH' | 'MEDIUM' | 'LOW'
  current_price: number
  consecutive_down_days?: number
  ret_5d?: number
  ret_10d?: number
  rsi?: number
  reason?: string
  justification: string
  hold_horizon?: string
}

interface ScreenResult {
  symbol: string
  sector: string
  current_price: number
  rsi?: number
  ret_5d?: number
  sma_50?: number
  sma_200?: number
  above_50_dma?: boolean | null
  above_200_dma?: boolean | null
  macd_bullish?: boolean | null
  consecutive_down_days?: number
  avg_vol_ratio?: number
  pct_from_52w_high?: number
  pct_from_52w_low?: number
  ret_20d?: number
}

interface StockPosition {
  symbol: string
  display: string
  sector: string
  allocation_pct: number
  conviction: string
  justification: string
  asset_type?: 'stock' | 'etf'
  status: 'watching' | 'chunk1_placed' | 'chunk2_placed' | 'trailing_sl' | 'exited' | 'error'
  chunk1_qty: number
  chunk1_price: number
  chunk1_date?: string
  chunk2_qty: number
  chunk2_price: number
  avg_price: number
  total_qty: number
  sl_price: number
  current_price: number
  pnl: number
  pnl_pct: number
  booked_pnl?: number
  exit_price?: number
  error?: string
  last_checked?: string
}

interface EntryCondition {
  type: 'immediately' | 'market_open' | 'manual'
}

interface ChunkDef {
  n: number
  fund_pct: number
  averaging_trigger_pct?: number
  min_hold_days?: number
}

interface ChunkConfig {
  chunks: ChunkDef[]
}

interface ExitConfig {
  profit_target_pct: number
  trailing_sl_gap_pct: number
}

interface Campaign {
  id: string
  name: string
  username: string
  status: 'active' | 'paused' | 'completed'
  auto_trade: boolean
  broker: string
  reserved_fund: number
  entry_condition: EntryCondition
  chunk_config?: ChunkConfig
  exit_config?: ExitConfig
  split_config?: { stocks_pct: number; etfs_pct: number }
  stocks: StockPosition[]
  cycle: number
  chunk1_deployed: number
  chunk2_deployed: boolean
  chunk1_date?: string
  last_cycle_booked_pnl?: number
  last_cycle_completed?: string
  created_at: string
  updated_at?: string
}

interface TradeLog {
  action: string
  symbol?: string
  qty?: number
  price?: number
  pnl?: number
  order_id?: string
  paper?: boolean
  logged_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  watching:       'Watching',
  chunk1_placed:  'Chunk 1 ✓', c1_placed: 'Chunk 1 ✓',
  chunk2_placed:  'Averaged',  c2_placed: 'Averaged',
  c3_placed:      'Chunk 3 ✓', c4_placed: 'Chunk 4 ✓',
  trailing_sl:    'Trailing SL',
  exited:         'Exited',
  error:          'Error',
}
const STATUS_COLOR: Record<string, string> = {
  watching:       'bg-slate-700 text-slate-300',
  chunk1_placed:  'bg-blue-900/60 text-blue-300',   c1_placed: 'bg-blue-900/60 text-blue-300',
  chunk2_placed:  'bg-purple-900/60 text-purple-300', c2_placed: 'bg-purple-900/60 text-purple-300',
  c3_placed:      'bg-indigo-900/60 text-indigo-300',
  c4_placed:      'bg-violet-900/60 text-violet-300',
  trailing_sl:    'bg-amber-900/60 text-amber-300',
  exited:         'bg-emerald-900/60 text-emerald-300',
  error:          'bg-red-900/60 text-red-400',
}

function probBadge(p: number | undefined) {
  if (p === undefined || p === null) return null
  const cls = p >= 65 ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50'
             : p >= 45 ? 'bg-amber-900/60 text-amber-300 border-amber-700/50'
             :           'bg-red-900/60 text-red-300 border-red-700/50'
  return <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${cls}`} title="Probability of +2% in 1 week">
    {p}% 1W
  </span>
}

function fmt(n: number | undefined | null, decimals = 2) {
  if (n === undefined || n === null) return '–'
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
function fmtRs(n: number | undefined | null) {
  if (n === undefined || n === null) return '–'
  return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
function pnlClass(v: number | undefined | null) {
  if (!v) return 'text-slate-400'
  return v >= 0 ? 'text-emerald-400' : 'text-red-400'
}
function convBadge(c: string) {
  if (c === 'HIGH')   return 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
  if (c === 'MEDIUM') return 'bg-amber-900/50 text-amber-300 border border-amber-700/50'
  return 'bg-slate-700 text-slate-300'
}

// ── Picks Tab ─────────────────────────────────────────────────────────────────

interface PicksTabProps {
  onBuildCampaign: (stocks: { pick: AIPick; allocation: number }[]) => void
}

function PicksTab({ onBuildCampaign }: PicksTabProps) {
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [picks, setPicks]       = useState<AIPick[]>([])
  const [meta, setMeta]         = useState<{ fetched_at?: string; total_screened?: number; candidates_shortlisted?: number }>({})
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('')
    try {
      const url = refresh ? '/stock-trader/picks/refresh' : '/stock-trader/picks'
      const r = refresh ? await api.post(url, {}) : await api.get(url)
      setPicks(r.picks || [])
      setMeta({ fetched_at: r.fetched_at, total_screened: r.total_screened, candidates_shortlisted: r.candidates_shortlisted })
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const toggleSelect = (sym: string) => {
    setSelected(prev => {
      const m = new Map(prev)
      if (m.has(sym)) m.delete(sym)
      else m.set(sym, 0)
      // Auto-balance allocations equally
      const total = m.size
      if (total > 0) {
        const eq = Math.floor(100 / total)
        let rem = 100 - eq * total
        let i = 0
        m.forEach((_, k) => { m.set(k, eq + (i++ < rem ? 1 : 0)) })
      }
      return m
    })
  }

  const setAlloc = (sym: string, val: number) => {
    setSelected(prev => { const m = new Map(prev); m.set(sym, val); return m })
  }

  const totalAlloc = Array.from(selected.values()).reduce((a, b) => a + b, 0)

  const handleBuild = () => {
    const list = Array.from(selected.entries()).map(([sym, alloc]) => {
      const pick = picks.find(p => p.symbol === sym)!
      return { pick, allocation: alloc }
    })
    onBuildCampaign(list)
  }

  if (loading && !picks.length) return (
    <div className="flex flex-col gap-3 mt-4">
      {[1,2,3,4].map(i => (
        <div key={i} className="h-32 bg-slate-800/60 rounded-xl animate-pulse" />
      ))}
      <p className="text-center text-sm text-muted mt-2">Screening {80}+ stocks, AI analyzing candidates…</p>
    </div>
  )

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-white">AI Quality Dip Picks</div>
          {meta.fetched_at && (
            <div className="text-[10px] text-muted mt-0.5">
              Updated {new Date(meta.fetched_at).toLocaleString('en-IN')} ·
              {meta.total_screened} screened · {meta.candidates_shortlisted} shortlisted · {picks.length} recommended
            </div>
          )}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg border border-border transition disabled:opacity-50"
        >
          {loading ? '⟳ Scanning…' : '⟳ Refresh'}
        </button>
      </div>

      {error && <div className="text-red-400 text-sm mb-3 bg-red-900/20 rounded-lg p-3">{error}</div>}

      {!picks.length && !loading && (
        <div className="text-center text-muted text-sm py-12">
          No picks available. Click Refresh to run the AI screen.
        </div>
      )}

      {/* Pick cards */}
      <div className="flex flex-col gap-3">
        {picks.map(pick => {
          const isSel   = selected.has(pick.symbol)
          const isExp   = expanded.has(pick.symbol)
          const alloc   = selected.get(pick.symbol) ?? 0
          return (
            <div
              key={pick.symbol}
              className={`rounded-xl border transition-all ${isSel ? 'border-blue-500/50 bg-blue-950/20' : 'border-border bg-slate-800/40'}`}
            >
              <div className="p-4">
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggleSelect(pick.symbol)}
                    className="mt-1 w-4 h-4 accent-blue-500 cursor-pointer flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-white font-bold text-sm">{pick.symbol}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${convBadge(pick.conviction)}`}>
                        {pick.conviction}
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded">{pick.cap_type}</span>
                      <span className="text-[9px] text-muted">{pick.sector}</span>
                      {probBadge(pick.prob_2pct_1w)}
                    </div>
                    <div className="flex items-center gap-4 flex-wrap text-xs">
                      <span className="text-white font-mono">₹{fmt(pick.current_price)}</span>
                      <span className="text-red-400">{pick.pct_from_52w_high}% from 52w high</span>
                      <span className="text-slate-400">{pick.hold_horizon}</span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-slate-400">
                      <span className="text-emerald-400/80">↑ {pick.recovery_catalyst}</span>
                    </div>
                    {pick.prob_reasoning && pick.prob_2pct_1w !== undefined && (
                      <div className="mt-1 text-[10px] text-slate-500">📊 {pick.prob_reasoning}</div>
                    )}
                  </div>
                  {/* Allocation input when selected */}
                  {isSel && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <input
                        type="number"
                        min={1} max={99}
                        value={alloc}
                        onChange={e => setAlloc(pick.symbol, Number(e.target.value))}
                        className="w-14 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white"
                      />
                      <span className="text-xs text-muted">%</span>
                    </div>
                  )}
                  <button
                    onClick={() => setExpanded(prev => {
                      const s = new Set(prev)
                      s.has(pick.symbol) ? s.delete(pick.symbol) : s.add(pick.symbol)
                      return s
                    })}
                    className="text-muted hover:text-white text-xs flex-shrink-0 ml-1"
                  >
                    {isExp ? '▲' : '▼'}
                  </button>
                </div>

                {/* Expanded: justification */}
                {isExp && (
                  <div className="mt-3 pt-3 border-t border-border/40 space-y-2 text-[11px]">
                    <div>
                      <span className="text-muted uppercase tracking-wider text-[9px]">AI Justification</span>
                      <p className="text-slate-300 mt-1 leading-relaxed">{pick.justification}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-muted text-[9px] uppercase">Decline Reason</span>
                        <p className="text-slate-400 mt-0.5">{pick.decline_reason}</p>
                      </div>
                      <div>
                        <span className="text-muted text-[9px] uppercase">Key Risks</span>
                        <p className="text-amber-400/80 mt-0.5">{pick.risks}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Build campaign bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 mt-4 bg-slate-900 border border-blue-600/50 rounded-xl p-4 shadow-2xl">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <span className="text-white font-semibold">{selected.size} stock{selected.size > 1 ? 's' : ''} selected</span>
              <span className={`ml-2 text-xs font-mono ${totalAlloc === 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                Allocation: {totalAlloc}%{totalAlloc !== 100 && ' — adjust in campaign modal'}
              </span>
            </div>
            <button
              onClick={handleBuild}
              disabled={selected.size === 0}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg font-semibold transition"
            >
              Build Campaign →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── ETF Picks Tab ─────────────────────────────────────────────────────────────

interface ETFPicksTabProps {
  onBuildCampaign: (etfs: { pick: ETFPick; allocation: number }[]) => void
}

function ETFPicksTab({ onBuildCampaign }: ETFPicksTabProps) {
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [picks, setPicks]       = useState<ETFPick[]>([])
  const [meta, setMeta]         = useState<{ fetched_at?: string; total_screened?: number; bounce_candidates_count?: number; momentum_etfs_count?: number }>({})
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('')
    try {
      const url = refresh ? '/stock-trader/etf-picks/refresh' : '/stock-trader/etf-picks'
      const r = refresh ? await api.post(url, {}) : await api.get(url)
      setPicks(r.picks || [])
      setMeta({ fetched_at: r.fetched_at, total_screened: r.total_screened, bounce_candidates_count: r.bounce_candidates_count, momentum_etfs_count: r.momentum_etfs_count })
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const toggleSelect = (sym: string) => {
    setSelected(prev => {
      const m = new Map(prev)
      if (m.has(sym)) m.delete(sym)
      else m.set(sym, 0)
      const total = m.size
      if (total > 0) {
        const eq = Math.floor(100 / total)
        let rem = 100 - eq * total
        let i = 0
        m.forEach((_, k) => { m.set(k, eq + (i++ < rem ? 1 : 0)) })
      }
      return m
    })
  }

  const setAlloc = (sym: string, val: number) => {
    setSelected(prev => { const m = new Map(prev); m.set(sym, val); return m })
  }

  const totalAlloc = Array.from(selected.values()).reduce((a, b) => a + b, 0)

  const handleBuild = () => {
    const list = Array.from(selected.entries()).map(([sym, alloc]) => {
      const pick = picks.find(p => p.symbol === sym)!
      return { pick, allocation: alloc }
    })
    onBuildCampaign(list)
  }

  if (loading && !picks.length) return (
    <div className="flex flex-col gap-3 mt-4">
      {[1, 2, 3].map(i => <div key={i} className="h-28 bg-slate-800/60 rounded-xl animate-pulse" />)}
      <p className="text-center text-sm text-muted mt-2">Screening ETFs, analyzing momentum & bounce signals…</p>
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-white">AI ETF Picks</div>
          {meta.fetched_at && (
            <div className="text-[10px] text-muted mt-0.5">
              Updated {new Date(meta.fetched_at).toLocaleString('en-IN')} ·
              {meta.total_screened} screened · {meta.bounce_candidates_count} bounce · {meta.momentum_etfs_count} momentum
            </div>
          )}
        </div>
        <button onClick={() => load(true)} disabled={loading}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg border border-border transition disabled:opacity-50">
          {loading ? '⟳ Scanning…' : '⟳ Refresh'}
        </button>
      </div>

      {error && <div className="text-red-400 text-sm mb-3 bg-red-900/20 rounded-lg p-3">{error}</div>}

      {!picks.length && !loading && (
        <div className="text-center text-muted text-sm py-12">
          No ETF picks available. Click Refresh to run the ETF screen.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {picks.map(pick => {
          const isSel = selected.has(pick.symbol)
          const isExp = expanded.has(pick.symbol)
          const alloc = selected.get(pick.symbol) ?? 0
          const isBounce = pick.screen_type === 'bounce'
          return (
            <div key={pick.symbol}
              className={`rounded-xl border transition-all ${isSel ? 'border-purple-500/50 bg-purple-950/20' : 'border-border bg-slate-800/40'}`}>
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <input type="checkbox" checked={isSel} onChange={() => toggleSelect(pick.symbol)}
                    className="mt-1 w-4 h-4 accent-purple-500 cursor-pointer flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-white font-bold text-sm">{pick.symbol}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold border ${isBounce ? 'bg-amber-900/50 text-amber-300 border-amber-700/50' : 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'}`}>
                        {isBounce ? 'BOUNCE' : 'MOMENTUM'}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${convBadge(pick.conviction)}`}>
                        {pick.conviction}
                      </span>
                      {pick.etf_type && <span className="text-[9px] px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded">{pick.etf_type}</span>}
                    </div>
                    <div className="flex items-center gap-4 flex-wrap text-xs">
                      <span className="text-white font-mono">₹{fmt(pick.current_price)}</span>
                      {pick.consecutive_down_days !== undefined && pick.consecutive_down_days > 0 && (
                        <span className="text-amber-400">{pick.consecutive_down_days}d down</span>
                      )}
                      {pick.ret_5d !== undefined && (
                        <span className={pick.ret_5d >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          5d: {pick.ret_5d >= 0 ? '+' : ''}{fmt(pick.ret_5d)}%
                        </span>
                      )}
                      {pick.ret_10d !== undefined && (
                        <span className={pick.ret_10d >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          10d: {pick.ret_10d >= 0 ? '+' : ''}{fmt(pick.ret_10d)}%
                        </span>
                      )}
                      {pick.rsi !== undefined && <span className="text-slate-400">RSI {fmt(pick.rsi, 0)}</span>}
                      {pick.hold_horizon && <span className="text-slate-400">{pick.hold_horizon}</span>}
                    </div>
                    {pick.reason && (
                      <div className="mt-1.5 text-[11px] text-slate-400">{pick.reason}</div>
                    )}
                  </div>
                  {isSel && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <input type="number" min={1} max={99} value={alloc}
                        onChange={e => setAlloc(pick.symbol, Number(e.target.value))}
                        className="w-14 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white" />
                      <span className="text-xs text-muted">%</span>
                    </div>
                  )}
                  <button
                    onClick={() => setExpanded(prev => { const s = new Set(prev); s.has(pick.symbol) ? s.delete(pick.symbol) : s.add(pick.symbol); return s })}
                    className="text-muted hover:text-white text-xs flex-shrink-0 ml-1">
                    {isExp ? '▲' : '▼'}
                  </button>
                </div>
                {isExp && (
                  <div className="mt-3 pt-3 border-t border-border/40 space-y-2 text-[11px]">
                    <div>
                      <span className="text-muted uppercase tracking-wider text-[9px]">AI Justification</span>
                      <p className="text-slate-300 mt-1 leading-relaxed">{pick.justification}</p>
                    </div>
                    {pick.theme && (
                      <div className="text-[10px] text-slate-400">
                        <span className="text-muted">Theme: </span>{pick.theme}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {selected.size > 0 && (
        <div className="sticky bottom-4 mt-4 bg-slate-900 border border-purple-600/50 rounded-xl p-4 shadow-2xl">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <span className="text-white font-semibold">{selected.size} ETF{selected.size > 1 ? 's' : ''} selected</span>
              <span className={`ml-2 text-xs font-mono ${totalAlloc === 100 ? 'text-purple-400' : 'text-amber-400'}`}>
                Allocation: {totalAlloc}%{totalAlloc !== 100 && ' — adjust in campaign modal'}
              </span>
            </div>
            <button onClick={handleBuild} disabled={selected.size === 0}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm rounded-lg font-semibold transition">
              Build Campaign →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Screener Tab ──────────────────────────────────────────────────────────────

const CHIP_GROUPS = [
  { label: 'Momentum', color: 'blue', chips: ['RSI Oversold', 'RSI Overbought', 'MACD Bullish', 'MACD Bearish'] },
  { label: 'Short-term Return', color: 'amber', chips: ['Recent Rally >3%', 'Recent Dip <-3%', '2+ Down Days'] },
  { label: 'Trend (DMA)', color: 'purple', chips: ['Above 50 DMA', 'Below 50 DMA', 'Above 200 DMA', 'Below 200 DMA'] },
  { label: 'Price Levels', color: 'emerald', chips: ['Near 52W High', 'Near 52W Low', 'Big Dip >15%'] },
  { label: 'Volume', color: 'slate', chips: ['Volume Surge'] },
] as const

const CHIP_COLOR: Record<string, string> = {
  blue:    'bg-blue-900/40 border-blue-700/40 text-blue-300',
  amber:   'bg-amber-900/40 border-amber-700/40 text-amber-300',
  purple:  'bg-purple-900/40 border-purple-700/40 text-purple-300',
  emerald: 'bg-emerald-900/40 border-emerald-700/40 text-emerald-300',
  slate:   'bg-slate-700/60 border-border text-slate-300',
}
const CHIP_ACTIVE: Record<string, string> = {
  blue:    'bg-blue-600 border-blue-500 text-white',
  amber:   'bg-amber-600 border-amber-500 text-white',
  purple:  'bg-purple-600 border-purple-500 text-white',
  emerald: 'bg-emerald-600 border-emerald-500 text-white',
  slate:   'bg-slate-500 border-slate-400 text-white',
}

function dmaCell(above: boolean | null | undefined) {
  if (above === true)  return <span className="text-emerald-400 text-[10px]">▲ Above</span>
  if (above === false) return <span className="text-red-400 text-[10px]">▼ Below</span>
  return <span className="text-slate-500 text-[10px]">—</span>
}
function macdCell(bullish: boolean | null | undefined) {
  if (bullish === true)  return <span className="text-emerald-400 text-[10px]">↑ Bull</span>
  if (bullish === false) return <span className="text-red-400 text-[10px]">↓ Bear</span>
  return <span className="text-slate-500 text-[10px]">—</span>
}

interface ScreenerTabProps {
  onBuildCampaign: (stocks: { pick: AIPick; allocation: number }[]) => void
}

function ScreenerTab({ onBuildCampaign }: ScreenerTabProps) {
  const [activeChips, setActiveChips] = useState<string[]>([])
  const [results, setResults]         = useState<ScreenResult[]>([])
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [selected, setSelected]       = useState<Set<string>>(new Set())
  const [screened, setScreened]       = useState(false)

  const toggleChip = (chip: string) =>
    setActiveChips(prev => prev.includes(chip) ? prev.filter(c => c !== chip) : [...prev, chip])

  const screen = async () => {
    setLoading(true); setError(null); setSelected(new Set())
    try {
      const data = await api.post('/stock-trader/screen', { chips: activeChips })
      setResults(data.results || [])
      setScreened(true)
    } catch (e: any) {
      setError(e.message || 'Screener failed')
    }
    setLoading(false)
  }

  const toggleSelect = (sym: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      s.has(sym) ? s.delete(sym) : s.add(sym)
      return s
    })
  }

  const handleBuild = () => {
    const picks = results.filter(r => selected.has(r.symbol))
    if (!picks.length) return
    const base = Math.floor(100 / picks.length)
    const rem  = 100 - base * picks.length
    const campaignPicks = picks.map((r, i) => ({
      pick: {
        symbol:            r.symbol,
        sector:            r.sector || '',
        cap_type:          '',
        conviction:        'MEDIUM' as const,
        current_price:     r.current_price,
        pct_from_52w_high: r.pct_from_52w_high || 0,
        decline_reason:    '',
        recovery_catalyst: '',
        risks:             '',
        justification:     `Screened: ${activeChips.join(' + ') || 'All stocks'}`,
        hold_horizon:      '1 week',
      },
      allocation: i < picks.length - 1 ? base : base + rem,
    }))
    onBuildCampaign(campaignPicks)
  }

  const groupColor = (chip: string) => {
    for (const g of CHIP_GROUPS) {
      if ((g.chips as readonly string[]).includes(chip)) return g.color
    }
    return 'slate'
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold">Rule-based Stock Screener</h2>
          <p className="text-xs text-muted mt-0.5">Toggle filters (AND logic) to find stocks likely to move in the next 1 week</p>
        </div>
        <button onClick={screen} disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg font-semibold transition">
          {loading ? 'Screening…' : 'Screen ▶'}
        </button>
      </div>

      {/* Filter chips */}
      <div className="space-y-3">
        {CHIP_GROUPS.map(group => (
          <div key={group.label}>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">{group.label}</div>
            <div className="flex flex-wrap gap-2">
              {group.chips.map(chip => {
                const isActive = activeChips.includes(chip)
                return (
                  <button key={chip} onClick={() => toggleChip(chip)}
                    className={`px-3 py-1 rounded-full text-xs border font-medium transition
                      ${isActive ? CHIP_ACTIVE[group.color] : CHIP_COLOR[group.color]}`}>
                    {chip}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Active filters summary */}
      {activeChips.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Filters:</span>
          {activeChips.map(c => (
            <span key={c} className={`px-2 py-0.5 rounded text-[10px] border ${CHIP_COLOR[groupColor(c)]}`}>{c}</span>
          ))}
          <button onClick={() => setActiveChips([])} className="text-slate-500 hover:text-slate-300 text-[10px] ml-1">clear all</button>
        </div>
      )}

      {error && <div className="bg-red-900/20 border border-red-700/30 rounded-lg p-3 text-sm text-red-400">{error}</div>}

      {/* Results */}
      {screened && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-white font-medium">
              {results.length} match{results.length !== 1 ? 'es' : ''}
              {activeChips.length === 0 && <span className="text-muted text-xs ml-2">(all stocks, no filters)</span>}
            </div>
            {selected.size > 0 && (
              <button onClick={handleBuild}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-semibold transition">
                Build Campaign ({selected.size} stock{selected.size > 1 ? 's' : ''}) →
              </button>
            )}
          </div>

          {results.length === 0 ? (
            <div className="text-center py-12 text-muted text-sm">
              No stocks match the selected filters. Try fewer or different filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800/60 text-muted">
                    <th className="px-3 py-2 text-left w-8"></th>
                    <th className="px-3 py-2 text-left">Symbol</th>
                    <th className="px-3 py-2 text-left hidden sm:table-cell">Sector</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">RSI</th>
                    <th className="px-3 py-2 text-right">5d Ret</th>
                    <th className="px-3 py-2 text-center">vs 50 DMA</th>
                    <th className="px-3 py-2 text-center">vs 200 DMA</th>
                    <th className="px-3 py-2 text-center">MACD</th>
                    <th className="px-3 py-2 text-center">↓ Days</th>
                    <th className="px-3 py-2 text-right hidden md:table-cell">52W Draw</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const isSel = selected.has(r.symbol)
                    return (
                      <tr key={r.symbol}
                        onClick={() => toggleSelect(r.symbol)}
                        className={`border-t border-border/40 cursor-pointer transition
                          ${isSel ? 'bg-blue-950/30' : 'hover:bg-slate-800/40'}`}>
                        <td className="px-3 py-2">
                          <input type="checkbox" readOnly checked={isSel}
                            className="w-3 h-3 accent-blue-500 pointer-events-none" />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-semibold text-white">{r.symbol}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-400 hidden sm:table-cell">{r.sector || '—'}</td>
                        <td className="px-3 py-2 text-right text-white font-mono">₹{fmt(r.current_price, 1)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`font-mono ${(r.rsi || 50) < 35 ? 'text-emerald-400' : (r.rsi || 50) > 65 ? 'text-red-400' : 'text-slate-300'}`}>
                            {r.rsi != null ? r.rsi : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={`font-mono ${(r.ret_5d || 0) > 0 ? 'text-emerald-400' : (r.ret_5d || 0) < 0 ? 'text-red-400' : 'text-slate-300'}`}>
                            {r.ret_5d != null ? `${r.ret_5d > 0 ? '+' : ''}${r.ret_5d}%` : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">{dmaCell(r.above_50_dma)}</td>
                        <td className="px-3 py-2 text-center">{dmaCell(r.above_200_dma)}</td>
                        <td className="px-3 py-2 text-center">{macdCell(r.macd_bullish)}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`font-mono ${(r.consecutive_down_days || 0) >= 2 ? 'text-amber-400' : 'text-slate-400'}`}>
                            {r.consecutive_down_days ?? 0}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono hidden md:table-cell">
                          <span className={(r.pct_from_52w_high || 0) < -15 ? 'text-red-400' : 'text-slate-400'}>
                            {r.pct_from_52w_high != null ? `${r.pct_from_52w_high}%` : '—'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!screened && !loading && (
        <div className="text-center py-16 text-muted text-sm">
          Select filters above and click <span className="text-white font-medium">Screen ▶</span> to find stocks
        </div>
      )}
    </div>
  )
}

// ── Campaign Builder Modal ────────────────────────────────────────────────────

interface BuilderProps {
  selectedPicks: { pick: AIPick; allocation: number }[]
  selectedEtfs: { pick: ETFPick; allocation: number }[]
  onClose: () => void
  onCreated: () => void
}

function CampaignBuilderModal({ selectedPicks, selectedEtfs, onClose, onCreated }: BuilderProps) {
  const [name, setName]       = useState(`AI Campaign ${new Date().toLocaleDateString('en-IN')}`)
  const [fund, setFund]       = useState('')
  const [broker, setBroker]   = useState('angelone')
  const [autoTrade, setAutoTrade] = useState(false)
  const [entry, setEntry]     = useState<'immediately' | 'market_open' | 'manual'>('market_open')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')

  // Manual stock/ETF addition (tab: 'stock' | 'etf')
  const [manualStocks, setManualStocks] = useState<Array<{ symbol: string; name: string; sector: string; allocation: number }>>([])
  const [manualEtfs,   setManualEtfs]   = useState<Array<{ symbol: string; name: string; allocation: number }>>([])
  const [manualSelected, setManualSelected] = useState<{ symbol: string; name: string; sector: string } | null>(null)
  const [manualAlloc, setManualAlloc] = useState<string>('10')
  const [addType, setAddType] = useState<'stock' | 'etf'>('stock')
  const [manualOpen, setManualOpen] = useState(true)

  const handleAddManual = () => {
    if (!manualSelected) return
    const alloc = Math.max(1, Math.min(99, parseInt(manualAlloc, 10) || 10))
    if (addType === 'etf') {
      setManualEtfs(prev => {
        if (prev.find(s => s.symbol === manualSelected.symbol)) return prev
        return [...prev, { symbol: manualSelected.symbol, name: manualSelected.name, allocation: alloc }]
      })
    } else {
      setManualStocks(prev => {
        if (prev.find(s => s.symbol === manualSelected.symbol)) return prev
        return [...prev, { ...manualSelected, allocation: alloc }]
      })
    }
    setManualSelected(null)
    setManualAlloc('10')
  }

  const removeManual = (sym: string) =>
    setManualStocks(prev => prev.filter(s => s.symbol !== sym))
  const removeManualEtf = (sym: string) =>
    setManualEtfs(prev => prev.filter(s => s.symbol !== sym))

  // Split config — relevant when both stocks and ETFs are present (from any source)
  const hasAnyStocks = selectedPicks.length > 0 || manualStocks.length > 0
  const hasAnyEtfs   = selectedEtfs.length > 0  || manualEtfs.length > 0
  const hasMixed     = hasAnyStocks && hasAnyEtfs
  const [splitEnabled, setSplitEnabled] = useState(hasMixed)
  const [stocksPct, setStocksPct] = useState(50)

  // Broker & fund validation
  const [brokerInfo, setBrokerInfo] = useState<{ connected: boolean; balance: number | null; error: string }>({ connected: false, balance: null, error: '' })
  const [fundErr, setFundErr]   = useState('')
  const [loadingBal, setLoadingBal] = useState(false)

  // Chunk configuration
  const [numChunks, setNumChunks] = useState(2)
  const [chunkPcts, setChunkPcts] = useState([40, 40, 20, 20])
  const [avgTriggers, setAvgTriggers] = useState([-3.0, -5.0, -7.0])
  const [avgDays, setAvgDays] = useState([3, 3, 3])

  // Exit configuration
  const [profitTarget, setProfitTarget] = useState(2.0)
  const [trailGap, setTrailGap]         = useState(0.5)

  const fetchBalance = async (b: string) => {
    setLoadingBal(true); setBrokerInfo({ connected: false, balance: null, error: '' })
    try {
      const r = await api.get(`/stock-trader/broker-balance?broker=${b}`)
      if (r.connected) {
        setBrokerInfo({ connected: true, balance: r.balance, error: '' })
      } else {
        setBrokerInfo({ connected: false, balance: null, error: r.error || 'Not connected' })
      }
    } catch (e: any) {
      setBrokerInfo({ connected: false, balance: null, error: e.message })
    }
    setLoadingBal(false)
  }

  useEffect(() => { fetchBalance(broker) }, [broker])

  const handleFundChange = (val: string) => {
    setFund(val)
    const n = Number(val)
    if (!n || n <= 0) { setFundErr(''); return }
    if (brokerInfo.balance !== null && n > brokerInfo.balance) {
      setFundErr(`Insufficient funds. Available ₹${brokerInfo.balance.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`)
    } else {
      setFundErr('')
    }
  }

  const adjustNumChunks = (n: number) => {
    setNumChunks(n)
    // Keep existing pcts, fill defaults for new chunks
    const base = [40, 30, 20, 10]
    const newPcts = [...chunkPcts]
    while (newPcts.length < n) newPcts.push(base[newPcts.length] || 10)
    setChunkPcts(newPcts)
  }

  const totalChunkPct = chunkPcts.slice(0, numChunks).reduce((a, b) => a + b, 0)
  const bufferPct = 100 - totalChunkPct

  // Live allocation totals for validation feedback
  const stockAllocTotal = selectedPicks.reduce((a, { allocation }) => a + allocation, 0)
                        + manualStocks.reduce((a, s) => a + s.allocation, 0)
  const etfAllocTotal   = selectedEtfs.reduce((a, { allocation }) => a + allocation, 0)
                        + manualEtfs.reduce((a, s) => a + s.allocation, 0)
  const stockAllocOk = stockAllocTotal === 0 || (stockAllocTotal >= 99 && stockAllocTotal <= 101)
  const etfAllocOk   = etfAllocTotal   === 0 || (etfAllocTotal   >= 99 && etfAllocTotal   <= 101)
  const hasAnyItems  = stockAllocTotal > 0 || etfAllocTotal > 0

  const handleCreate = async () => {
    if (!fund || isNaN(Number(fund)) || Number(fund) <= 0) { setErr('Enter a valid fund amount'); return }
    if (fundErr) { setErr(fundErr); return }
    if (totalChunkPct > 100) { setErr(`Chunk percentages sum to ${totalChunkPct}%, must be ≤ 100%`); return }
    if (!hasAnyItems) { setErr('Add at least one stock or ETF'); return }
    if (!stockAllocOk) { setErr(`Stock allocations sum to ${stockAllocTotal}% — must be 100%`); return }
    if (!etfAllocOk)   { setErr(`ETF allocations sum to ${etfAllocTotal}% — must be 100%`); return }
    if (hasMixed && splitEnabled && (stocksPct < 10 || stocksPct > 90)) { setErr('Split must be between 10-90%'); return }
    setSaving(true); setErr('')
    try {
      const chunks: ChunkDef[] = Array.from({ length: numChunks }, (_, i) => ({
        n: i + 1,
        fund_pct: chunkPcts[i],
        ...(i > 0 ? { averaging_trigger_pct: avgTriggers[i - 1], min_hold_days: avgDays[i - 1] } : {}),
      }))
      const stocks = [
        ...selectedPicks.map(({ pick, allocation }) => ({
          symbol: pick.symbol, display: pick.symbol, sector: pick.sector,
          cap_type: pick.cap_type, allocation_pct: allocation,
          justification: pick.justification, conviction: pick.conviction,
          asset_type: 'stock',
        })),
        ...selectedEtfs.map(({ pick, allocation }) => ({
          symbol: pick.symbol, display: pick.symbol,
          sector: pick.etf_type || pick.theme || 'ETF',
          cap_type: 'ETF', allocation_pct: allocation,
          justification: pick.justification, conviction: pick.conviction,
          asset_type: 'etf',
        })),
        ...manualStocks.map(s => ({
          symbol: s.symbol, display: s.name || s.symbol, sector: s.sector,
          cap_type: '', allocation_pct: s.allocation,
          justification: 'Manually selected', conviction: 'MEDIUM',
          asset_type: 'stock',
        })),
        ...manualEtfs.map(s => ({
          symbol: s.symbol, display: s.name || s.symbol, sector: 'ETF',
          cap_type: 'ETF', allocation_pct: s.allocation,
          justification: 'Manually selected ETF', conviction: 'MEDIUM',
          asset_type: 'etf',
        })),
      ]
      const split_config = (hasMixed && splitEnabled)
        ? { stocks_pct: stocksPct, etfs_pct: 100 - stocksPct }
        : {}
      await api.post('/stock-trader/campaign', {
        name, broker,
        reserved_fund:   Number(fund),
        auto_trade:      autoTrade,
        entry_condition: { type: entry },
        chunk_config:    { chunks },
        exit_config:     { profit_target_pct: profitTarget, trailing_sl_gap_pct: trailGap },
        split_config,
        stocks,
      })
      onCreated()
    } catch (e: any) { setErr(e.response?.data?.error || e.message) }
    setSaving(false)
  }

  const fundNum = Number(fund)

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-border rounded-2xl w-full max-w-2xl shadow-2xl my-4">
        <div className="p-5 border-b border-border flex items-center justify-between">
          <div className="text-white font-semibold">Build Campaign</div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg">✕</button>
        </div>
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">

          {/* Selected stocks */}
          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Selected Stocks</div>
            <div className="flex flex-wrap gap-2">
              {selectedPicks.map(({ pick, allocation }) => (
                <div key={pick.symbol} className="flex items-center gap-1 bg-blue-950/60 border border-blue-700/30 rounded px-2 py-0.5 text-xs">
                  <span className="text-white">{pick.symbol}</span>
                  <span className="text-muted">{allocation}%</span>
                  {pick.prob_2pct_1w !== undefined && probBadge(pick.prob_2pct_1w)}
                </div>
              ))}
              {selectedPicks.length === 0 && <span className="text-muted text-xs">None selected</span>}
            </div>
          </div>

          {/* Selected ETFs */}
          {selectedEtfs.length > 0 && (
            <div className="bg-slate-800/60 rounded-lg p-3">
              <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Selected ETFs</div>
              <div className="flex flex-wrap gap-2">
                {selectedEtfs.map(({ pick, allocation }) => (
                  <div key={pick.symbol} className="flex items-center gap-1 bg-purple-950/60 border border-purple-700/30 rounded px-2 py-0.5 text-xs">
                    <span className="text-white">{pick.symbol}</span>
                    <span className={`text-[9px] px-1 py-0 rounded ${pick.screen_type === 'bounce' ? 'bg-amber-900/60 text-amber-300' : 'bg-emerald-900/60 text-emerald-300'}`}>
                      {pick.screen_type?.toUpperCase()}
                    </span>
                    <span className="text-muted">{allocation}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Allocation balance indicator */}
          {hasAnyItems && (
            <div className={`flex gap-3 rounded-lg px-3 py-2 text-xs border ${
              stockAllocOk && etfAllocOk
                ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-300'
                : 'bg-amber-900/20 border-amber-700/40 text-amber-300'
            }`}>
              {stockAllocTotal > 0 && (
                <span>
                  Stocks: <span className={`font-mono font-bold ${stockAllocOk ? 'text-emerald-400' : 'text-red-400'}`}>{stockAllocTotal}%</span>
                  {!stockAllocOk && <span className="text-red-400"> ← must be 100%</span>}
                </span>
              )}
              {stockAllocTotal > 0 && etfAllocTotal > 0 && <span className="text-slate-600">·</span>}
              {etfAllocTotal > 0 && (
                <span>
                  ETFs: <span className={`font-mono font-bold ${etfAllocOk ? 'text-purple-400' : 'text-red-400'}`}>{etfAllocTotal}%</span>
                  {!etfAllocOk && <span className="text-red-400"> ← must be 100%</span>}
                </span>
              )}
              {stockAllocOk && etfAllocOk && <span className="ml-auto">✓ Allocations balanced</span>}
            </div>
          )}

          {/* Split config — shown when both asset classes present */}
          {hasMixed && (
            <div className="border border-purple-700/40 bg-purple-950/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="splitEn" checked={splitEnabled} onChange={e => setSplitEnabled(e.target.checked)}
                  className="w-4 h-4 accent-purple-500" />
                <label htmlFor="splitEn" className="text-xs font-semibold text-purple-300 cursor-pointer">
                  Mixed Portfolio — set stock/ETF fund split
                </label>
              </div>
              {splitEnabled && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-blue-300 w-20">Stocks: {stocksPct}%</span>
                    <input type="range" min={10} max={90} step={5} value={stocksPct}
                      onChange={e => setStocksPct(Number(e.target.value))}
                      className="flex-1 accent-blue-500" />
                    <span className="text-xs text-purple-300 w-20 text-right">ETFs: {100 - stocksPct}%</span>
                  </div>
                  {fund && Number(fund) > 0 && (
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="bg-blue-950/40 rounded p-2 text-center">
                        <div className="text-muted">Stocks Fund</div>
                        <div className="text-blue-300 font-mono font-semibold mt-0.5">
                          ₹{(Number(fund) * stocksPct / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </div>
                      </div>
                      <div className="bg-purple-950/40 rounded p-2 text-center">
                        <div className="text-muted">ETFs Fund</div>
                        <div className="text-purple-300 font-mono font-semibold mt-0.5">
                          ₹{(Number(fund) * (100 - stocksPct) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!splitEnabled && (
                <p className="text-[10px] text-slate-400">Without split config, all items share the same fund pool. Enable above to set separate envelopes.</p>
              )}
            </div>
          )}

          {/* Campaign name */}
          <div>
            <label className="text-xs text-muted mb-1 block">Campaign Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white" />
          </div>

          {/* ── Broker & Fund ─────────────────────────────────────────────── */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-white uppercase tracking-wider">Broker & Fund</div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted mb-1 block">Broker</label>
                <select value={broker} onChange={e => setBroker(e.target.value)}
                  className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white">
                  <option value="angelone">Angel One</option>
                  <option value="kotak">Kotak Neo</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Broker Status</label>
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs
                  ${brokerInfo.connected ? 'border-emerald-600/50 bg-emerald-900/20 text-emerald-300'
                  : 'border-red-600/50 bg-red-900/20 text-red-400'}`}>
                  {loadingBal ? '⟳ Checking…' : brokerInfo.connected
                    ? `✓ Connected · ₹${(brokerInfo.balance ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} avail.`
                    : `✗ ${brokerInfo.error || 'Not connected'}`}
                </div>
              </div>
            </div>

            {!brokerInfo.connected && !loadingBal && (
              <p className="text-[10px] text-amber-400">Connect broker in Settings first to enable live trading.</p>
            )}

            <div>
              <label className="text-xs text-muted mb-1 block">Reserved Fund (₹)</label>
              <input type="number" value={fund} onChange={e => handleFundChange(e.target.value)}
                placeholder="e.g. 100000"
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm text-white
                  ${fundErr ? 'border-red-500' : 'border-border'}`} />
              {fundErr && <p className="text-red-400 text-[10px] mt-1">{fundErr}</p>}
              {brokerInfo.connected && fund && !fundErr && fundNum > 0 && (
                <p className="text-emerald-400 text-[10px] mt-1">
                  ✓ Funds available. Buffer after deployment: ₹{((brokerInfo.balance ?? 0) - fundNum).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </p>
              )}
            </div>
          </div>

          {/* ── Chunk Configuration ──────────────────────────────────────── */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-white uppercase tracking-wider">Chunk Configuration</div>
              <div className="flex gap-1">
                {[2, 3, 4].map(n => (
                  <button key={n} onClick={() => adjustNumChunks(n)}
                    className={`px-2.5 py-1 text-xs rounded transition ${numChunks === n ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                    {n} Chunks
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {Array.from({ length: numChunks }, (_, i) => (
                <div key={i} className="bg-slate-800/60 rounded-lg p-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                      i === 0 ? 'bg-blue-900/60 text-blue-300'
                      : i === 1 ? 'bg-purple-900/60 text-purple-300'
                      : i === 2 ? 'bg-indigo-900/60 text-indigo-300'
                      : 'bg-violet-900/60 text-violet-300'}`}>
                      Chunk {i + 1}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number" min={1} max={99} step={1}
                        value={chunkPcts[i]}
                        onChange={e => { const p = [...chunkPcts]; p[i] = Number(e.target.value); setChunkPcts(p) }}
                        className="w-14 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white"
                      />
                      <span className="text-xs text-muted">% of reserved</span>
                      {fund && fundNum > 0 && (
                        <span className="text-[10px] text-slate-400 font-mono">
                          = ₹{(fundNum * chunkPcts[i] / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </span>
                      )}
                    </div>
                    {i === 0 && <span className="text-[10px] text-slate-400">Deployed at entry condition</span>}
                    {i > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-slate-400">
                        <span>Average when stock falls</span>
                        <input
                          type="number" min={-30} max={-1} step={0.5}
                          value={avgTriggers[i - 1]}
                          onChange={e => { const t = [...avgTriggers]; t[i-1] = Number(e.target.value); setAvgTriggers(t) }}
                          className="w-16 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white"
                        />
                        <span>% from prev buy after</span>
                        <input
                          type="number" min={1} max={30} step={1}
                          value={avgDays[i - 1]}
                          onChange={e => { const d = [...avgDays]; d[i-1] = Number(e.target.value); setAvgDays(d) }}
                          className="w-12 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white"
                        />
                        <span>days</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className={`text-[10px] flex gap-3 ${totalChunkPct > 100 ? 'text-red-400' : 'text-slate-400'}`}>
              <span>Total chunks: <span className="font-mono text-white">{totalChunkPct}%</span></span>
              <span>Buffer remaining: <span className={`font-mono ${bufferPct < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{bufferPct}%</span></span>
              {bufferPct < 0 && <span className="text-red-400">Reduce chunk %s</span>}
            </div>
          </div>

          {/* ── Exit Configuration ───────────────────────────────────────── */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-white uppercase tracking-wider">Exit Configuration</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted mb-1 block">Start Trailing SL at profit of</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0.5} max={20} step={0.5} value={profitTarget}
                    onChange={e => setProfitTarget(Number(e.target.value))}
                    className="w-20 text-center bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-sm text-white" />
                  <span className="text-sm text-muted">%</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Trailing SL gap (below current)</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0.1} max={5} step={0.1} value={trailGap}
                    onChange={e => setTrailGap(Number(e.target.value))}
                    className="w-20 text-center bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-sm text-white" />
                  <span className="text-sm text-muted">%</span>
                </div>
              </div>
            </div>
            <div className="bg-slate-800/60 rounded-lg p-2.5 text-[10px] text-slate-400 space-y-0.5">
              <div>SL activates once stock reaches <span className="text-emerald-400">+{profitTarget}%</span> profit</div>
              <div>SL price = current price × {(1 - trailGap / 100).toFixed(3)}, ratchets up as price rises</div>
              <div>Minimum locked profit = <span className="text-emerald-400">+{(profitTarget - trailGap).toFixed(1)}%</span> (if exited at SL trigger)</div>
              <div className="text-amber-400">No loss booking — if stock falls before target, next chunk averages the position.</div>
            </div>
          </div>

          {/* Entry condition */}
          <div>
            <label className="text-xs text-muted mb-1 block">Entry Condition for Chunk 1</label>
            <select value={entry} onChange={e => setEntry(e.target.value as typeof entry)}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white">
              <option value="market_open">Next Market Open (9:15 AM IST)</option>
              <option value="immediately">Immediately on Activation</option>
              <option value="manual">Manual Trigger Only</option>
            </select>
          </div>

          {/* Auto-trade toggle */}
          <div className="flex items-start gap-3 bg-amber-900/20 border border-amber-700/30 rounded-lg p-3">
            <input type="checkbox" id="at" checked={autoTrade} onChange={e => setAutoTrade(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-amber-500" />
            <label htmlFor="at" className="text-xs text-amber-300 cursor-pointer">
              <span className="font-semibold">Enable Auto-Trade (Live Orders)</span>
              <p className="text-amber-400/70 mt-0.5">
                {brokerInfo.connected
                  ? `Will place real orders via ${broker}. Ensure ₹${Number(fund || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} is reserved and internet is stable.`
                  : 'Broker not connected — auto-trade will be disabled until broker is connected.'}
              </p>
            </label>
          </div>

          {err && <div className="text-red-400 text-xs bg-red-900/20 rounded p-2">{err}</div>}
        </div>

        {/* ── Manual Add Section — OUTSIDE overflow-y-auto so dropdown is not clipped ── */}
        <div className="px-5 py-3 border-t border-border/60 bg-slate-900/80">
          <button onClick={() => setManualOpen(o => !o)}
            className="w-full flex items-center justify-between text-sm font-semibold text-blue-300 hover:text-blue-200 transition">
            <span>+ Add Stocks / ETFs Manually</span>
            <span className="text-blue-500/60 text-xs">{manualOpen ? '▲' : '▼'}</span>
          </button>
          {manualOpen && (
            <div className="mt-3 space-y-3">
              {/* Stock / ETF type tab */}
              <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1 w-fit">
                {(['stock', 'etf'] as const).map(t => (
                  <button key={t} onClick={() => { setAddType(t); setManualSelected(null) }}
                    className={`px-3 py-1 text-xs rounded transition ${addType === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                    {t === 'stock' ? '📈 Stock' : '🏦 ETF'}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 items-end">
                <div className="flex-1 relative" style={{ zIndex: 200 }}>
                  <NseStockSearch
                    placeholder={addType === 'etf' ? 'Search ETF (e.g. NIFTYBEES, GOLDBEES…)' : 'Search NSE stock (e.g. HDFC, Reliance…)'}
                    includeEtfIndex={addType === 'etf'}
                    onSelect={(sym, name, sector) => setManualSelected({ symbol: sym.replace('.NS', ''), name, sector: sector || '' })}
                  />
                  {manualSelected && (
                    <div className="text-[10px] text-emerald-400 mt-1">✓ {manualSelected.symbol} — {manualSelected.name}</div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted">Alloc %</label>
                  <input type="number" min={1} max={99} value={manualAlloc}
                    onChange={e => setManualAlloc(e.target.value)}
                    className="w-20 text-center bg-slate-800 border border-border rounded-lg px-2 py-2 text-sm text-white" />
                </div>
                <button onClick={handleAddManual} disabled={!manualSelected}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg transition self-end">
                  Add
                </button>
              </div>
              {/* Added stocks chips */}
              {manualStocks.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {manualStocks.map(s => (
                    <div key={s.symbol} className="flex items-center gap-1 bg-blue-950/60 border border-blue-700/30 rounded px-2 py-0.5 text-xs">
                      <span className="text-white font-semibold">{s.symbol}</span>
                      <span className="text-blue-400 font-mono">{s.allocation}%</span>
                      <button onClick={() => removeManual(s.symbol)} className="text-slate-500 hover:text-red-400 transition">✕</button>
                    </div>
                  ))}
                  <span className="text-[10px] text-slate-500 self-center">Stocks total: {manualStocks.reduce((a, s) => a + s.allocation, 0)}%</span>
                </div>
              )}
              {/* Added ETF chips */}
              {manualEtfs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {manualEtfs.map(s => (
                    <div key={s.symbol} className="flex items-center gap-1 bg-purple-950/60 border border-purple-700/30 rounded px-2 py-0.5 text-xs">
                      <span className="text-white font-semibold">{s.symbol}</span>
                      <span className="text-purple-400 font-mono">{s.allocation}%</span>
                      <button onClick={() => removeManualEtf(s.symbol)} className="text-slate-500 hover:text-red-400 transition">✕</button>
                    </div>
                  ))}
                  <span className="text-[10px] text-slate-500 self-center">ETFs total: {manualEtfs.reduce((a, s) => a + s.allocation, 0)}%</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-border flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-sm text-white rounded-lg">Cancel</button>
          <button onClick={handleCreate} disabled={saving || !!fundErr || totalChunkPct > 100 || !stockAllocOk || !etfAllocOk || !hasAnyItems}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold rounded-lg">
            {saving ? 'Creating…' : 'Create Campaign'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Broker Session Banner ─────────────────────────────────────────────────────

function BrokerSessionBanner({ campaign, onReset }: { campaign: Campaign; onReset: () => void }) {
  const errorStocks = campaign.stocks.filter(s => s.status === 'error')
  const SESSION_PHRASES = ['session', 'expired', 'no response', 'unauthorized', 'reconnect', 'token']
  const isBrokerError = errorStocks.length > 0 && errorStocks.every(s => {
    const e = ((s as any).error || '').toLowerCase()
    return SESSION_PHRASES.some(p => e.includes(p))
  })

  const [resetting, setResetting] = useState(false)

  if (!isBrokerError) return null

  const handleReset = async () => {
    setResetting(true)
    try {
      await api.post(`/stock-trader/campaign/${campaign.id}/reset-errors`, {})
      onReset()
    } catch {}
    setResetting(false)
  }

  return (
    <div className="mx-4 my-2 flex items-center gap-3 bg-amber-900/20 border border-amber-700/40 rounded-lg px-4 py-2.5 text-xs">
      <span className="text-amber-400 text-lg flex-shrink-0">⚠</span>
      <div className="flex-1 text-amber-300">
        <span className="font-semibold">Broker session expired</span>
        <span className="text-amber-400/80"> — Angel One session timed out. Go to Settings → reconnect, then reset this campaign to retry.</span>
      </div>
      <a href="/settings" className="flex-shrink-0 px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded transition text-[10px]">
        Settings
      </a>
      <button onClick={handleReset} disabled={resetting}
        className="flex-shrink-0 px-2.5 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded transition text-[10px] font-semibold whitespace-nowrap">
        {resetting ? 'Resetting…' : 'Reset & Retry'}
      </button>
    </div>
  )
}

// ── Stocks Table (per-row edit + delete) ──────────────────────────────────────

const EDITABLE_STATUSES = new Set(['watching', 'exited', 'error'])
const HAS_POSITION = (s: CampaignStock) => !!s.total_qty && s.total_qty > 0

interface CampaignStock {
  symbol: string; allocation_pct: number; status: string
  total_qty?: number; avg_price?: number; current_price?: number
  pnl?: number; pnl_pct?: number; sl_price?: number
  booked_pnl?: number; exit_price?: number; error?: string
}

function StocksTable({ campaign, onRefresh }: { campaign: Campaign; onRefresh: () => void }) {
  const [editingSymbol,     setEditingSymbol]     = useState<string | null>(null)
  const [editAlloc,         setEditAlloc]         = useState('')
  const [editStatus,        setEditStatus]        = useState('')
  const [savingSymbol,      setSavingSymbol]      = useState<string | null>(null)
  const [deleteTarget,      setDeleteTarget]      = useState<string | null>(null)
  const [deleting,          setDeleting]          = useState(false)
  const [editingAllocFor,   setEditingAllocFor]   = useState<string | null>(null)
  const [inlineAlloc,       setInlineAlloc]       = useState('')
  const [savingAlloc,       setSavingAlloc]       = useState<string | null>(null)

  const startEdit = (s: CampaignStock) => {
    setEditingSymbol(s.symbol)
    setEditAlloc(String(s.allocation_pct))
    setEditStatus(s.status)
  }

  const cancelEdit = () => { setEditingSymbol(null); setEditAlloc(''); setEditStatus('') }

  const startAllocEdit = (s: CampaignStock) => {
    setEditingAllocFor(s.symbol)
    setInlineAlloc(String(s.allocation_pct))
  }

  const saveAllocInline = async (sym: string) => {
    const val = Number(inlineAlloc)
    if (!val || val < 1 || val > 100) { setEditingAllocFor(null); return }
    setSavingAlloc(sym)
    try {
      await api.patch(`/stock-trader/campaign/${campaign.id}/stock/${sym}`, { allocation_pct: val })
      onRefresh()
    } catch {}
    setSavingAlloc(null)
    setEditingAllocFor(null)
  }

  const saveEdit = async (sym: string) => {
    setSavingSymbol(sym)
    try {
      await api.patch(`/stock-trader/campaign/${campaign.id}/stock/${sym}`, { status: editStatus })
      onRefresh()
      cancelEdit()
    } catch {}
    setSavingSymbol(null)
  }

  const confirmDelete = async (sym: string) => {
    setDeleting(true)
    try {
      await api.delete(`/stock-trader/campaign/${campaign.id}/stock/${sym}`)
      onRefresh()
      setDeleteTarget(null)
    } catch {}
    setDeleting(false)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/30 text-muted text-left">
            <th className="px-4 py-2">Stock</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2 text-right">Qty</th>
            <th className="px-4 py-2 text-right">Avg Cost</th>
            <th className="px-4 py-2 text-right">CMP</th>
            <th className="px-4 py-2 text-right">P&L</th>
            <th className="px-4 py-2 text-right">SL</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {campaign.stocks.map((s, i) => {
            const isEditing  = editingSymbol === s.symbol
            const isDeleting = deleteTarget === s.symbol
            const hasPos     = HAS_POSITION(s)

            return (
              <tr key={i} className={`border-b border-border/20 group transition ${isEditing ? 'bg-slate-700/30' : 'hover:bg-slate-700/20'}`}>
                {/* Stock name */}
                <td className="px-4 py-2">
                  <div className="font-semibold text-white">{s.symbol}</div>
                  {editingAllocFor === s.symbol ? (
                    <div className="flex items-center gap-1 mt-1">
                      <input
                        type="number" min={1} max={100} step={1}
                        value={inlineAlloc}
                        onChange={e => setInlineAlloc(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveAllocInline(s.symbol); if (e.key === 'Escape') setEditingAllocFor(null) }}
                        onBlur={() => saveAllocInline(s.symbol)}
                        autoFocus
                        className="w-14 text-center text-xs bg-slate-700 border border-blue-500 rounded px-1 py-0.5 text-white focus:outline-none" />
                      <span className="text-[9px] text-muted">%</span>
                      {savingAlloc === s.symbol && <span className="text-[9px] text-muted">…</span>}
                    </div>
                  ) : (
                    <div
                      className="text-[9px] text-blue-400 hover:text-blue-300 cursor-pointer underline decoration-dotted mt-0.5 w-fit"
                      title="Click to edit allocation"
                      onClick={() => startAllocEdit(s)}>
                      {s.allocation_pct}% alloc
                    </div>
                  )}
                </td>

                {/* Status */}
                <td className="px-4 py-2">
                  {isEditing ? (
                    <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                      className="text-[10px] bg-slate-700 border border-border rounded px-1 py-0.5 text-white">
                      <option value="watching">Watching</option>
                      <option value="c1_placed">C1 Placed</option>
                      <option value="c2_placed">C2 Placed</option>
                      <option value="c3_placed">C3 Placed</option>
                      <option value="c4_placed">C4 Placed</option>
                      <option value="trailing_sl">Trailing SL</option>
                      <option value="exited">Exited</option>
                      <option value="error">Error</option>
                    </select>
                  ) : (
                    <>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_COLOR[s.status] || 'bg-slate-700 text-slate-400'}`}>
                        {STATUS_LABEL[s.status] || s.status}
                      </span>
                      {s.error && <div className="text-red-400 text-[9px] mt-0.5">{s.error}</div>}
                    </>
                  )}
                </td>

                <td className="px-4 py-2 text-right text-slate-300">{s.total_qty || '–'}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-300">
                  {s.avg_price ? `₹${fmt(s.avg_price)}` : '–'}
                </td>
                <td className="px-4 py-2 text-right font-mono text-white">
                  {s.current_price ? `₹${fmt(s.current_price)}` : '–'}
                </td>
                <td className="px-4 py-2 text-right">
                  {s.pnl !== undefined && s.pnl !== 0 ? (
                    <div className={pnlClass(s.pnl)}>
                      <div>{s.pnl >= 0 ? '+' : ''}₹{Math.abs(s.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      <div className="text-[9px] font-mono">{s.pnl_pct! >= 0 ? '+' : ''}{fmt(s.pnl_pct!)}%</div>
                    </div>
                  ) : s.status === 'exited' && s.booked_pnl ? (
                    <div className={pnlClass(s.booked_pnl)}>
                      <div>Booked {s.booked_pnl >= 0 ? '+' : ''}₹{Math.abs(s.booked_pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      {s.exit_price && <div className="text-[9px] text-muted">@ ₹{fmt(s.exit_price)}</div>}
                    </div>
                  ) : '–'}
                </td>
                <td className="px-4 py-2 text-right font-mono text-amber-400 text-[10px]">
                  {s.sl_price ? `₹${fmt(s.sl_price)}` : '–'}
                </td>

                {/* Actions */}
                <td className="px-3 py-2 text-right">
                  {isEditing ? (
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => saveEdit(s.symbol)} disabled={savingSymbol === s.symbol}
                        className="text-[10px] px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50 transition">
                        {savingSymbol === s.symbol ? '…' : '✓'}
                      </button>
                      <button onClick={cancelEdit}
                        className="text-[10px] px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded transition">
                        ✕
                      </button>
                    </div>
                  ) : isDeleting ? (
                    <div className="flex items-center justify-end gap-1 flex-wrap">
                      {hasPos && (
                        <span className="text-[9px] text-amber-400 block w-full text-right">Has open position</span>
                      )}
                      <button onClick={() => confirmDelete(s.symbol)} disabled={deleting}
                        className="text-[10px] px-2 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50 transition">
                        {deleting ? '…' : 'Remove'}
                      </button>
                      <button onClick={() => setDeleteTarget(null)}
                        className="text-[10px] px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded transition">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
                      <button onClick={() => startEdit(s)} title="Edit allocation / status"
                        className="text-[10px] px-1.5 py-0.5 text-slate-400 hover:text-white hover:bg-slate-600 rounded transition">
                        ✎
                      </button>
                      <button onClick={() => setDeleteTarget(s.symbol)} title="Remove from campaign"
                        className="text-[10px] px-1.5 py-0.5 text-red-500 hover:text-red-300 hover:bg-red-900/30 rounded transition">
                        🗑
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Edit Campaign Modal ───────────────────────────────────────────────────────

interface EditProps { campaign: Campaign; onClose: () => void; onSaved: () => void }

function EditCampaignModal({ campaign, onClose, onSaved }: EditProps) {
  const existing_cc = (campaign.chunk_config as any) || {}
  const existing_chunks: any[] = existing_cc.chunks || []
  const defaultNumChunks = existing_chunks.length || 2
  const defaultPcts  = existing_chunks.length ? existing_chunks.map((c: any) => c.fund_pct ?? 40)  : [40, 40, 20, 20]
  const defaultTrig  = existing_chunks.slice(1).map((c: any) => c.averaging_trigger_pct ?? -3.0)
  const defaultDays  = existing_chunks.slice(1).map((c: any) => c.min_hold_days ?? 3)
  const existing_ec  = (campaign.exit_config as any) || {}

  const [name, setName]           = useState(campaign.name)
  const [fund, setFund]           = useState(String(campaign.reserved_fund))
  const [entry, setEntry]         = useState<'immediately' | 'market_open' | 'manual'>(
    (campaign.entry_condition?.type as any) || 'market_open'
  )
  const [saving,    setSaving]    = useState(false)
  const [err,       setErr]       = useState('')

  const [brokerInfo, setBrokerInfo] = useState<{ connected: boolean; balance: number | null; error: string }>({ connected: false, balance: null, error: '' })
  const [fundErr,   setFundErr]   = useState('')
  const [loadingBal, setLoadingBal] = useState(false)

  const [numChunks,   setNumChunks]   = useState(defaultNumChunks)
  const [chunkPcts,   setChunkPcts]   = useState<number[]>(defaultPcts)
  const [avgTriggers, setAvgTriggers] = useState<number[]>(defaultTrig.length ? defaultTrig : [-3.0, -5.0, -7.0])
  const [avgDays,     setAvgDays]     = useState<number[]>(defaultDays.length ? defaultDays : [3, 3, 3])

  const [profitTarget, setProfitTarget] = useState<number>(existing_ec.profit_target_pct ?? 2.0)
  const [trailGap,     setTrailGap]     = useState<number>(existing_ec.trailing_sl_gap_pct ?? 0.5)

  useEffect(() => {
    setLoadingBal(true)
    api.get(`/stock-trader/broker-balance?broker=${campaign.broker}`)
      .then(r => setBrokerInfo(r.connected ? { connected: true, balance: r.balance, error: '' } : { connected: false, balance: null, error: r.error || 'Not connected' }))
      .catch(e => setBrokerInfo({ connected: false, balance: null, error: e.message }))
      .finally(() => setLoadingBal(false))
  }, [campaign.broker])

  const handleFundChange = (val: string) => {
    setFund(val)
    const n = Number(val)
    if (!n || n <= 0) { setFundErr(''); return }
    if (brokerInfo.balance !== null && n > brokerInfo.balance) {
      setFundErr(`Insufficient funds. Available ₹${brokerInfo.balance.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`)
    } else setFundErr('')
  }

  const adjustNumChunks = (n: number) => {
    setNumChunks(n)
    const base = [40, 30, 20, 10]
    const newPcts = [...chunkPcts]
    while (newPcts.length < n) newPcts.push(base[newPcts.length] || 10)
    setChunkPcts(newPcts)
  }

  const totalChunkPct = chunkPcts.slice(0, numChunks).reduce((a, b) => a + b, 0)

  const handleSave = async () => {
    if (!fund || isNaN(Number(fund)) || Number(fund) <= 0) { setErr('Enter a valid fund amount'); return }
    if (fundErr) { setErr(fundErr); return }
    if (totalChunkPct > 100) { setErr(`Chunk %s sum to ${totalChunkPct}%, must be ≤ 100%`); return }
    setSaving(true); setErr('')
    try {
      const chunks: ChunkDef[] = Array.from({ length: numChunks }, (_, i) => ({
        n: i + 1, fund_pct: chunkPcts[i],
        ...(i > 0 ? { averaging_trigger_pct: avgTriggers[i - 1], min_hold_days: avgDays[i - 1] } : {}),
      }))
      await api.patch(`/stock-trader/campaign/${campaign.id}`, {
        name, reserved_fund: Number(fund),
        entry_condition: { type: entry },
        chunk_config: { chunks },
        exit_config: { profit_target_pct: profitTarget, trailing_sl_gap_pct: trailGap },
      })
      onSaved()
    } catch (e: any) { setErr(e.message) }
    setSaving(false)
  }

  const fundNum = Number(fund)

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-border rounded-2xl w-full max-w-2xl shadow-2xl my-4">
        <div className="p-5 border-b border-border flex items-center justify-between">
          <div className="text-white font-semibold">Edit Campaign</div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg">✕</button>
        </div>
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">

          <div>
            <label className="text-xs text-muted mb-1 block">Campaign Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white" />
          </div>

          {/* Fund */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-white uppercase tracking-wider">Broker & Fund</div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs w-fit
              border-emerald-600/50 bg-emerald-900/20">
              {loadingBal ? <span className="text-slate-400">⟳ Checking…</span> :
                brokerInfo.connected
                  ? <span className="text-emerald-300">✓ {campaign.broker} · ₹{(brokerInfo.balance ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} avail.</span>
                  : <span className="text-red-400">✗ {brokerInfo.error || 'Not connected'}</span>
              }
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Reserved Fund (₹)</label>
              <input type="number" value={fund} onChange={e => handleFundChange(e.target.value)}
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-sm text-white ${fundErr ? 'border-red-500' : 'border-border'}`} />
              {fundErr && <p className="text-red-400 text-[10px] mt-1">{fundErr}</p>}
            </div>
          </div>

          {/* Chunks */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-white uppercase tracking-wider">Chunk Configuration</div>
              <div className="flex gap-1">
                {[2, 3, 4].map(n => (
                  <button key={n} onClick={() => adjustNumChunks(n)}
                    className={`px-2.5 py-1 text-xs rounded transition ${numChunks === n ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {Array.from({ length: numChunks }, (_, i) => (
                <div key={i} className="bg-slate-800/60 rounded-lg p-3 flex items-center gap-3 flex-wrap text-xs">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    i === 0 ? 'bg-blue-900/60 text-blue-300' : i === 1 ? 'bg-purple-900/60 text-purple-300'
                    : i === 2 ? 'bg-indigo-900/60 text-indigo-300' : 'bg-violet-900/60 text-violet-300'}`}>
                    C{i + 1}
                  </span>
                  <input type="number" min={1} max={99} step={1} value={chunkPcts[i]}
                    onChange={e => { const p = [...chunkPcts]; p[i] = Number(e.target.value); setChunkPcts(p) }}
                    className="w-14 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white" />
                  <span className="text-muted">%</span>
                  {fund && fundNum > 0 && <span className="text-slate-400 font-mono text-[10px]">= ₹{(fundNum * chunkPcts[i] / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>}
                  {i > 0 && <>
                    <span className="text-slate-400 text-[10px]">avg when</span>
                    <input type="number" min={-30} max={-1} step={0.5} value={avgTriggers[i-1]}
                      onChange={e => { const t = [...avgTriggers]; t[i-1] = Number(e.target.value); setAvgTriggers(t) }}
                      className="w-16 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white" />
                    <span className="text-slate-400 text-[10px]">% after</span>
                    <input type="number" min={1} max={30} step={1} value={avgDays[i-1]}
                      onChange={e => { const d = [...avgDays]; d[i-1] = Number(e.target.value); setAvgDays(d) }}
                      className="w-12 text-center text-xs bg-slate-700 border border-border rounded px-1 py-1 text-white" />
                    <span className="text-slate-400 text-[10px]">days</span>
                  </>}
                </div>
              ))}
            </div>
            <div className={`text-[10px] text-slate-400 ${totalChunkPct > 100 ? 'text-red-400' : ''}`}>
              Total: {totalChunkPct}% &nbsp;·&nbsp; Buffer: {100 - totalChunkPct}%
            </div>
          </div>

          {/* Exit config */}
          <div className="border border-border rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-white uppercase tracking-wider">Exit Configuration</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted mb-1 block">Trailing SL activates at</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0.5} max={20} step={0.5} value={profitTarget}
                    onChange={e => setProfitTarget(Number(e.target.value))}
                    className="w-20 text-center bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-sm text-white" />
                  <span className="text-sm text-muted">% profit</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">SL gap below current price</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0.1} max={5} step={0.1} value={trailGap}
                    onChange={e => setTrailGap(Number(e.target.value))}
                    className="w-20 text-center bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-sm text-white" />
                  <span className="text-sm text-muted">%</span>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-slate-400">
              Min locked profit when SL triggers: <span className="text-emerald-400 font-mono">+{(profitTarget - trailGap).toFixed(1)}%</span>
            </p>
          </div>

          {/* Entry condition */}
          <div>
            <label className="text-xs text-muted mb-1 block">Entry Condition (Chunk 1)</label>
            <select value={entry} onChange={e => setEntry(e.target.value as typeof entry)}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white">
              <option value="market_open">Next Market Open (9:15 AM IST)</option>
              <option value="immediately">Immediately on Activation</option>
              <option value="manual">Manual Trigger Only</option>
            </select>
          </div>

          {err && <div className="text-red-400 text-xs bg-red-900/20 rounded p-2">{err}</div>}
        </div>
        <div className="p-5 border-t border-border flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-sm text-white rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={saving || !!fundErr || totalChunkPct > 100}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold rounded-lg">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Campaign Card ─────────────────────────────────────────────────────────────

function AddStockRow({ campaign, onRefresh }: { campaign: Campaign; onRefresh: () => void }) {
  const [open,       setOpen]       = useState(false)
  const [pick,       setPick]       = useState<{ symbol: string; name: string; sector: string } | null>(null)
  const [alloc,      setAlloc]      = useState('10')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  const isEtf = pick?.sector === 'ETF'

  const submit = async () => {
    if (!pick) return
    const allocNum = Number(alloc)
    if (!allocNum || allocNum < 1 || allocNum > 100) { setError('Allocation must be 1–100%'); return }
    setSaving(true); setError('')
    try {
      await api.post(`/stock-trader/campaign/${campaign.id}/stock`, {
        symbol:         pick.symbol.replace('.NS', ''),
        display:        pick.name || pick.symbol,
        sector:         pick.sector || '',
        allocation_pct: allocNum,
        asset_type:     isEtf ? 'etf' : 'stock',
        conviction:     'MEDIUM',
        justification:  'Manually added',
      })
      onRefresh()
      setPick(null); setAlloc('10'); setOpen(false)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to add stock')
    }
    setSaving(false)
  }

  if (!open) return (
    <div className="px-4 pb-3">
      <button onClick={() => setOpen(true)}
        className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/50 hover:border-blue-600 rounded-lg px-3 py-1.5 transition">
        + Add Stock / ETF
      </button>
    </div>
  )

  return (
    <div className="mx-4 mb-3 p-3 bg-slate-800/60 border border-border rounded-xl">
      <div className="text-xs font-semibold text-slate-300 mb-2">Add Stock or ETF</div>
      <NseStockSearch
        includeEtfIndex
        onSelect={(sym, name, sector) => { setPick({ symbol: sym, name, sector: sector || '' }); setError('') }}
        placeholder="Search NSE symbol…"
      />
      {pick && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-slate-400">Allocation</span>
          <input type="number" min={1} max={100} value={alloc}
            onChange={e => setAlloc(e.target.value)}
            className="w-16 text-center text-xs bg-slate-700 border border-border rounded px-2 py-1 text-white focus:border-blue-500 focus:outline-none" />
          <span className="text-xs text-muted">%</span>
          <button onClick={submit} disabled={saving}
            className="ml-auto px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded-lg transition font-medium">
            {saving ? '…' : 'Add'}
          </button>
          <button onClick={() => { setOpen(false); setPick(null); setError('') }}
            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-xs text-slate-300 rounded-lg transition">
            Cancel
          </button>
        </div>
      )}
      {!pick && (
        <button onClick={() => { setOpen(false); setError('') }}
          className="mt-2 text-xs text-muted hover:text-slate-300">
          Cancel
        </button>
      )}
      {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
    </div>
  )
}

function CampaignCard({ campaign, onRefresh }: { campaign: Campaign; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(true)
  const [running,  setRunning]  = useState(false)
  const [log,      setLog]      = useState<TradeLog[]>([])
  const [showLog,  setShowLog]  = useState(false)
  const [toggling, setToggling] = useState(false)
  const [lastActions, setLastActions] = useState<string[]>([])
  const [showEdit,    setShowEdit]    = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [preview,     setPreview]     = useState<any>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  const totalPnl      = campaign.stocks.reduce((s, x) => s + (x.pnl || 0), 0)
  const bookedPnl     = campaign.stocks.reduce((s, x) => s + (x.booked_pnl || 0), 0)
  const activeStocks  = campaign.stocks.filter(s => !['watching', 'exited', 'error'].includes(s.status))
  const exitedStocks  = campaign.stocks.filter(s => s.status === 'exited')

  const fetchPreview = async () => {
    setLoadingPreview(true)
    setPreview(null)
    try {
      const r = await api.get(`/stock-trader/campaign/${campaign.id}/order-preview`)
      setPreview(r)
    } catch (e: any) {
      setPreview({ error: e.response?.data?.error || e.message })
    }
    setLoadingPreview(false)
  }

  const runAgent = async () => {
    setRunning(true)
    try {
      const r = await api.post(`/stock-trader/campaign/${campaign.id}/run`, {})
      if (r.error === 'broker_session_expired') {
        setLastActions([`⚠ Broker session expired — reconnect in Settings then retry`])
      } else if (r.error) {
        setLastActions([`⚠ ${r.error}`])
      } else if (r.message && !r.actions?.length) {
        setLastActions([r.message])
      } else {
        const actions = (r.actions || []).map((a: any) =>
          typeof a === 'string' ? a : `${a.action}${a.symbol ? ' ' + a.symbol : ''}${a.pnl_pct != null ? ` (${a.pnl_pct > 0 ? '+' : ''}${a.pnl_pct}%)` : ''}`
        )
        setLastActions(actions.length ? actions : ['No actions taken'])
      }
      onRefresh()
    } catch (e: any) {
      const body = e.response?.data
      setLastActions([`Error: ${body?.error || body?.message || e.message}`])
    }
    setRunning(false)
  }

  const toggleAutoTrade = async () => {
    setToggling(true)
    try {
      await api.patch(`/stock-trader/campaign/${campaign.id}`, { auto_trade: !campaign.auto_trade })
      onRefresh()
    } catch {}
    setToggling(false)
  }

  const loadLog = async () => {
    try {
      const r = await api.get(`/stock-trader/campaign/${campaign.id}/log`)
      setLog(r.logs || [])
      setShowLog(true)
    } catch {}
  }

  const manualTrigger = async () => {
    try {
      await api.patch(`/stock-trader/campaign/${campaign.id}`, { manual_trigger: true })
      await runAgent()
    } catch {}
  }

  const deleteCampaign = async () => {
    setDeleting(true)
    try {
      await api.delete(`/stock-trader/campaign/${campaign.id}`)
      onRefresh()
    } catch {}
    setDeleting(false)
  }

  return (
    <div className="bg-slate-800/40 border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-4 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm">{campaign.name}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded ${campaign.auto_trade ? 'bg-emerald-900/50 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
              {campaign.auto_trade ? 'AUTO' : 'PAPER'}
            </span>
            <span className="text-[9px] px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded">
              Cycle {campaign.cycle}
            </span>
            {campaign.entry_condition?.type && (
              <span className="text-[9px] text-muted">Entry: {campaign.entry_condition.type}</span>
            )}
          </div>
          <div className="flex gap-4 mt-1 text-xs flex-wrap">
            <span className="text-muted">Reserved <span className="text-white">₹{campaign.reserved_fund.toLocaleString('en-IN')}</span></span>
            <span className="text-muted">Deployed <span className="text-blue-300">₹{(campaign.chunk1_deployed || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span></span>
            {activeStocks.length > 0 && (
              <span className={`font-mono ${pnlClass(totalPnl)}`}>
                Unrealised {totalPnl >= 0 ? '+' : ''}₹{Math.abs(totalPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </span>
            )}
            {exitedStocks.length > 0 && (
              <span className={`font-mono ${pnlClass(bookedPnl)}`}>
                Booked {bookedPnl >= 0 ? '+' : ''}₹{Math.abs(bookedPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={toggleAutoTrade} disabled={toggling}
            className={`text-[10px] px-2 py-1 rounded border transition ${campaign.auto_trade ? 'border-amber-600 text-amber-400 hover:bg-amber-900/20' : 'border-border text-muted hover:bg-slate-700'}`}>
            {campaign.auto_trade ? 'Auto ON' : 'Auto OFF'}
          </button>
          <button onClick={() => setShowEdit(true)} title="Edit campaign"
            className="text-[10px] px-2 py-1 rounded border border-border text-muted hover:bg-slate-700 hover:text-white transition">
            ✎ Edit
          </button>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} title="Delete campaign"
              className="text-[10px] px-2 py-1 rounded border border-red-800/50 text-red-400 hover:bg-red-900/20 transition">
              🗑
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-red-400">Delete?</span>
              <button onClick={deleteCampaign} disabled={deleting}
                className="text-[10px] px-2 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50 transition">
                {deleting ? '…' : 'Yes'}
              </button>
              <button onClick={() => setConfirmDelete(false)}
                className="text-[10px] px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded transition">
                No
              </button>
            </div>
          )}
          <button onClick={() => setExpanded(e => !e)} className="text-muted hover:text-white text-xs">
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Stocks table + actions */}
      {expanded && (
        <div className="border-t border-border/40">
          <StocksTable campaign={campaign} onRefresh={onRefresh} />

          <AddStockRow campaign={campaign} onRefresh={onRefresh} />

          <BrokerSessionBanner campaign={campaign} onReset={onRefresh} />

          {/* Actions row */}
          <div className="px-4 py-3 flex items-center gap-3 flex-wrap border-t border-border/30">
            <button onClick={fetchPreview} disabled={loadingPreview || running}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-xs text-slate-200 rounded-lg transition font-medium">
              {loadingPreview ? '⟳ Loading…' : '📋 Preview Orders'}
            </button>
            <button onClick={runAgent} disabled={running}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded-lg font-semibold transition">
              {running ? '⟳ Running…' : '▶ Run Agent Now'}
            </button>
            {campaign.entry_condition?.type === 'manual' && (
              <button onClick={manualTrigger} disabled={running}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs text-white rounded-lg transition">
                Trigger Entry
              </button>
            )}
            <button onClick={loadLog} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs text-slate-300 rounded-lg transition">
              View Log
            </button>
            {lastActions.length > 0 && (
              <div className="text-[10px] text-slate-400 flex-1">
                Last run: {lastActions.join(' · ')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Order preview panel */}
      {preview && (
        <div className="border-t border-border/40 bg-slate-900/80">
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-[10px] text-muted uppercase tracking-wider">
              Order Preview — Chunk {preview.chunk} · Fund ₹{preview.chunk_fund?.toLocaleString('en-IN')}
            </span>
            <button onClick={() => setPreview(null)} className="text-muted hover:text-white text-xs">✕</button>
          </div>
          {preview.error ? (
            <div className="px-4 pb-3 text-xs text-score-red">{preview.error}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-muted border-b border-border/30">
                      <th className="px-4 py-1.5 text-left">Symbol</th>
                      <th className="px-3 py-1.5 text-right">Alloc</th>
                      <th className="px-3 py-1.5 text-right">Fund</th>
                      <th className="px-3 py-1.5 text-right">LTP (₹)</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-white">Qty</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-white">Limit Price</th>
                      <th className="px-3 py-1.5 text-right">Order Value</th>
                      <th className="px-3 py-1.5 text-center">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.orders || []).map((o: any) => (
                      <tr key={o.symbol} className="border-b border-border/20 hover:bg-slate-800/40">
                        <td className="px-4 py-2 text-white font-medium">{o.symbol}</td>
                        <td className="px-3 py-2 text-right text-slate-400">{o.allocation}</td>
                        <td className="px-3 py-2 text-right text-slate-400">₹{o.fund?.toLocaleString('en-IN')}</td>
                        <td className="px-3 py-2 text-right text-slate-300">
                          {o.ltp?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          {o.price_source === 'delayed' && <span className="text-amber-500 ml-1 text-[9px]">~</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-score-blue">{o.qty}</td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-400">
                          ₹{o.limit_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300">₹{o.order_value?.toLocaleString('en-IN')}</td>
                        <td className="px-3 py-2 text-center">
                          <span className="px-1.5 py-0.5 bg-blue-950 text-blue-400 rounded text-[9px] font-medium">{o.order_type}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 flex items-center justify-between border-t border-border/20">
                <span className="text-[10px] text-muted">
                  Total order value: <span className="text-white font-semibold">₹{preview.total_value?.toLocaleString('en-IN')}</span>
                  {preview.note && <span className="ml-3 text-amber-500/70">~ prices at preview time</span>}
                </span>
                <span className="text-[10px] text-muted">Orders will be LIMIT at live LTP when executed</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Trade log panel */}
      {showLog && (
        <div className="border-t border-border/40 bg-slate-900/60 max-h-56 overflow-y-auto">
          <div className="p-3 flex items-center justify-between">
            <span className="text-[10px] text-muted uppercase tracking-wider">Trade Log</span>
            <button onClick={() => setShowLog(false)} className="text-muted hover:text-white text-xs">✕</button>
          </div>
          {log.length === 0 && <p className="text-center text-muted text-xs pb-4">No entries yet</p>}
          {log.slice().reverse().map((entry, i) => (
            <div key={i} className="px-4 py-2 border-t border-border/20 text-[10px] flex items-start gap-3">
              <span className="text-muted flex-shrink-0 font-mono">
                {new Date(entry.logged_at).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
              </span>
              <span className={`flex-shrink-0 font-semibold ${
                entry.action?.includes('BUY') ? 'text-blue-400' :
                entry.action?.includes('SELL') || entry.action?.includes('EXIT') ? 'text-emerald-400' :
                entry.action?.includes('SL') ? 'text-amber-400' : 'text-slate-400'
              }`}>{entry.action}</span>
              {entry.symbol && <span className="text-white">{entry.symbol}</span>}
              {entry.qty && <span className="text-slate-400">{entry.qty} @ ₹{fmt(entry.price)}</span>}
              {entry.pnl !== undefined && entry.pnl !== null && (
                <span className={pnlClass(entry.pnl)}>P&L: {entry.pnl >= 0 ? '+' : ''}₹{Math.abs(entry.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
              )}
              {entry.paper && <span className="text-slate-500">[paper]</span>}
            </div>
          ))}
        </div>
      )}

      {showEdit && (
        <EditCampaignModal
          campaign={campaign}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); onRefresh() }}
        />
      )}
    </div>
  )
}

// ── Campaigns Tab ─────────────────────────────────────────────────────────────

function CampaignsTab({ onNewCampaign }: { onNewCampaign?: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/stock-trader/campaigns')
      setCampaigns(r.campaigns || [])
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 2 min
  useEffect(() => {
    const t = setInterval(load, 120_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-white">Active Campaigns</div>
        <div className="flex gap-2">
          {onNewCampaign && (
            <button onClick={onNewCampaign}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg border border-blue-500 transition font-medium">
              + New Campaign
            </button>
          )}
          <button onClick={load} disabled={loading}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg border border-border transition">
            {loading ? '⟳' : '⟳ Refresh'}
          </button>
        </div>
      </div>
      {!loading && !campaigns.length && (
        <div className="text-center text-muted text-sm py-12">
          No campaigns yet. Click <span className="text-blue-400 font-medium">+ New Campaign</span> to build one manually,
          or go to AI Picks / Screener to select stocks first.
        </div>
      )}
      <div className="flex flex-col gap-4">
        {campaigns.map(c => <CampaignCard key={c.id} campaign={c} onRefresh={load} />)}
      </div>
    </div>
  )
}

// ── Positions Tab ─────────────────────────────────────────────────────────────

interface LivePosition extends StockPosition {
  _campaign: string
  _cid: string
}

function PositionsTab() {
  const [positions, setPositions] = useState<LivePosition[]>([])
  const [loading,   setLoading]   = useState(false)
  const [liveMode,  setLiveMode]  = useState(false)

  const load = useCallback(async (live = false) => {
    setLoading(true)
    try {
      if (live) {
        const r = await api.get('/stock-trader/positions/live')
        setPositions(r.positions || [])
        setLiveMode(true)
      } else {
        const r = await api.get('/stock-trader/campaigns')
        const camps: Campaign[] = r.campaigns || []
        const flat = camps.flatMap(c =>
          c.stocks
            .filter(s => s.status !== 'watching')
            .map(s => ({ ...s, _campaign: c.name, _cid: c.id } as LivePosition))
        )
        setPositions(flat)
        setLiveMode(false)
      }
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => load(liveMode), 120_000)
    return () => clearInterval(t)
  }, [load, liveMode])

  const active  = positions.filter(p => p.status !== 'exited')
  const exited  = positions.filter(p => p.status === 'exited')

  const totalInvested = active.reduce((s, p) => s + ((p.avg_price || 0) * (p.total_qty || p.chunk1_qty || 0)), 0)
  const totalCurrent  = active.reduce((s, p) => s + ((p.current_price || p.avg_price || 0) * (p.total_qty || p.chunk1_qty || 0)), 0)
  const totalUnreal   = liveMode ? (totalCurrent - totalInvested) : active.reduce((s, p) => s + (p.pnl || 0), 0)
  const totalBooked   = exited.reduce((s, p) => s + (p.booked_pnl || 0), 0)

  const pnlAmt = (amt: number | undefined) => amt === undefined || amt === 0 ? '–'
    : `${amt >= 0 ? '+' : ''}₹${Math.abs(amt).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  const pnlPct = (pct: number | undefined) => pct === undefined || pct === 0 ? '–'
    : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-white">All Positions</div>
        <div className="flex gap-2">
          <button onClick={() => load(false)} disabled={loading}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg border border-border transition">
            ⟳ Cached
          </button>
          <button onClick={() => load(true)} disabled={loading}
            className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-xs text-white rounded-lg border border-blue-600 transition font-medium">
            {loading && liveMode ? '⟳' : '⚡ Live P&L'}
          </button>
        </div>
      </div>

      {liveMode && (
        <div className="mb-3 text-[10px] text-blue-400 bg-blue-950/30 border border-blue-800/40 rounded px-3 py-1.5">
          Live prices fetched from market data — P&L is real-time
        </div>
      )}

      {/* Summary strip */}
      {positions.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-slate-800/60 rounded-lg p-3 text-center">
            <div className="text-[10px] text-muted">Active Positions</div>
            <div className="text-lg font-bold text-white mt-0.5">{active.length}</div>
          </div>
          <div className="bg-slate-800/60 rounded-lg p-3 text-center">
            <div className="text-[10px] text-muted">Unrealised P&L</div>
            <div className={`text-lg font-bold mt-0.5 ${pnlClass(totalUnreal)}`}>
              {totalUnreal >= 0 ? '+' : ''}₹{Math.abs(totalUnreal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
          <div className="bg-slate-800/60 rounded-lg p-3 text-center">
            <div className="text-[10px] text-muted">Booked P&L</div>
            <div className={`text-lg font-bold mt-0.5 ${pnlClass(totalBooked)}`}>
              {totalBooked >= 0 ? '+' : ''}₹{Math.abs(totalBooked).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      )}

      {!loading && !positions.length && (
        <div className="text-center text-muted text-sm py-12">
          No positions yet. Create a campaign and run the trade agent to start.
        </div>
      )}

      {positions.length > 0 && (
        <div className="overflow-x-auto bg-slate-800/40 rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted text-left">
                <th className="px-4 py-3">Stock</th>
                <th className="px-4 py-3">Campaign</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Avg Cost</th>
                <th className="px-4 py-3 text-right">CMP</th>
                <th className="px-4 py-3 text-right">P&L</th>
                <th className="px-4 py-3 text-right">P&L%</th>
                <th className="px-4 py-3 text-right">SL</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const qty    = p.total_qty || p.chunk1_qty || 0
                const livePnl = liveMode && p.avg_price && qty && p.current_price
                  ? (p.current_price - p.avg_price) * qty : undefined
                const livePct = liveMode && p.avg_price && p.current_price
                  ? ((p.current_price - p.avg_price) / p.avg_price) * 100 : undefined
                const dispPnl = p.status === 'exited' ? p.booked_pnl : (livePnl ?? p.pnl)
                const dispPct = p.status === 'exited' ? undefined : (livePct ?? p.pnl_pct)
                return (
                  <tr key={i} className="border-b border-border/20 hover:bg-slate-700/20">
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-white">{p.symbol}</div>
                      <div className="text-[9px] text-muted">{p.sector}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{p._campaign}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_COLOR[p.status] || ''}`}>
                        {STATUS_LABEL[p.status] || p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-300">{qty || '–'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                      {p.avg_price ? `₹${fmt(p.avg_price)}` : '–'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-white">
                      {p.current_price ? `₹${fmt(p.current_price)}` : (p.exit_price ? `₹${fmt(p.exit_price)}` : '–')}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono font-semibold ${pnlClass(dispPnl)}`}>
                      {pnlAmt(dispPnl)}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono text-[10px] ${pnlClass(dispPct)}`}>
                      {pnlPct(dispPct)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-amber-400 text-[10px]">
                      {p.sl_price ? `₹${fmt(p.sl_price)}` : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {/* Aggregate row */}
            {active.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border bg-slate-700/30 font-semibold">
                  <td className="px-4 py-2.5 text-slate-300" colSpan={4}>Total ({active.length} positions)</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                    {totalInvested > 0 ? `₹${totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '–'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-white">
                    {totalCurrent > 0 ? `₹${totalCurrent.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '–'}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono ${pnlClass(totalUnreal)}`}>
                    {pnlAmt(totalUnreal)}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-[10px] ${pnlClass(totalInvested > 0 ? totalUnreal / totalInvested * 100 : 0)}`}>
                    {totalInvested > 0 ? pnlPct(totalUnreal / totalInvested * 100) : '–'}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  )
}

// ── Reports Tab ───────────────────────────────────────────────────────────────

function ReportsTab() {
  const [reports,    setReports]    = useState<{ year_month: string; month_name: string; report_text: string; generated_at: string }[]>([])
  const [selected,   setSelectedR]  = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [loading,    setLoading]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/stock-trader/reports')
      setReports(r.reports || [])
      if (r.reports?.length && !selected) setSelectedR(r.reports[0].year_month)
    } catch {}
    setLoading(false)
  }, [selected])

  useEffect(() => { load() }, [load])

  const generate = async () => {
    setGenerating(true)
    try {
      await api.post('/stock-trader/reports/generate', {})
      await load()
    } catch {}
    setGenerating(false)
  }

  const active = reports.find(r => r.year_month === selected)

  return (
    <div className="flex gap-4 h-full">
      {/* Sidebar list */}
      <div className="w-44 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-white">Reports</span>
          <button onClick={generate} disabled={generating}
            className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded"
            title="Generate report for current month">
            {generating ? '…' : '+ Generate'}
          </button>
        </div>
        {!reports.length && !loading && (
          <p className="text-muted text-xs">No reports yet. Generate one at month end.</p>
        )}
        {reports.map(r => (
          <button key={r.year_month}
            onClick={() => setSelectedR(r.year_month)}
            className={`w-full text-left px-3 py-2 rounded-lg mb-1 text-xs transition
              ${selected === r.year_month ? 'bg-blue-600 text-white' : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700'}`}>
            {r.month_name || r.year_month}
          </button>
        ))}
      </div>

      {/* Report content */}
      <div className="flex-1 min-w-0 bg-slate-800/40 rounded-xl border border-border p-5 overflow-y-auto">
        {!active
          ? <p className="text-muted text-sm text-center py-8">Select a report or generate one</p>
          : (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="text-white font-semibold">{active.month_name}</div>
                <div className="flex items-center gap-3">
                  <div className="text-[10px] text-muted">
                    Generated {new Date(active.generated_at).toLocaleDateString('en-IN')}
                  </div>
                  <button onClick={generate} disabled={generating}
                    className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded border border-border">
                    {generating ? '…' : '↺ Regenerate'}
                  </button>
                </div>
              </div>
              {active.report_text?.startsWith('[LLM') && (
                <div className="mb-4 bg-amber-950/50 border border-amber-800/60 rounded-lg px-4 py-3 text-xs text-amber-300">
                  <strong>LLM error in this report.</strong> Fix your API key in Settings, then click <strong>↺ Regenerate</strong> above to overwrite it with a fresh report.
                </div>
              )}
              <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                {active.report_text}
              </div>
            </>
          )
        }
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function StockTrader() {
  const [tab, setTab] = useState<'picks' | 'etf-picks' | 'screener' | 'campaigns' | 'positions' | 'reports'>('picks')

  // Shared state for campaign builder — selected from both AI Picks and ETF Picks tabs
  const [pendingStocks, setPendingStocks] = useState<{ pick: AIPick; allocation: number }[]>([])
  const [pendingEtfs,   setPendingEtfs]   = useState<{ pick: ETFPick; allocation: number }[]>([])
  const [showModal, setShowModal] = useState(false)

  const openModal = () => setShowModal(true)

  const handleStocksBuild = (stocks: { pick: AIPick; allocation: number }[]) => {
    setPendingStocks(stocks)
    openModal()
  }

  const handleEtfsBuild = (etfs: { pick: ETFPick; allocation: number }[]) => {
    setPendingEtfs(etfs)
    openModal()
  }

  const tabs = [
    { key: 'picks',     label: 'AI Picks' },
    { key: 'etf-picks', label: 'ETF Picks' },
    { key: 'screener',  label: 'Screener' },
    { key: 'campaigns', label: 'Campaigns' },
    { key: 'positions', label: 'Positions' },
    { key: 'reports',   label: 'Reports' },
  ] as const

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">AI Stock Trader</h1>
        <p className="text-sm text-muted mt-1">
          AI screens quality large/mid-cap dips + momentum ETFs → you select → agent buys in chunks, averages on falls, exits with trailing stop.
        </p>
      </div>

      {/* How it works strip */}
      <div className="flex gap-2 mb-6 flex-wrap text-[10px]">
        {[
          { step: '1', label: 'AI screens 80+ stocks & ETFs', color: 'bg-blue-900/40 text-blue-300 border-blue-700/40' },
          { step: '2', label: 'You pick stocks + ETFs + allocate %', color: 'bg-slate-700 text-slate-300 border-border' },
          { step: '3', label: 'Chunk 1: 40% deployed', color: 'bg-purple-900/40 text-purple-300 border-purple-700/40' },
          { step: '4', label: 'Average if falls >3% in 3d', color: 'bg-amber-900/40 text-amber-300 border-amber-700/40' },
          { step: '5', label: 'Trailing SL after 2% profit', color: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40' },
          { step: '6', label: 'Cycle restarts after portfolio exits', color: 'bg-slate-700 text-slate-300 border-border' },
        ].map(({ step, label, color }) => (
          <div key={step} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${color}`}>
            <span className="font-bold">{step}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border mb-6">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition
              ${tab === t.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-muted hover:text-white'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'picks'     && <PicksTab onBuildCampaign={handleStocksBuild} />}
      {tab === 'etf-picks' && <ETFPicksTab onBuildCampaign={handleEtfsBuild} />}
      {tab === 'screener'  && <ScreenerTab onBuildCampaign={handleStocksBuild} />}
      {tab === 'campaigns' && <CampaignsTab onNewCampaign={() => { setPendingStocks([]); setPendingEtfs([]); setShowModal(true) }} />}
      {tab === 'positions' && <PositionsTab />}
      {tab === 'reports'   && <ReportsTab />}

      {/* Campaign builder modal — lifted to root so both tabs can trigger it */}
      {showModal && (
        <CampaignBuilderModal
          selectedPicks={pendingStocks}
          selectedEtfs={pendingEtfs}
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false)
            setPendingStocks([])
            setPendingEtfs([])
            setTab('campaigns')
          }}
        />
      )}
    </div>
  )
}
