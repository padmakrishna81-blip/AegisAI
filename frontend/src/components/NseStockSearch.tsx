import { useState, useEffect, useRef } from 'react'
import client from '../api/client'

interface NseResult {
  symbol: string
  name: string
  sector: string
  type?: 'stock' | 'etf' | 'index'
}

interface Props {
  onSelect: (symbol: string, name: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
  includeEtfIndex?: boolean  // also show ETFs and indices
}

// Static ETF + Index entries shown when query matches
const ETF_INDEX_CATALOG: NseResult[] = [
  // Indices
  { symbol: '^NSEI',     name: 'NIFTY 50',         sector: 'Index',  type: 'index' },
  { symbol: '^NSEBANK',  name: 'NIFTY Bank',        sector: 'Index',  type: 'index' },
  { symbol: '^CNXIT',    name: 'NIFTY IT',          sector: 'Index',  type: 'index' },
  { symbol: '^CNXPHARMA',name: 'NIFTY Pharma',      sector: 'Index',  type: 'index' },
  { symbol: '^CNXAUTO',  name: 'NIFTY Auto',        sector: 'Index',  type: 'index' },
  { symbol: '^CNXFMCG',  name: 'NIFTY FMCG',       sector: 'Index',  type: 'index' },
  { symbol: '^NSEMDCP50',name: 'NIFTY Midcap 50',   sector: 'Index',  type: 'index' },
  // Top ETFs
  { symbol: 'NIFTYBEES.NS', name: 'Nippon Nifty BeES',      sector: 'ETF', type: 'etf' },
  { symbol: 'BANKBEES.NS',  name: 'Nippon Bank BeES',        sector: 'ETF', type: 'etf' },
  { symbol: 'GOLDBEES.NS',  name: 'Nippon Gold BeES',        sector: 'ETF', type: 'etf' },
  { symbol: 'MOM100.NS',    name: 'Motilal Oswal Nasdaq 100',sector: 'ETF', type: 'etf' },
  { symbol: 'ITBEES.NS',    name: 'Nippon IT BeES',          sector: 'ETF', type: 'etf' },
  { symbol: 'PHARMABEES.NS',name: 'Nippon Pharma BeES',      sector: 'ETF', type: 'etf' },
  { symbol: 'BANKBEES.NS',  name: 'Nippon Bank BeES',        sector: 'ETF', type: 'etf' },
  { symbol: 'JUNIORBEES.NS',name: 'Nippon Junior BeES',      sector: 'ETF', type: 'etf' },
  { symbol: 'AUTOBEES.NS',  name: 'Nippon Auto BeES',        sector: 'ETF', type: 'etf' },
]

const TYPE_BADGE: Record<string, string> = {
  stock: 'bg-slate-700 text-slate-300',
  etf:   'bg-amber-950 border border-amber-800 text-amber-400',
  index: 'bg-blue-950 border border-blue-800 text-score-blue',
}

export default function NseStockSearch({ onSelect, placeholder, autoFocus, className, includeEtfIndex }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NseResult[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (query.length < 3) { setResults([]); setOpen(false); return }
    const q = query.toUpperCase()

    // ETF/Index local match
    const etfMatches: NseResult[] = includeEtfIndex
      ? ETF_INDEX_CATALOG.filter(e =>
          e.symbol.replace('^','').replace('.NS','').includes(q) ||
          e.name.toUpperCase().includes(q)
        ).filter((e, i, arr) => arr.findIndex(x => x.symbol === e.symbol) === i)
      : []

    const tid = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await client.get(`/nse/search?q=${encodeURIComponent(query)}`)
        const stocks: NseResult[] = (r.data.results || []).map((s: NseResult) => ({ ...s, type: 'stock' as const }))
        setResults([...etfMatches, ...stocks])
        setOpen(true)
      } catch { setResults(etfMatches); setOpen(etfMatches.length > 0) }
      finally { setSearching(false) }
    }, 250)
    return () => clearTimeout(tid)
  }, [query, includeEtfIndex])

  const select = (r: NseResult) => {
    onSelect(r.symbol, r.name)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div ref={wrapperRef} className={`relative ${className || ''}`}>
      <div className="relative">
        <input
          value={query}
          onChange={e => setQuery(e.target.value.toUpperCase())}
          placeholder={placeholder || 'Search NSE stocks (e.g. HDFC, BEL, Infosys)'}
          autoFocus={autoFocus}
          className="w-full bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
        />
        {searching && (
          <span className="absolute right-3 top-2.5 text-[10px] text-muted animate-pulse">searching…</span>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-border rounded-xl z-50 overflow-hidden shadow-xl max-h-64 overflow-y-auto">
          {results.map(r => (
            <button key={r.symbol} onClick={() => select(r)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700 transition-colors text-left border-b border-border/40 last:border-0">
              <div className="flex-1 min-w-0">
                <span className="font-bold text-white text-sm">{r.symbol.replace('^', '')}</span>
                <span className="text-muted text-xs ml-2 truncate">{r.name}</span>
              </div>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${TYPE_BADGE[r.type || 'stock']}`}>
                {r.type === 'index' ? 'Index' : r.type === 'etf' ? 'ETF' : 'NSE'}
              </span>
              {r.sector && r.type === 'stock' && <span className="text-[10px] text-muted shrink-0 hidden sm:block">{r.sector}</span>}
            </button>
          ))}
        </div>
      )}

      {open && query.length >= 3 && !searching && results.length === 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-border rounded-xl z-50 px-4 py-3 text-sm text-muted">
          No results for "{query}"
        </div>
      )}
    </div>
  )
}
