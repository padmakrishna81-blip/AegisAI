import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import client from '../api/client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Holding {
  id: string
  account_holder: string
  broker: string
  symbol: string
  display_symbol: string
  name: string
  exchange: string
  asset_type: string
  qty: number
  avg_cost: number
  currency: string
  buy_date: string
  notes: string
  added_at: string
  is_esop?: boolean
  // enriched
  cmp?: number
  current_value?: number
  value_inr?: number
  cost_inr?: number
  pnl_inr?: number
  pnl?: number
  pnl_pct?: number
  day_chg_pct?: number
}

interface Summary {
  total_value_inr: number
  total_pnl_inr: number
  total_pnl_pct: number
  avg_day_chg_pct: number
  count: number
  esop_count: number
  usdinr_rate: number
  eurinr_rate: number
}

interface HoldingData {
  account_holders: string[]
  holdings: Holding[]
  summary: Summary
}

const BROKERS = ['Sharekhan', 'Angel One', 'ICICI', 'IBKR via ICICI', 'IBKR (Direct)', 'IBKR', 'EQUATEPLUS', 'Zerodha', 'Other']
const EXCHANGES = ['NSE', 'BSE', 'NYSE', 'NASDAQ', 'XETRA', 'Frankfurt']
const CURRENCIES: Record<string, string> = { NSE: 'INR', BSE: 'INR', NYSE: 'USD', NASDAQ: 'USD', XETRA: 'EUR', Frankfurt: 'EUR', EQUATEPLUS: 'EUR' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (v: number, dec = 0) => v?.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) ?? '—'
const fmtPct = (v?: number) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const pnlColor = (v?: number) => !v ? 'text-slate-400' : v >= 0 ? 'text-green-400' : 'text-red-400'

// ─── Blank form ───────────────────────────────────────────────────────────────

function blank(accountHolders: string[]): Partial<Holding> {
  return {
    account_holder: accountHolders[0] ?? 'Self',
    broker: 'ICICI',
    display_symbol: '',
    name: '',
    exchange: 'NSE',
    asset_type: 'stock',
    qty: 0,
    avg_cost: 0,
    currency: 'INR',
    buy_date: '',
    notes: '',
  }
}

// ─── Symbol Search ────────────────────────────────────────────────────────────

interface SearchResult { symbol: string; name: string; exchange?: string; sector?: string }

