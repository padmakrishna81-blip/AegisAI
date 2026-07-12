import { useState, useEffect, useCallback, Fragment } from 'react'
import client from '../api/client'
import { useWatchlistStore } from '../store/watchlistStore'
import { formatINR, scoreToColor, shortSymbol } from '../utils/formatters'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChunkConfig {
  chunk_no: number
  allocation_pct: number
  entry_price: number
  profit_pct: number
}

interface ChunkState extends ChunkConfig {
  allocation_amount: number
  actual_cost: number
  exit_price: number
  quantity: number
  status: 'WAITING' | 'BOUGHT' | 'SOLD' | 'CANCELLED'
  buy_price: number | null
  sell_price: number | null
  buy_time: string | null
  sell_time: string | null
  realised_pnl: number | null
  unrealised_pnl: number | null
  label?: string                    // optional label e.g. "Phase 1 Entry" for CC trades
  cmp: number | null
  dist_to_entry: number | null        // CMP - entry_price: +ve = waiting to fall, -ve = missed
  dist_to_entry_pct: number | null
}

interface Trade {
  trade_id: string
  symbol: string
  company_name: string
  total_allocation: number
  chunks: ChunkState[]
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED'
  created_at: string
  started_at: string | null
  total_realised_pnl: number
}

interface Position {
  trade_id: string
  symbol: string
  company_name: string
  status: string
  trade_type?: string           // "EQUITY" | "COVERED_CALL"
  has_any_fill: boolean
  total_allocation: number
  invested: number
  current_value: number
  unrealised_pnl: number
  unrealised_pnl_pct: number
  realised_pnl: number
  live_price: number
  mtm_target_pct: number | null
  mtm_target_inr: number | null
  chunks: ChunkState[]
}

interface CcPosition {
  trade_id: string
  symbol: string
  company_name: string
  trade_status: string
  option_symbol: string
  strike: number
  expiry: string
  sell_premium: number
  premium_income: number
  lots: number
  lot_size: number
  option_status: 'OPEN' | 'CLOSED' | 'EXPIRED'
  option_pnl: number | null
  close_premium: number | null
  opened_at: string
  closed_at: string | null
  // Live MTM fields
  current_ltp:     number | null
  buy_back_cost:   number | null
  option_mtm_inr:  number | null   // +ve = profit (CE decayed), -ve = loss (CE rose)
  option_mtm_pct:  number | null
  // Stock chunks
  phase1_status: string
  phase2_status: string
  phase1_buy_price: number | null
  phase2_buy_price: number | null
}

interface Summary {
  virtual_cash: number
  total_invested: number
  unrealised_pnl: number
  realised_pnl: number
  total_pnl: number
  portfolio_value: number
  active_trade_count: number
  holdings: HoldingAgg[]
  positions: Position[]
  cc_positions: CcPosition[]
}

interface ChunkDetail {
  trade_id: string
  chunk_no: number
  buy_price: number
  exit_price: number
  quantity: number
  profit_pct: number
  cost: number
  target_value: number
  current_value: number
  unrealised_pnl: number
  buy_time: string | null
}

