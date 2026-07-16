import { useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import { useWatchlistStore, type WatchlistItem } from '../store/watchlistStore'
import StockDetailModal from '../components/company/StockDetailModal'
import NseStockSearch from '../components/NseStockSearch'
import { scoreToColor, recommendationColor, shortSymbol } from '../utils/formatters'
import type { ScanResult } from '../types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EtfEntry {
  symbol: string
  name: string
  category: string
  type?: string
  tracks?: string
  etf_symbol?: string | null
  aum_cr?: number
  expense?: number
  score?: number
  trend?: string
  rsi?: number
  above_200dma?: boolean
  return_1m?: number
  return_1y?: number
  signal?: string
  current?: number
  prev_close?: number
  change_inr?: number
  change_pct?: number
  error?: string
}

const INDICES = [
  { key: 'nifty50',        label: 'Nifty 50' },
  { key: 'nifty_bank',     label: 'Nifty Bank' },
  { key: 'nifty_it',       label: 'Nifty IT' },
  { key: 'nifty_fin',      label: 'Nifty Fin Services' },
  { key: 'nifty_pharma',   label: 'Nifty Pharma' },
  { key: 'nifty_auto',     label: 'Nifty Auto' },
  { key: 'nifty_fmcg',     label: 'Nifty FMCG' },
  { key: 'nifty_metal',    label: 'Nifty Metal' },
  { key: 'nifty_energy',   label: 'Nifty Energy' },
  { key: 'nifty_midcap',   label: 'Midcap Select' },
  { key: 'nifty_smallcap', label: 'Nifty Smallcap' },
]

type Tab = 'individual' | 'index' | 'watchlist' | 'etf'

// ─── Add to Watchlist button ───────────────────────────────────────────────────

