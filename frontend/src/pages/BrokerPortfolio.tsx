import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import client from '../api/client'
import type { BrokerHolding, BrokerFunds, BrokerOrder, BrokerPosition, BrokerStatus } from '../types'

type Tab = 'holdings' | 'positions' | 'funds' | 'orders'
type Phase = 'loading' | 'not_configured' | 'not_connected' | 'connected'

function fmtExpiry(iso: string | null | undefined): string {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

function BrokerBadge({ broker }: { broker: string }) {
  const isAO = broker === 'Angel One'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
      isAO ? 'bg-orange-950/60 text-orange-300 border-orange-800/40'
           : 'bg-red-950/60 text-red-300 border-red-800/40'
    }`}>{broker}</span>
  )
}

function PnlCell({ val, pct }: { val: number; pct?: number }) {
  const pos = val >= 0
  return (
    <td className={`px-4 py-2.5 text-right font-semibold ${pos ? 'text-score-green' : 'text-score-red'}`}>
      <div>{pos ? '+' : ''}₹{Math.abs(val).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
      {pct !== undefined && (
        <div className="text-[10px] font-normal opacity-70">{pos ? '+' : ''}{pct.toFixed(2)}%</div>
      )}
    </td>
  )
}

// ── Symbol constants ──────────────────────────────────────────────────────────

const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']
const STOCK_SYMBOLS = [
  'RELIANCE','TCS','INFOSYS','HDFCBANK','ICICIBANK','WIPRO','AXISBANK',
  'BAJFINANCE','KOTAKBANK','LT','SBIN','MARUTI','SUNPHARMA','HINDUNILVR',
  'ULTRACEMCO','ADANIENT','ADANIPORTS','POWERGRID','NTPC','ONGC','COALINDIA',
  'BPCL','ITC','NESTLEIND','ASIANPAINT','BAJAJFINSV','DIVISLAB','DRREDDY',
  'CIPLA','HEROMOTOCO','EICHERMOT','M&M','TATAMOTORS','TATASTEEL','JSWSTEEL',
  'HINDALCO','VEDL','GRASIM','INDUSINDBK','HCLTECH','TECHM','MPHASIS',
  'PERSISTENT','LTIM','FEDERALBNK','PIDILITIND','TITAN','TRENT','DMART',
  'ZOMATO','BHARTIARTL','BAJAJ-AUTO','BRITANNIA','LUPIN','TORNTPHARM','HAVELLS',
  'SIEMENS','ABB','CUMMINSIND','BOSCHLTD','GODREJCP','MARICO','COLPAL',
  'TATACONSUM','PIDILITIND','BERGEPAINT','KANSAINER','ASTRAL','POLYCAB',
]

// Expiry day: 4=Thu(NIFTY/MIDCP), 3=Wed(BANKNIFTY), 2=Tue(FINNIFTY), 1=Mon(SENSEX/BANKEX)
const INDEX_EXPIRY_DAY: Record<string, number> = {
  NIFTY: 4, MIDCPNIFTY: 4, BANKNIFTY: 3, FINNIFTY: 2, SENSEX: 1, BANKEX: 1,
}
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

function getUpcomingExpiries(base: string, count = 8): string[] {
  const expiryDay = INDEX_EXPIRY_DAY[base] ?? 4
  const result: string[] = []
  const now = new Date()
  const cur = new Date(now)
  let ahead = (expiryDay - cur.getDay() + 7) % 7
  if (ahead === 0) ahead = 7
  cur.setDate(cur.getDate() + ahead)
  for (let i = 0; i < count; i++) {
    const d = String(cur.getDate()).padStart(2, '0')
    const m = MONTHS[cur.getMonth()]
    const y = String(cur.getFullYear()).slice(-2)
    result.push(`${d}${m}${y}`)
    cur.setDate(cur.getDate() + 7)
  }
  return result
}

// ── Option Chain types ────────────────────────────────────────────────────────

interface OCLeg {
  ltp: number; iv: number; oi: number; oi_chg: number
  vol: number; bid: number; ask: number; pchg: number
}
interface OCStrike {
  strike: number; is_atm: boolean
  CE: OCLeg | null; PE: OCLeg | null
}
interface OCData {
  symbol: string; spot: number; expiry: string; expiries: string[]
  atm: number; ce_max_oi: number; pe_max_oi: number; strikes: OCStrike[]
}

interface OptionChainPanelProps {
  symbol: string
  initialExpiry?: string
  onSelect: (strike: number, type: 'CE' | 'PE', ltp: number, expiry: string) => void
  onClose: () => void
}

function OptionChainPanel({ symbol, initialExpiry, onSelect, onClose }: OptionChainPanelProps) {
  const [data, setData]       = useState<OCData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [expiry, setExpiry]   = useState(initialExpiry ?? '')
  const [showAll, setShowAll] = useState(false)

  const fetchChain = async (exp: string) => {
    setLoading(true); setError(null)
    try {
      const qs = exp
        ? `?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(exp)}`
        : `?symbol=${encodeURIComponent(symbol)}`
      const r = await client.get(`/broker/option-chain${qs}`)
      setData(r.data)
      if (!exp && r.data.expiry) setExpiry(r.data.expiry)
    } catch (e: unknown) {
      setError(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
          ?? 'Failed to load option chain'
      )
    } finally { setLoading(false) }
  }

  useEffect(() => {
    fetchChain(expiry)
  }, [expiry]) // eslint-disable-line react-hooks/exhaustive-deps

  const spot       = data?.spot ?? 0
  const ceMaxOi    = data?.ce_max_oi ?? 1
  const peMaxOi    = data?.pe_max_oi ?? 1
  const allStrikes = data?.strikes ?? []
  const visStrikes = showAll
    ? allStrikes
    : allStrikes.filter(s => Math.abs(s.strike - spot) / (spot || 1) <= 0.10)
  const hasHidden  = allStrikes.length > visStrikes.length

  const fmtNum = (n: number, d = 0) =>
    n.toLocaleString('en-IN', { maximumFractionDigits: d })
  const fmtOI = (n: number) =>
    n >= 100000 ? `${(n / 100000).toFixed(1)}L`
    : n >= 1000  ? `${(n / 1000).toFixed(1)}K`
    : String(n)

  return (
    <div className="bg-slate-900 border border-indigo-800/50 rounded-xl overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-indigo-950/40">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-bold text-white text-sm">{symbol}</span>
          {spot > 0 && (
            <span className="text-xs text-slate-300">
              Spot: <span className="font-semibold text-white">₹{fmtNum(spot, 2)}</span>
            </span>
          )}
          <span className="text-[10px] text-indigo-300 bg-indigo-950/60 border border-indigo-800/40 px-2 py-0.5 rounded">
            Click LTP to fill order
          </span>
        </div>
        <button onClick={onClose} className="text-muted hover:text-white text-xl leading-none px-1 ml-2">×</button>
      </div>

      {/* Expiry tabs */}
      {data && data.expiries.length > 0 && (
        <div className="flex gap-1 px-4 py-2 overflow-x-auto border-b border-border bg-slate-800/30">
          {data.expiries.map(ex => (
            <button key={ex} onClick={() => setExpiry(ex)}
              className={`px-3 py-1 rounded text-[10px] font-medium whitespace-nowrap transition-colors ${
                ex === expiry
                  ? 'bg-indigo-700 text-white'
                  : 'bg-slate-700/60 text-muted hover:text-white'
              }`}>{ex}</button>
          ))}
        </div>
      )}

      {/* Loading / Error */}
      {loading && (
        <div className="py-10 text-center text-muted animate-pulse text-xs">Loading option chain…</div>
      )}
      {error && !loading && (
        <div className="py-6 text-center text-score-red text-xs">{error}</div>
      )}

      {/* Table */}
      {!loading && data && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] text-muted border-b border-border bg-slate-800/50 uppercase tracking-wider">
                {/* CE side (right-aligned) */}
                <th className="px-1 py-1.5 text-right">OI</th>
                <th className="px-1 py-1.5 text-right w-16">OI Bar</th>
                <th className="px-1 py-1.5 text-right">Chg%</th>
                <th className="px-1 py-1.5 text-right">IV</th>
                <th className="px-2 py-1.5 text-right font-bold text-blue-300">LTP (CE)</th>
                <th className="px-1 py-1.5 text-right">Bid/Ask</th>
                {/* Strike */}
                <th className="px-3 py-1.5 text-center font-bold text-white">Strike</th>
                {/* PE side (left-aligned) */}
                <th className="px-1 py-1.5 text-left">Bid/Ask</th>
                <th className="px-2 py-1.5 text-left font-bold text-amber-300">LTP (PE)</th>
                <th className="px-1 py-1.5 text-left">IV</th>
                <th className="px-1 py-1.5 text-left">Chg%</th>
                <th className="px-1 py-1.5 text-left w-16">OI Bar</th>
                <th className="px-1 py-1.5 text-left">OI</th>
              </tr>
            </thead>
            <tbody>
              {visStrikes.map(row => {
                const ce    = row.CE
                const pe    = row.PE
                const isAtm = row.is_atm
                const itmCE = row.strike < spot  // CE ITM: strike below spot
                const itmPE = row.strike > spot  // PE ITM: strike above spot

                const rowBg = isAtm
                  ? 'bg-yellow-950/30 border-yellow-800/20'
                  : 'border-border/20'

                return (
                  <tr key={row.strike}
                    className={`border-b ${rowBg} hover:bg-slate-800/30 transition-colors`}>

                    {/* CE — OI */}
                    <td className={`px-1 py-1.5 text-right text-slate-300 ${itmCE ? 'bg-blue-950/20' : ''}`}>
                      {ce ? fmtOI(ce.oi) : '—'}
                    </td>
                    {/* CE — OI bar */}
                    <td className={`px-1 py-1.5 ${itmCE ? 'bg-blue-950/20' : ''}`}>
                      <div className="flex justify-end items-center h-4">
                        {ce && (
                          <div className="h-2 bg-emerald-600/70 rounded-sm"
                            style={{ width: `${Math.min((ce.oi / ceMaxOi) * 60, 60)}px` }} />
                        )}
                      </div>
                    </td>
                    {/* CE — Chg% */}
                    <td className={`px-1 py-1.5 text-right ${itmCE ? 'bg-blue-950/20' : ''}`}>
                      {ce ? (
                        <span className={ce.pchg >= 0 ? 'text-score-green' : 'text-score-red'}>
                          {ce.pchg >= 0 ? '+' : ''}{ce.pchg.toFixed(1)}%
                        </span>
                      ) : '—'}
                    </td>
                    {/* CE — IV */}
                    <td className={`px-1 py-1.5 text-right text-slate-300 ${itmCE ? 'bg-blue-950/20' : ''}`}>
                      {ce ? `${ce.iv.toFixed(1)}%` : '—'}
                    </td>
                    {/* CE — LTP (clickable) */}
                    <td
                      className={`px-2 py-1.5 text-right cursor-pointer hover:bg-blue-900/40 rounded ${itmCE ? 'bg-blue-950/20' : ''}`}
                      onClick={() => ce && onSelect(row.strike, 'CE', ce.ltp, expiry)}
                    >
                      <span className={`font-semibold text-blue-200 ${isAtm ? 'font-bold' : ''}`}>
                        {ce ? `₹${fmtNum(ce.ltp, 2)}` : '—'}
                      </span>
                    </td>
                    {/* CE — Bid/Ask */}
                    <td className={`px-1 py-1.5 text-right text-slate-400 ${itmCE ? 'bg-blue-950/20' : ''}`}>
                      {ce ? `${fmtNum(ce.bid, 1)}/${fmtNum(ce.ask, 1)}` : '—'}
                    </td>

                    {/* Strike */}
                    <td className={`px-3 py-1.5 text-center font-bold ${isAtm ? 'text-yellow-400 text-xs' : 'text-slate-200'}`}>
                      {row.strike.toLocaleString('en-IN')}
                      {isAtm && <span className="ml-1 text-[8px] text-yellow-500 font-normal">ATM</span>}
                    </td>

                    {/* PE — Bid/Ask */}
                    <td className={`px-1 py-1.5 text-left text-slate-400 ${itmPE ? 'bg-amber-950/20' : ''}`}>
                      {pe ? `${fmtNum(pe.bid, 1)}/${fmtNum(pe.ask, 1)}` : '—'}
                    </td>
                    {/* PE — LTP (clickable) */}
                    <td
                      className={`px-2 py-1.5 text-left cursor-pointer hover:bg-amber-900/40 rounded ${itmPE ? 'bg-amber-950/20' : ''}`}
                      onClick={() => pe && onSelect(row.strike, 'PE', pe.ltp, expiry)}
                    >
                      <span className={`font-semibold text-amber-200 ${isAtm ? 'font-bold' : ''}`}>
                        {pe ? `₹${fmtNum(pe.ltp, 2)}` : '—'}
                      </span>
                    </td>
                    {/* PE — IV */}
                    <td className={`px-1 py-1.5 text-left text-slate-300 ${itmPE ? 'bg-amber-950/20' : ''}`}>
                      {pe ? `${pe.iv.toFixed(1)}%` : '—'}
                    </td>
                    {/* PE — Chg% */}
                    <td className={`px-1 py-1.5 text-left ${itmPE ? 'bg-amber-950/20' : ''}`}>
                      {pe ? (
                        <span className={pe.pchg >= 0 ? 'text-score-green' : 'text-score-red'}>
                          {pe.pchg >= 0 ? '+' : ''}{pe.pchg.toFixed(1)}%
                        </span>
                      ) : '—'}
                    </td>
                    {/* PE — OI bar */}
                    <td className={`px-1 py-1.5 ${itmPE ? 'bg-amber-950/20' : ''}`}>
                      <div className="flex items-center h-4">
                        {pe && (
                          <div className="h-2 bg-red-600/70 rounded-sm"
                            style={{ width: `${Math.min((pe.oi / peMaxOi) * 60, 60)}px` }} />
                        )}
                      </div>
                    </td>
                    {/* PE — OI */}
                    <td className={`px-1 py-1.5 text-left text-slate-300 ${itmPE ? 'bg-amber-950/20' : ''}`}>
                      {pe ? fmtOI(pe.oi) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Show all strikes toggle */}
      {!loading && data && hasHidden && (
        <div className="px-4 py-2 border-t border-border bg-slate-800/30 text-center">
          <button onClick={() => setShowAll(v => !v)}
            className="text-[10px] text-indigo-400 hover:text-indigo-300">
            {showAll
              ? 'Show fewer strikes (±10% of spot)'
              : `Show all ${allStrikes.length} strikes (${allStrikes.length - visStrikes.length} hidden)`}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Trade Panel ───────────────────────────────────────────────────────────────

interface TradeForm {
  broker: string; symbol: string; token: string; exchange: string
  side: string; qty: string; price: string; order_type: string; product: string
}

function TradePanel({ connectedBrokers, onOrderPlaced }: {
  connectedBrokers: string[]
  onOrderPlaced: () => void
}) {
  const [form, setForm] = useState<TradeForm>({
    broker: connectedBrokers[0] ?? 'angelone',
    symbol: '', token: '', exchange: 'NSE',
    side: 'BUY', qty: '', price: '', order_type: 'MARKET', product: 'INTRADAY',
  })
  const [placing, setPlacing] = useState(false)
  const [msg, setMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  // Symbol picker state
  const [symQuery, setSymQuery]       = useState('')
  const [showList, setShowList]       = useState(false)
  const [selectedBase, setSelectedBase] = useState('')
  const symRef = useRef<HTMLDivElement>(null)

  // Option chain builder state (active when NFO + index)
  const [ocExpiry, setOcExpiry] = useState('')
  const [ocStrike, setOcStrike] = useState('')
  const [ocType,   setOcType]   = useState<'CE' | 'PE'>('CE')

  // Live option chain panel
  const [showChain,   setShowChain]   = useState(false)
  const [chainExpiry, setChainExpiry] = useState('')

  const isNFOIndex = INDEX_SYMBOLS.includes(selectedBase) && form.exchange === 'NFO'
  const expiries   = isNFOIndex ? getUpcomingExpiries(selectedBase) : []

  // Auto-build NFO trading symbol from components
  useEffect(() => {
    if (isNFOIndex && ocExpiry && ocStrike) {
      setForm(f => ({ ...f, symbol: `${selectedBase}${ocExpiry}${ocStrike.replace(/\D/g, '')}${ocType}` }))
    }
  }, [isNFOIndex, selectedBase, ocExpiry, ocStrike, ocType])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (symRef.current && !symRef.current.contains(e.target as Node)) setShowList(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const allSymbols = [
    ...INDEX_SYMBOLS.map(s => ({ sym: s, cat: 'Index' })),
    ...STOCK_SYMBOLS.map(s => ({ sym: s, cat: 'Stock' })),
  ]
  const filtered = symQuery
    ? allSymbols.filter(s => s.sym.includes(symQuery.toUpperCase())).slice(0, 20)
    : allSymbols.slice(0, 24)

  const selectBase = (sym: string, cat: string) => {
    setSelectedBase(sym)
    setSymQuery(sym)
    setShowList(false)
    setOcExpiry(''); setOcStrike(''); setOcType('CE')
    // For stocks on NSE, the trading symbol IS the base symbol
    if (cat === 'Stock') {
      setForm(f => ({ ...f, symbol: sym, exchange: 'NSE' }))
    } else {
      // Index: clear symbol until OC components are filled
      setForm(f => ({ ...f, symbol: sym, exchange: f.exchange === 'NSE' ? 'NFO' : f.exchange }))
    }
  }

  const set = (k: keyof TradeForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const place = async () => {
    if (!form.symbol || !form.qty) { setMsg({ ok: false, text: 'Symbol and qty are required' }); return }
    setPlacing(true); setMsg(null)
    try {
      const body = {
        broker: form.broker, symbol: form.symbol.toUpperCase(), token: form.token,
        exchange: form.exchange, side: form.side, qty: parseInt(form.qty),
        price: parseFloat(form.price || '0'), order_type: form.order_type, product: form.product,
      }
      const r = await client.post('/broker/place-order', body)
      setMsg({ ok: true, text: `✓ Order placed — ID: ${r.data.order_id || 'submitted'}` })
      setForm(f => ({ ...f, symbol: '', token: '', qty: '', price: '' }))
      setSymQuery(''); setSelectedBase(''); setOcExpiry(''); setOcStrike('')
      onOrderPlaced()
    } catch (e: unknown) {
      const err = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Order failed'
      setMsg({ ok: false, text: err })
    } finally { setPlacing(false) }
  }

  const inputCls = 'w-full bg-slate-800 border border-border rounded-lg px-2.5 py-2 text-xs text-white placeholder-muted focus:outline-none focus:border-indigo-500'
  const selectCls = inputCls + ' cursor-pointer'

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="text-sm font-semibold text-white">Place Order</div>

      {/* Row 1: Broker / Exchange / Symbol search */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Broker */}
        <div>
          <label className="text-[10px] text-muted block mb-1">Broker</label>
          <select value={form.broker} onChange={set('broker')} className={selectCls}>
            {connectedBrokers.map(b => (
              <option key={b} value={b}>{b === 'angelone' ? 'Angel One' : 'Kotak Neo'}</option>
            ))}
          </select>
        </div>

        {/* Exchange */}
        <div>
          <label className="text-[10px] text-muted block mb-1">Exchange</label>
          <select value={form.exchange} onChange={e => {
            const ex = e.target.value
            setForm(f => ({ ...f, exchange: ex }))
            // If user switches to NFO while an index is selected, rebuild
            if (ex !== 'NFO') { setOcExpiry(''); setOcStrike('') }
          }} className={selectCls}>
            {['NSE','BSE','NFO','MCX','CDS'].map(x => <option key={x}>{x}</option>)}
          </select>
        </div>

        {/* Symbol search */}
        <div className="col-span-2 relative" ref={symRef}>
          <label className="text-[10px] text-muted block mb-1">Underlying Symbol</label>
          <input
            value={symQuery}
            onChange={e => { setSymQuery(e.target.value); setShowList(true); setSelectedBase('') }}
            onFocus={() => setShowList(true)}
            placeholder="Search: NIFTY, RELIANCE, TCS…"
            className={inputCls}
          />
          {showList && filtered.length > 0 && (
            <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-slate-900 border border-border rounded-xl shadow-xl max-h-60 overflow-y-auto">
              {/* Group header: indices */}
              {filtered.some(s => s.cat === 'Index') && (
                <div className="px-3 pt-2 pb-1 text-[9px] text-muted uppercase tracking-wider sticky top-0 bg-slate-900">Indices</div>
              )}
              {filtered.filter(s => s.cat === 'Index').map(({ sym }) => (
                <button key={sym} onMouseDown={() => selectBase(sym, 'Index')}
                  className="w-full text-left px-3 py-2 text-xs text-white hover:bg-indigo-900/50 flex items-center gap-2">
                  <span className="text-[9px] bg-indigo-900 text-indigo-300 px-1.5 py-0.5 rounded font-mono">IDX</span>
                  <span className="font-semibold">{sym}</span>
                  <span className="text-muted text-[10px] ml-auto">{INDEX_EXPIRY_DAY[sym] === 4 ? 'Thu expiry' : INDEX_EXPIRY_DAY[sym] === 3 ? 'Wed expiry' : INDEX_EXPIRY_DAY[sym] === 2 ? 'Tue expiry' : 'Mon expiry'}</span>
                </button>
              ))}
              {/* Stocks */}
              {filtered.some(s => s.cat === 'Stock') && (
                <div className="px-3 pt-2 pb-1 text-[9px] text-muted uppercase tracking-wider sticky top-0 bg-slate-900 border-t border-border/50">Stocks (NSE)</div>
              )}
              {filtered.filter(s => s.cat === 'Stock').map(({ sym }) => (
                <button key={sym} onMouseDown={() => selectBase(sym, 'Stock')}
                  className="w-full text-left px-3 py-2 text-xs text-white hover:bg-slate-800 flex items-center gap-2">
                  <span className="text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">EQ</span>
                  <span>{sym}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Option Chain Builder — only for NFO index */}
      {isNFOIndex && (
        <div className="bg-slate-800/50 border border-indigo-900/50 rounded-xl p-3 space-y-2">
          <div className="text-[10px] text-indigo-300 font-medium uppercase tracking-wider mb-1">
            Option Chain — {selectedBase}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {/* Expiry */}
            <div>
              <label className="text-[10px] text-muted block mb-1">Expiry</label>
              <select value={ocExpiry} onChange={e => setOcExpiry(e.target.value)} className={selectCls}>
                <option value="">-- select --</option>
                {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
            {/* Strike */}
            <div>
              <label className="text-[10px] text-muted block mb-1">Strike</label>
              <input value={ocStrike} onChange={e => setOcStrike(e.target.value)}
                placeholder={selectedBase === 'BANKNIFTY' ? '54000' : '24500'}
                className={inputCls} />
            </div>
            {/* CE / PE */}
            <div>
              <label className="text-[10px] text-muted block mb-1">Type</label>
              <div className="flex gap-1 h-[34px]">
                {(['CE', 'PE'] as const).map(t => (
                  <button key={t} onClick={() => setOcType(t)}
                    className={`flex-1 rounded-lg text-xs font-bold border transition-colors ${
                      ocType === t
                        ? t === 'CE' ? 'bg-blue-800 border-blue-700 text-blue-100' : 'bg-amber-800 border-amber-700 text-amber-100'
                        : 'bg-slate-800 border-border text-muted hover:text-white'
                    }`}>{t}</button>
                ))}
              </div>
            </div>
          </div>
          {/* Symbol preview */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <span className="text-[10px] text-muted">Trading symbol:</span>
            <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${form.symbol && ocExpiry && ocStrike ? 'text-green-300 bg-green-950/40 border border-green-800/40' : 'text-slate-500 bg-slate-800 border border-border'}`}>
              {form.symbol && ocExpiry && ocStrike ? form.symbol : `${selectedBase}__________`}
            </span>
            <button
              onClick={() => setShowChain(v => !v)}
              className="px-3 py-1 text-xs bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg font-medium"
            >
              {showChain ? 'Hide Chain' : 'View Live Chain'}
            </button>
          </div>
        </div>
      )}

      {/* Direct symbol input for manual/stock entry */}
      {!isNFOIndex && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className="text-[10px] text-muted block mb-1">Trading Symbol</label>
            <div className="flex gap-2">
              <input value={form.symbol} onChange={set('symbol')}
                placeholder={form.exchange === 'NFO' ? 'e.g. NIFTY27NOV2524500CE' : selectedBase || 'e.g. RELIANCE'}
                className={inputCls} />
              {selectedBase && form.exchange === 'NFO' && (
                <button
                  onClick={() => setShowChain(v => !v)}
                  className="px-3 py-1 text-xs bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg font-medium whitespace-nowrap"
                >
                  {showChain ? 'Hide Chain' : 'View Chain'}
                </button>
              )}
            </div>
          </div>
          <div className="col-span-2">
            <label className="text-[10px] text-muted block mb-1">Token (optional)</label>
            <input value={form.token} onChange={set('token')} placeholder="e.g. 35001" className={inputCls} />
          </div>
        </div>
      )}

      {/* Live Option Chain Panel */}
      {showChain && selectedBase && (
        <OptionChainPanel
          symbol={selectedBase}
          initialExpiry={ocExpiry || chainExpiry}
          onSelect={(strike, type, _ltp, expiry) => {
            setOcExpiry(expiry)
            setOcStrike(String(strike))
            setOcType(type)
            setChainExpiry(expiry)
            setShowChain(false)
          }}
          onClose={() => setShowChain(false)}
        />
      )}

      {/* Row: Side / Qty / Order Type / Product */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Side */}
        <div>
          <label className="text-[10px] text-muted block mb-1">Side</label>
          <div className="flex gap-1">
            {['BUY','SELL'].map(s => (
              <button key={s} onClick={() => setForm(f => ({ ...f, side: s }))}
                className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${
                  form.side === s
                    ? s === 'BUY' ? 'bg-green-800 border-green-700 text-white' : 'bg-red-800 border-red-700 text-white'
                    : 'bg-slate-800 border-border text-muted hover:text-white'
                }`}>{s}</button>
            ))}
          </div>
        </div>
        {/* Qty */}
        <div>
          <label className="text-[10px] text-muted block mb-1">Quantity</label>
          <input type="number" min="1" value={form.qty} onChange={set('qty')} placeholder="50" className={inputCls} />
        </div>
        {/* Order type */}
        <div>
          <label className="text-[10px] text-muted block mb-1">Order Type</label>
          <select value={form.order_type} onChange={set('order_type')} className={selectCls}>
            <option value="MARKET">Market</option>
            <option value="LIMIT">Limit</option>
          </select>
        </div>
        {/* Limit price or product */}
        {form.order_type === 'LIMIT' ? (
          <div>
            <label className="text-[10px] text-muted block mb-1">Limit Price</label>
            <input type="number" step="0.05" value={form.price} onChange={set('price')} placeholder="0.00" className={inputCls} />
          </div>
        ) : (
          <div>
            <label className="text-[10px] text-muted block mb-1">Product</label>
            <select value={form.product} onChange={set('product')} className={selectCls}>
              <option value="INTRADAY">Intraday (MIS)</option>
              <option value="DELIVERY">Delivery (CNC)</option>
              <option value="CARRYFORWARD">Carry Forward (NRML)</option>
            </select>
          </div>
        )}
      </div>

      {/* Product row when LIMIT order pushed it out */}
      {form.order_type === 'LIMIT' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="text-[10px] text-muted block mb-1">Product</label>
            <select value={form.product} onChange={set('product')} className={selectCls}>
              <option value="INTRADAY">Intraday (MIS)</option>
              <option value="DELIVERY">Delivery (CNC)</option>
              <option value="CARRYFORWARD">Carry Forward (NRML)</option>
            </select>
          </div>
        </div>
      )}

      {/* Order confirmation preview */}
      {form.symbol && form.qty && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${
          form.side === 'BUY' ? 'bg-green-950/20 border-green-900/40' : 'bg-red-950/20 border-red-900/40'
        }`}>
          <span className={form.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>▶</span>
          <span className="text-slate-300">
            <span className={`font-bold ${form.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{form.side}</span>
            {' '}<span className="text-white font-mono">{form.symbol}</span>
            {' '}× <span className="text-white">{form.qty}</span>
            {' at '}<span className="text-white">{form.order_type === 'LIMIT' ? `₹${form.price || '?'} Limit` : 'Market'}</span>
            {' via '}<span className="text-slate-400">{form.exchange}</span>
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={place} disabled={placing || !form.symbol}
          className={`px-6 py-2 rounded-lg text-sm font-bold disabled:opacity-50 transition-colors ${
            form.side === 'BUY'
              ? 'bg-green-700 hover:bg-green-600 text-white'
              : 'bg-red-700 hover:bg-red-600 text-white'
          }`}>
          {placing ? 'Placing…' : `Place ${form.side} Order`}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? 'text-score-green' : 'text-score-red'}`}>{msg.text}</span>
        )}
      </div>
      <div className="text-[10px] text-slate-500">
        Market orders execute at best available price. Verify symbol and qty before placing.
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BrokerPortfolio() {
  const navigate = useNavigate()
  const [phase, setPhase]           = useState<Phase>('loading')
  const [status, setStatus]         = useState<BrokerStatus>({})
  const [tab, setTab]               = useState<Tab>('positions')
  const [holdings, setHoldings]     = useState<BrokerHolding[]>([])
  const [positions, setPositions]   = useState<BrokerPosition[]>([])
  const [funds, setFunds]           = useState<Record<string, BrokerFunds>>({})
  const [orders, setOrders]         = useState<BrokerOrder[]>([])
  const [tabLoading, setTabLoading] = useState(false)
  const [tabError, setTabError]     = useState<string | null>(null)
  const [authError, setAuthError]   = useState(false)   // session expired
  const [connecting, setConnecting] = useState<'angelone' | 'kotak' | null>(null)
  const [connectMsg, setConnectMsg] = useState<{ broker: string; ok: boolean; text: string } | null>(null)
  const [syncing, setSyncing]       = useState(false)
  const [syncMsg, setSyncMsg]       = useState<string | null>(null)
  const [tabDataLoaded, setTabDataLoaded] = useState<Set<Tab>>(new Set())
  const [closing, setClosing]       = useState<string | null>(null)
  const [closeMsg, setCloseMsg]     = useState<{ symbol: string; ok: boolean; text: string } | null>(null)
  const [showTradePanel, setShowTradePanel] = useState(false)

  // refreshStatus never resets phase to 'loading' after the first load — avoids flash
  const firstLoad = useRef(true)
  const refreshStatus = useCallback(async () => {
    try {
      const r = await client.get('/broker/status')
      const s: BrokerStatus = r.data
      setStatus(s)
      const anyConfigured = !!(s.angelone?.configured || s.kotak?.configured)
      const anyConnected  = !!(s.angelone?.connected  || s.kotak?.connected)
      if (!anyConfigured)      setPhase('not_configured')
      else if (!anyConnected)  setPhase('not_connected')
      else                     setPhase('connected')
    } catch { setPhase('not_configured') }
    finally  { firstLoad.current = false }
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  useEffect(() => {
    if (phase !== 'connected') return
    if (tabDataLoaded.has(tab)) return
    loadTabData(tab)
  }, [phase, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadTabData = async (t: Tab) => {
    setTabLoading(true); setTabError(null); setAuthError(false)
    try {
      if (t === 'holdings') {
        const r = await client.get('/broker/holdings')
        setHoldings(r.data.holdings ?? [])
        if (r.data.errors?.length) setTabError(r.data.errors.join('; '))
      } else if (t === 'positions') {
        const r = await client.get('/broker/positions')
        setPositions(r.data.positions ?? [])
        if (r.data.errors?.length) setTabError(r.data.errors.join('; '))
      } else if (t === 'funds') {
        const r = await client.get('/broker/funds')
        setFunds(r.data.funds ?? {})
        if (r.data.errors?.length) setTabError(r.data.errors.join('; '))
      } else {
        const r = await client.get('/broker/orders')
        setOrders(r.data.orders ?? [])
      }
      // Mark loaded on success (prevents retry on next tab switch back)
      setTabDataLoaded(prev => new Set(prev).add(t))
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to load'
      setTabError(msg)
      // Mark loaded even on failure — prevents infinite retry loop on tab switch
      setTabDataLoaded(prev => new Set(prev).add(t))
      // If it looks like a session/auth error, re-check broker status
      const isAuth = msg.toLowerCase().includes('session') ||
                     msg.toLowerCase().includes('token') ||
                     msg.toLowerCase().includes('unauthori') ||
                     msg.toLowerCase().includes('login') ||
                     (e as { response?: { status?: number } })?.response?.status === 401
      if (isAuth) {
        setAuthError(true)
        await refreshStatus()   // may flip phase to not_connected
      }
    } finally { setTabLoading(false) }
  }

  const refreshTab = () => {
    setTabDataLoaded(prev => { const s = new Set(prev); s.delete(tab); return s })
    setAuthError(false)
    loadTabData(tab)
  }

  const connectBroker = async (broker: 'angelone' | 'kotak') => {
    setConnecting(broker); setConnectMsg(null)
    try {
      const r = await client.post('/broker/connect', { broker })
      setConnectMsg({ broker, ok: true, text: r.data.message || 'Connected successfully' })
      await refreshStatus()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Connection failed'
      setConnectMsg({ broker, ok: false, text: msg })
    } finally { setConnecting(null) }
  }

  const disconnectBroker = async (broker: 'angelone' | 'kotak') => {
    await client.delete(`/broker/disconnect/${broker}`)
    setHoldings([]); setPositions([]); setFunds({}); setOrders([])
    setTabDataLoaded(new Set())
    await refreshStatus()
  }

  const closePosition = async (pos: BrokerPosition) => {
    setClosing(pos.symbol); setCloseMsg(null)
    try {
      const r = await client.post('/broker/close-position', {
        broker:   pos.broker === 'Angel One' ? 'angelone' : 'kotak',
        symbol:   pos.symbol,
        token:    pos.token,
        exchange: pos.exchange,
        qty:      pos.close_qty,
        side:     pos.close_side,
        product:  pos.product || 'CARRYFORWARD',
      })
      setCloseMsg({ symbol: pos.symbol, ok: true, text: `Closed — Order ID: ${r.data.order_id || 'submitted'}` })
      // Refresh positions + orders after a brief delay
      setTimeout(() => {
        setTabDataLoaded(prev => { const s = new Set(prev); s.delete('positions'); s.delete('orders'); return s })
        loadTabData('positions')
      }, 1500)
    } catch (e: unknown) {
      const err = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Close failed'
      setCloseMsg({ symbol: pos.symbol, ok: false, text: err })
    } finally { setClosing(null) }
  }

  const syncToHoldings = async () => {
    setSyncing(true); setSyncMsg(null)
    try {
      const r = await client.post('/broker/sync-to-holdings')
      setSyncMsg(`✓ Synced ${r.data.synced} holdings to AegisAI`)
    } catch { setSyncMsg('✗ Sync failed') }
    finally { setSyncing(false) }
  }

  const connectedBrokerNames = (Object.entries(status) as [string, { connected?: boolean; configured?: boolean; expires_at?: string | null }][])
    .filter(([, s]) => s?.connected).map(([name]) => name)

  const totalPosPnl  = positions.reduce((s, p) => s + p.unrealised + p.realised, 0)
  const totalValue   = holdings.reduce((s, h) => s + h.ltp * h.qty, 0)
  const totalHldPnl  = holdings.reduce((s, h) => s + h.pnl, 0)
  const totalCash    = Object.values(funds).reduce((s, f) => s + (f?.available_cash ?? 0), 0)

  // ── not_configured ──────────────────────────────────────────────────────────
  if (phase === 'loading') return (
    <div className="flex items-center justify-center h-full p-10">
      <div className="text-muted animate-pulse text-sm">Checking broker connections…</div>
    </div>
  )

  if (phase === 'not_configured') return (
    <div className="p-6 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-white mb-6">🏦 Broker Portfolio</h1>
      <div className="bg-card border border-border rounded-xl p-8 text-center space-y-4">
        <div className="text-4xl">🔌</div>
        <div className="text-white font-semibold text-lg">No broker configured yet</div>
        <div className="text-sm text-muted max-w-xs mx-auto">
          Add your Angel One or Kotak Neo API credentials in Settings to get started.
        </div>
        <Link to="/settings"
          className="inline-block mt-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium">
          ⚙ Go to Settings → Broker Connections
        </Link>
      </div>
    </div>
  )

  if (phase === 'not_connected') return (
    <div className="p-6 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-white mb-6">🏦 Broker Portfolio</h1>
      <div className="space-y-4">
        {(['angelone', 'kotak'] as const).map(broker => {
          const s = status[broker]; if (!s?.configured) return null
          const label = broker === 'angelone' ? 'Angel One' : 'Kotak Neo'
          const myMsg = connectMsg?.broker === broker ? connectMsg : null
          return (
            <div key={broker} className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">{broker === 'angelone' ? '🟠' : '🔴'}</span>
                <div>
                  <div className="font-semibold text-white">{label}</div>
                  <div className="text-xs text-muted">Credentials saved — session expired or not started</div>
                </div>
              </div>
              <button onClick={() => connectBroker(broker)} disabled={connecting === broker}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                {connecting === broker ? 'Connecting…' : `⚡ Connect ${label}`}
              </button>
              {myMsg && (
                <div className={`text-xs px-3 py-2 rounded-lg ${myMsg.ok ? 'bg-green-950 border border-green-800 text-score-green' : 'bg-red-950 border border-red-800 text-score-red'}`}>
                  {myMsg.ok ? '✓' : '✗'} {myMsg.text}
                </div>
              )}
            </div>
          )
        })}
        <div className="text-center">
          <Link to="/settings" className="text-xs text-indigo-400 underline">Update credentials in Settings</Link>
        </div>
      </div>
    </div>
  )

  // ── connected ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">🏦 Broker Portfolio</h1>
          <div className="flex gap-4 mt-1.5 flex-wrap">
            {(['angelone', 'kotak'] as const).map(broker => {
              const s = status[broker]; if (!s?.configured) return null
              const label = broker === 'angelone' ? 'Angel One' : 'Kotak Neo'
              return (
                <div key={broker} className="flex items-center gap-1.5 text-xs">
                  <span className={`w-2 h-2 rounded-full inline-block ${s.connected ? 'bg-score-green' : 'bg-slate-500'}`} />
                  <span className={s.connected ? 'text-score-green' : 'text-muted'}>{label}</span>
                  {s.connected && s.expires_at && (
                    <span className="text-[10px] text-slate-500">· until {fmtExpiry(s.expires_at)}</span>
                  )}
                  {s.connected
                    ? <button onClick={() => disconnectBroker(broker)} className="text-[10px] text-slate-500 hover:text-score-red ml-1">disconnect</button>
                    : <button onClick={() => connectBroker(broker)} disabled={connecting === broker}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300 ml-1 disabled:opacity-50">
                        {connecting === broker ? 'connecting…' : 'reconnect'}
                      </button>
                  }
                </div>
              )
            })}
          </div>
          {connectMsg && (
            <div className={`mt-1.5 text-xs ${connectMsg.ok ? 'text-score-green' : 'text-score-red'}`}>
              {connectMsg.ok ? '✓' : '✗'} {connectMsg.text}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowTradePanel(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              showTradePanel ? 'bg-indigo-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white'
            }`}>
            {showTradePanel ? '✕ Close Trade Panel' : '⚡ Trade'}
          </button>
          <button onClick={refreshTab}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Trade panel (collapsible) */}
      {showTradePanel && connectedBrokerNames.length > 0 && (
        <TradePanel
          connectedBrokers={connectedBrokerNames}
          onOrderPlaced={() => {
            setTabDataLoaded(prev => { const s = new Set(prev); s.delete('orders'); return s })
            setTab('orders')
          }}
        />
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Open Positions P&L</div>
          <div className={`text-lg font-bold ${totalPosPnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
            {positions.length > 0 ? `${totalPosPnl >= 0 ? '+' : ''}₹${Math.abs(totalPosPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
          </div>
          <div className="text-[10px] text-muted mt-0.5">{positions.length} open position{positions.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Holdings Value</div>
          <div className="text-lg font-bold text-white">
            {holdings.length > 0 ? `₹${totalValue.toLocaleString('en-IN')}` : '—'}
          </div>
          <div className={`text-[10px] mt-0.5 ${totalHldPnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
            {holdings.length > 0 ? `${totalHldPnl >= 0 ? '+' : ''}₹${Math.abs(totalHldPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })} P&L` : ''}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-[10px] text-muted uppercase tracking-wide mb-1">Available Cash</div>
          <div className="text-lg font-bold text-white">
            {Object.keys(funds).length > 0 ? `₹${totalCash.toLocaleString('en-IN')}` : '—'}
          </div>
          <div className="text-[10px] text-muted mt-0.5">From broker margin account</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1 w-fit">
        {([
          ['positions', `Positions${positions.length ? ` (${positions.length})` : ''}`],
          ['holdings',  `Holdings${holdings.length ? ` (${holdings.length})` : ''}`],
          ['funds',     'Funds & Margin'],
          ['orders',    'Orders Today'],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-blue-600 text-white' : 'text-muted hover:text-white'
            }`}>{label}</button>
        ))}
      </div>

      {tabError && !authError && (
        <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-800/30 rounded-lg px-3 py-2">⚠ {tabError}</div>
      )}

      {authError && (
        <div className="bg-red-950/40 border border-red-800/50 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-red-300">Session expired — broker not connected</div>
            <div className="text-xs text-red-400 mt-0.5">Your Angel One / Kotak session has timed out. Reconnect to resume trading.</div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => navigate('/settings')}
              className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg text-xs font-medium">
              ⚙ Settings
            </button>
            <button onClick={refreshStatus}
              className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white rounded-lg text-xs font-medium">
              ↻ Recheck
            </button>
          </div>
        </div>
      )}
      {tabLoading && (
        <div className="text-center py-10 text-muted animate-pulse text-sm">Loading from broker…</div>
      )}

      {/* ── Positions tab ─────────────────────────────────────────────────── */}
      {!tabLoading && tab === 'positions' && (
        <div className="space-y-3">
          {closeMsg && (
            <div className={`text-xs px-3 py-2 rounded-lg border ${
              closeMsg.ok ? 'bg-green-950 border-green-800 text-score-green' : 'bg-red-950 border-red-800 text-score-red'
            }`}>{closeMsg.ok ? '✓' : '✗'} {closeMsg.symbol}: {closeMsg.text}</div>
          )}
          {positions.length === 0 ? (
            <div className="text-center py-10 text-muted text-sm bg-card border border-border rounded-xl">
              No open positions. Options/F&O positions appear here when you have active trades.
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                    <th className="text-left px-4 py-2.5">Symbol</th>
                    <th className="text-center px-3 py-2.5">Broker</th>
                    <th className="text-center px-3 py-2.5">Side</th>
                    <th className="text-right px-3 py-2.5">Qty</th>
                    <th className="text-right px-3 py-2.5">Avg</th>
                    <th className="text-right px-3 py-2.5">LTP</th>
                    <th className="text-right px-4 py-2.5">Unrealised</th>
                    <th className="text-right px-4 py-2.5">Realised</th>
                    <th className="text-center px-3 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-slate-800/20">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-white font-mono text-xs">{p.symbol}</div>
                        <div className="text-[10px] text-muted">
                          {p.exchange}{p.expiry ? ` · exp ${p.expiry}` : ''}
                          {p.product ? ` · ${p.product}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center"><BrokerBadge broker={p.broker} /></td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                          p.side === 'LONG' ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'
                        }`}>{p.side}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-white font-mono text-xs">
                        {p.net_qty > 0 ? '+' : ''}{p.net_qty}
                      </td>
                      <td className="px-3 py-2.5 text-right text-muted">
                        ₹{p.avg_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 text-right text-white">
                        ₹{p.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <PnlCell val={p.unrealised} />
                      <PnlCell val={p.realised} />
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => closePosition(p)}
                          disabled={closing === p.symbol}
                          className="px-2.5 py-1 bg-red-900/60 hover:bg-red-800 border border-red-800/50 text-score-red text-[10px] font-semibold rounded-lg disabled:opacity-40 transition-colors"
                        >
                          {closing === p.symbol ? '…' : `Close (${p.close_side} ${p.close_qty})`}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Holdings tab ──────────────────────────────────────────────────── */}
      {!tabLoading && tab === 'holdings' && (
        <div className="space-y-3">
          {holdings.length === 0 ? (
            <div className="text-center py-10 text-muted text-sm bg-card border border-border rounded-xl">
              No equity holdings in connected broker account.
            </div>
          ) : (
            <>
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                      <th className="text-left px-4 py-2.5">Symbol</th>
                      <th className="text-center px-3 py-2.5">Broker</th>
                      <th className="text-right px-3 py-2.5">Qty</th>
                      <th className="text-right px-3 py-2.5">Avg Price</th>
                      <th className="text-right px-3 py-2.5">LTP</th>
                      <th className="text-right px-4 py-2.5">P&L</th>
                      <th className="text-right px-4 py-2.5">P&L%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-slate-800/20">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-white">{h.symbol}</div>
                          <div className="text-[10px] text-muted">{h.exchange}</div>
                        </td>
                        <td className="px-3 py-2.5 text-center"><BrokerBadge broker={h.broker} /></td>
                        <td className="px-3 py-2.5 text-right text-white">{h.qty.toLocaleString('en-IN')}</td>
                        <td className="px-3 py-2.5 text-right text-muted">₹{h.avg_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2.5 text-right text-white">₹{h.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                        <PnlCell val={h.pnl} pct={h.pnl_pct} />
                        <td className={`px-4 py-2.5 text-right ${h.pnl_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          {h.pnl_pct >= 0 ? '+' : ''}{h.pnl_pct.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={syncToHoldings} disabled={syncing}
                  className="px-4 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                  {syncing ? 'Syncing…' : '⇄ Sync to AegisAI Holdings'}
                </button>
                {syncMsg && <span className={`text-xs ${syncMsg.startsWith('✓') ? 'text-score-green' : 'text-score-red'}`}>{syncMsg}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Funds tab ─────────────────────────────────────────────────────── */}
      {!tabLoading && tab === 'funds' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.keys(funds).length === 0 ? (
            <div className="col-span-2 text-center py-10 text-muted text-sm bg-card border border-border rounded-xl">
              No fund data. Click ↻ Refresh.
            </div>
          ) : Object.entries(funds).map(([broker, f]) => (
            <div key={broker} className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <BrokerBadge broker={f.broker} />
                <span className="font-semibold text-white">{f.broker}</span>
              </div>
              <div className="space-y-2">
                {[
                  { label: 'Available Cash', value: f.available_cash, color: 'text-score-green' },
                  { label: 'Used Margin',    value: f.used_margin,    color: 'text-score-red'   },
                  { label: 'Net',            value: f.net,            color: f.net >= 0 ? 'text-score-green' : 'text-score-red' },
                  { label: 'Total Margin',   value: f.total_margin,   color: 'text-white'       },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center justify-between border-b border-border/20 pb-1.5">
                    <span className="text-xs text-muted">{label}</span>
                    <span className={`text-sm font-semibold ${color}`}>₹{value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Orders tab ────────────────────────────────────────────────────── */}
      {!tabLoading && tab === 'orders' && (
        <div>
          {orders.length === 0 ? (
            <div className="text-center py-10 text-muted text-sm bg-card border border-border rounded-xl">No orders today.</div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                    <th className="text-left px-4 py-2.5">Time</th>
                    <th className="text-left px-3 py-2.5">Symbol</th>
                    <th className="text-center px-3 py-2.5">Side</th>
                    <th className="text-right px-3 py-2.5">Qty</th>
                    <th className="text-right px-3 py-2.5">Price</th>
                    <th className="text-center px-3 py-2.5">Type</th>
                    <th className="text-center px-4 py-2.5">Status</th>
                    <th className="text-left px-4 py-2.5">Order ID</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-slate-800/20">
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {(o.time || o.timestamp) ? new Date(o.time || o.timestamp || '').toLocaleTimeString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-white font-mono text-xs">{o.symbol}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded font-bold ${o.side === 'BUY' ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'}`}>
                          {o.side}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-white">{o.qty}</td>
                      <td className="px-3 py-2.5 text-right text-muted">
                        {o.price > 0 ? `₹${o.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : 'MKT'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-xs text-muted">{o.order_type}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          (o.status ?? '').toLowerCase().includes('complet') ? 'bg-green-950 text-score-green' :
                          (o.status ?? '').toLowerCase().includes('reject')  ? 'bg-red-950 text-score-red' :
                          'bg-slate-700 text-muted'
                        }`}>{o.status || 'placed'}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted font-mono">{o.order_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