function SymbolSearch({ exchange, onSelect }: {
  exchange: string
  onSelect: (sym: string, name: string, exch?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = (q: string) => {
    setQuery(q)
    if (q.length < 3) { setResults([]); setOpen(false); return }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const isIndian = exchange === 'NSE' || exchange === 'BSE'
        // Always search global; also search NSE for Indian exchanges
        const [globalRes, nseRes] = await Promise.all([
          client.get(`/global-stocks/search?q=${encodeURIComponent(q)}`).catch(() => ({ data: { results: [] } })),
          isIndian ? client.get(`/nse/search?q=${encodeURIComponent(q)}`).catch(() => ({ data: { results: [] } })) : Promise.resolve({ data: { results: [] } }),
        ])
        const global: SearchResult[] = globalRes.data.results ?? []
        const nse: SearchResult[] = (nseRes.data.results ?? []).map((r: any) => ({
          symbol: r.symbol, name: r.name, exchange: 'NSE',
        }))
        // For Indian exchange: show NSE results first; for others: show matching exchange first
        let merged: SearchResult[]
        if (isIndian) {
          const nseSyms = new Set(nse.map(r => r.symbol))
          merged = [...nse, ...global.filter(r => !nseSyms.has(r.symbol))]
        } else {
          const pref = global.filter(r => r.exchange?.toUpperCase().includes(exchange.toUpperCase()))
          const rest = global.filter(r => !r.exchange?.toUpperCase().includes(exchange.toUpperCase()))
          merged = [...pref, ...rest]
        }
        setResults(merged.slice(0, 10))
        setOpen(true)
      } catch { /* silent */ }
      setSearching(false)
    }, 280)
  }

  const pick = (r: SearchResult) => {
    // Strip exchange suffix for display_symbol
    let bare = r.symbol.replace(/\.(NS|BO|DE|F)$/i, '')
    onSelect(bare, r.name, r.exchange)
    setQuery(bare)
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={query}
        onChange={e => search(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Type 3+ chars to search (e.g. SAP, RELI, NVDA)"
        className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
      />
      {searching && <div className="absolute right-3 top-2.5 text-xs text-muted">…</div>}
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-slate-900 border border-border rounded-lg shadow-xl max-h-56 overflow-y-auto">
          {results.map(r => (
            <button key={r.symbol} onClick={() => pick(r)}
              className="w-full text-left px-3 py-2 hover:bg-slate-700 flex items-center gap-3 border-b border-border/50 last:border-0">
              <span className="text-xs font-mono font-bold text-white w-16 shrink-0">{r.symbol}</span>
              <span className="text-xs text-muted truncate flex-1">{r.name}</span>
              {r.exchange && <span className="text-[10px] text-slate-500 shrink-0">{r.exchange}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Add/Edit Modal ───────────────────────────────────────────────────────────

interface ModalProps {
  mode: 'add' | 'edit'
  initial: Partial<Holding>
  accountHolders: string[]
  onSave: (data: Partial<Holding>) => Promise<void>
  onClose: () => void
}

function AddEditModal({ mode, initial, accountHolders, onSave, onClose }: ModalProps) {
  const [form, setForm] = useState<Partial<Holding>>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: keyof Holding, v: string | number) => {
    setForm(f => {
      const updated = { ...f, [k]: v }
      if (k === 'exchange') updated.currency = CURRENCIES[v as string] ?? 'INR'
      return updated
    })
  }

  const save = async () => {
    if (!form.display_symbol?.trim()) { setErr('Symbol is required'); return }
    if (!form.qty || !form.avg_cost) { setErr('Qty and Avg Cost are required'); return }
    setSaving(true)
    try { await onSave(form) } catch (e: any) { setErr(e?.message ?? 'Save failed') }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="text-base font-semibold text-white">{mode === 'add' ? '+ Add Holding' : 'Edit Holding'}</div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto max-h-[70vh]">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted block mb-1">Account Holder</label>
              <select value={form.account_holder ?? ''} onChange={e => set('account_holder', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
                {accountHolders.map(h => <option key={h}>{h}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Broker</label>
              <select value={form.broker ?? ''} onChange={e => set('broker', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
                {BROKERS.map(b => <option key={b}>{b}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted block mb-1">Symbol (search or type)</label>
              <SymbolSearch
                exchange={form.exchange ?? 'NSE'}
                onSelect={(sym, name, exch) => {
                  const resolvedExch = exch
                    ? (exch.toUpperCase().includes('XETRA') || exch.toUpperCase().includes('GER') ? 'XETRA'
                      : exch.toUpperCase().includes('FRANKFURT') || exch.toUpperCase().includes('FRA') ? 'Frankfurt'
                      : exch.toUpperCase() === 'NYSE' ? 'NYSE'
                      : exch.toUpperCase() === 'NMS' || exch.toUpperCase() === 'NASDAQ' ? 'NASDAQ'
                      : form.exchange ?? 'NSE')
                    : form.exchange ?? 'NSE'
                  setForm(f => ({
                    ...f,
                    display_symbol: sym,
                    name: f.name || name,
                    exchange: resolvedExch,
                    currency: CURRENCIES[resolvedExch] ?? f.currency ?? 'INR',
                  }))
                }}
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Exchange</label>
              <select value={form.exchange ?? 'NSE'} onChange={e => set('exchange', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
                {EXCHANGES.map(x => <option key={x}>{x}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">Company Name</label>
            <input value={form.name ?? ''} onChange={e => set('name', e.target.value)}
              placeholder="e.g. Reliance Industries"
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted block mb-1">Qty</label>
              <input type="number" value={form.qty ?? ''} onChange={e => set('qty', parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Avg Cost ({form.currency ?? 'INR'})</label>
              <input type="number" value={form.avg_cost ?? ''} onChange={e => set('avg_cost', parseFloat(e.target.value) || 0)}
                step="0.01"
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Currency</label>
              <select value={form.currency ?? 'INR'} onChange={e => set('currency', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
                <option>INR</option><option>USD</option><option>EUR</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted block mb-1">Buy Date</label>
              <input type="date" value={form.buy_date ?? ''} onChange={e => set('buy_date', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Asset Type</label>
              <select value={form.asset_type ?? 'stock'} onChange={e => set('asset_type', e.target.value)}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
                {['stock','etf','mf','bond'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">Notes</label>
            <input value={form.notes ?? ''} onChange={e => set('notes', e.target.value)}
              placeholder="Optional notes"
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox"
              checked={!!form.is_esop}
              onChange={e => setForm(f => ({ ...f, is_esop: e.target.checked }))}
              className="w-4 h-4 rounded accent-amber-500" />
            <span className="text-sm text-white">ESOP / RSU <span className="text-xs text-muted ml-1">(exclude from P&amp;L totals, include in Net Worth)</span></span>
          </label>
          {err && <div className="text-red-400 text-xs">{err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-border flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted border border-border rounded-lg hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg">
            {saving ? 'Saving…' : mode === 'add' ? 'Add Holding' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Manage Account Holders Modal ─────────────────────────────────────────────

function ManageHoldersModal({ holders, onSave, onClose }: {
  holders: string[]
  onSave: (h: string[]) => Promise<void>
  onClose: () => void
}) {
  const [list, setList] = useState<string[]>([...holders])
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  const add = () => {
    const n = newName.trim()
    if (n && !list.includes(n)) { setList(l => [...l, n]); setNewName('') }
  }
  const remove = (h: string) => setList(l => l.filter(x => x !== h))
  const save = async () => {
    if (!list.length) return
    setSaving(true)
    await onSave(list)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="text-sm font-semibold text-white">⚙ Manage Account Holders</div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="space-y-1">
            {list.map(h => (
              <div key={h} className="flex items-center justify-between bg-slate-800 rounded px-3 py-2 text-sm text-white">
                {h}
                <button onClick={() => remove(h)} className="text-muted hover:text-red-400 text-xs ml-3">✕</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
              placeholder="New holder name"
              className="flex-1 bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            <button onClick={add} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded">+ Add</button>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-border flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted border border-border rounded-lg hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving || !list.length}
            className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Excel Upload Modal ───────────────────────────────────────────────────────

function ExcelUploadModal({ accountHolders, onDone, onClose }: {
  accountHolders: string[]
  onDone: () => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [imported, setImported] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const parseFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = e => {
      const buf = e.target?.result as ArrayBuffer
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json(ws, { defval: '' })
      setRows(json as any[])
    }
    reader.readAsArrayBuffer(file)
  }

  const confirm = async () => {
    if (!rows.length) return
    setUploading(true)
    try {
      const r = await client.post('/holdings/bulk-import', { rows })
      setImported(r.data.imported)
      setErrors(r.data.errors ?? [])
    } catch { setErrors(['Upload failed']) }
    setUploading(false)
  }

  const downloadTemplate = () => {
    window.open('/api/holdings/template', '_blank')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="text-sm font-semibold text-white">📤 Upload Holdings from Excel / CSV</div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {imported === null ? (
            <>
              <div className="flex items-center gap-3">
                <button onClick={() => fileRef.current?.click()}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">
                  📁 Choose File (.xlsx / .csv)
                </button>
                <button onClick={downloadTemplate}
                  className="px-4 py-2 border border-border text-muted hover:text-white text-sm rounded-lg">
                  ⬇ Download Template
                </button>
                <span className="text-xs text-muted">
                  {rows.length > 0 ? `${rows.length} rows loaded` : 'No file selected'}
                </span>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => e.target.files?.[0] && parseFile(e.target.files[0])} />

              {rows.length > 0 && (
                <div className="overflow-x-auto max-h-64 border border-border rounded-lg">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-800 sticky top-0">
                      <tr>{Object.keys(rows[0]).map(k => (
                        <th key={k} className="px-3 py-2 text-left text-muted whitespace-nowrap">{k}</th>
                      ))}</tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.slice(0, 20).map((r, i) => (
                        <tr key={i} className="hover:bg-slate-800/50">
                          {Object.values(r).map((v: any, j) => (
                            <td key={j} className="px-3 py-1.5 text-white whitespace-nowrap">{String(v)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 20 && <div className="text-xs text-muted px-3 py-2">…and {rows.length - 20} more rows</div>}
                </div>
              )}
              {errors.length > 0 && (
                <div className="text-red-400 text-xs space-y-0.5">{errors.map((e, i) => <div key={i}>{e}</div>)}</div>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <div className="text-4xl mb-3">✓</div>
              <div className="text-white font-semibold">{imported} holding{imported !== 1 ? 's' : ''} imported successfully</div>
              {errors.length > 0 && <div className="text-xs text-amber-400 mt-2">{errors.length} row(s) skipped: {errors.join('; ')}</div>}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-border flex justify-end gap-3">
          <button onClick={() => { onClose(); if (imported !== null) onDone() }}
            className="px-4 py-2 text-sm text-muted border border-border rounded-lg hover:text-white">
            {imported !== null ? 'Close' : 'Cancel'}
          </button>
          {imported === null && (
            <button onClick={confirm} disabled={!rows.length || uploading}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg">
              {uploading ? 'Importing…' : `Import ${rows.length} Rows`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Summary Bar ──────────────────────────────────────────────────────────────

function SummaryBar({ summary }: { summary: Summary }) {
  const tiles = [
    {
      label: 'Portfolio Value (₹)',
      val: `₹${fmt(summary.total_value_inr)}`,
      sub: `$1 = ₹${summary.usdinr_rate} · €1 = ₹${summary.eurinr_rate}`,
      color: 'text-white',
    },
    {
      label: 'Total P&L (₹)',
      val: `${summary.total_pnl_inr >= 0 ? '+' : ''}₹${fmt(Math.abs(summary.total_pnl_inr))}`,
      sub: `${fmtPct(summary.total_pnl_pct)}${summary.esop_count > 0 ? ` · ${summary.esop_count} ESOP excl.` : ''}`,
      color: pnlColor(summary.total_pnl_inr),
    },
    {
      label: "Today's Change",
      val: fmtPct(summary.avg_day_chg_pct),
      sub: 'weighted avg',
      color: pnlColor(summary.avg_day_chg_pct),
    },
    {
      label: 'Holdings',
      val: String(summary.count),
      sub: 'across all accounts',
      color: 'text-blue-400',
    },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
      {tiles.map(t => (
        <div key={t.label} className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted mb-1">{t.label}</div>
          <div className={`text-xl font-bold ${t.color}`}>{t.val}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{t.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Holding Row ──────────────────────────────────────────────────────────────

function HoldingRow({ h, onEdit, onDelete }: {
  h: Holding
  onEdit: () => void
  onDelete: () => void
}) {
  const cs = h.currency === 'USD' ? '$' : h.currency === 'EUR' ? '€' : '₹'
  return (
    <tr className="border-b border-border hover:bg-slate-800/40 transition-colors">
      <td className="px-3 py-2.5 text-xs font-medium text-slate-300 whitespace-nowrap">{h.account_holder}</td>
      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">{h.broker}</td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <div className="text-sm font-semibold text-white flex items-center gap-1.5">
          {h.display_symbol}
          {h.is_esop && <span className="text-[9px] bg-amber-900 text-amber-300 border border-amber-700 px-1 py-0.5 rounded font-bold">ESOP</span>}
        </div>
        <div className="text-[10px] text-muted">{h.exchange}</div>
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-300 max-w-[140px] truncate">{h.name}</td>
      <td className="px-3 py-2.5 text-sm text-white text-right tabular-nums">{fmt(h.qty)}</td>
      <td className="px-3 py-2.5 text-sm text-white text-right tabular-nums">{cs}{fmt(h.avg_cost, 2)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {h.cmp ? (
          <div className="text-sm font-semibold text-white">{cs}{fmt(h.cmp, 2)}</div>
        ) : <span className="text-muted text-xs">—</span>}
      </td>
      <td className="px-3 py-2.5 text-sm text-white text-right tabular-nums">
        {h.current_value ? `${cs}${fmt(h.current_value)}` : '—'}
      </td>
      {/* Net Worth in ₹ */}
      <td className="px-3 py-2.5 text-sm text-right tabular-nums">
        {h.value_inr != null && h.value_inr > 0
          ? <span className="text-sky-300 font-semibold">₹{fmt(h.value_inr)}</span>
          : <span className="text-muted">—</span>}
      </td>
      <td className={`px-3 py-2.5 text-sm text-right tabular-nums font-semibold ${h.is_esop ? 'text-slate-600' : pnlColor(h.pnl)}`}>
        {h.is_esop
          ? <span title="ESOP — excluded from totals">—</span>
          : h.pnl != null ? `${h.pnl >= 0 ? '+' : ''}${cs}${fmt(Math.abs(h.pnl))}` : '—'}
      </td>
      {/* Net P&L in ₹ */}
      <td className={`px-3 py-2.5 text-sm text-right tabular-nums font-semibold ${h.is_esop ? 'text-slate-600' : pnlColor(h.pnl_inr)}`}>
        {h.is_esop
          ? <span title="ESOP — excluded from totals">—</span>
          : h.pnl_inr != null ? `${h.pnl_inr >= 0 ? '+' : ''}₹${fmt(Math.abs(h.pnl_inr))}` : '—'}
      </td>
      <td className={`px-3 py-2.5 text-xs text-right tabular-nums ${h.is_esop ? 'text-slate-600' : pnlColor(h.pnl_pct)}`}>
        {h.is_esop ? '—' : fmtPct(h.pnl_pct)}
      </td>
      <td className={`px-3 py-2.5 text-xs text-right tabular-nums ${pnlColor(h.day_chg_pct)}`}>
        {fmtPct(h.day_chg_pct)}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">{h.buy_date || '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <div className="flex items-center gap-1">
          <button onClick={onEdit}
            className="px-2 py-1 text-xs text-slate-400 hover:text-white border border-transparent hover:border-border rounded transition-colors" title="Edit">✎</button>
          <button onClick={onDelete}
            className="px-2 py-1 text-xs text-slate-500 hover:text-red-400 border border-transparent hover:border-red-800 rounded transition-colors" title="Delete">✕</button>
        </div>
      </td>
    </tr>
  )
}

// ─── Sort Icon ────────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'
interface Sort { col: string; dir: SortDir }

function SortTh({ label, col, sort, onSort, className = '' }: {
  label: string; col: string; sort: Sort; onSort: (c: string) => void; className?: string
}) {
  const active = sort.col === col
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-3 py-2.5 text-left text-xs font-semibold text-muted cursor-pointer select-none whitespace-nowrap hover:text-white ${active ? 'text-white' : ''} ${className}`}
    >
      {label} {active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Holdings() {
  const [data, setData] = useState<HoldingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filterHolder, setFilterHolder] = useState('All')
  const [filterBroker, setFilterBroker] = useState('All')
  const [sort, setSort] = useState<Sort>({ col: 'account_holder', dir: 'asc' })
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
  const [editTarget, setEditTarget] = useState<Holding | null>(null)
  const [showManage, setShowManage] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const fetchData = async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true)
    try {
      const r = await client.get('/holdings/list')
      setData(r.data)
    } catch { /* silent */ }
    setLoading(false); setRefreshing(false)
  }

  useEffect(() => {
    fetchData()
    const t = setInterval(() => fetchData(true), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const toggleSort = (col: string) => {
    setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  }

  const accountHolders = data?.account_holders ?? ['Self', 'Mother', 'HUF']

  const filtered = (data?.holdings ?? []).filter(h => {
    if (filterHolder !== 'All' && h.account_holder !== filterHolder) return false
    if (filterBroker !== 'All' && h.broker !== filterBroker) return false
    return true
  }).sort((a, b) => {
    const mul = sort.dir === 'asc' ? 1 : -1
    const va = (a as any)[sort.col] ?? ''
    const vb = (b as any)[sort.col] ?? ''
    return mul * (va < vb ? -1 : va > vb ? 1 : 0)
  })

  const uniqueBrokers = Array.from(new Set((data?.holdings ?? []).map(h => h.broker)))

  const handleAdd = async (form: Partial<Holding>) => {
    await client.post('/holdings/add', form)
    await fetchData()
    setModalMode(null)
  }

  const handleEdit = async (form: Partial<Holding>) => {
    if (!editTarget) return
    await client.put(`/holdings/${editTarget.id}`, form)
    await fetchData()
    setModalMode(null); setEditTarget(null)
  }

  const handleDelete = async (id: string) => {
    await client.delete(`/holdings/${id}`)
    await fetchData()
    setDeleteConfirm(null)
  }

  const handleSaveHolders = async (holders: string[]) => {
    await client.put('/holdings/account-holders', { holders })
    await fetchData()
    setShowManage(false)
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full p-20">
      <div className="text-muted text-sm">Loading holdings…</div>
    </div>
  )

  return (
    <div className="p-5 space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">💼 Holdings</h1>
          <p className="text-xs text-muted mt-0.5">All accounts · Live CMP · Multi-broker</p>
        </div>
        {refreshing && <span className="text-xs text-muted animate-pulse">Refreshing…</span>}
      </div>

      {/* Summary tiles */}
      {data?.summary && <SummaryBar summary={data.summary} />}

      {/* Controls */}
      <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
        {/* Account holder filters */}
        <div className="flex gap-1 flex-wrap">
          {['All', ...accountHolders].map(h => (
            <button key={h} onClick={() => setFilterHolder(h)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                filterHolder === h
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800 border-border text-muted hover:text-white'
              }`}>
              {h}
            </button>
          ))}
          <button onClick={() => setShowManage(true)}
            className="px-2 py-1.5 text-xs text-muted border border-border rounded-lg hover:text-white" title="Manage account holders">⚙</button>
        </div>

        {/* Broker filter */}
        <select value={filterBroker} onChange={e => setFilterBroker(e.target.value)}
          className="bg-slate-800 border border-border text-sm text-white rounded-lg px-3 py-1.5 focus:outline-none">
          <option value="All">All Brokers</option>
          {uniqueBrokers.map(b => <option key={b}>{b}</option>)}
        </select>

        <div className="flex-1" />

        {/* Action buttons */}
        <button onClick={() => { setEditTarget(null); setModalMode('add') }}
          className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg">
          + Add Holding
        </button>
        <button onClick={() => setShowUpload(true)}
          className="px-4 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
          📤 Upload Excel
        </button>
        <button onClick={() => fetchData(true)} disabled={refreshing}
          className="px-4 py-1.5 text-xs font-semibold border border-border text-muted hover:text-white rounded-lg disabled:opacity-40">
          ⟳ Refresh
        </button>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-800/60 border-b border-border">
              <tr>
                <SortTh label="Account" col="account_holder" sort={sort} onSort={toggleSort} />
                <SortTh label="Broker" col="broker" sort={sort} onSort={toggleSort} />
                <SortTh label="Symbol" col="display_symbol" sort={sort} onSort={toggleSort} />
                <SortTh label="Name" col="name" sort={sort} onSort={toggleSort} />
                <SortTh label="Qty" col="qty" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Avg Cost" col="avg_cost" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="CMP" col="cmp" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Value" col="current_value" sort={sort} onSort={toggleSort} className="text-right" />
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-sky-400 whitespace-nowrap">Net Worth (₹)</th>
                <SortTh label="P&L" col="pnl" sort={sort} onSort={toggleSort} className="text-right" />
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-emerald-400 whitespace-nowrap">Net P&L (₹)</th>
                <SortTh label="P&L %" col="pnl_pct" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Day %" col="day_chg_pct" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Buy Date" col="buy_date" sort={sort} onSort={toggleSort} />
                <th className="px-3 py-2.5 text-xs text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={15} className="py-16 text-center text-muted text-sm">
                    {data?.holdings.length === 0
                      ? 'No holdings yet. Click "+ Add Holding" or upload an Excel file.'
                      : 'No holdings match the current filter.'}
                  </td>
                </tr>
              ) : filtered.map(h => (
                <HoldingRow key={h.id} h={h}
                  onEdit={() => { setEditTarget(h); setModalMode('edit') }}
                  onDelete={() => setDeleteConfirm(h.id)} />
              ))}
              {/* Totals row */}
              {filtered.length > 0 && (() => {
                const totalNetWorth = filtered.reduce((s, h) => s + (h.value_inr ?? 0), 0)
                const totalPnlInr   = filtered.filter(h => !h.is_esop).reduce((s, h) => s + (h.pnl_inr ?? 0), 0)
                const esopCount     = filtered.filter(h => h.is_esop).length
                return (
                  <tr className="border-t-2 border-border bg-slate-800/60 font-semibold">
                    <td colSpan={7} className="px-3 py-2.5 text-xs text-muted">
                      TOTAL ({filtered.length} holdings{esopCount > 0 ? ` · ${esopCount} ESOP excl. from P&L` : ''})
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted text-right">—</td>
                    <td className="px-3 py-2.5 text-sm text-right tabular-nums">
                      <span className="text-sky-300 font-bold">₹{fmt(totalNetWorth)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted text-right">—</td>
                    <td className={`px-3 py-2.5 text-sm text-right tabular-nums font-bold ${pnlColor(totalPnlInr)}`}>
                      {totalPnlInr >= 0 ? '+' : ''}₹{fmt(Math.abs(totalPnlInr))}
                    </td>
                    <td colSpan={3} />
                  </tr>
                )
              })()}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-2 border-t border-border text-xs text-muted">
            {filtered.length} of {data?.holdings.length} holdings
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {modalMode && (
        <AddEditModal
          mode={modalMode}
          initial={modalMode === 'edit' && editTarget ? editTarget : blank(accountHolders)}
          accountHolders={accountHolders}
          onSave={modalMode === 'add' ? handleAdd : handleEdit}
          onClose={() => { setModalMode(null); setEditTarget(null) }}
        />
      )}

      {/* Manage account holders */}
      {showManage && (
        <ManageHoldersModal
          holders={accountHolders}
          onSave={handleSaveHolders}
          onClose={() => setShowManage(false)}
        />
      )}

      {/* Excel Upload */}
      {showUpload && (
        <ExcelUploadModal
          accountHolders={accountHolders}
          onDone={() => fetchData()}
          onClose={() => setShowUpload(false)}
        />
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full mx-4 space-y-4">
            <div className="text-white font-semibold">Remove this holding?</div>
            <div className="text-sm text-muted">This action cannot be undone.</div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-muted border border-border rounded-lg hover:text-white">Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)}
                className="px-4 py-2 text-sm bg-red-700 hover:bg-red-800 text-white font-semibold rounded-lg">Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
