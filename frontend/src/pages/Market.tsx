import { useState, useEffect } from 'react'
import { useMarket } from '../hooks/useMarket'
import { scoreToColor, scoreToLabel, marketModeColor, shortSymbol } from '../utils/formatters'
import ScoreBreakdownPanel from '../components/scores/ScoreBreakdown'
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer, Tooltip } from 'recharts'
import client from '../api/client'
import { useWatchlistStore } from '../store/watchlistStore'
import GlobalStockDetailModal from '../components/GlobalStockDetailModal'
import NextSessionPredictCard from '../components/NextSessionPredictCard'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GlobalIndex {
  symbol: string
  name: string
  region: string
  country: string
  currency: string
  note?: string
  price: number | null
  prev_close: number | null
  change: number | null
  change_pct: number | null
  direction: 'up' | 'down' | 'flat'
}

interface NewsItem {
  title: string
  summary: string
  link: string
  published: string
  source: string
  impact_score: number
  timestamp: number
  sentiment: 'positive' | 'negative' | 'neutral'
  nse_impact: string
  direction: 'Up' | 'Down' | 'Mixed' | 'Neutral'
  ai_powered: boolean
  prediction: {
    decision: string
    probability: number
    nse_impact: string
  } | null
}

interface ResultsEvent {
  symbol: string
  company: string
  purpose: string
  description: string
  date: string
  date_iso: string
  when: string
  days_from_today: number
}

// ─── GIFT Nifty Live Card ─────────────────────────────────────────────────────

interface GiftNiftyData {
  price: number | null
  prev_close: number | null
  day_high: number | null
  day_low: number | null
  day_open: number | null
  change: number | null
  change_pct: number | null
  gap_pts: number | null
  gap_signal: 'positive' | 'negative' | 'flat'
  last_updated: string | null
  source?: string
  error?: string
}