function WatchlistBtn({ symbol, companyName, score, rec }: {
  symbol: string; companyName?: string; score?: number; rec?: string
}) {
  const { add, remove, has } = useWatchlistStore()
  const inList = has(symbol)
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (inList) {
          remove(symbol)
        } else {
          add({ symbol, company_name: companyName || symbol, last_score: score, last_recommendation: rec })
        }
      }}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
        inList
          ? 'bg-amber-950 border-amber-700 text-amber-400 hover:bg-red-950 hover:border-red-700 hover:text-red-400'
          : 'bg-card border-border text-muted hover:border-score-blue hover:text-white'
      }`}
      title={inList ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {inList ? '★ Watching' : '☆ Watch'}
    </button>
  )
}

// ─── Main Discover Page ────────────────────────────────────────────────────────

export default function Discover() {
  const [tab, setTab] = useState<Tab>('individual')
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null)
  const { items: watchlistItems, remove: removeFromWatchlist, update: updateWatchlistItem } = useWatchlistStore()

  return (
    <div className="p-6 space-y-5">
      {/* Tab bar */}
      <div className="flex gap-2 border-b border-border pb-0">
        {([
          { key: 'individual', label: 'Individual Stock' },
          { key: 'index',      label: 'Index Scan' },
          { key: 'watchlist',  label: `Watchlist ${watchlistItems.length > 0 ? `(${watchlistItems.length})` : ''}` },
          { key: 'etf',        label: 'ETF & Indices' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-blue-500 text-white'
                : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'individual' && (
        <IndividualTab onViewDetails={setDetailSymbol} />
      )}
      {tab === 'index' && (
        <IndexScanTab onViewDetails={setDetailSymbol} />
      )}
      {tab === 'watchlist' && (
        <WatchlistTab
          items={watchlistItems}
          onRemove={removeFromWatchlist}
          onViewDetails={setDetailSymbol}
          onUpdateItem={updateWatchlistItem}
        />
      )}
      {tab === 'etf' && (
        <EtfTab onViewDetails={setDetailSymbol} />
      )}

      {/* Stock Detail Modal */}
      {detailSymbol && (
        <StockDetailModal
          symbol={detailSymbol}
          onClose={() => setDetailSymbol(null)}
        />
      )}
    </div>
  )
}

// ─── Tab 1: Individual Stock ──────────────────────────────────────────────────

function IndividualTab({ onViewDetails }: { onViewDetails: (s: string) => void }) {
  const handleSelect = (symbol: string, _name: string) => {
    onViewDetails(symbol)
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="text-xs text-muted mb-3">
          Type at least 3 characters to search NSE-listed stocks. Select from the list to analyze.
        </div>
        <NseStockSearch onSelect={handleSelect} autoFocus includeEtfIndex />
      </div>

      {/* Quick access: popular stocks */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs text-muted mb-3">Popular stocks — click to analyze</div>
        <div className="flex flex-wrap gap-2">
          {['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'BEL', 'VEDL', 'ICICIBANK', 'BAJFINANCE', 'TITAN', 'SBIN'].map((sym) => (
            <button
              key={sym}
              onClick={() => onViewDetails(sym + '.NS')}
              className="px-3 py-1.5 bg-slate-800 border border-border rounded-lg text-xs text-white hover:border-blue-500 transition-colors"
            >
              {sym}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Tab 2: Index Scan ────────────────────────────────────────────────────────

function IndexScanTab({ onViewDetails }: { onViewDetails: (s: string) => void }) {
  const [selectedIndex, setSelectedIndex] = useState('nifty50')
  const [topN, setTopN] = useState(10)
  const [minScore, setMinScore] = useState(0)
  const [results, setResults] = useState<ScanResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const scan = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await client.get('/discover/scan', {
        params: { index: selectedIndex, top_n: topN, min_score: minScore },
      })
      setResults(res.data.results || [])
    } catch {
      setError('Scan failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="grid grid-cols-4 gap-3 items-end">
          <div>
            <label className="text-xs text-muted block mb-1.5">Index</label>
            <select
              value={selectedIndex}
              onChange={(e) => setSelectedIndex(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              {INDICES.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted block mb-1.5">Top N</label>
            <input
              type="number" min={1} max={50} value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1.5">Min Score</label>
            <input
              type="number" min={0} max={100} value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={scan} disabled={loading}
            className="py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {loading ? 'Scanning...' : 'Scan'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-score-red">{error}</p>}
      </div>

      {loading && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
          Scanning {topN} stocks from {INDICES.find((i) => i.key === selectedIndex)?.label}…
        </div>
      )}

      {results.length > 0 && !loading && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <div className="text-sm font-semibold text-white">{results.length} results</div>
            <div className="text-xs text-muted">Sorted by overall score</div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
                <th className="text-left px-4 py-3">#</th>
                <th className="text-left px-3 py-3">Company</th>
                <th className="text-right px-3 py-3">Score</th>
                <th className="text-right px-3 py-3">Price</th>
                <th className="text-center px-3 py-3">Action</th>
                <th className="text-left px-3 py-3">Why?</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.symbol} className="border-b border-border/40 hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-muted">{r.rank}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-white">{shortSymbol(r.symbol)}</div>
                    <div className="text-xs text-muted truncate max-w-[140px]">{r.company_name}</div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className="font-bold" style={{ color: scoreToColor(r.overall_score) }}>
                      {r.overall_score}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-300">
                    {r.current_price ? `₹${r.current_price.toLocaleString('en-IN')}` : '—'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${recommendationColor(r.recommendation)}`}>
                      {r.recommendation}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted max-w-[180px] truncate">{r.reason}</td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => onViewDetails(r.symbol)}
                        className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium"
                      >
                        Details
                      </button>
                      <WatchlistBtn
                        symbol={r.symbol}
                        companyName={r.company_name}
                        score={r.overall_score}
                        rec={r.recommendation}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Tab 3: Watchlist ─────────────────────────────────────────────────────────

interface QuoteData {
  symbol: string
  cmp: number | null
  prev_close: number | null
  change_inr: number | null
  change_pct: number | null
  high_30d: number | null
  low_30d: number | null
  drop_from_30d_high_pct: number | null
  lift_from_30d_low_pct: number | null
  high_52w: number | null
  low_52w: number | null
  error?: string | null
}