interface HoldingAgg {
  symbol: string
  company_name: string
  total_quantity: number
  avg_cost_price: number
  current_market_price: number
  total_invested: number
  current_value: number
  mtm_inr: number
  mtm_pct: number
  target_value: number
  target_pnl: number
  target_label: string
  mtm_target_pct: number | null
  mtm_target_inr: number | null
  chunk_details: ChunkDetail[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  ACTIVE:    'bg-blue-950 border border-blue-800 text-score-blue',
  COMPLETED: 'bg-green-950 border border-green-800 text-score-green',
  CANCELLED: 'bg-slate-700 border border-slate-600 text-muted',
  PAUSED:    'bg-amber-950 border border-amber-700 text-score-amber',
  WAITING:   'bg-slate-800 text-muted',
  BOUGHT:    'bg-blue-950 text-score-blue',
  SOLD:      'bg-green-950 text-score-green',
}

function fmt(v: number | null | undefined, decimals = 2) {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ─── New Trade Form ───────────────────────────────────────────────────────────

interface PriceInfo {
  current_price: number
  prev_close: number | null
  change_inr: number | null
  change_pct: number | null
  company_name: string
}

function NewTradeForm({ onCreated }: { onCreated: () => void }) {
  const { items: watchlistItems } = useWatchlistStore()
  const [symbol, setSymbol] = useState('')
  const [totalAlloc, setTotalAlloc] = useState('')
  const [chunks, setChunks] = useState<ChunkConfig[]>([
    { chunk_no: 1, allocation_pct: 40, entry_price: 0, profit_pct: 8 },
    { chunk_no: 2, allocation_pct: 30, entry_price: 0, profit_pct: 10 },
    { chunk_no: 3, allocation_pct: 30, entry_price: 0, profit_pct: 12 },
  ])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [priceInfo, setPriceInfo] = useState<PriceInfo | null>(null)

  // MTM target at creation time
  const [mtmMode, setMtmMode] = useState<'none' | 'pct' | 'inr'>('none')
  const [mtmVal, setMtmVal] = useState('')

  const totalPct = chunks.reduce((s, c) => s + c.allocation_pct, 0)

  const fetchPrice = async (sym: string) => {
    setPriceInfo(null)
    try {
      const res = await client.get(`/validate/${sym}`)
      if (res.data.valid) {
        setPriceInfo({
          current_price: res.data.current_price,
          prev_close: res.data.prev_close,
          change_inr: res.data.change_inr,
          change_pct: res.data.change_pct,
          company_name: res.data.company_name,
        })
      }
    } catch { /* ignore */ }
  }

  useEffect(() => { if (symbol) fetchPrice(symbol) }, [symbol])

  const updateChunk = (idx: number, field: keyof ChunkConfig, val: number) =>
    setChunks(prev => prev.map((c, i) => i === idx ? { ...c, [field]: val } : c))

  const addChunk = () => {
    const n = chunks.length + 1
    setChunks(prev => [...prev, { chunk_no: n, allocation_pct: 0, entry_price: 0, profit_pct: 8 }])
  }

  const removeChunk = (idx: number) => {
    if (chunks.length <= 1) return
    setChunks(prev => prev.filter((_, i) => i !== idx).map((c, i) => ({ ...c, chunk_no: i + 1 })))
  }

  const submit = async () => {
    setError('')
    if (!symbol) { setError('Select a stock or ETF from watchlist'); return }
    if (!totalAlloc || Number(totalAlloc) <= 0) { setError('Enter total allocation amount'); return }
    if (Math.abs(totalPct - 100) > 0.5) { setError(`Chunk % must sum to 100 (currently ${totalPct.toFixed(1)}%)`); return }
    if (chunks.some(c => c.entry_price <= 0)) { setError('All entry prices must be > 0'); return }
    setLoading(true)
    try {
      await client.post('/paper/trades', {
        symbol, total_allocation: Number(totalAlloc), chunks, notes,
        mtm_target_pct: mtmMode === 'pct' && mtmVal ? parseFloat(mtmVal) : null,
        mtm_target_inr: mtmMode === 'inr' && mtmVal ? parseFloat(mtmVal) : null,
      })
      setSymbol(''); setTotalAlloc(''); setNotes(''); setPriceInfo(null); setMtmVal(''); setMtmMode('none')
      setChunks([
        { chunk_no: 1, allocation_pct: 40, entry_price: 0, profit_pct: 8 },
        { chunk_no: 2, allocation_pct: 30, entry_price: 0, profit_pct: 10 },
        { chunk_no: 3, allocation_pct: 30, entry_price: 0, profit_pct: 12 },
      ])
      onCreated()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Failed to create trade')
    } finally { setLoading(false) }
  }

  const alloc = Number(totalAlloc) || 0

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">Configure New Paper Trade</div>
        <div className="text-xs text-muted">Only watchlist stocks/ETFs can be traded</div>
      </div>

      {/* Symbol + Allocation row */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="text-xs text-muted block mb-1.5">Stock / ETF (from Watchlist)</label>
          <select
            value={symbol}
            onChange={e => { setSymbol(e.target.value); setPriceInfo(null) }}
            className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">— Select —</option>
            {watchlistItems.map(item => (
              <option key={item.symbol} value={item.symbol}>
                {shortSymbol(item.symbol)} — {item.company_name}
              </option>
            ))}
          </select>

          {/* CMP + % change from prev close */}
          {priceInfo && (
            <div className="mt-2 bg-slate-800 rounded-lg px-3 py-2 flex items-center justify-between">
              <div>
                <span className="text-xs text-muted mr-2">CMP</span>
                <span className="text-sm font-bold text-white">₹{priceInfo.current_price.toLocaleString('en-IN')}</span>
              </div>
              {priceInfo.change_pct != null && (
                <div className="text-right">
                  <div className={`text-xs font-semibold ${priceInfo.change_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                    {priceInfo.change_pct >= 0 ? '+' : ''}{priceInfo.change_pct.toFixed(2)}%
                  </div>
                  <div className={`text-[10px] ${priceInfo.change_inr != null && priceInfo.change_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                    {priceInfo.change_inr != null ? `${priceInfo.change_inr >= 0 ? '+' : ''}₹${priceInfo.change_inr.toFixed(2)}` : ''}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="text-xs text-muted block mb-1.5">Total Allocation (₹)</label>
          <input
            type="number" value={totalAlloc}
            onChange={e => setTotalAlloc(e.target.value)}
            placeholder="e.g. 100000"
            className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          {alloc > 0 && <div className="mt-1 text-xs text-muted">{formatINR(alloc)} total</div>}
        </div>
        <div>
          <label className="text-xs text-muted block mb-1.5">Notes (optional)</label>
          <input
            type="text" value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Breakout trade, support zone"
            className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Chunk table */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-muted">Chunk Configuration</div>
          <div className={`text-xs font-medium ${Math.abs(totalPct - 100) < 0.5 ? 'text-score-green' : 'text-score-amber'}`}>
            Total: {totalPct.toFixed(0)}% {Math.abs(totalPct - 100) < 0.5 ? '✓' : '(must be 100%)'}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
                <th className="text-center px-3 py-2.5">Chunk</th>
                <th className="text-right px-3 py-2.5">Allocation %</th>
                <th className="text-right px-3 py-2.5">Amount</th>
                <th className="text-right px-3 py-2.5">Entry Price ₹</th>
                <th className="text-right px-3 py-2.5">Profit Book %</th>
                <th className="text-right px-3 py-2.5">Exit Price</th>
                <th className="text-right px-3 py-2.5">Qty</th>
                <th className="px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {chunks.map((chunk, idx) => {
                const amount = alloc * chunk.allocation_pct / 100
                const exitPrice = chunk.entry_price > 0 ? chunk.entry_price * (1 + chunk.profit_pct / 100) : 0
                const qty = chunk.entry_price > 0 ? Math.floor(amount / chunk.entry_price) : 0
                return (
                  <tr key={idx} className="border-b border-border/50">
                    <td className="px-3 py-2 text-center">
                      <span className="w-6 h-6 rounded-full bg-blue-950 border border-blue-800 text-score-blue text-xs font-bold inline-flex items-center justify-center">
                        {chunk.chunk_no}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min={0} max={100} step={5}
                        value={chunk.allocation_pct}
                        onChange={e => updateChunk(idx, 'allocation_pct', Number(e.target.value))}
                        className="w-20 text-right bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      />
                      <span className="text-xs text-muted ml-1">%</span>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 text-xs">
                      {amount > 0 ? formatINR(amount) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min={0} step={0.5}
                        value={chunk.entry_price || ''}
                        onChange={e => updateChunk(idx, 'entry_price', Number(e.target.value))}
                        placeholder="0.00"
                        className="w-24 text-right bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number" min={0.5} max={50} step={0.5}
                        value={chunk.profit_pct}
                        onChange={e => updateChunk(idx, 'profit_pct', Number(e.target.value))}
                        className="w-16 text-right bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      />
                      <span className="text-xs text-muted ml-1">%</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {exitPrice > 0 ? (
                        <span className="text-xs font-medium text-score-green">₹{exitPrice.toFixed(2)}</span>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 text-xs">
                      {qty > 0 ? qty.toLocaleString() : '—'}
                    </td>
                    <td className="px-2 py-2">
                      {chunks.length > 1 && (
                        <button onClick={() => removeChunk(idx)} className="text-muted hover:text-score-red text-xs">✕</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <button
          onClick={addChunk}
          className="mt-2 text-xs text-score-blue hover:text-blue-400 flex items-center gap-1"
        >
          + Add Chunk
        </button>
      </div>

      {/* MTM Profit / Stop-Loss target at creation time */}
      <div className="bg-slate-800 border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-white">MTM Profit / Stop-Loss Target <span className="text-muted font-normal">(optional)</span></div>
            <div className="text-[10px] text-muted mt-0.5">
              When set, all executed chunks are exited together when the aggregate MTM hits this target.
              Overrides individual chunk profit%. Can be set now or changed anytime later.
            </div>
          </div>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex rounded-lg overflow-hidden border border-border">
            {([['none','Off'],['pct','% MTM'],['inr','₹ MTM']] as const).map(([v,lbl]) => (
              <button key={v} onClick={() => { setMtmMode(v); setMtmVal('') }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${mtmMode === v ? 'bg-blue-600 text-white' : 'text-muted hover:text-white'}`}>
                {lbl}
              </button>
            ))}
          </div>
          {mtmMode !== 'none' && (
            <input
              type="number" value={mtmVal} step={mtmMode === 'pct' ? 0.5 : 500}
              onChange={e => setMtmVal(e.target.value)}
              placeholder={mtmMode === 'pct' ? 'e.g. 8 (profit) or -5 (stop)' : 'e.g. 8000 or -3000'}
              className="flex-1 min-w-[200px] bg-slate-700 border border-border rounded-lg px-3 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
          )}
          {mtmMode !== 'none' && mtmVal && (
            <div className={`text-[10px] font-medium ${parseFloat(mtmVal) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
              {parseFloat(mtmVal) >= 0
                ? `↑ Exit all executed chunks at +${mtmMode === 'pct' ? mtmVal + '%' : '₹' + parseFloat(mtmVal).toLocaleString('en-IN')} gain`
                : `↓ Stop loss at ${mtmMode === 'pct' ? mtmVal + '%' : '₹' + parseFloat(mtmVal).toLocaleString('en-IN')} loss`}
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-score-red bg-red-950 border border-red-800 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex justify-end">
        <button
          onClick={submit}
          disabled={loading}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold"
        >
          {loading ? 'Creating...' : 'Create Trade Plan'}
        </button>
      </div>
    </div>
  )
}

// ─── Trade Card ───────────────────────────────────────────────────────────────

function TradeCard({ pos, onAction }: { pos: Position; onAction: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [acting, setActing] = useState(false)

  // Edit WAITING chunks
  const [editingChunks, setEditingChunks] = useState(false)
  const [editChunks, setEditChunks] = useState<ChunkState[]>([])

  // MTM book profit
  const [showMtm, setShowMtm] = useState(false)
  const [mtmMode, setMtmMode] = useState<'pct' | 'inr'>('pct')
  const [mtmValue, setMtmValue] = useState('')
  const [savingMtm, setSavingMtm] = useState(false)
  const [mtmMsg, setMtmMsg] = useState('')

  const waitingChunks = pos.chunks.filter(c => c.status === 'WAITING')
  const boughtChunks  = pos.chunks.filter(c => c.status === 'BOUGHT')
  const hasEditable   = waitingChunks.length > 0 && pos.status !== 'CANCELLED'

  const startEdit = () => {
    setEditChunks(pos.chunks.map(c => ({ ...c })))
    setEditingChunks(true)
  }

  const saveChunks = async () => {
    setActing(true)
    try {
      await client.put(`/paper/trades/${pos.trade_id}/chunks`, {
        chunks: editChunks.filter(c => c.status === 'WAITING').map(c => ({
          chunk_no: c.chunk_no,
          allocation_pct: c.allocation_pct,
          entry_price: c.entry_price,
          profit_pct: c.profit_pct,
        }))
      })
      setEditingChunks(false)
      onAction()
    } catch { /* ignore */ }
    finally { setActing(false) }
  }

  const setMtmTarget = async () => {
    const val = parseFloat(mtmValue)
    if (isNaN(val)) { setMtmMsg('Enter a valid number'); return }
    setSavingMtm(true)
    setMtmMsg('')
    try {
      await client.post(`/paper/trades/${pos.trade_id}/mtm-target`, {
        mtm_pct: mtmMode === 'pct' ? val : null,
        mtm_inr: mtmMode === 'inr' ? val : null,
      })
      setMtmMsg(`MTM target set: ${val >= 0 ? '+' : ''}${mtmMode === 'pct' ? val + '%' : '₹' + val.toLocaleString('en-IN')}`)
      setMtmValue('')
      onAction()
    } catch (e: unknown) {
      setMtmMsg('Failed to set MTM target')
    } finally { setSavingMtm(false) }
  }

  const clearMtmTarget = async () => {
    await client.post(`/paper/trades/${pos.trade_id}/mtm-target`, { mtm_pct: null, mtm_inr: null })
    setMtmMsg('MTM target cleared — using individual chunk exits')
    onAction()
  }

  const doAction = async (action: 'start' | 'pause' | 'cancel') => {
    setActing(true)
    try {
      await client.post(`/paper/trades/${pos.trade_id}/${action}`)
      onAction()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (msg) alert(msg)
    } finally {
      setActing(false)
    }
  }

  const doDelete = async () => {
    if (!window.confirm(`Delete cancelled trade for ${shortSymbol(pos.symbol)}? This cannot be undone.`)) return
    setActing(true)
    try {
      await client.delete(`/paper/trades/${pos.trade_id}`)
      onAction()
    } finally {
      setActing(false)
    }
  }

  const pnlColor = pos.unrealised_pnl >= 0 ? 'text-score-green' : 'text-score-red'

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-800/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-4">
          <div>
            <div className="font-semibold text-white">{shortSymbol(pos.symbol)}</div>
            <div className="text-xs text-muted truncate max-w-[160px]">{pos.company_name}</div>
          </div>
          {pos.trade_type === 'COVERED_CALL' && (
            <span className="px-2 py-0.5 bg-amber-950 border border-amber-700 text-score-amber rounded text-[10px] font-bold">CC</span>
          )}
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${STATUS_STYLES[pos.status] || 'text-muted'}`}>
            {pos.status}
          </span>
        </div>

        <div className="flex items-center gap-6 text-right">
          <div>
            <div className="text-[10px] text-muted">Allocated</div>
            <div className="text-sm text-white">{formatINR(pos.total_allocation)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Invested</div>
            <div className="text-sm text-white">{formatINR(pos.invested)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Unrealised</div>
            <div className={`text-sm font-medium ${pnlColor}`}>
              {pos.unrealised_pnl >= 0 ? '+' : ''}{formatINR(pos.unrealised_pnl)}
              <span className="text-xs ml-1">({pos.unrealised_pnl_pct >= 0 ? '+' : ''}{pos.unrealised_pnl_pct.toFixed(1)}%)</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Realised</div>
            <div className={`text-sm font-medium ${pos.realised_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
              {pos.realised_pnl >= 0 ? '+' : ''}{formatINR(pos.realised_pnl)}
            </div>
          </div>
          {pos.live_price > 0 && (
            <div>
              <div className="text-[10px] text-muted">Live</div>
              <div className="text-sm text-white">₹{pos.live_price.toLocaleString('en-IN')}</div>
            </div>
          )}
          <span className="text-muted">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-4 space-y-4">
          {/* Chunk table */}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted border-b border-border/50">
                <th className="text-center pb-2">Chunk</th>
                <th className="text-right pb-2">Entry ₹</th>
                <th className="text-right pb-2">CMP ₹</th>
                <th className="text-right pb-2">Gap to Entry</th>
                <th className="text-right pb-2">Exit Target</th>
                <th className="text-right pb-2">Profit%</th>
                <th className="text-right pb-2">Qty</th>
                <th className="text-right pb-2">Alloc%</th>
                <th className="text-center pb-2">Status</th>
                <th className="text-right pb-2">Buy @</th>
                <th className="text-right pb-2">Sell @</th>
                <th className="text-right pb-2">P&L</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {pos.chunks.map(chunk => {
                const isWaiting = chunk.status === 'WAITING'
                const dist = chunk.dist_to_entry
                // dist > 0: CMP still above entry (needs to fall further)
                // dist <= 0: CMP at or below entry (should trigger next tick)
                const distColor = dist == null ? '' : dist <= 0 ? 'text-score-green' : 'text-score-amber'
                const distLabel = dist == null ? '—'
                  : dist <= 0
                    ? `₹${Math.abs(dist).toFixed(2)} below ✓`
                    : `₹${dist.toFixed(2)} above`
                const distPctLabel = chunk.dist_to_entry_pct != null
                  ? ` (${chunk.dist_to_entry_pct > 0 ? '+' : ''}${chunk.dist_to_entry_pct.toFixed(2)}%)`
                  : ''

                return (
                  <tr key={chunk.chunk_no} className={`border-b border-border/30 ${isWaiting && dist != null && dist <= 0 ? 'bg-green-950/20' : ''}`}>
                    <td className="py-2 text-center">
                      {chunk.label ? (
                        <span className="text-[10px] text-blue-400 font-medium whitespace-nowrap">{chunk.label.replace(' Entry','')}</span>
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-blue-950 border border-blue-800 text-score-blue text-[10px] font-bold inline-flex items-center justify-center">
                          {chunk.chunk_no}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right text-white font-medium">₹{chunk.entry_price.toFixed(2)}</td>
                    <td className="py-2 text-right">
                      {chunk.cmp != null ? (
                        <span className="text-slate-300">₹{chunk.cmp.toFixed(2)}</span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-2 text-right">
                      {isWaiting ? (
                        <div>
                          <span className={`font-medium ${distColor}`}>{distLabel}</span>
                          {distPctLabel && <span className={`${distColor} opacity-70`}>{distPctLabel}</span>}
                        </div>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-2 text-right text-score-green">₹{chunk.exit_price.toFixed(2)}</td>
                    <td className="py-2 text-right text-score-amber">{chunk.profit_pct}%</td>
                    <td className="py-2 text-right text-slate-300">{chunk.quantity.toLocaleString()}</td>
                    <td className="py-2 text-right text-slate-300">{chunk.allocation_pct}%</td>
                    <td className="py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${STATUS_STYLES[chunk.status] || ''}`}>
                        {chunk.status}
                      </span>
                    </td>
                    <td className="py-2 text-right text-slate-300">
                      {chunk.buy_price ? `₹${chunk.buy_price.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2 text-right text-slate-300">
                      {chunk.sell_price ? `₹${chunk.sell_price.toFixed(2)}` : '—'}
                    </td>
                    <td className={`py-2 text-right font-medium ${(chunk.realised_pnl ?? 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {chunk.realised_pnl != null
                        ? `${chunk.realised_pnl >= 0 ? '+' : ''}₹${chunk.realised_pnl.toFixed(0)}`
                        : chunk.unrealised_pnl != null
                        ? <span className="text-muted">{chunk.unrealised_pnl >= 0 ? '+' : ''}₹{chunk.unrealised_pnl.toFixed(0)}</span>
                        : '—'}
                    </td>
                    <td className="py-2 pl-1.5">
                      {chunk.status === 'WAITING' && (
                        <button
                          onClick={() => {
                            if (!window.confirm(`Buy Chunk ${chunk.chunk_no} at CMP now?`)) return
                            setActing(true)
                            client.post(`/paper/trades/${pos.trade_id}/chunks/${chunk.chunk_no}/manual-buy`)
                              .then(onAction).finally(() => setActing(false))
                          }}
                          disabled={acting}
                          className="px-2 py-0.5 bg-blue-950 border border-blue-800 text-score-blue hover:bg-blue-900 rounded text-[10px] font-medium whitespace-nowrap"
                        >
                          Buy Now
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* ── Edit WAITING Chunks ─────────────────────────────────────── */}
          {hasEditable && (
            <div className="border-t border-border pt-3">
              {!editingChunks ? (
                <button
                  onClick={startEdit}
                  className="px-3 py-1.5 bg-card border border-border text-muted hover:border-blue-500 hover:text-white rounded-lg text-xs font-medium"
                >
                  ✏ Edit WAITING Chunks
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-white">Edit WAITING chunks (BOUGHT/SOLD are locked)</div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted border-b border-border/50">
                        <th className="text-center pb-1.5">Chunk</th>
                        <th className="text-right pb-1.5">Alloc%</th>
                        <th className="text-right pb-1.5">Entry ₹</th>
                        <th className="text-right pb-1.5">Profit%</th>
                        <th className="text-right pb-1.5">Exit ₹</th>
                        <th className="text-right pb-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editChunks.map((c, idx) => (
                        <tr key={c.chunk_no} className="border-b border-border/30">
                          <td className="py-1.5 text-center text-slate-300">{c.chunk_no}</td>
                          <td className="py-1.5 text-right">
                            {c.status === 'WAITING' ? (
                              <input type="number" min={1} max={100} step={5}
                                value={c.allocation_pct}
                                onChange={e => setEditChunks(prev => prev.map((x, i) => i === idx ? {...x, allocation_pct: Number(e.target.value)} : x))}
                                className="w-16 text-right bg-slate-700 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                              />
                            ) : <span className="text-muted">{c.allocation_pct}%</span>}
                          </td>
                          <td className="py-1.5 text-right">
                            {c.status === 'WAITING' ? (
                              <input type="number" min={0} step={0.5}
                                value={c.entry_price}
                                onChange={e => setEditChunks(prev => prev.map((x, i) => i === idx ? {...x, entry_price: Number(e.target.value)} : x))}
                                className="w-24 text-right bg-slate-700 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                              />
                            ) : <span className="text-muted">₹{c.entry_price}</span>}
                          </td>
                          <td className="py-1.5 text-right">
                            {c.status === 'WAITING' ? (
                              <input type="number" min={0.5} max={100} step={0.5}
                                value={c.profit_pct}
                                onChange={e => setEditChunks(prev => prev.map((x, i) => i === idx ? {...x, profit_pct: Number(e.target.value)} : x))}
                                className="w-16 text-right bg-slate-700 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                              />
                            ) : <span className="text-muted">{c.profit_pct}%</span>}
                          </td>
                          <td className="py-1.5 text-right text-score-green text-[11px]">
                            {c.status === 'WAITING'
                              ? `₹${(c.entry_price * (1 + c.profit_pct/100)).toFixed(2)}`
                              : `₹${c.exit_price}`}
                          </td>
                          <td className="py-1.5 text-right">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_STYLES[c.status] || ''}`}>{c.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex gap-2">
                    <button onClick={saveChunks} disabled={acting}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                      {acting ? 'Saving…' : 'Save Changes'}
                    </button>
                    <button onClick={() => setEditingChunks(false)}
                      className="px-3 py-1.5 bg-card border border-border text-muted hover:text-white rounded-lg text-xs">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MTM Book Profit / Stop Loss — always visible for non-cancelled trades ── */}
          {pos.status !== 'CANCELLED' && pos.status !== 'COMPLETED' && (
            <div className="border-t border-border pt-3">

              {/* ── Display row: always shows current MTM target ── */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-white">MTM Exit Target</span>
                  {pos.mtm_target_inr != null || pos.mtm_target_pct != null ? (
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                      ((pos.mtm_target_inr ?? pos.mtm_target_pct ?? 0) >= 0)
                        ? 'bg-green-950 border-green-800 text-score-green'
                        : 'bg-red-950 border-red-800 text-score-red'
                    }`}>
                      {pos.mtm_target_inr != null ? (
                        <>
                          {pos.mtm_target_inr >= 0 ? '↑ Profit' : '↓ Stop'}
                          {' '}₹{Math.abs(pos.mtm_target_inr).toLocaleString('en-IN')}
                        </>
                      ) : (
                        <>
                          {(pos.mtm_target_pct ?? 0) >= 0 ? '↑ Profit' : '↓ Stop'}
                          {' '}{pos.mtm_target_pct}%
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-muted italic">Not set — using individual chunk exits</span>
                  )}
                  {boughtChunks.length > 0 && (
                    <span className="text-[10px] text-muted">
                      (monitors {boughtChunks.length} executed chunk{boughtChunks.length > 1 ? 's' : ''})
                    </span>
                  )}
                  {boughtChunks.length === 0 && (
                    <span className="text-[10px] text-muted">(activates when first chunk executes)</span>
                  )}
                </div>
                <div className="flex gap-2">
                  {(pos.mtm_target_inr != null || pos.mtm_target_pct != null) && (
                    <button onClick={clearMtmTarget}
                      className="text-xs text-muted hover:text-score-red">
                      Clear
                    </button>
                  )}
                  <button onClick={() => setShowMtm(!showMtm)}
                    className="text-xs text-score-blue hover:underline">
                    {showMtm ? 'Hide' : 'Edit'}
                  </button>
                </div>
              </div>

              {/* ── Edit panel — shown when Edit clicked ── */}
              {showMtm && (
                <div className="bg-slate-800 rounded-lg p-3 space-y-3">
                  <div className="text-[10px] text-muted leading-relaxed">
                    Exit <span className="text-white">all executed (BOUGHT) chunks simultaneously</span> when aggregate MTM hits this target.
                    WAITING chunks keep monitoring their own entry price independently.
                    Positive = profit booking. Negative = stop loss.
                  </div>
                  <div className="flex gap-2 items-center flex-wrap">
                    <div className="flex rounded-lg overflow-hidden border border-border">
                      <button onClick={() => setMtmMode('pct')}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors ${mtmMode === 'pct' ? 'bg-blue-600 text-white' : 'text-muted hover:text-white'}`}>
                        % MTM
                      </button>
                      <button onClick={() => setMtmMode('inr')}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors ${mtmMode === 'inr' ? 'bg-blue-600 text-white' : 'text-muted hover:text-white'}`}>
                        ₹ MTM
                      </button>
                    </div>
                    <input
                      type="number"
                      value={mtmValue}
                      step={mtmMode === 'pct' ? 0.5 : 100}
                      onChange={e => setMtmValue(e.target.value)}
                      placeholder={mtmMode === 'pct'
                        ? (pos.mtm_target_pct != null ? `Current: ${pos.mtm_target_pct}%` : 'e.g. 8 or -5')
                        : (pos.mtm_target_inr != null ? `Current: ₹${pos.mtm_target_inr}` : 'e.g. 8000 or -3000')}
                      className="flex-1 min-w-[140px] bg-slate-700 border border-border rounded-lg px-3 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={setMtmTarget} disabled={savingMtm || !mtmValue}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                      {savingMtm ? '…' : 'Save'}
                    </button>
                  </div>
                  {mtmValue && (
                    <div className={`text-[10px] font-medium ${parseFloat(mtmValue) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {parseFloat(mtmValue) >= 0
                        ? `↑ Exit all BOUGHT chunks when MTM profit reaches ${mtmMode === 'pct' ? '+' + mtmValue + '%' : '₹' + parseFloat(mtmValue).toLocaleString('en-IN')}`
                        : `↓ Stop loss: exit all BOUGHT chunks if MTM loss hits ${mtmMode === 'pct' ? mtmValue + '%' : '₹' + parseFloat(mtmValue).toLocaleString('en-IN')}`}
                    </div>
                  )}
                  {mtmMsg && <div className="text-[10px] text-score-green">{mtmMsg}</div>}
                </div>
              )}
            </div>
          )}

          {/* ── Action buttons ───────────────────────────────────────────── */}
          <div className="flex gap-2 pt-1">
            {pos.status === 'ACTIVE' && (
              <>
                <button
                  onClick={() => doAction('pause')}
                  disabled={acting}
                  className="px-3 py-1.5 bg-amber-950 border border-amber-700 text-amber-400 hover:bg-amber-900 rounded-lg text-xs font-medium"
                >
                  ⏸ Pause
                </button>
                <button
                  onClick={() => doAction('cancel')}
                  disabled={acting}
                  className="px-3 py-1.5 bg-card border border-border text-muted hover:border-score-red hover:text-score-red rounded-lg text-xs font-medium"
                >
                  ✕ Cancel
                </button>
              </>
            )}
            {pos.status === 'PAUSED' && (
              <>
                <button
                  onClick={() => doAction('start')}
                  disabled={acting}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium"
                >
                  ▶ Resume
                </button>
                <button
                  onClick={() => doAction('cancel')}
                  disabled={acting}
                  className="px-3 py-1.5 bg-card border border-border text-muted hover:border-score-red hover:text-score-red rounded-lg text-xs font-medium"
                >
                  ✕ Cancel
                </button>
              </>
            )}
            {pos.status === 'CANCELLED' && (
              <button
                onClick={doDelete}
                disabled={acting}
                className="px-3 py-1.5 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded-lg text-xs font-medium"
              >
                🗑 Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Holdings Tab ─────────────────────────────────────────────────────────────

function HoldingsTab({ holdings, loading, onRefresh }: {
  holdings: HoldingAgg[]
  loading: boolean
  onRefresh: () => void
}) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null)
  const [editingExit, setEditingExit] = useState<{ trade_id: string; chunk_no: number } | null>(null)
  const [exitVal, setExitVal] = useState('')
  const [acting, setActing] = useState(false)

  const doExitAll = async (trade_id: string, symbol: string) => {
    if (!window.confirm(`Exit ALL bought chunks of ${shortSymbol(symbol)} at CMP?`)) return
    setActing(true)
    try {
      await client.post(`/paper/trades/${trade_id}/manual-exit-all`)
      onRefresh()
    } finally { setActing(false) }
  }

  const doExitChunk = async (trade_id: string, chunk_no: number, symbol: string) => {
    if (!window.confirm(`Exit Chunk ${chunk_no} of ${shortSymbol(symbol)} at CMP?`)) return
    setActing(true)
    try {
      await client.post(`/paper/trades/${trade_id}/chunks/${chunk_no}/manual-exit`)
      onRefresh()
    } finally { setActing(false) }
  }

  const saveExitPrice = async (trade_id: string, chunk_no: number) => {
    const val = parseFloat(exitVal)
    if (isNaN(val) || val <= 0) return
    setActing(true)
    try {
      await client.put(`/paper/trades/${trade_id}/chunks/${chunk_no}/exit-price`, { exit_price: val })
      setEditingExit(null)
      setExitVal('')
      onRefresh()
    } finally { setActing(false) }
  }

  if (loading) return <div className="text-muted text-sm p-4">Loading…</div>

  if (holdings.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-10 text-center">
        <div className="text-3xl mb-3">💼</div>
        <div className="text-white font-semibold mb-1">No holdings yet</div>
        <div className="text-sm text-muted">Executed chunks appear here once a buy triggers.</div>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
            <th className="text-left px-4 py-3">Stock</th>
            <th className="text-right px-3 py-3">Qty</th>
            <th className="text-right px-3 py-3">Avg Cost</th>
            <th className="text-right px-3 py-3">CMP</th>
            <th className="text-right px-3 py-3">Invested</th>
            <th className="text-right px-3 py-3">Curr Value</th>
            <th className="text-right px-3 py-3">MTM</th>
            <th className="text-right px-3 py-3">Target</th>
            <th className="text-right px-3 py-3">Target P&L</th>
            <th className="px-3 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {holdings.map(h => {
            const isExpanded = expandedSymbol === h.symbol
            const firstTradeId = h.chunk_details[0]?.trade_id

            return (
              <Fragment key={h.symbol}>
                {/* ── Aggregate row ── */}
                <tr
                  className="border-b border-border/50 hover:bg-slate-800/30 cursor-pointer"
                  onClick={() => setExpandedSymbol(isExpanded ? null : h.symbol)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-muted text-xs">{isExpanded ? '▼' : '▶'}</span>
                      <div>
                        <div className="font-bold text-white">{shortSymbol(h.symbol)}</div>
                        <div className="text-xs text-muted truncate max-w-[140px]">{h.company_name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-300">{h.total_quantity.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-3 text-right text-slate-300">₹{h.avg_cost_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-3 text-right text-white">₹{h.current_market_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-3 text-right text-slate-300">{formatINR(h.total_invested)}</td>
                  <td className="px-3 py-3 text-right text-white">{formatINR(h.current_value)}</td>
                  <td className="px-3 py-3 text-right">
                    <div className={`font-medium ${h.mtm_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {h.mtm_inr >= 0 ? '+' : ''}{formatINR(h.mtm_inr)}
                    </div>
                    <div className={`text-xs ${h.mtm_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {h.mtm_pct >= 0 ? '+' : ''}{h.mtm_pct.toFixed(2)}%
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="text-score-blue">{formatINR(h.target_value)}</div>
                    <div className="text-[10px] text-muted">{h.target_label}</div>
                  </td>
                  <td className={`px-3 py-3 text-right font-medium ${h.target_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                    {h.target_pnl >= 0 ? '+' : ''}{formatINR(h.target_pnl)}
                  </td>
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    {firstTradeId && (
                      <button
                        onClick={() => doExitAll(firstTradeId, h.symbol)}
                        disabled={acting}
                        className="px-2.5 py-1.5 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded-lg text-xs font-medium whitespace-nowrap"
                      >
                        🚪 Exit All
                      </button>
                    )}
                  </td>
                </tr>

                {isExpanded && h.chunk_details.length > 0 && (
                  <tr key={`${h.symbol}-expanded`} className="border-b border-border/50">
                    <td colSpan={10} className="px-5 py-4 bg-slate-800/20">
                      <div className="text-xs text-muted mb-3">Individual Chunk Details</div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted border-b border-border/50">
                            <th className="text-center pb-2">Chunk</th>
                            <th className="text-right pb-2">Buy @</th>
                            <th className="text-right pb-2">Qty</th>
                            <th className="text-right pb-2">Cost</th>
                            <th className="text-right pb-2">Exit Target ₹</th>
                            <th className="text-right pb-2">Target Val</th>
                            <th className="text-right pb-2">CMP Val</th>
                            <th className="text-right pb-2">Unrealised</th>
                            <th className="pb-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {h.chunk_details.map(c => {
                            const isEditingThis = editingExit?.trade_id === c.trade_id && editingExit?.chunk_no === c.chunk_no
                            return (
                              <tr key={`${c.trade_id}-${c.chunk_no}`} className="border-b border-border/30">
                                <td className="py-2 text-center">
                                  <span className="w-5 h-5 rounded-full bg-blue-950 border border-blue-800 text-score-blue text-[10px] font-bold inline-flex items-center justify-center">
                                    {c.chunk_no}
                                  </span>
                                </td>
                                <td className="py-2 text-right text-white font-medium">₹{c.buy_price.toFixed(2)}</td>
                                <td className="py-2 text-right text-slate-300">{c.quantity.toLocaleString()}</td>
                                <td className="py-2 text-right text-slate-300">{formatINR(c.cost)}</td>

                                {/* Editable exit price */}
                                <td className="py-2 text-right">
                                  {isEditingThis ? (
                                    <div className="flex items-center gap-1 justify-end">
                                      <input
                                        type="number" value={exitVal} step={0.5}
                                        onChange={e => setExitVal(e.target.value)}
                                        placeholder={c.exit_price.toFixed(2)}
                                        className="w-20 text-right bg-slate-700 border border-blue-500 rounded px-1.5 py-0.5 text-[11px] text-white focus:outline-none"
                                        autoFocus
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') saveExitPrice(c.trade_id, c.chunk_no)
                                          if (e.key === 'Escape') { setEditingExit(null); setExitVal('') }
                                        }}
                                      />
                                      <button onClick={() => saveExitPrice(c.trade_id, c.chunk_no)} disabled={acting}
                                        className="px-1.5 py-0.5 bg-blue-600 text-white rounded text-[10px]">✓</button>
                                      <button onClick={() => { setEditingExit(null); setExitVal('') }}
                                        className="px-1.5 py-0.5 text-muted hover:text-white text-[10px]">✕</button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => { setEditingExit({ trade_id: c.trade_id, chunk_no: c.chunk_no }); setExitVal(c.exit_price.toFixed(2)) }}
                                      className="text-score-green hover:text-green-400 font-medium group flex items-center gap-1 ml-auto"
                                      title="Click to edit exit price"
                                    >
                                      ₹{c.exit_price.toFixed(2)}
                                      <span className="text-muted opacity-0 group-hover:opacity-100 text-[9px]">✏</span>
                                    </button>
                                  )}
                                </td>

                                <td className="py-2 text-right text-score-blue">{formatINR(c.target_value)}</td>
                                <td className="py-2 text-right text-white">{formatINR(c.current_value)}</td>
                                <td className={`py-2 text-right font-medium ${c.unrealised_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                                  {c.unrealised_pnl >= 0 ? '+' : ''}{formatINR(c.unrealised_pnl)}
                                </td>
                                <td className="py-2 pl-2">
                                  <button
                                    onClick={() => doExitChunk(c.trade_id, c.chunk_no, h.symbol)}
                                    disabled={acting}
                                    className="px-2 py-1 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded text-[10px] font-medium whitespace-nowrap"
                                  >
                                    Exit
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Orders log ───────────────────────────────────────────────────────────────

function OrdersLog() {
  const [orders, setOrders] = useState<unknown[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    client.get('/paper/orders').then(r => setOrders(r.data.orders || [])).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-muted text-sm p-4">Loading orders…</div>
  if (!orders.length) return (
    <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted">
      No orders yet. Start a trade to see simulated fills here.
    </div>
  )

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border text-sm font-semibold text-white">Order Log</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted border-b border-border bg-slate-800/40">
            <th className="text-left px-4 py-2.5">Time</th>
            <th className="text-left px-3 py-2.5">Symbol</th>
            <th className="text-center px-3 py-2.5">Side</th>
            <th className="text-center px-3 py-2.5">Chunk</th>
            <th className="text-right px-3 py-2.5">Qty</th>
            <th className="text-right px-3 py-2.5">Trigger</th>
            <th className="text-right px-3 py-2.5">Fill</th>
            <th className="text-right px-3 py-2.5">Amount</th>
            <th className="text-right px-3 py-2.5">P&L</th>
          </tr>
        </thead>
        <tbody>
          {[...orders].reverse().map((o: unknown) => {
            const ord = o as Record<string, unknown>
            const side = ord.side as string
            const pnl = ord.pnl as number | undefined
            return (
              <tr key={ord.order_id as string} className="border-b border-border/40 hover:bg-slate-800/30">
                <td className="px-4 py-2 text-muted">{fmtDate(ord.timestamp as string)}</td>
                <td className="px-3 py-2 font-medium text-white">{shortSymbol(ord.symbol as string)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`px-2 py-0.5 rounded font-bold ${side === 'BUY' ? 'bg-blue-950 text-score-blue' : 'bg-green-950 text-score-green'}`}>
                    {side}
                  </span>
                </td>
                <td className="px-3 py-2 text-center text-slate-300">{ord.chunk_no as number}</td>
                <td className="px-3 py-2 text-right text-slate-300">{(ord.quantity as number).toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-muted">₹{fmt(ord.trigger_price as number)}</td>
                <td className="px-3 py-2 text-right text-white">₹{fmt(ord.fill_price as number)}</td>
                <td className="px-3 py-2 text-right text-slate-300">{formatINR(ord.amount as number)}</td>
                <td className={`px-3 py-2 text-right font-medium ${pnl == null ? 'text-muted' : pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {pnl != null ? `${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── CC Options Positions Tab ─────────────────────────────────────────────────

function CcPositionsTab({ positions, onRefresh }: { positions: CcPosition[]; onRefresh: () => void }) {
  const [closing, setClosing]       = useState<string | null>(null)
  const [closePremium, setClosePremium] = useState<Record<string, string>>({})
  const [acting, setActing]         = useState(false)

  const doClose = async (tid: string) => {
    const p = parseFloat(closePremium[tid] || '0')
    if (!p || p <= 0) return
    setActing(true)
    try {
      await client.post(`/paper/cc-option/${tid}/close`, { close_premium: p })
      setClosing(null)
      onRefresh()
    } finally { setActing(false) }
  }

  const doExpire = async (tid: string) => {
    if (!window.confirm('Mark this CE as expired worthless? You keep the full premium.')) return
    setActing(true)
    try {
      await client.post(`/paper/cc-option/${tid}/expire`)
      onRefresh()
    } finally { setActing(false) }
  }

  const statusBadge = (s: string) => {
    if (s === 'OPEN')    return 'bg-blue-950 border-blue-800 text-score-blue'
    if (s === 'CLOSED')  return 'bg-slate-700 border-slate-600 text-muted'
    if (s === 'EXPIRED') return 'bg-green-950 border-green-800 text-score-green'
    return ''
  }

  if (positions.length === 0) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center">
      <div className="text-3xl mb-3">🔒</div>
      <div className="text-white font-semibold mb-1">No options positions yet</div>
      <div className="text-sm text-muted">Short CE positions from Covered Call plans appear here.</div>
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="text-xs text-blue-400 px-1">
        Short CE positions from Covered Call plans. Close by buying back at a lower premium, or mark as Expired if the option expires worthless.
      </div>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
              <th className="text-left px-5 py-2.5">Stock / Option</th>
              <th className="text-left px-3 py-2.5">Expiry</th>
              <th className="text-right px-3 py-2.5">Sold @</th>
              <th className="text-right px-3 py-2.5">Current LTP</th>
              <th className="text-right px-3 py-2.5">Total Income</th>
              <th className="text-right px-3 py-2.5">MTM P&L</th>
              <th className="text-right px-3 py-2.5">Buy-back Cost</th>
              <th className="text-center px-3 py-2.5">Phase 1</th>
              <th className="text-center px-3 py-2.5">Phase 2</th>
              <th className="text-center px-3 py-2.5">Status</th>
              <th className="text-right px-3 py-2.5">Final P&L</th>
              <th className="px-3 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {positions.map(p => (
              <>
                <tr key={p.trade_id} className="border-b border-border/40 hover:bg-slate-800/20">
                  <td className="px-5 py-3">
                    <div className="font-bold text-white">{p.option_symbol}</div>
                    <div className="text-[10px] text-muted">{p.company_name} · Strike ₹{p.strike} · {p.lots}L × {p.lot_size.toLocaleString('en-IN')}</div>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-300">{p.expiry}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="text-score-green font-semibold">₹{p.sell_premium}</div>
                    <div className="text-[10px] text-muted">per share</div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {p.option_status === 'OPEN' ? (
                      p.current_ltp != null ? (
                        <div>
                          <div className={`font-semibold ${p.current_ltp < p.sell_premium ? 'text-score-green' : 'text-score-red'}`}>
                            ₹{p.current_ltp.toFixed(2)}
                          </div>
                          <div className="text-[10px] text-muted">live</div>
                        </div>
                      ) : <span className="text-muted text-xs">fetching…</span>
                    ) : (
                      p.close_premium != null
                        ? <span className="text-slate-400 text-xs">₹{p.close_premium} (closed)</span>
                        : <span className="text-score-green text-xs">₹0 (expired)</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-score-green font-bold">₹{p.premium_income.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-3 text-right">
                    {p.option_status === 'OPEN' && p.option_mtm_inr != null ? (
                      <div>
                        <div className={`font-bold ${p.option_mtm_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          {p.option_mtm_inr >= 0 ? '+' : ''}₹{Math.abs(p.option_mtm_inr).toLocaleString('en-IN')}
                        </div>
                        <div className={`text-[10px] ${p.option_mtm_pct != null && p.option_mtm_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          {p.option_mtm_pct != null ? `${p.option_mtm_pct >= 0 ? '+' : ''}${p.option_mtm_pct}%` : ''}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-slate-400">
                    {p.option_status === 'OPEN' && p.buy_back_cost != null
                      ? `₹${p.buy_back_cost.toLocaleString('en-IN')}`
                      : '—'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      p.phase1_status === 'BOUGHT' ? 'bg-blue-950 border border-blue-800 text-score-blue' :
                      p.phase1_status === 'SOLD' ? 'bg-green-950 border border-green-800 text-score-green' :
                      'bg-slate-700 text-muted'}`}>
                      {p.phase1_status}
                      {p.phase1_buy_price ? ` @₹${p.phase1_buy_price}` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      p.phase2_status === 'BOUGHT' ? 'bg-blue-950 border border-blue-800 text-score-blue' :
                      p.phase2_status === 'SOLD' ? 'bg-green-950 border border-green-800 text-score-green' :
                      'bg-slate-700 text-muted'}`}>
                      {p.phase2_status}
                      {p.phase2_buy_price ? ` @₹${p.phase2_buy_price}` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${statusBadge(p.option_status)}`}>
                      {p.option_status}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {p.option_pnl != null ? (
                      <span className={`font-bold ${p.option_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {p.option_pnl >= 0 ? '+' : ''}₹{p.option_pnl.toLocaleString('en-IN')}
                      </span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {p.option_status === 'OPEN' && (
                      <div className="flex gap-1">
                        <button onClick={() => setClosing(closing === p.trade_id ? null : p.trade_id)}
                          className="px-2 py-1 bg-card border border-border text-muted hover:text-white rounded text-xs">
                          Close
                        </button>
                        <button onClick={() => doExpire(p.trade_id)} disabled={acting}
                          className="px-2 py-1 bg-green-950 border border-green-800 text-score-green hover:bg-green-900 rounded text-xs">
                          Expired
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {closing === p.trade_id && (
                  <tr key={`${p.trade_id}-close`} className="border-b border-border/40 bg-slate-800/20">
                    <td colSpan={12} className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-300">Buy back {p.option_symbol} at premium:</span>
                        <input type="number" value={closePremium[p.trade_id] || ''} step={0.05} min={0.05}
                          onChange={e => setClosePremium(prev => ({...prev, [p.trade_id]: e.target.value}))}
                          placeholder="e.g. 2.50"
                          className="w-28 bg-slate-800 border border-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                        {closePremium[p.trade_id] && (
                          <span className="text-xs text-slate-400">
                            Cost: ₹{Math.round(parseFloat(closePremium[p.trade_id] || '0') * p.lots * p.lot_size).toLocaleString('en-IN')} |
                            P&L: <span className={p.premium_income - parseFloat(closePremium[p.trade_id] || '0') * p.lots * p.lot_size >= 0 ? 'text-score-green' : 'text-score-red'}>
                              {p.premium_income - parseFloat(closePremium[p.trade_id] || '0') * p.lots * p.lot_size >= 0 ? '+' : ''}
                              ₹{Math.round(p.premium_income - parseFloat(closePremium[p.trade_id] || '0') * p.lots * p.lot_size).toLocaleString('en-IN')}
                            </span>
                          </span>
                        )}
                        <button onClick={() => doClose(p.trade_id)} disabled={acting || !closePremium[p.trade_id]}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-xs font-medium">
                          Confirm Close
                        </button>
                        <button onClick={() => setClosing(null)} className="text-xs text-muted hover:text-white">Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Trade Page ──────────────────────────────────────────────────────────

type TradeTab = 'holdings' | 'portfolio' | 'new_trade' | 'orders' | 'options'

export default function Trade() {
  const [tab, setTab] = useState<TradeTab>('holdings')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [cash, setCash] = useState('')
  const [settingCash, setSettingCash] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get('/paper/summary')
      setSummary(res.data)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Auto-refresh every 6 seconds to match the monitor loop
  useEffect(() => {
    const id = setInterval(refresh, 6_000)
    return () => clearInterval(id)
  }, [refresh])

  const handleSetCash = async () => {
    if (!cash || Number(cash) <= 0) return
    setSettingCash(true)
    await client.post('/paper/cash', { amount: Number(cash) })
    setCash('')
    setSettingCash(false)
    refresh()
  }

  const tradeCreated = () => {
    setTab('portfolio')
    refresh()
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header strip */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: 'Virtual Cash', val: summary ? formatINR(summary.virtual_cash) : '—', color: 'text-white' },
          { label: 'Invested', val: summary ? formatINR(summary.total_invested) : '—', color: 'text-slate-300' },
          { label: 'Unrealised P&L', val: summary ? `${(summary.unrealised_pnl >= 0 ? '+' : '') + formatINR(summary.unrealised_pnl)}` : '—', color: summary && summary.unrealised_pnl >= 0 ? 'text-score-green' : 'text-score-red' },
          { label: 'Realised P&L', val: summary ? `${(summary.realised_pnl >= 0 ? '+' : '') + formatINR(summary.realised_pnl)}` : '—', color: summary && summary.realised_pnl >= 0 ? 'text-score-green' : 'text-score-red' },
          { label: 'Active Trades', val: summary ? String(summary.active_trade_count) : '—', color: 'text-score-blue' },
        ].map(({ label, val, color }) => (
          <div key={label} className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted mb-1">{label}</div>
            <div className={`text-lg font-bold ${color}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Set virtual cash */}
      <div className="flex items-center gap-3 bg-card border border-border rounded-xl px-5 py-3">
        <span className="text-xs text-muted">Set virtual cash:</span>
        <input
          type="number" value={cash}
          onChange={e => setCash(e.target.value)}
          placeholder="e.g. 500000"
          className="w-36 bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSetCash} disabled={settingCash}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium"
        >
          Update
        </button>
        <span className="text-xs text-muted ml-2">
          Paper trading uses virtual money — no real money involved.
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {([
          { key: 'holdings',   label: '💼 Holdings' },
          { key: 'portfolio',  label: '📊 Active Trades' },
          { key: 'new_trade',  label: '+ New Trade' },
          { key: 'orders',     label: '📋 Order Log' },
          { key: 'options',    label: '🔒 Options' },
        ] as { key: TradeTab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key ? 'border-blue-500 text-white' : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'new_trade' && <NewTradeForm onCreated={tradeCreated} />}

      {tab === 'holdings' && (
        <HoldingsTab holdings={summary?.holdings || []} loading={loading} onRefresh={refresh} />
      )}

      {tab === 'portfolio' && (
        <div className="space-y-4">
          {loading && <div className="text-muted text-sm p-4">Loading trades…</div>}

          {/* Holdings moved to dedicated Holdings tab */}
          {!loading && summary?.holdings && summary.holdings.length > 0 && (
            <div className="bg-blue-950 border border-blue-800 rounded-xl px-4 py-2.5 flex items-center justify-between">
              <span className="text-xs text-blue-300">
                {summary.holdings.length} holding{summary.holdings.length > 1 ? 's' : ''} in portfolio
              </span>
              <button onClick={() => setTab('holdings')} className="text-xs text-score-blue hover:underline">
                View Holdings →
              </button>
            </div>
          )}

          {!loading && (!summary || summary.positions.length === 0) && (
            <div className="bg-card border border-border rounded-xl p-10 text-center">
              <div className="text-3xl mb-3">📈</div>
              <div className="text-white font-semibold mb-1">No paper trades yet</div>
              <div className="text-sm text-muted mb-4">Add stocks/ETFs to your Watchlist, then create a trade plan.</div>
              <button onClick={() => setTab('new_trade')}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">
                + Create First Trade
              </button>
            </div>
          )}

          {/* ── Trades with at least one fill — "Active Positions" ── */}
          {(() => {
            const activeFilled = summary?.positions.filter(p => p.has_any_fill && p.status !== 'CANCELLED') || []
            return activeFilled.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs text-muted px-1">Active Positions (partially or fully executed)</div>
                <div className="space-y-3">
                  {activeFilled.map(pos => <TradeCard key={pos.trade_id} pos={pos} onAction={refresh} />)}
                </div>
              </div>
            ) : null
          })()}

          {/* ── Trade Plans — all WAITING (no fills yet) ── */}
          {(() => {
            const plans = summary?.positions.filter(p => !p.has_any_fill && p.status !== 'CANCELLED') || []
            return plans.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs text-muted px-1">Trade Plans — Monitoring entry prices (no fills yet)</div>
                <div className="space-y-3">
                  {plans.map(pos => <TradeCard key={pos.trade_id} pos={pos} onAction={refresh} />)}
                </div>
              </div>
            ) : null
          })()}

          {/* ── Cancelled trades ── */}
          {(() => {
            const cancelled = summary?.positions.filter(p => p.status === 'CANCELLED') || []
            return cancelled.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs text-muted px-1">Cancelled Trades</div>
                <div className="space-y-3">
                  {cancelled.map(pos => <TradeCard key={pos.trade_id} pos={pos} onAction={refresh} />)}
                </div>
              </div>
            ) : null
          })()}
        </div>
      )}

      {tab === 'orders' && <OrdersLog />}

      {tab === 'options' && (
        <CcPositionsTab positions={summary?.cc_positions || []} onRefresh={refresh} />
      )}

      {/* Info footer */}
      <div className="bg-slate-800/60 border border-border rounded-xl p-4 text-xs text-muted space-y-1">
        <div className="font-medium text-slate-400 mb-1">How Paper Trading Works</div>
        <div>1. Add stocks/ETFs to Watchlist (Discover tab) first.</div>
        <div>2. Create a trade plan above — set total allocation, define chunks with entry price and profit % each.</div>
        <div>3. The agent monitors live prices every 60 seconds. When price ≤ chunk entry → simulated BUY. When price ≥ exit target → simulated SELL.</div>
        <div>4. All orders are paper (virtual) — no real money moves. Use this to test your strategy before going live.</div>
      </div>
    </div>
  )
}