function GiftNiftyCard() {
  const [data, setData] = useState<GiftNiftyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const refresh = () => {
    setLoading(true)
    client.get('/market/gift-nifty')
      .then(r => { setData(r.data); setLastFetch(new Date()) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 60000) // auto-refresh every 60s
    return () => clearInterval(t)
  }, [])

  const up   = (data?.change ?? 0) > 0
  const down = (data?.change ?? 0) < 0
  const chgColor = up ? 'text-score-green' : down ? 'text-score-red' : 'text-slate-400'
  const bgPulse  = up ? 'border-green-800/60' : down ? 'border-red-800/60' : 'border-border'

  const fmt = (v: number | null) =>
    v != null ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'

  return (
    <div className={`bg-card border ${bgPulse} rounded-xl p-5`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-white">GIFT NIFTY</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${
            up ? 'bg-green-950 text-green-400 border-green-800' :
            down ? 'bg-red-950 text-red-400 border-red-800' :
            'bg-slate-800 text-slate-400 border-slate-700'
          }`}>LIVE</span>
        </div>
        <button onClick={refresh} disabled={loading}
          className="text-muted hover:text-white text-xs px-2 py-1 rounded border border-border hover:border-slate-500 transition-colors disabled:opacity-40">
          {loading ? '⟳' : '⟳ Refresh'}
        </button>
      </div>

      {loading && !data && (
        <div className="h-16 flex items-center text-muted text-sm animate-pulse">Fetching live data…</div>
      )}

      {data && !data.error && (
        <>
          {/* Price row */}
          <div className="flex items-end gap-4 mb-4">
            <div className="text-3xl font-bold text-white">{fmt(data.price)}</div>
            <div className="pb-0.5">
              <span className={`text-base font-semibold ${chgColor}`}>
                {up ? '+' : ''}{fmt(data.change)} ({up ? '+' : ''}{data.change_pct?.toFixed(2)}%)
              </span>
            </div>
          </div>

          {/* Gap signal banner */}
          {data.gap_pts != null && (
            <div className={`rounded-lg px-4 py-2.5 mb-4 text-sm font-semibold ${
              data.gap_signal === 'positive' ? 'bg-green-950/60 border border-green-800/50 text-green-300' :
              data.gap_signal === 'negative' ? 'bg-red-950/60 border border-red-800/50 text-red-300' :
              'bg-slate-800 border border-border text-slate-400'
            }`}>
              {data.gap_signal === 'positive'
                ? `▲ Nifty likely to open ~${Math.abs(data.gap_pts).toFixed(0)} pts positive in next session`
                : data.gap_signal === 'negative'
                ? `▼ Nifty likely to open ~${Math.abs(data.gap_pts).toFixed(0)} pts negative in next session`
                : 'Nifty likely to open flat in next session'}
            </div>
          )}

          {/* Performance grid */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: "Today's High", val: fmt(data.day_high), color: 'text-score-green' },
              { label: "Today's Low",  val: fmt(data.day_low),  color: 'text-score-red'   },
              { label: "Today's Open", val: fmt(data.day_open), color: 'text-white'        },
              { label: 'Prev Close',   val: fmt(data.prev_close), color: 'text-slate-300'  },
            ].map(({ label, val, color }) => (
              <div key={label} className="bg-slate-800/60 rounded-lg p-2.5">
                <div className="text-[10px] text-muted mb-0.5">{label}</div>
                <div className={`text-sm font-bold ${color}`}>{val}</div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between">
            {lastFetch && (
              <div className="text-[10px] text-muted">
                Updated {lastFetch.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                <span className="ml-1 text-slate-600">· auto-refreshes every 60s</span>
              </div>
            )}
            {data.source && (
              <div className="text-[10px] text-slate-600 italic text-right max-w-xs">Source: {data.source}</div>
            )}
          </div>
        </>
      )}

      {data?.error && (
        <div className="text-score-red text-sm">Failed to fetch: {data.error}</div>
      )}
    </div>
  )
}

// ─── Global Indices Tab ───────────────────────────────────────────────────────

const REGION_ORDER = ['Asia', 'Americas', 'Europe', 'Forex ↔ INR', 'Commodity', 'Currency', 'Volatility']

function GlobalIndicesTab() {
  const [indices, setIndices] = useState<GlobalIndex[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetch = () => {
    setLoading(true)
    client.get('/market/global-indices')
      .then(r => { setIndices(r.data.indices || []); setLastUpdated(new Date()) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetch() }, [])

  const byRegion = REGION_ORDER.map(region => ({
    region,
    items: indices.filter(i => i.region === region),
  })).filter(g => g.items.length > 0)

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      Fetching live global indices…
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between px-1">
        <div className="text-xs text-muted">
          Live prices with previous close change. Markets may be closed outside trading hours.
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[10px] text-muted">
              Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={fetch}
            className="px-3 py-1.5 bg-card border border-border text-muted hover:text-white rounded-lg text-xs"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {byRegion.map(({ region, items }) => (
        <div key={region} className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-slate-800/40">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{region}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-muted border-b border-border/50">
                <th className="text-left px-5 py-2">Index</th>
                <th className="text-left px-3 py-2">Country</th>
                <th className="text-left px-3 py-2">Currency</th>
                <th className="text-right px-3 py-2">Price</th>
                <th className="text-right px-3 py-2">Change</th>
                <th className="text-right px-4 py-2">Change %</th>
              </tr>
            </thead>
            <tbody>
              {items.map(idx => {
                const up = idx.direction === 'up'
                const down = idx.direction === 'down'
                const color = up ? 'text-score-green' : down ? 'text-score-red' : 'text-muted'
                const arrow = up ? '▲' : down ? '▼' : '—'
                return (
                  <tr key={idx.symbol} className="border-b border-border/30 hover:bg-slate-800/20">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-white">{idx.name}</div>
                      <div className="text-[10px] text-muted">{idx.symbol}</div>
                      {idx.note && <div className="text-[10px] text-amber-500/70 italic mt-0.5">{idx.note}</div>}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted">{idx.country}</td>
                    <td className="px-3 py-3 text-xs text-slate-400">{idx.currency}</td>
                    <td className="px-3 py-3 text-right font-mono">
                      {idx.price != null ? (
                        <span className="text-white font-semibold">
                          {idx.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-sm ${color}`}>
                      {idx.change != null ? (
                        <span>
                          {arrow} {idx.change >= 0 ? '+' : ''}{idx.change.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${color}`}>
                      {idx.change_pct != null ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold ${
                          up ? 'bg-green-950 border border-green-800' :
                          down ? 'bg-red-950 border border-red-800' :
                          'bg-slate-800'
                        }`}>
                          {arrow} {idx.change_pct >= 0 ? '+' : ''}{idx.change_pct.toFixed(2)}%
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

// ─── News Room Tab ────────────────────────────────────────────────────────────

const IMPACT_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Low',    color: 'bg-slate-700 text-muted' },
  1: { label: 'Low',    color: 'bg-slate-700 text-muted' },
  2: { label: 'Medium', color: 'bg-amber-950 border border-amber-700 text-amber-400' },
  3: { label: 'High',   color: 'bg-orange-950 border border-orange-700 text-orange-400' },
}

function getImpactStyle(score: number) {
  if (score >= 4) return { label: 'Very High', color: 'bg-red-950 border border-red-800 text-score-red' }
  return IMPACT_LABELS[score] ?? IMPACT_LABELS[0]
}

function timeSince(published: string): string {
  try {
    const d = new Date(published)
    const diffMs = Date.now() - d.getTime()
    const diffH = Math.floor(diffMs / 3_600_000)
    if (diffH < 1) return `${Math.floor(diffMs / 60000)}m ago`
    if (diffH < 24) return `${diffH}h ago`
    return `${Math.floor(diffH / 24)}d ago`
  } catch { return '' }
}

function NewsRoomTab() {
  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetch = () => {
    setLoading(true)
    client.get('/market/news')
      .then(r => { setNews(r.data.news || []); setLastUpdated(new Date()) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetch() }, [])

  // Auto-refresh news every 5 minutes so headlines stay current
  useEffect(() => {
    const id = setInterval(fetch, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      Fetching latest market news…
    </div>
  )

  if (!news.length) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      No news available right now. Try refreshing.
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="text-xs text-muted">
          Top headlines ranked by potential NSE market impact. Click any headline to read.
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[10px] text-muted">
              Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={fetch}
            className="px-3 py-1.5 bg-card border border-border text-muted hover:text-white rounded-lg text-xs"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {news.map((item, i) => {
        const impact = getImpactStyle(item.impact_score)
        const sentColor = item.sentiment === 'positive' ? 'text-score-green'
          : item.sentiment === 'negative' ? 'text-score-red' : 'text-muted'
        const dirArrow = item.direction === 'Up' ? '▲' : item.direction === 'Down' ? '▼'
          : item.direction === 'Mixed' ? '↕' : '→'
        const dirColor = item.direction === 'Up' ? 'text-score-green'
          : item.direction === 'Down' ? 'text-score-red' : 'text-score-amber'
        return (
          <div key={i} className="bg-card border border-border rounded-xl p-4 space-y-2.5">
            {/* Header row */}
            <div className="flex items-start gap-3">
              <div className="text-2xl font-bold text-slate-700 w-7 shrink-0 mt-0.5">{i + 1}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3 mb-1">
                  <a href={item.link} target="_blank" rel="noopener noreferrer"
                    className="font-semibold text-white text-sm leading-snug hover:text-blue-300 transition-colors">
                    {item.title}
                  </a>
                  <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${impact.color}`}>
                    {impact.label} Impact
                  </span>
                </div>
                {item.summary && (
                  <div className="text-xs text-muted leading-relaxed line-clamp-2">{item.summary}</div>
                )}
                <div className="flex items-center gap-3 text-[10px] text-muted mt-1">
                  <span className="text-slate-500">{item.source.replace('Google News ', '')}</span>
                  {item.published && <><span>·</span><span>{timeSince(item.published)}</span></>}
                  {item.ai_powered && <span className="text-score-blue">◆ AI</span>}
                  <a href={item.link} target="_blank" rel="noopener noreferrer"
                    className="ml-auto text-blue-500 hover:underline">Read →</a>
                </div>
              </div>
            </div>

            {/* NSE Impact row */}
            <div className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-2 flex-wrap">
              <span className="text-[10px] text-muted font-medium">NSE Impact:</span>
              <span className={`text-xs font-bold ${dirColor}`}>{dirArrow} {item.direction}</span>
              <span className="text-xs text-slate-300 flex-1">{item.nse_impact}</span>
              <span className={`text-[10px] font-semibold capitalize ${sentColor}`}>
                {item.sentiment === 'positive' ? '● Positive' : item.sentiment === 'negative' ? '● Negative' : '● Neutral'}
              </span>
            </div>

            {/* Policy prediction */}
            {item.prediction && (
              <div className="bg-amber-950/50 border border-amber-800/50 rounded-lg px-3 py-2 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-amber-400 font-semibold">📋 POLICY PREDICTION</span>
                  <span className="text-[10px] text-amber-300 font-bold ml-auto">
                    {Math.round(item.prediction.probability * 100)}% probability
                  </span>
                </div>
                <div className="text-xs text-amber-200 font-medium">{item.prediction.decision}</div>
                <div className="text-[11px] text-slate-300">{item.prediction.nse_impact}</div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Global Stocks Tab ────────────────────────────────────────────────────────

interface GlobalStock {
  symbol: string
  name: string
  exchange: string
  sector: string
  price: number | null
  prev_close: number | null
  change: number | null
  change_pct: number | null
  currency: string
  direction: 'up' | 'down' | 'flat'
}

interface SearchResult {
  symbol: string
  name: string
  exchange: string
  exchange_code: string
  sector: string
}

function GlobalStocksTab() {
  const [stocks, setStocks] = useState<GlobalStock[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [detailStock, setDetailStock] = useState<{ symbol: string; name: string } | null>(null)

  const loadStocks = async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const r = await client.get('/global-stocks/list')
      setStocks(r.data.stocks || [])
      setLastUpdated(new Date())
    } catch { /* ignore */ }
    finally { setLoading(false); setRefreshing(false) }
  }

  useEffect(() => { loadStocks() }, [])

  // Debounced search
  useEffect(() => {
    if (query.length < 3) { setSuggestions([]); return }
    const tid = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await client.get(`/global-stocks/search?q=${encodeURIComponent(query)}`)
        setSuggestions(r.data.results || [])
      } catch { setSuggestions([]) }
      finally { setSearching(false) }
    }, 350)
    return () => clearTimeout(tid)
  }, [query])

  const addStock = async (s: SearchResult) => {
    await client.post('/global-stocks/add', s)
    setQuery('')
    setSuggestions([])
    loadStocks(true)
  }

  const removeStock = async (symbol: string) => {
    await client.delete(`/global-stocks/${symbol}`)
    setStocks(prev => prev.filter(s => s.symbol !== symbol))
  }

  const exchangeColor = (ex: string) => {
    if (ex === 'NASDAQ') return 'bg-blue-950 border-blue-800 text-score-blue'
    if (ex === 'NYSE')   return 'bg-purple-950 border-purple-800 text-purple-400'
    if (ex === 'XETRA' || ex.includes('Frankfurt')) return 'bg-amber-950 border-amber-800 text-amber-400'
    return 'bg-slate-700 text-muted'
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="text-xs text-muted">Add stocks from NASDAQ, NYSE, or XETRA — type at least 3 characters</div>
        <div className="relative">
          <div className="flex gap-3">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. Apple, MSFT, SAP, Tesla…"
              className="flex-1 bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
            {searching && (
              <div className="absolute right-4 top-3 text-muted text-xs animate-pulse">Searching…</div>
            )}
          </div>
          {suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-border rounded-xl z-20 overflow-hidden shadow-xl">
              {suggestions.map(s => (
                <button key={s.symbol} onClick={() => addStock(s)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-700 transition-colors text-left border-b border-border/40 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-white text-sm">{s.symbol}</div>
                    <div className="text-xs text-muted truncate">{s.name}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${exchangeColor(s.exchange)}`}>{s.exchange}</span>
                  {s.sector && <span className="text-[10px] text-muted hidden sm:block">{s.sector}</span>}
                  <span className="text-xs text-score-blue">+ Add</span>
                </button>
              ))}
            </div>
          )}
          {query.length >= 3 && !searching && suggestions.length === 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-border rounded-xl z-20 px-4 py-3 text-sm text-muted">
              No NASDAQ/NYSE/XETRA results for "{query}"
            </div>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      {detailStock && (
        <GlobalStockDetailModal
          symbol={detailStock.symbol}
          name={detailStock.name}
          onClose={() => setDetailStock(null)}
        />
      )}

      {/* Stocks table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-semibold text-white">
            Global Watchlist {stocks.length > 0 ? `(${stocks.length})` : ''}
          </span>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-[10px] text-muted">
                Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button onClick={() => loadStocks(true)} disabled={refreshing}
              className="px-3 py-1.5 bg-card border border-border text-muted hover:text-white rounded-lg text-xs disabled:opacity-50">
              {refreshing ? '…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {(loading || refreshing) && stocks.length === 0 ? (
          <div className="p-10 text-center text-muted text-sm">Loading…</div>
        ) : stocks.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <div className="text-3xl">🌐</div>
            <div className="text-white font-semibold">No global stocks yet</div>
            <div className="text-sm text-muted">Search for stocks above to add them to your global watchlist.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                <th className="text-left px-5 py-2.5">Stock</th>
                <th className="text-center px-3 py-2.5">Exchange</th>
                <th className="text-right px-3 py-2.5">Price</th>
                <th className="text-right px-3 py-2.5">Chg</th>
                <th className="text-right px-4 py-2.5">Chg %</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {stocks.map(s => {
                const up   = s.direction === 'up'
                const down = s.direction === 'down'
                const pcolor = up ? 'text-score-green' : down ? 'text-score-red' : 'text-muted'
                const arrow  = up ? '▲' : down ? '▼' : '—'
                return (
                  <tr key={s.symbol} className="border-b border-border/30 hover:bg-slate-800/20">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-white">{s.symbol}</div>
                      <div className="text-[10px] text-muted truncate max-w-[180px]">{s.name}</div>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${exchangeColor(s.exchange)}`}>
                        {s.exchange}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {s.price != null ? (
                        <span className="font-semibold text-white font-mono">
                          {s.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          <span className="text-[10px] text-muted ml-1">{s.currency}</span>
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono ${pcolor}`}>
                      {s.change != null
                        ? `${arrow} ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}`
                        : '—'}
                    </td>
                    <td className={`px-4 py-3 text-right ${pcolor}`}>
                      {s.change_pct != null ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold ${
                          up ? 'bg-green-950 border border-green-800'
                             : down ? 'bg-red-950 border border-red-800'
                             : 'bg-slate-800'
                        }`}>
                          {arrow} {s.change_pct >= 0 ? '+' : ''}{s.change_pct.toFixed(2)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setDetailStock({ symbol: s.symbol, name: s.name })}
                          className="text-xs text-score-blue hover:text-blue-300 transition-colors font-medium">Detail</button>
                        <button onClick={() => removeStock(s.symbol)}
                          className="text-xs text-muted hover:text-score-red transition-colors">Remove</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Results Calendar Tab ─────────────────────────────────────────────────────

const PURPOSE_BADGE: Record<string, string> = {
  'Financial Results':       'bg-blue-950 border border-blue-800 text-score-blue',
  'Financial Results/Dividend': 'bg-green-950 border border-green-800 text-score-green',
  'Dividend':                'bg-green-950 border border-green-800 text-score-green',
}
function purposeBadge(p: string) {
  for (const [key, cls] of Object.entries(PURPOSE_BADGE)) {
    if (p.startsWith(key)) return cls
  }
  return 'bg-slate-700 text-muted'
}
function purposeShort(p: string) {
  if (p.includes('Dividend') && p.includes('Financial')) return 'Results + Dividend'
  if (p.startsWith('Financial Results')) return 'Q Results'
  if (p.startsWith('Dividend')) return 'Dividend'
  return p.split('/')[0]
}

function ResultsCalendarTab() {
  const [events, setEvents] = useState<ResultsEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'today' | 'upcoming'>('all')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const { items: watchlist } = useWatchlistStore()

  // Extract base symbols from watchlist (e.g. "HCLTECH.NS" → "HCLTECH")
  const watchlistSymbols = new Set(
    watchlist.map(w => shortSymbol(w.symbol).toUpperCase())
  )

  const doFetch = () => {
    setLoading(true)
    client.get('/market/results-calendar')
      .then(r => { setEvents(r.data.events || []); setLastUpdated(new Date()) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { doFetch() }, [])

  // Only show events for watchlisted stocks
  const watchlistEvents = events.filter(e => watchlistSymbols.has(e.symbol.toUpperCase()))

  const filtered = watchlistEvents.filter(e => {
    if (filter === 'today')    return e.days_from_today === 0
    if (filter === 'upcoming') return e.days_from_today > 0
    return true
  })

  // Group by date label
  const groups: Record<string, ResultsEvent[]> = {}
  for (const e of filtered) {
    if (!groups[e.when]) groups[e.when] = []
    groups[e.when].push(e)
  }

  const dayOrder = ['Yesterday', 'Today', 'Tomorrow']
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    const ai = dayOrder.indexOf(a), bi = dayOrder.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      Fetching results calendar from NSE…
    </div>
  )

  if (watchlist.length === 0) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center space-y-2">
      <div className="text-3xl">📋</div>
      <div className="text-white font-semibold">No watchlist stocks</div>
      <div className="text-sm text-muted">Add stocks to your Watchlist in the Discover tab to see their upcoming results here.</div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="flex gap-2">
          {(['all', 'today', 'upcoming'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
                filter === f
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-card border-border text-muted hover:text-white'
              }`}>
              {f === 'all'      ? `All (${watchlistEvents.length})`
               : f === 'today' ? `Today (${watchlistEvents.filter(e => e.days_from_today === 0).length})`
               :                 `Upcoming (${watchlistEvents.filter(e => e.days_from_today > 0).length})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted">Showing {watchlist.length} watchlist stock{watchlist.length !== 1 ? 's' : ''}</span>
          {lastUpdated && (
            <span className="text-[10px] text-muted">
              · Updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button onClick={doFetch}
            className="px-3 py-1.5 bg-card border border-border text-muted hover:text-white rounded-lg text-xs">
            ↻ Refresh
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center space-y-2">
          <div className="text-3xl">✓</div>
          <div className="text-white font-semibold">No events scheduled</div>
          <div className="text-sm text-muted">
            None of your {watchlist.length} watchlisted stocks have results or board meetings in this window.
          </div>
        </div>
      ) : (
        sortedGroups.map(([day, items]) => (
          <div key={day} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className={`px-5 py-2.5 border-b border-border flex items-center gap-3 ${
              day === 'Today' ? 'bg-blue-950/50' : 'bg-slate-800/40'
            }`}>
              <span className={`text-sm font-bold ${day === 'Today' ? 'text-score-blue' : 'text-slate-300'}`}>
                {day}
              </span>
              <span className="text-xs text-muted">{items.length} compan{items.length === 1 ? 'y' : 'ies'}</span>
              {day === 'Today' && (
                <span className="ml-auto px-2 py-0.5 bg-blue-600 text-white rounded text-[10px] font-bold animate-pulse">LIVE</span>
              )}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] text-muted border-b border-border/50">
                  <th className="text-left px-5 py-2">Symbol</th>
                  <th className="text-left px-3 py-2">Company</th>
                  <th className="text-center px-3 py-2">Type</th>
                  <th className="text-left px-5 py-2">Board Meeting Purpose</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-slate-800/20">
                    <td className="px-5 py-2.5">
                      <span className="font-bold text-white">{e.symbol}</span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 text-xs max-w-[200px] truncate">{e.company}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${purposeBadge(e.purpose)}`}>
                        {purposeShort(e.purpose)}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-xs text-muted max-w-[300px]">
                      <div className="truncate" title={e.description}>{e.description || e.purpose}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}

// ─── Main Market Page ─────────────────────────────────────────────────────────

type MarketTab = 'overview' | 'global' | 'global_stocks' | 'news' | 'results'

export default function Market() {
  const { macro, sectors, loading } = useMarket()
  const [tab, setTab] = useState<MarketTab>('overview')

  const radarData = sectors.slice(0, 8).map((s) => ({
    subject: s.sector.length > 8 ? s.sector.substring(0, 8) : s.sector,
    score: s.score,
  }))

  return (
    <div className="p-6 space-y-5">
      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {([
          { key: 'overview',      label: '📊 Market Overview' },
          { key: 'global',        label: '🌍 Global Indices' },
          { key: 'global_stocks', label: '🏢 Global Stocks' },
          { key: 'news',          label: '📰 News Room' },
          { key: 'results',       label: '📋 Quarterly Results' },
        ] as { key: MarketTab; label: string }[]).map(({ key, label }) => (
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

      {/* ── Overview Tab ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {loading && (
            <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
              Loading market data...
            </div>
          )}

          {macro && (
            <div className="space-y-4">
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-xs text-muted mb-1">Macro Environment Score</div>
                    <div className="text-4xl font-bold" style={{ color: scoreToColor(macro.score) }}>
                      {macro.score}
                      <span className="text-base font-normal text-muted ml-1">/100</span>
                    </div>
                    <div className="text-sm text-muted mt-0.5">{scoreToLabel(macro.score)}</div>
                  </div>
                  <span className={`px-4 py-2 rounded-lg text-sm font-bold tracking-wide ${marketModeColor(macro.market_mode)}`}>
                    {macro.market_mode}
                  </span>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 text-xs text-slate-300">
                  <span className="text-muted mr-2">Position Sizing:</span>
                  {macro.score >= 90 ? '100% of planned allocation — aggressive deployment' :
                   macro.score >= 80 ? '80-100% of planned allocation — normal investing' :
                   macro.score >= 70 ? '60-70% of planned allocation — selective entries' :
                   macro.score >= 60 ? '40-50% of planned allocation — defensive mode' :
                   '20-30% of planned allocation — capital preservation'}
                </div>
              </div>
              <ScoreBreakdownPanel
                title="Macro Breakdown"
                score={macro.score}
                breakdown={macro.breakdown}
                defaultOpen={false}
              />
            </div>
          )}

          {sectors.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="text-xs text-muted mb-4">Sector Heatmap</div>
                <div className="grid grid-cols-2 gap-2">
                  {sectors.map((s) => (
                    <div
                      key={s.sector}
                      className="rounded-lg p-3 border border-border/50"
                      style={{ backgroundColor: `${scoreToColor(s.score)}15` }}
                    >
                      <div className="text-xs text-white font-medium truncate">{s.sector}</div>
                      <div className="text-lg font-bold mt-1" style={{ color: scoreToColor(s.score) }}>
                        {s.score}
                      </div>
                      <div className="text-[10px] text-muted">{scoreToLabel(s.score)}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="text-xs text-muted mb-4">Sector Strength Radar</div>
                {radarData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <RadarChart data={radarData}>
                      <PolarGrid stroke="#334155" />
                      <PolarAngleAxis dataKey="subject" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <Radar name="Score" dataKey="score" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                        labelStyle={{ color: '#e2e8f0' }}
                        itemStyle={{ color: '#3b82f6' }}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-64 flex items-center justify-center text-muted text-sm">Loading...</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Global Indices Tab ── */}
      {tab === 'global' && (
        <div className="space-y-4">
          <GiftNiftyCard />
          {/* Benchmark Predictions */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <span>🔮</span> Next Session Predictions — Benchmark Indices
            </div>
            <div className="grid grid-cols-3 gap-4">
              <NextSessionPredictCard symbol="^NSEI"    name="NIFTY 50"  compact />
              <NextSessionPredictCard symbol="^NSEBANK" name="Bank Nifty" compact />
              <NextSessionPredictCard symbol="^BSESN"   name="Sensex"    compact />
            </div>
          </div>
          <GlobalIndicesTab />
        </div>
      )}

      {/* ── Global Stocks Tab ── */}
      {tab === 'global_stocks' && <GlobalStocksTab />}

      {/* ── News Room Tab ── */}
      {tab === 'news' && <NewsRoomTab />}

      {/* ── Quarterly Results Tab ── */}
      {tab === 'results' && <ResultsCalendarTab />}
    </div>
  )
}