function WatchlistTab({
  items,
  onRemove,
  onViewDetails,
  onUpdateItem,
}: {
  items: WatchlistItem[]
  onRemove: (s: string) => void
  onViewDetails: (s: string) => void
  onUpdateItem: (symbol: string, patch: Partial<WatchlistItem>) => void
}) {
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({})
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [generatingPred, setGeneratingPred] = useState(false)
  const [predMsg, setPredMsg] = useState('')

  const generatePredictions = async () => {
    const enabled = items.filter(i => i.prediction_enabled)
    if (enabled.length === 0) { setPredMsg('No stocks selected for prediction. Enable via the 🔮 checkbox.'); return }
    setGeneratingPred(true)
    setPredMsg('')
    let done = 0
    for (const item of enabled) {
      try {
        await client.get(`/predict/${encodeURIComponent(item.symbol)}`)
        done++
      } catch { /* skip */ }
    }
    setGeneratingPred(false)
    setPredMsg(`✓ Generated predictions for ${done} stock${done !== 1 ? 's' : ''}. Results appear in AI Insights tracker.`)
  }

  const fetchQuotes = useCallback(async () => {
    if (items.length === 0) return
    setLoading(true)
    try {
      const symbols = items.map(i =>
        i.symbol.includes('.') || i.symbol.startsWith('^') ? i.symbol : i.symbol + '.NS'
      ).join(',')
      const res = await client.get(`/watchlist/quotes?symbols=${encodeURIComponent(symbols)}`)
      const merged: Record<string, QuoteData> = {}
      for (const [k, v] of Object.entries(res.data as Record<string, QuoteData>)) {
        merged[k] = v
        merged[k.replace('.NS', '')] = v
      }
      setQuotes(merged)
      setLastRefresh(new Date())
    } catch { /* ignore */ }
    finally { setLoading(false) }

    // Backfill score+signal for items missing them — use quick endpoint (2 engines, fast)
    const missing = items.filter(i => i.last_score == null)
    if (missing.length === 0) return
    for (const item of missing) {
      try {
        const r = await client.get(`/analyze/${encodeURIComponent(item.symbol)}/quick`)
        const d = r.data
        if (d?.overall_score != null) {
          onUpdateItem(item.symbol, {
            last_score: d.overall_score,
            last_recommendation: d.recommendation ?? undefined,
          })
        }
      } catch { /* keep blank on error */ }
    }
  }, [items, onUpdateItem])

  useEffect(() => { fetchQuotes() }, [fetchQuotes])

  // Auto-retry once after 4s if any stock has blank CMP (rate-limit recovery)
  useEffect(() => {
    if (items.length === 0 || loading) return
    const hasBlank = items.some(i => {
      const sym = i.symbol.includes('.') ? i.symbol : i.symbol + '.NS'
      return !quotes[sym]?.cmp && !quotes[i.symbol]?.cmp
    })
    if (!hasBlank) return
    const tid = setTimeout(fetchQuotes, 4000)
    return () => clearTimeout(tid)
  }, [quotes, items, loading, fetchQuotes])

  if (items.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <div className="text-4xl mb-3">☆</div>
        <div className="text-white font-semibold mb-1">Your watchlist is empty</div>
        <div className="text-sm text-muted">Add stocks from Individual Stock or Index Scan.</div>
      </div>
    )
  }

  const fmt = (v: number | null | undefined, dec = 2) =>
    v != null ? v.toFixed(dec) : '—'

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between px-1">
        <div className="text-xs text-muted">
          {items.length} stocks · {lastRefresh
            ? `Updated ${lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : 'Loading…'}
        </div>
        <div className="flex items-center gap-2">
          {predMsg && <span className="text-[10px] text-score-green">{predMsg}</span>}
          <button
            onClick={generatePredictions}
            disabled={generatingPred || loading}
            className="px-3 py-1 bg-blue-950 border border-blue-800 text-xs text-blue-300 hover:text-white hover:bg-blue-900 rounded-lg disabled:opacity-40 transition-colors"
            title="Generate next-session predictions for 🔮-enabled stocks"
          >
            {generatingPred ? '⟳ Generating…' : '🔮 Generate Predictions'}
          </button>
          <button
            onClick={fetchQuotes}
            disabled={loading}
            className="px-3 py-1 bg-card border border-border text-xs text-muted hover:text-white rounded-lg disabled:opacity-40 transition-colors"
          >
            {loading ? '⟳ Refreshing…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
                <th className="text-left px-4 py-3 whitespace-nowrap">Symbol</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">CMP (LTP)</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">Chg ₹</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">Chg %</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">52W High</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">52W Low</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">30D High</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">30D Low</th>
                <th className="text-right px-3 py-3 whitespace-nowrap">Score</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Signal</th>
                <th className="text-center px-3 py-3 whitespace-nowrap" title="Enable next-session prediction tracking">🔮</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: WatchlistItem) => {
                const symKey = quotes[item.symbol] ? item.symbol
                              : quotes[item.symbol + '.NS'] ? item.symbol + '.NS'
                              : item.symbol
                const q = quotes[symKey] || {}
                const chgPos = (q.change_inr ?? 0) >= 0

                return (
                  <tr key={item.symbol} className="border-b border-border/40 hover:bg-slate-800/30">
                    {/* Symbol */}
                    <td className="px-4 py-3">
                      <div className="font-semibold text-white">{shortSymbol(item.symbol)}</div>
                      <div className="text-[10px] text-muted truncate max-w-[120px]">{item.company_name}</div>
                    </td>

                    {/* CMP */}
                    <td className="px-3 py-3 text-right">
                      {q.cmp != null ? (
                        <span className="font-bold text-white">₹{q.cmp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                      ) : loading ? (
                        <span className="text-muted text-xs animate-pulse">…</span>
                      ) : <span className="text-muted">—</span>}
                    </td>

                    {/* Change ₹ */}
                    <td className="px-3 py-3 text-right">
                      {q.change_inr != null ? (
                        <span className={`text-xs font-medium ${chgPos ? 'text-score-green' : 'text-score-red'}`}>
                          {chgPos ? '+' : ''}₹{Math.abs(q.change_inr).toFixed(2)}
                        </span>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* Change % */}
                    <td className="px-3 py-3 text-right">
                      {q.change_pct != null ? (
                        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                          chgPos ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'
                        }`}>
                          {chgPos ? '+' : ''}{q.change_pct.toFixed(2)}%
                        </span>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* 52W High */}
                    <td className="px-3 py-3 text-right">
                      {q.high_52w != null ? (
                        <div>
                          <div className="text-xs font-medium text-slate-300">₹{q.high_52w.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
                          {q.cmp && <div className="text-[10px] text-score-red">{((q.cmp / q.high_52w - 1) * 100).toFixed(1)}%</div>}
                        </div>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* 52W Low */}
                    <td className="px-3 py-3 text-right">
                      {q.low_52w != null ? (
                        <div>
                          <div className="text-xs font-medium text-slate-300">₹{q.low_52w.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
                          {q.cmp && <div className="text-[10px] text-score-green">+{((q.cmp / q.low_52w - 1) * 100).toFixed(1)}%</div>}
                        </div>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* 30D High */}
                    <td className="px-3 py-3 text-right text-xs text-slate-400">
                      {q.high_30d != null ? `₹${q.high_30d.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </td>

                    {/* 30D Low */}
                    <td className="px-3 py-3 text-right text-xs text-slate-400">
                      {q.low_30d != null ? `₹${q.low_30d.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </td>

                    {/* Last Score */}
                    <td className="px-3 py-3 text-right">
                      {item.last_score != null ? (
                        <span className="font-bold" style={{ color: scoreToColor(item.last_score) }}>
                          {item.last_score}
                        </span>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* Signal */}
                    <td className="px-3 py-3 text-center">
                      {item.last_recommendation ? (
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${recommendationColor(item.last_recommendation)}`}>
                          {item.last_recommendation}
                        </span>
                      ) : <span className="text-muted text-xs">—</span>}
                    </td>

                    {/* Prediction toggle */}
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => onUpdateItem(item.symbol, { prediction_enabled: !item.prediction_enabled })}
                        className={`text-base transition-colors ${item.prediction_enabled ? 'opacity-100' : 'opacity-25 hover:opacity-60'}`}
                        title={item.prediction_enabled ? 'Prediction tracking ON — click to disable' : 'Click to enable prediction tracking'}
                      >
                        🔮
                      </button>
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-3">
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => onViewDetails(item.symbol)}
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium"
                        >
                          Details
                        </button>
                        <button
                          onClick={() => onRemove(item.symbol)}
                          className="px-2.5 py-1 bg-card border border-border hover:border-score-red hover:text-score-red text-muted rounded text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Tab 4: ETF & Indices ─────────────────────────────────────────────────────

function EtfTab({ onViewDetails }: { onViewDetails: (s: string) => void }) {
  const [etfs, setEtfs] = useState<EtfEntry[]>([])
  const [indices, setIndices] = useState<EtfEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDetail, setSelectedDetail] = useState<string | null>(null)
  const [detailData, setDetailData] = useState<Record<string, unknown> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [view, setView] = useState<'etfs' | 'indices'>('etfs')
  const { add, remove, has } = useWatchlistStore()

  useEffect(() => {
    setLoading(true)
    client.get('/etf/overview')
      .then((r) => {
        setEtfs(r.data.etfs || [])
        setIndices(r.data.indices || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const allItems = view === 'etfs' ? etfs : indices

  const viewDetail = async (symbol: string) => {
    setSelectedDetail(symbol)
    setDetailData(null)
    setDetailLoading(true)
    try {
      const res = await client.get(`/etf/analyze/${encodeURIComponent(symbol)}`)
      setDetailData(res.data)
    } catch {
      setDetailData({ error: 'Failed to load' })
    } finally {
      setDetailLoading(false)
    }
  }

  const findEntry = (sym: string) =>
    [...etfs, ...indices].find((e) => e.symbol === sym)

  // Top 6 featured ETFs always shown first
  const TOP_ETF_SYMBOLS = ['NIFTYBEES.NS', 'BANKBEES.NS', 'GOLDBEES.NS', 'MOM100.NS', 'ITBEES.NS', 'PHARMABEES.NS']
  const topEtfs = TOP_ETF_SYMBOLS.map(s => etfs.find(e => e.symbol === s)).filter(Boolean) as EtfEntry[]

  return (
    <div className="space-y-4">
      {/* View toggle */}
      <div className="flex gap-2">
        {(['etfs', 'indices'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
              view === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-card border-border text-muted hover:text-white'
            }`}>
            {v === 'etfs' ? 'Tradeable ETFs' : 'Benchmark Indices'}
          </button>
        ))}
      </div>

      {loading && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
          Loading ETF data…
        </div>
      )}

      {/* Top 6 ETF cards — shown prominently on ETF view */}
      {!loading && view === 'etfs' && topEtfs.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2 px-1">Top ETFs — click ☆ to add to watchlist, then use in Paper Trade</div>
          <div className="grid grid-cols-3 gap-3">
            {topEtfs.map((e) => (
              <div key={e.symbol}
                className="bg-card border border-border rounded-xl p-4 hover:border-blue-500 transition-colors cursor-pointer"
                onClick={() => viewDetail(e.symbol)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold text-white text-sm">{e.symbol.replace('.NS', '')}</div>
                    <div className="text-xs text-muted mt-0.5 leading-tight">{e.name}</div>
                    {e.tracks && <div className="text-[10px] text-slate-500 mt-0.5">Tracks: {e.tracks}</div>}
                  </div>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      has(e.symbol) ? remove(e.symbol)
                        : add({ symbol: e.symbol, company_name: e.name, last_score: e.score, last_recommendation: e.signal })
                    }}
                    className={`text-lg transition-colors ${has(e.symbol) ? 'text-amber-400' : 'text-muted hover:text-amber-400'}`}
                    title={has(e.symbol) ? 'Remove from watchlist' : 'Add to watchlist'}
                  >
                    {has(e.symbol) ? '★' : '☆'}
                  </button>
                </div>

                {/* Price + returns */}
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-lg font-bold text-white">
                      {e.current ? `₹${e.current.toLocaleString('en-IN')}` : '—'}
                    </div>
                    {e.change_pct != null && (
                      <div className={`text-xs font-medium mt-0.5 ${e.change_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {e.change_pct >= 0 ? '+' : ''}{e.change_pct.toFixed(2)}%
                        {e.change_inr != null && (
                          <span className="ml-1 opacity-80">
                            ({e.change_inr >= 0 ? '+' : ''}₹{Math.abs(e.change_inr).toLocaleString('en-IN', { maximumFractionDigits: 2 })})
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex gap-3 mt-1">
                      {e.return_1m != null && (
                        <span className={`text-xs ${e.return_1m >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          1M: {e.return_1m >= 0 ? '+' : ''}{e.return_1m.toFixed(1)}%
                        </span>
                      )}
                      {e.return_1y != null && (
                        <span className={`text-xs ${e.return_1y >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          1Y: {e.return_1y >= 0 ? '+' : ''}{e.return_1y.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    {e.score != null && (
                      <div className="text-xl font-bold" style={{ color: scoreToColor(e.score) }}>{e.score}</div>
                    )}
                    {e.signal && (
                      <div className={`text-xs font-bold ${
                        e.signal === 'BUY' ? 'text-score-green' : e.signal === 'AVOID' ? 'text-score-red' : 'text-score-blue'
                      }`}>{e.signal}</div>
                    )}
                  </div>
                </div>

                {/* AUM + Expense */}
                {(e.aum_cr || e.expense) && (
                  <div className="mt-2 flex gap-3 text-[10px] text-muted border-t border-border/50 pt-2">
                    {e.aum_cr && <span>AUM ₹{e.aum_cr.toLocaleString()}Cr</span>}
                    {e.expense && <span>Exp: {e.expense}%</span>}
                    {e.above_200dma != null && (
                      <span className={e.above_200dma ? 'text-score-green' : 'text-score-red'}>
                        {e.above_200dma ? '↑ Above 200DMA' : '↓ Below 200DMA'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full table */}
      {!loading && allItems.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-sm font-semibold text-white">
              {view === 'etfs' ? `All ETFs (${allItems.length})` : `Benchmark Indices (${allItems.length})`}
            </span>
            <span className="text-xs text-muted">Click ☆ to add to Watchlist • Click row for details</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
                  <th className="text-left px-5 py-2.5">{view === 'etfs' ? 'ETF' : 'Index'}</th>
                  {view === 'etfs' && <th className="text-left px-3 py-2.5">Tracks</th>}
                  <th className="text-right px-3 py-2.5">Price</th>
                  <th className="text-right px-3 py-2.5">Day Chg</th>
                  <th className="text-right px-3 py-2.5">1M%</th>
                  <th className="text-right px-3 py-2.5">1Y%</th>
                  <th className="text-center px-3 py-2.5">RSI</th>
                  <th className="text-center px-3 py-2.5">200DMA</th>
                  <th className="text-center px-3 py-2.5">Score</th>
                  <th className="text-center px-3 py-2.5">Signal</th>
                  {view === 'etfs' && <th className="text-right px-3 py-2.5">Exp%</th>}
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((e) => (
                  <tr key={e.symbol}
                    className="border-b border-border/40 hover:bg-slate-800/30 cursor-pointer"
                    onClick={() => viewDetail(e.symbol)}
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-white">{e.symbol.replace('.NS','').replace('^','')}</div>
                      <div className="text-[10px] text-muted">{e.name}</div>
                    </td>
                    {view === 'etfs' && (
                      <td className="px-3 py-3 text-xs text-muted">{e.tracks || '—'}</td>
                    )}
                    <td className="px-3 py-3 text-right text-slate-300">
                      {e.current ? `₹${e.current.toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {e.change_pct != null ? (
                        <div>
                          <div className={`font-medium ${e.change_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                            {e.change_pct >= 0 ? '+' : ''}{e.change_pct.toFixed(2)}%
                          </div>
                          {e.change_inr != null && (
                            <div className={`text-[10px] ${e.change_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                              {e.change_inr >= 0 ? '+' : ''}₹{Math.abs(e.change_inr).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </div>
                          )}
                        </div>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {e.return_1m != null
                        ? <span className={e.return_1m >= 0 ? 'text-score-green' : 'text-score-red'}>{e.return_1m >= 0?'+':''}{e.return_1m.toFixed(1)}%</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {e.return_1y != null
                        ? <span className={e.return_1y >= 0 ? 'text-score-green' : 'text-score-red'}>{e.return_1y >= 0?'+':''}{e.return_1y.toFixed(1)}%</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {e.rsi != null
                        ? <span className={(e.rsi??50)>70?'text-score-red':(e.rsi??50)<30?'text-score-amber':'text-slate-300'}>{e.rsi.toFixed(0)}</span>
                        : '—'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {e.above_200dma != null
                        ? <span className={e.above_200dma?'text-score-green':'text-score-red'}>{e.above_200dma?'✓':'✗'}</span>
                        : '—'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {e.score != null
                        ? <span className="font-bold" style={{color:scoreToColor(e.score)}}>{e.score}</span>
                        : '—'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {e.signal && (
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                          e.signal==='BUY'?'bg-green-950 border border-green-800 text-score-green':
                          e.signal==='AVOID'?'bg-red-950 border border-red-800 text-score-red':
                          'bg-blue-950 border border-blue-800 text-score-blue'
                        }`}>{e.signal}</span>
                      )}
                    </td>
                    {view === 'etfs' && (
                      <td className="px-3 py-3 text-right text-xs text-muted">{e.expense != null ? `${e.expense}%` : '—'}</td>
                    )}
                    <td className="px-3 py-3" onClick={ev => ev.stopPropagation()}>
                      {e.type === 'index' ? (
                        <span className="px-2.5 py-1 rounded-lg text-xs text-muted border border-border/40 whitespace-nowrap cursor-default" title="Indices cannot be traded directly — use a linked ETF instead">
                          Not tradeable
                        </span>
                      ) : (
                        <button
                          onClick={() => has(e.symbol) ? remove(e.symbol)
                            : add({ symbol: e.symbol, company_name: e.name, last_score: e.score, last_recommendation: e.signal })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                            has(e.symbol)
                              ? 'bg-amber-950 border-amber-700 text-amber-400 hover:bg-red-950 hover:border-red-700 hover:text-red-400'
                              : 'bg-card border-border text-muted hover:border-score-blue hover:text-white'
                          }`}
                        >
                          {has(e.symbol) ? '★ Watching' : '☆ Watch'}
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

      {/* Detail slide-over */}
      {selectedDetail && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedDetail(null)} />
          <div className="relative w-full max-w-xl bg-background border-l border-border overflow-y-auto z-10 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-bold text-white">{findEntry(selectedDetail)?.name || selectedDetail}</div>
                <div className="text-xs text-muted">{selectedDetail}</div>
              </div>
              <div className="flex gap-2 items-center">
                {findEntry(selectedDetail)?.type === 'index' ? (
                  <span className="px-3 py-1.5 rounded-lg text-xs border border-border/40 text-muted cursor-default" title="Indices cannot be traded — use the linked ETF">
                    Index — not tradeable
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      const e = findEntry(selectedDetail)
                      has(selectedDetail) ? remove(selectedDetail)
                        : add({ symbol: selectedDetail, company_name: e?.name || selectedDetail, last_score: e?.score, last_recommendation: e?.signal })
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      has(selectedDetail)
                        ? 'bg-amber-950 border-amber-700 text-amber-400'
                        : 'bg-card border-border text-muted hover:text-white hover:border-blue-500'
                    }`}
                  >
                    {has(selectedDetail) ? '★ Watching' : '☆ Add to Watchlist'}
                  </button>
                )}
                <button onClick={() => setSelectedDetail(null)} className="text-muted hover:text-white p-1 text-lg">✕</button>
              </div>
            </div>
            {detailLoading && <div className="py-20 text-center text-muted text-sm">Loading…</div>}
            {detailData && !detailLoading && <EtfDetailPanel data={detailData} />}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ETF Detail panel ─────────────────────────────────────────────────────────

function EtfDetailPanel({ data }: { data: Record<string, unknown> }) {
  const tech = data.technicals as Record<string, unknown> | undefined
  const retObj: Record<string, number | null> = {}
  if (tech?.returns && typeof tech.returns === 'object') {
    for (const [k, v] of Object.entries(tech.returns as Record<string, unknown>)) {
      retObj[k] = typeof v === 'number' ? v : null
    }
  }
  const score: number = (typeof data.score === 'number' ? data.score : 0)
  const signal: string = (typeof data.signal === 'string' ? data.signal : 'HOLD')
  const aiJustification: string | null = typeof data.ai_justification === 'string' ? data.ai_justification : null
  const changeInr: number | null = typeof tech?.change_inr === 'number' ? tech.change_inr : null
  const changePct: number | null = typeof tech?.change_pct === 'number' ? tech.change_pct : null
  const prevClose: number | null = typeof tech?.prev_close === 'number' ? tech.prev_close : null

  return (
    <div className="space-y-4">
      {/* Score + Signal + Trend */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-xs text-muted mb-1">Technical Score</div>
          <div className="text-3xl font-bold" style={{ color: scoreToColor(score) }}>{score}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-xs text-muted mb-1">Signal</div>
          <div className={`text-lg font-bold ${signal === 'BUY' ? 'text-score-green' : signal === 'AVOID' ? 'text-score-red' : 'text-score-blue'}`}>
            {signal}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-xs text-muted mb-1">Trend</div>
          <div className="text-sm font-semibold text-white">{String(tech?.trend ?? '—')}</div>
        </div>
      </div>

      {/* Day change */}
      {(changeInr != null || changePct != null) && (
        <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-4">
          <div>
            <div className="text-xs text-muted mb-0.5">Day Change</div>
            <div className={`text-lg font-bold ${(changePct ?? 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
              {changePct != null ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : '—'}
            </div>
          </div>
          {changeInr != null && (
            <div>
              <div className="text-xs text-muted mb-0.5">Amount</div>
              <div className={`text-sm font-semibold ${changeInr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {changeInr >= 0 ? '+' : ''}₹{Math.abs(changeInr).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
            </div>
          )}
          {prevClose != null && (
            <div className="ml-auto text-right">
              <div className="text-xs text-muted mb-0.5">Prev Close</div>
              <div className="text-sm text-slate-300">₹{prevClose.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
          )}
        </div>
      )}

      {/* AI Justification */}
      {aiJustification ? (
        <div className="bg-slate-800/60 border border-border rounded-xl p-4">
          <div className="text-xs text-muted mb-2 flex items-center gap-1.5">
            <span>AI Analysis</span>
            <span className="px-1.5 py-0.5 bg-blue-950 border border-blue-800 text-score-blue rounded text-[10px] font-medium">AUTO</span>
          </div>
          <div className="text-sm text-slate-200 leading-relaxed">{aiJustification}</div>
        </div>
      ) : null}

      {/* Returns table */}
      {(() => {
        const keys = Object.keys(retObj)
        if (!keys.length) return null
        return (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted mb-3">Performance Returns</div>
            <div className="grid grid-cols-5 gap-2">
              {([
                { key: '1w', label: '1 Week' }, { key: '1m', label: '1 Month' },
                { key: '3m', label: '3 Months' }, { key: '6m', label: '6 Months' },
                { key: '1y', label: '1 Year' },
              ] as { key: string; label: string }[]).map(({ key, label }) => {
                const rawVal = retObj[key]
                const val: number | null = typeof rawVal === 'number' ? rawVal : null
                return (
                  <div key={key} className="bg-slate-800 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-muted">{label}</div>
                    <div className={`text-sm font-bold mt-0.5 ${val == null ? 'text-muted' : val >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(1)}%` : '—'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Technical indicators */}
      {tech != null && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted mb-3">Technical Indicators</div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Current', val: tech.current as number },
              { label: 'SMA 20', val: tech.sma20 as number },
              { label: 'SMA 50', val: tech.sma50 as number },
              { label: 'SMA 200', val: tech.sma200 as number },
              { label: 'RSI (14)', val: tech.rsi as number },
              { label: '52W High', val: tech['52w_high'] as number },
            ].map(({ label, val }) => (
              <div key={label} className="bg-slate-800 rounded-lg p-2.5">
                <div className="text-[10px] text-muted">{label}</div>
                <div className="text-sm font-semibold text-white">
                  {val != null ? val.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2 bg-slate-800 rounded px-3 py-2">
              <span className="text-muted">vs 200DMA:</span>
              <span className={tech.above_200dma ? 'text-score-green' : 'text-score-red'}>
                {tech.above_200dma ? '✓ Above — bullish' : '✗ Below — bearish'}
              </span>
            </div>
            <div className="flex items-center gap-2 bg-slate-800 rounded px-3 py-2">
              <span className="text-muted">MACD:</span>
              <span className={(tech.macd as number ?? 0) > (tech.macd_signal as number ?? 0) ? 'text-score-green' : 'text-score-red'}>
                {(tech.macd as number ?? 0) > (tech.macd_signal as number ?? 0) ? 'Bullish crossover' : 'Bearish crossover'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ETF info */}
      {data.etf_symbol && (
        <div className="bg-blue-950 border border-blue-800 rounded-xl p-3 text-xs text-blue-300">
          Tradeable ETF: <span className="font-semibold text-white">{String(data.etf_symbol)}</span>
        </div>
      )}
    </div>
  )
}
