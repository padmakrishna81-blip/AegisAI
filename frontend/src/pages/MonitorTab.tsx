import { useState, useEffect, useRef } from 'react'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

// ── Types ──────────────────────────────────────────────────────────────────────

interface MonitorStock {
  symbol: string
  name: string
  sector: string
  exchange?: string
  added_at: string
  kpi_labels: string[]
  quarters: Record<string, { kpis?: Record<string, string>; notes?: string }>
}

interface MonitorData {
  indian: MonitorStock[]
  global: MonitorStock[]
}

interface QuarterRow {
  label: string
  date: string | null
  revenue_cr?: number | null
  pat_cr?: number | null
  revenue_m?: number | null
  pat_m?: number | null
  gross_margin_pct?: number | null
  op_margin_pct?: number | null
  net_margin_pct?: number | null
  eps?: number | null
}

interface FinancialsData {
  symbol: string
  is_indian: boolean
  currency: string
  quarters: QuarterRow[]
}

interface Headline {
  title: string
  source: string
  link: string
  published: number
  tag: string
}

interface OutlookData {
  symbol: string
  headlines: Headline[]
  summary: string
}

// ── Tag colors ────────────────────────────────────────────────────────────────
const TAG_COLORS: Record<string, string> = {
  results:    'bg-blue-950 border-blue-700 text-blue-300',
  order:      'bg-green-950 border-green-700 text-green-300',
  expansion:  'bg-purple-950 border-purple-700 text-purple-300',
  guidance:   'bg-amber-950 border-amber-700 text-amber-300',
  management: 'bg-slate-800 border-slate-600 text-slate-300',
  policy:     'bg-cyan-950 border-cyan-700 text-cyan-300',
  global:     'bg-indigo-950 border-indigo-700 text-indigo-300',
  general:    'bg-slate-800 border-slate-600 text-slate-400',
}

// ── Global stock search ───────────────────────────────────────────────────────
function GlobalSearchInput({ onAdd }: { onAdd: (s: { symbol: string; name: string; exchange: string }) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const timer = useRef<any>(null)

  useEffect(() => {
    if (q.length < 2) { setResults([]); return }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await client.get(`/global-stocks/search?q=${encodeURIComponent(q)}`)
        setResults(r.data.results || [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 350)
  }, [q])

  return (
    <div className="relative">
      <input
        value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search NASDAQ/NYSE stocks (e.g. ORCL, MSFT)…"
        className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
      />
      {results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-xl max-h-52 overflow-y-auto">
          {results.map((r: any) => (
            <button key={r.symbol}
              onClick={() => { onAdd({ symbol: r.symbol, name: r.name, exchange: r.exchange }); setQ(''); setResults([]) }}
              className="w-full text-left px-3 py-2 hover:bg-slate-700 text-sm">
              <span className="text-white font-medium">{r.symbol}</span>
              <span className="text-muted ml-2 text-xs">{r.name}</span>
              <span className="float-right text-[10px] text-muted">{r.exchange}</span>
            </button>
          ))}
        </div>
      )}
      {searching && <div className="absolute right-3 top-2.5 text-xs text-muted">…</div>}
    </div>
  )
}

// ── Inline editable cell ──────────────────────────────────────────────────────
function EditableCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  if (editing) return (
    <input ref={ref} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onSave(draft) }}
      onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onSave(draft) } if (e.key === 'Escape') { setEditing(false); setDraft(value) } }}
      className="w-full bg-slate-700 border border-blue-500 rounded px-1 py-0.5 text-xs text-white focus:outline-none min-w-[60px]"
    />
  )
  return (
    <div onClick={() => { setEditing(true); setDraft(value) }}
      className={`cursor-pointer rounded px-1 py-0.5 text-xs min-h-[22px] hover:bg-slate-700 ${value ? 'text-white' : 'text-slate-600 italic'}`}>
      {value || '—'}
    </div>
  )
}

