import { useState, useEffect } from 'react'
import { useMarket } from '../hooks/useMarket'
import { scoreToColor, scoreToLabel, marketModeColor, shortSymbol } from '../utils/formatters'
import ScoreBreakdownPanel from '../components/scores/ScoreBreakdown'
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer, Tooltip } from 'recharts'
import client from '../api/client'
import { useWatchlistStore } from '../store/watchlistStore'
import GlobalStockDetailModal from '../components/GlobalStockDetailModal'

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

// ─── Sector Detail Modal ──────────────────────────────────────────────────────

interface SectorDetailData {
  sector: string
  sector_score: number
  index_symbol: string | null
  trend_3m_pct: number | null
  trend_1y_pct: number | null
  outlook: string
  outlook_label: 'bullish' | 'bearish' | 'neutral_positive' | 'neutral'
  top5_stocks: { symbol: string; name: string; score: number; signal: string; cmp: number; change_pct: number | null; nifty50: boolean }[]
  news: { title: string; source: string; published_at: number | null }[]
  stock_count: number
}

function SectorDetailModal({ sector, onClose }: { sector: string; onClose: () => void }) {
  const [data, setData] = useState<SectorDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    client.get(`/market/sector-detail/${encodeURIComponent(sector)}`)
      .then(r => setData(r.data))
      .catch(() => setError('Failed to load sector details'))
      .finally(() => setLoading(false))
  }, [sector])

  const outlookColors: Record<string, string> = {
    bullish:         'bg-green-950 border-green-800 text-green-300',
    neutral_positive:'bg-blue-950 border-blue-800 text-blue-300',
    neutral:         'bg-slate-800 border-slate-700 text-slate-300',
    bearish:         'bg-red-950 border-red-800 text-red-300',
  }
  const trendColor = (v: number | null) => v == null ? 'text-muted' : v >= 0 ? 'text-score-green' : 'text-score-red'
  const sigColor   = (s: string) => s === 'BUY' ? 'text-score-green bg-green-950 border-green-800' : s === 'SELL' ? 'text-score-red bg-red-950 border-red-800' : 'text-score-blue bg-blue-950 border-blue-800'

  const fmtDate = (ts: number | null) => ts ? new Date(ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-2xl m-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between z-10">
          <div>
            <div className="text-lg font-bold text-white">{sector} Sector</div>
            <div className="text-xs text-muted">{data ? `${data.stock_count} stocks tracked` : 'Loading…'}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl font-bold px-2">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {loading && <div className="text-center py-12 text-muted text-sm animate-pulse">Analysing sector…</div>}
          {error && <div className="text-score-red text-sm text-center py-8">{error}</div>}

          {data && !loading && (
            <>
              {/* Score + Trend strip */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Sector Score</div>
                  <div className="text-2xl font-bold" style={{ color: scoreToColor(data.sector_score) }}>{data.sector_score}</div>
                  <div className="text-[10px] text-muted">{scoreToLabel(data.sector_score)}</div>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">3M Return</div>
                  <div className={`text-lg font-bold ${trendColor(data.trend_3m_pct)}`}>
                    {data.trend_3m_pct != null ? `${data.trend_3m_pct >= 0 ? '+' : ''}${data.trend_3m_pct}%` : '—'}
                  </div>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">1Y Return</div>
                  <div className={`text-lg font-bold ${trendColor(data.trend_1y_pct)}`}>
                    {data.trend_1y_pct != null ? `${data.trend_1y_pct >= 0 ? '+' : ''}${data.trend_1y_pct}%` : '—'}
                  </div>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Stocks</div>
                  <div className="text-lg font-bold text-white">{data.stock_count}</div>
                </div>
              </div>

              {/* 3-month outlook */}
              <div className={`rounded-xl p-4 border ${outlookColors[data.outlook_label] || outlookColors.neutral}`}>
                <div className="text-[10px] uppercase tracking-wider font-bold mb-1 opacity-70">3-Month Outlook</div>
                <div className="text-sm font-medium">{data.outlook}</div>
              </div>

              {/* Top 5 stocks */}
              <div className="bg-slate-800/30 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 text-xs font-semibold text-white border-b border-border">
                  All {data.stock_count} Stocks in {sector} — sorted by score
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-muted border-b border-border/40 bg-slate-800/40">
                      <th className="text-left px-4 py-2">#</th>
                      <th className="text-left px-3 py-2">Stock</th>
                      <th className="text-right px-3 py-2">CMP</th>
                      <th className="text-right px-3 py-2">Day %</th>
                      <th className="text-right px-3 py-2">Score</th>
                      <th className="text-center px-3 py-2">Signal</th>
                      <th className="text-center px-3 py-2">N50</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top5_stocks.map((s, i) => (
                      <tr key={s.symbol} className="border-b border-border/20 hover:bg-slate-800/30">
                        <td className="px-4 py-2.5 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-white">{s.symbol}</div>
                          <div className="text-[10px] text-muted truncate max-w-[130px]">{s.name}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right text-white font-medium">
                          {s.cmp ? `₹${s.cmp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-medium ${trendColor(s.change_pct)}`}>
                          {s.change_pct != null ? `${s.change_pct >= 0 ? '+' : ''}${s.change_pct.toFixed(2)}%` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="font-bold" style={{ color: scoreToColor(s.score) }}>{s.score}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${sigColor(s.signal)}`}>{s.signal}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {s.nifty50 ? (
                            <span className="px-1.5 py-0.5 bg-amber-950 border border-amber-700 text-amber-400 rounded text-[10px] font-bold">N50</span>
                          ) : (
                            <span className="text-slate-700">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Recent news */}
              {data.news.length > 0 && (
                <div className="bg-slate-800/30 rounded-xl p-4 space-y-2">
                  <div className="text-xs font-semibold text-white mb-3">Recent Sector News</div>
                  {data.news.map((n, i) => (
                    <div key={i} className="border-b border-border/20 pb-2 last:border-0">
                      <div className="text-xs text-slate-200 leading-snug">{n.title}</div>
                      <div className="text-[10px] text-muted mt-0.5 flex gap-2">
                        <span>{n.source}</span>
                        {n.published_at && <span>· {fmtDate(n.published_at)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="text-[10px] text-slate-600 text-center">
                Scores based on AegisAI 6-engine analysis · Outlook is rule-based, not financial advice
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Index History Tab ───────────────────────────────────────────────────────

interface HistoryRow {
  date: string
  prev_close: number
  open: number
  gap_pts: number
  gap_pct: number | null
  gap_direction: 'up' | 'down' | 'flat'
  close: number
  change_pts: number
  change_pct: number | null
  direction: 'up' | 'down'
  volume: number | null
}

interface HistoryData {
  symbol: string
  name: string
  sessions: number
  rows: HistoryRow[]
}

function IndexHistoryTab() {
  const [index, setIndex]     = useState<'nifty' | 'banknifty' | 'sensex'>('nifty')
  const [data, setData]       = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [error, setError]     = useState('')

  const load = (idx = index, force = false) => {
    if (loading && !force) return
    setLoading(true)
    setError('')
    client.get(`/market/history/${idx}?sessions=30`)
      .then(r => { setData(r.data); setLastSync(new Date()) })
      .catch(() => setError('Failed to load history. Click Sync to retry.'))
      .finally(() => setLoading(false))
  }

  // Auto-load on tab open and when index changes
  useEffect(() => { load() }, [index])

  const TABS = [
    { key: 'nifty',     label: 'NIFTY 50' },
    { key: 'banknifty', label: 'Bank Nifty' },
    { key: 'sensex',    label: 'Sensex' },
  ] as const

  const fmt  = (v: number, dec = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  const fmtV = (v: number | null) => {
    if (v == null) return '—'
    if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`
    if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`
    return v.toLocaleString('en-IN')
  }

  return (
    <div className="space-y-4">
      {/* Sub-tabs + sync */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => { setIndex(t.key); }}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                index === t.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-card border border-border text-muted hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {lastSync && (
            <span className="text-[10px] text-muted">
              Synced {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => load(index, true)}
            disabled={loading}
            className="px-3 py-1.5 bg-card border border-border hover:border-blue-500 text-xs text-muted hover:text-white rounded-lg disabled:opacity-40 transition-colors flex items-center gap-1.5"
          >
            <span className={loading ? 'animate-spin inline-block' : ''}>⟳</span>
            {loading ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800 rounded-xl px-4 py-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm animate-pulse">
          Loading {TABS.find(t => t.key === index)?.label} history…
        </div>
      )}

      {data && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-slate-800/40">
            <div className="text-sm font-semibold text-white">{data.name} — Last {data.sessions} Sessions</div>
            <div className="text-[10px] text-muted">Most recent first · Auto-syncs on open</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-muted border-b border-border bg-slate-800/20">
                  <th className="text-left px-4 py-2.5 whitespace-nowrap">#</th>
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">Date</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Prev Close</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Open</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Gap Up/Down</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Close</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Chg Points</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">% Change</th>
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">Volume</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  const up  = r.direction === 'up'
                  const gUp = r.gap_direction === 'up'
                  const gFlat = r.gap_direction === 'flat'
                  return (
                    <tr key={r.date} className={`border-b border-border/30 hover:bg-slate-800/20 ${i === 0 ? 'bg-blue-950/10' : ''}`}>
                      <td className="px-4 py-2.5 text-slate-600">{i + 1}</td>
                      <td className="px-3 py-2.5 font-medium text-white whitespace-nowrap">
                        {new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-300">{fmt(r.prev_close, 2)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-300">{fmt(r.open, 2)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={`font-medium ${gFlat ? 'text-muted' : gUp ? 'text-score-green' : 'text-score-red'}`}>
                          {r.gap_pts >= 0 ? '+' : ''}{fmt(r.gap_pts, 2)}
                          {r.gap_pct != null && (
                            <span className="text-[10px] ml-1 opacity-70">
                              ({r.gap_pct >= 0 ? '+' : ''}{r.gap_pct.toFixed(2)}%)
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={`px-3 py-2.5 text-right font-semibold ${up ? 'text-score-green' : 'text-score-red'}`}>
                        {fmt(r.close, 2)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-medium ${up ? 'text-score-green' : 'text-score-red'}`}>
                        {r.change_pts >= 0 ? '+' : ''}{fmt(r.change_pts, 2)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${up ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'}`}>
                          {r.change_pct != null ? `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(2)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{fmtV(r.volume)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Market Page ─────────────────────────────────────────────────────────

// ── Indian ADRs Tab ────────────────────────────────────────────────────────
interface ADR {
  symbol: string
  name: string
  nse: string | null
  sector: string
  cmp: number
  prev_close: number
  change_amt: number
  change_pct: number
  high_52w: number
  low_52w: number
  currency: string
}

function IndianADRsTab() {
  const [adrs, setAdrs]       = useState<ADR[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ADR | null>(null)
  const [news, setNews]       = useState<any[]>([])
  const [newsLoading, setNewsLoading] = useState(false)

  useEffect(() => {
    client.get('/market/adrs')
      .then(r => setAdrs(r.data.adrs || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const openDetail = (adr: ADR) => {
    setSelected(adr)
    setNews([])
    setNewsLoading(true)
    // Fetch news for the NSE symbol if available, else ADR symbol
    const sym = adr.nse || adr.symbol
    client.get('/market/news')
      .then(r => {
        const items: any[] = r.data.news || []
        const filtered = items.filter(n =>
          n.title?.toLowerCase().includes(sym.toLowerCase()) ||
          n.title?.toLowerCase().includes(adr.name.split(' ')[0].toLowerCase())
        )
        setNews(filtered.length > 0 ? filtered : items.slice(0, 5))
      })
      .catch(() => {})
      .finally(() => setNewsLoading(false))
  }

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-10 text-center text-muted text-sm">
      Loading Indian ADRs…
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-white font-semibold">Indian ADRs on NYSE / NASDAQ</div>
            <div className="text-xs text-muted mt-0.5">Prices in USD · click a row for news & trend</div>
          </div>
          <span className="text-xs text-muted">{adrs.length} ADRs</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted">
              <th className="px-4 py-2 text-left">Company</th>
              <th className="px-4 py-2 text-center">Sector</th>
              <th className="px-4 py-2 text-right">CMP (USD)</th>
              <th className="px-4 py-2 text-right">Prev Close</th>
              <th className="px-4 py-2 text-right">Change</th>
              <th className="px-4 py-2 text-right">% Change</th>
              <th className="px-4 py-2 text-right">52W High</th>
              <th className="px-4 py-2 text-right">52W Low</th>
            </tr>
          </thead>
          <tbody>
            {adrs.map(adr => (
              <tr
                key={adr.symbol}
                onClick={() => openDetail(adr)}
                className={`border-b border-border cursor-pointer transition-colors hover:bg-slate-800 ${selected?.symbol === adr.symbol ? 'bg-slate-800' : ''}`}
              >
                <td className="px-4 py-3">
                  <div className="font-semibold text-white">{adr.symbol}</div>
                  <div className="text-[10px] text-muted">{adr.name}{adr.nse ? ` · NSE:${adr.nse}` : ''}</div>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="text-xs bg-slate-800 border border-border px-1.5 py-0.5 rounded text-slate-300">{adr.sector}</span>
                </td>
                <td className="px-4 py-3 text-right font-semibold text-white">${adr.cmp.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-muted text-xs">${adr.prev_close.toFixed(2)}</td>
                <td className={`px-4 py-3 text-right text-xs font-medium ${adr.change_amt >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {adr.change_amt >= 0 ? '+' : ''}{adr.change_amt.toFixed(2)}
                </td>
                <td className={`px-4 py-3 text-right text-xs font-bold ${adr.change_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {adr.change_pct >= 0 ? '+' : ''}{adr.change_pct.toFixed(2)}%
                </td>
                <td className="px-4 py-3 text-right text-xs text-slate-400">${adr.high_52w.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-xs text-slate-400">${adr.low_52w.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail panel — news + 52W range bar */}
      {selected && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-white font-bold text-lg">{selected.symbol}</span>
              <span className="text-muted ml-2 text-sm">{selected.name}</span>
            </div>
            <button onClick={() => setSelected(null)} className="text-muted hover:text-white text-xs px-2 py-1 rounded border border-border">✕ Close</button>
          </div>

          {/* 52W range bar */}
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-xs text-muted mb-2">52-Week Range</div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-score-red w-14 text-right">${selected.low_52w.toFixed(2)}</span>
              <div className="flex-1 h-2 bg-slate-700 rounded-full relative">
                <div
                  className="absolute h-3 w-3 rounded-full bg-blue-400 top-1/2 -translate-y-1/2 -translate-x-1/2"
                  style={{ left: `${Math.min(100, Math.max(0, ((selected.cmp - selected.low_52w) / (selected.high_52w - selected.low_52w)) * 100))}%` }}
                />
                <div className="h-full bg-gradient-to-r from-score-red via-score-amber to-score-green rounded-full opacity-30" />
              </div>
              <span className="text-score-green w-14">${selected.high_52w.toFixed(2)}</span>
              <span className="text-blue-400 font-semibold">CMP ${selected.cmp.toFixed(2)}</span>
            </div>
          </div>

          {/* News */}
          <div>
            <div className="text-xs text-muted mb-2 font-semibold uppercase tracking-wider">Related News</div>
            {newsLoading && <div className="text-muted text-xs">Loading news…</div>}
            {!newsLoading && news.length === 0 && <div className="text-muted text-xs">No specific news found — showing latest market news.</div>}
            <div className="space-y-2">
              {news.map((item, i) => (
                <a key={i} href={item.link} target="_blank" rel="noreferrer"
                  className="block bg-slate-800 hover:bg-slate-700 border border-border rounded-lg p-3 transition-colors">
                  <div className="text-white text-sm font-medium leading-snug">{item.title}</div>
                  <div className="flex gap-3 mt-1 text-[10px] text-muted">
                    <span>{item.source}</span>
                    {item.published && <span>{new Date(item.published).toLocaleDateString('en-IN')}</span>}
                    {item.sentiment && (
                      <span className={item.sentiment === 'positive' ? 'text-score-green' : item.sentiment === 'negative' ? 'text-score-red' : 'text-muted'}>
                        {item.sentiment}
                      </span>
                    )}
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type MarketTab = 'overview' | 'global' | 'global_stocks' | 'news' | 'results' | 'history' | 'adrs'

export default function Market() {
  const { macro, sectors, loading } = useMarket()
  const [tab, setTab] = useState<MarketTab>('overview')
  const [selectedSector, setSelectedSector] = useState<string | null>(null)

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
          { key: 'adrs',          label: '🇺🇸 Indian ADRs' },
          { key: 'global_stocks', label: '🏢 Global Stocks' },
          { key: 'news',          label: '📰 News Room' },
          { key: 'results',       label: '📋 Quarterly Results' },
          { key: 'history',       label: '📈 History' },
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
                <div className="text-xs text-muted mb-1">Sector Heatmap</div>
                <div className="text-[10px] text-slate-600 mb-3">Click a sector for details</div>
                <div className="grid grid-cols-2 gap-2">
                  {sectors.map((s) => (
                    <button
                      key={s.sector}
                      onClick={() => setSelectedSector(s.sector)}
                      className="rounded-lg p-3 border border-border/50 text-left hover:border-blue-500/60 transition-colors group"
                      style={{ backgroundColor: `${scoreToColor(s.score)}15` }}
                    >
                      <div className="text-xs text-white font-medium truncate group-hover:text-blue-300">{s.sector}</div>
                      <div className="text-lg font-bold mt-1" style={{ color: scoreToColor(s.score) }}>
                        {s.score}
                      </div>
                      <div className="text-[10px] text-muted">{scoreToLabel(s.score)}</div>
                    </button>
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

      {/* ── Sector Detail Modal ── */}
      {selectedSector && (
        <SectorDetailModal sector={selectedSector} onClose={() => setSelectedSector(null)} />
      )}

      {/* ── Global Indices Tab ── */}
      {tab === 'global' && (
        <div className="space-y-4">
          <GiftNiftyCard />
          <GlobalIndicesTab />
        </div>
      )}

      {/* ── Global Stocks Tab ── */}
      {tab === 'global_stocks' && <GlobalStocksTab />}

      {/* ── News Room Tab ── */}
      {tab === 'news' && <NewsRoomTab />}

      {/* ── Quarterly Results Tab ── */}
      {tab === 'results' && <ResultsCalendarTab />}
      {tab === 'history' && <IndexHistoryTab />}
      {tab === 'adrs' && <IndianADRsTab />}
    </div>
  )
}