// ── Stock Monitor Card ────────────────────────────────────────────────────────
function StockMonitorCard({
  stock, section, onRemove, onDataChange
}: {
  stock: MonitorStock
  section: 'indian' | 'global'
  onRemove: () => void
  onDataChange: (updated: MonitorData) => void
}) {
  const [financials, setFinancials] = useState<FinancialsData | null>(null)
  const [outlook, setOutlook] = useState<OutlookData | null>(null)
  const [loadingFin, setLoadingFin] = useState(false)
  const [loadingOut, setLoadingOut] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [outlookOpen, setOutlookOpen] = useState(false)
  const [newKpiLabel, setNewKpiLabel] = useState('')
  const [addingKpi, setAddingKpi] = useState(false)
  const [cmp, setCmp] = useState<number | null>(null)
  const [changePct, setChangePct] = useState<number | null>(null)

  // Fetch live CMP
  useEffect(() => {
    const sym = section === 'indian' ? stock.symbol : stock.symbol
    client.get(`/watchlist/quotes?symbols=${encodeURIComponent(sym)}`)
      .then(r => {
        const data = r.data[sym] || r.data[sym.replace('.NS', '')]
        if (data) { setCmp(data.cmp); setChangePct(data.change_pct) }
      }).catch(() => {})
  }, [stock.symbol, section])

  const loadFinancials = () => {
    if (loadingFin || financials) return
    setLoadingFin(true)
    client.get(`/monitor/financials/${encodeURIComponent(stock.symbol)}`)
      .then(r => setFinancials(r.data))
      .catch(() => {})
      .finally(() => setLoadingFin(false))
  }

  const loadOutlook = () => {
    if (loadingOut || outlook) return
    setLoadingOut(true)
    client.get(`/monitor/outlook/${encodeURIComponent(stock.symbol)}`)
      .then(r => setOutlook(r.data))
      .catch(() => {})
      .finally(() => setLoadingOut(false))
  }

  const toggleExpand = () => {
    if (!expanded) { loadFinancials(); loadOutlook() }
    setExpanded(e => !e)
  }

  // Build merged quarter columns: auto financials + manual kpis
  const autoQuarters = financials?.quarters || []
  const manualQuarters = stock.quarters || {}
  const allQLabels = [
    ...autoQuarters.map(q => q.label),
    ...Object.keys(manualQuarters).filter(k => !autoQuarters.some(q => q.label === k))
  ]

  const saveKpi = (quarter: string, kpiKey: string, value: string) => {
    const existing = stock.quarters[quarter] || {}
    const kpis = { ...(existing.kpis || {}), [kpiKey]: value }
    client.post('/monitor/quarter', { section, symbol: stock.symbol, quarter, kpis, notes: existing.notes || '' })
      .then(r => onDataChange(r.data))
      .catch(() => {})
  }

  const saveNotes = (quarter: string, notes: string) => {
    const existing = stock.quarters[quarter] || {}
    client.post('/monitor/quarter', { section, symbol: stock.symbol, quarter, kpis: existing.kpis || {}, notes })
      .then(r => onDataChange(r.data))
      .catch(() => {})
  }

  const addKpiLabel = () => {
    if (!newKpiLabel.trim()) return
    const labels = [...stock.kpi_labels, newKpiLabel.trim()]
    client.put('/monitor/kpi-labels', { section, symbol: stock.symbol, labels })
      .then(r => { onDataChange(r.data); setNewKpiLabel(''); setAddingKpi(false) })
      .catch(() => {})
  }

  const removeKpiLabel = (label: string) => {
    const labels = stock.kpi_labels.filter(l => l !== label)
    client.put('/monitor/kpi-labels', { section, symbol: stock.symbol, labels })
      .then(r => onDataChange(r.data))
      .catch(() => {})
  }

  const isIndian = financials?.is_indian ?? section === 'indian'
  const currency = financials?.currency || (isIndian ? 'INR' : 'USD')
  const revLabel  = isIndian ? 'Revenue (₹Cr)' : 'Revenue ($M)'
  const patLabel  = isIndian ? 'PAT (₹Cr)' : 'Net Income ($M)'

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-800/50 transition-colors" onClick={toggleExpand}>
        <div className="flex items-center gap-3">
          <div>
            <span className="font-bold text-white">{stock.symbol.replace('.NS', '')}</span>
            <span className="text-muted text-sm ml-2">{stock.name}</span>
            {stock.sector && <span className="ml-2 text-[10px] bg-slate-800 border border-border px-1.5 py-0.5 rounded text-slate-400">{stock.sector}</span>}
            {stock.exchange && <span className="ml-1 text-[10px] text-muted">{stock.exchange}</span>}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {cmp !== null && (
            <div className="text-right">
              <div className="text-white font-semibold text-sm">{isIndian ? '₹' : '$'}{cmp.toFixed(2)}</div>
              {changePct !== null && (
                <div className={`text-[10px] font-medium ${changePct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                </div>
              )}
            </div>
          )}
          <button onClick={e => { e.stopPropagation(); onRemove() }}
            className="text-muted hover:text-red-400 text-xs px-2 py-1 rounded border border-border hover:border-red-800 transition-colors">
            ✕
          </button>
          <span className="text-muted text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          {/* Quarterly table */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Quarterly Tracker</div>
              <div className="flex items-center gap-2">
                {addingKpi ? (
                  <div className="flex items-center gap-1">
                    <input value={newKpiLabel} onChange={e => setNewKpiLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addKpiLabel(); if (e.key === 'Escape') { setAddingKpi(false); setNewKpiLabel('') } }}
                      placeholder="KPI label (e.g. Ore Volume)"
                      className="bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 w-44" autoFocus />
                    <button onClick={addKpiLabel} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded">Add</button>
                    <button onClick={() => { setAddingKpi(false); setNewKpiLabel('') }} className="text-xs text-muted hover:text-white px-1">✕</button>
                  </div>
                ) : (
                  <button onClick={() => setAddingKpi(true)} className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800 rounded px-2 py-1">+ Add KPI</button>
                )}
              </div>
            </div>

            {loadingFin && <div className="text-muted text-xs py-4 text-center">Loading financials…</div>}
            {!loadingFin && allQLabels.length === 0 && (
              <div className="text-muted text-xs py-4 text-center">No financial data available from yfinance for this stock.</div>
            )}

            {!loadingFin && allQLabels.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-2 py-1.5 text-muted font-medium w-36">Metric</th>
                      {allQLabels.map(q => (
                        <th key={q} className="text-right px-2 py-1.5 text-white font-semibold">{q}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Auto financial rows */}
                    {[
                      { key: isIndian ? 'revenue_cr' : 'revenue_m', label: revLabel, fmt: (v: number) => v?.toLocaleString('en-IN', { maximumFractionDigits: 0 }) },
                      { key: isIndian ? 'pat_cr' : 'pat_m',         label: patLabel, fmt: (v: number) => v?.toLocaleString('en-IN', { maximumFractionDigits: 0 }) },
                      { key: 'gross_margin_pct', label: 'Gross Margin',  fmt: (v: number) => v != null ? `${v}%` : null },
                      { key: 'op_margin_pct',    label: 'OPM',           fmt: (v: number) => v != null ? `${v}%` : null },
                      { key: 'net_margin_pct',   label: 'Net Margin',    fmt: (v: number) => v != null ? `${v}%` : null },
                      { key: 'eps',              label: 'EPS',           fmt: (v: number) => v != null ? v.toFixed(2) : null },
                    ].map(row => (
                      <tr key={row.key} className="border-b border-border/50 hover:bg-slate-800/30">
                        <td className="px-2 py-1.5 text-slate-400 font-medium">{row.label}</td>
                        {allQLabels.map(q => {
                          const autoQ = autoQuarters.find(aq => aq.label === q)
                          const val = autoQ ? (autoQ as any)[row.key] : null
                          return (
                            <td key={q} className="px-2 py-1.5 text-right text-slate-300">
                              {val != null ? row.fmt(val) : <span className="text-slate-600">—</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}

                    {/* Divider if KPIs exist */}
                    {stock.kpi_labels.length > 0 && (
                      <tr><td colSpan={allQLabels.length + 1} className="pt-2 pb-1 px-2"><div className="text-[10px] text-muted uppercase tracking-wider">Custom KPIs</div></td></tr>
                    )}

                    {/* Manual KPI rows */}
                    {stock.kpi_labels.map(label => (
                      <tr key={label} className="border-b border-border/50 hover:bg-slate-800/30">
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <span className="text-blue-300 font-medium">{label}</span>
                            <button onClick={() => removeKpiLabel(label)} className="text-slate-600 hover:text-red-400 text-[10px] ml-1">✕</button>
                          </div>
                        </td>
                        {allQLabels.map(q => {
                          const val = stock.quarters[q]?.kpis?.[label] || ''
                          return (
                            <td key={q} className="px-2 py-1">
                              <EditableCell value={val} onSave={v => saveKpi(q, label, v)} />
                            </td>
                          )
                        })}
                      </tr>
                    ))}

                    {/* Notes row */}
                    <tr className="border-b border-border/50">
                      <td className="px-2 py-1.5 text-slate-400 font-medium">Notes</td>
                      {allQLabels.map(q => (
                        <td key={q} className="px-2 py-1">
                          <EditableCell value={stock.quarters[q]?.notes || ''} onSave={v => saveNotes(q, v)} />
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Outlook / News */}
          <div className="border-t border-border px-4 py-3">
            <button onClick={() => { setOutlookOpen(o => !o); if (!outlookOpen) loadOutlook() }}
              className="flex items-center gap-2 text-xs font-semibold text-slate-300 uppercase tracking-wider hover:text-white">
              <span>{outlookOpen ? '▼' : '▶'}</span> Outlook & News
            </button>
            {outlookOpen && (
              <div className="mt-3 space-y-3">
                {loadingOut && <div className="text-muted text-xs">Loading news…</div>}
                {!loadingOut && outlook && (
                  <>
                    {outlook.summary && (
                      <div className="bg-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 border-l-2 border-blue-600">
                        {outlook.summary}
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {outlook.headlines.map((h, i) => (
                        <a key={i} href={h.link} target="_blank" rel="noreferrer"
                          className="flex items-start gap-2 p-2 bg-slate-800/50 hover:bg-slate-800 border border-border/50 rounded-lg transition-colors">
                          <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wide ${TAG_COLORS[h.tag] || TAG_COLORS.general}`}>
                            {h.tag}
                          </span>
                          <span className="text-white text-xs leading-snug flex-1">{h.title}</span>
                          <span className="text-muted text-[10px] shrink-0">{h.source}</span>
                        </a>
                      ))}
                    </div>
                    {outlook.headlines.length === 0 && <div className="text-muted text-xs">No recent news found.</div>}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Monitor Section ───────────────────────────────────────────────────────────
function MonitorSection({
  title, section, stocks, onDataChange
}: {
  title: string
  section: 'indian' | 'global'
  stocks: MonitorStock[]
  onDataChange: (data: MonitorData) => void
}) {
  const [adding, setAdding] = useState(false)

  const handleAddIndian = (sym: string, name: string) => {
    const symbol = sym.endsWith('.NS') ? sym : sym + '.NS'
    client.post('/monitor/add', { section: 'indian', symbol, name })
      .then(r => { onDataChange(r.data); setAdding(false) })
      .catch(() => {})
  }

  const handleAddGlobal = (s: { symbol: string; name: string; exchange: string }) => {
    client.post('/monitor/add', { section: 'global', symbol: s.symbol, name: s.name, exchange: s.exchange })
      .then(r => { onDataChange(r.data); setAdding(false) })
      .catch(() => {})
  }

  const handleRemove = (symbol: string) => {
    client.delete(`/monitor/${section}/${encodeURIComponent(symbol)}`)
      .then(r => onDataChange(r.data))
      .catch(() => {})
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-300">{title}</div>
        <button onClick={() => setAdding(a => !a)}
          className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800 rounded-lg px-3 py-1.5 transition-colors">
          {adding ? '✕ Cancel' : '+ Add Stock'}
        </button>
      </div>

      {adding && (
        <div className="bg-card border border-border rounded-xl p-4">
          {section === 'indian' ? (
            <div>
              <div className="text-xs text-muted mb-2">Search NSE stocks:</div>
              <NseStockSearch
                onSelect={(symbol, name) => handleAddIndian(symbol, name)}
                autoFocus
              />
            </div>
          ) : (
            <div>
              <div className="text-xs text-muted mb-2">Search NASDAQ / NYSE stocks:</div>
              <GlobalSearchInput onAdd={handleAddGlobal} />
            </div>
          )}
        </div>
      )}

      {stocks.length === 0 && !adding && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-muted text-sm">
          No stocks added yet. Click "+ Add Stock" to start tracking.
        </div>
      )}

      {stocks.map(stock => (
        <StockMonitorCard
          key={stock.symbol}
          stock={stock}
          section={section}
          onRemove={() => handleRemove(stock.symbol)}
          onDataChange={onDataChange}
        />
      ))}
    </div>
  )
}

// ── Main MonitorTab export ────────────────────────────────────────────────────
export default function MonitorTab() {
  const [data, setData] = useState<MonitorData>({ indian: [], global: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    client.get('/monitor/list')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      Loading monitor…
    </div>
  )

  return (
    <div className="space-y-8">
      <MonitorSection
        title="🇮🇳 Indian Stocks"
        section="indian"
        stocks={data.indian}
        onDataChange={setData}
      />
      <MonitorSection
        title="🌍 Global Stocks"
        section="global"
        stocks={data.global}
        onDataChange={setData}
      />
    </div>
  )
}
