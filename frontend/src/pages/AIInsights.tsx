import { useState, useEffect } from 'react'
import client from '../api/client'
import { scoreToColor } from '../utils/formatters'
import NseStockSearch from '../components/NseStockSearch'
import NextSessionPredictCard from '../components/NextSessionPredictCard'

// ─── Prediction Accuracy Leaderboard ─────────────────────────────────────────

interface AccuracyRow {
  symbol: string
  name: string
  total: number
  hits: number
  nears: number
  misses: number
  hit_rate_pct: number | null
}

interface AccuracySummary {
  overall_hit_rate_pct: number | null
  total_predictions: number
  by_symbol: AccuracyRow[]
}

function PredictionLeaderboard() {
  const [data, setData] = useState<AccuracySummary | null>(null)
  const [history, setHistory] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [filling, setFilling] = useState(false)
  const [fillMsg, setFillMsg] = useState('')
  const [detailSym, setDetailSym]           = useState<string | null>(null)
  const [constHistory, setConstHistory]     = useState<Record<string, unknown>[]>([])

  const CONST_INDEX_MAP: Record<string, string> = {
    '^NSEI': 'nifty', '^NSEBANK': 'banknifty', '^BSESN': 'sensex',
  }

  const load = () => {
    setLoading(true)
    client.get('/predict/accuracy/all')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const loadHistory = (sym: string) => {
    setDetailSym(sym)
    setConstHistory([])
    client.get(`/predict/history/${encodeURIComponent(sym)}?days=30`)
      .then(r => setHistory(r.data.predictions || []))
      .catch(() => setHistory([]))
    // Also load constituent history if it's a tracked index
    const constKey = CONST_INDEX_MAP[sym]
    if (constKey) {
      client.get(`/predict/constituents-history/${constKey}?days=30`)
        .then(r => setConstHistory(r.data.predictions || []))
        .catch(() => setConstHistory([]))
    }
  }

  const fillActuals = async () => {
    setFilling(true)
    setFillMsg('')
    try {
      const r = await client.post('/admin/fill-actuals')
      setFillMsg(`✓ ${r.data.message}`)
      load()
    } catch {
      setFillMsg('Failed to fill actuals')
    } finally { setFilling(false) }
  }

  useEffect(() => { if (expanded) load() }, [expanded])

  const rateColor = (r: number | null) =>
    r == null ? 'text-muted' : r >= 60 ? 'text-score-green' : r >= 40 ? 'text-amber-400' : 'text-score-red'

  const accBadge = (a: string) =>
    a === 'HIT' ? 'bg-green-950 text-green-400 border-green-800' :
    a === 'NEAR' ? 'bg-amber-950 text-amber-400 border-amber-800' :
    'bg-red-950 text-red-400 border-red-800'

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-800/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-base">🎯</span>
          <div className="text-left">
            <div className="text-sm font-semibold text-white">Prediction Accuracy Tracker</div>
            <div className="text-[10px] text-muted">Track how well next-session predictions performed — HIT / NEAR / MISS</div>
          </div>
          {data && data.total_predictions > 0 && (
            <span className={`ml-2 px-2 py-0.5 rounded text-xs font-bold border ${
              (data.overall_hit_rate_pct ?? 0) >= 60 ? 'bg-green-950 border-green-800 text-green-400' :
              (data.overall_hit_rate_pct ?? 0) >= 40 ? 'bg-amber-950 border-amber-800 text-amber-400' :
              'bg-red-950 border-red-800 text-red-400'
            }`}>
              {data.overall_hit_rate_pct != null ? `${data.overall_hit_rate_pct}% overall` : 'No data'}
            </span>
          )}
        </div>
        <span className="text-muted text-sm">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border px-5 pb-5 space-y-4 pt-4">
          {/* Actions row */}
          <div className="flex items-center gap-3">
            <button onClick={load} disabled={loading}
              className="px-3 py-1.5 bg-card border border-border hover:border-blue-500 text-xs text-muted hover:text-white rounded-lg transition-colors disabled:opacity-40">
              {loading ? '⟳ Loading…' : '⟳ Refresh'}
            </button>
            <button onClick={fillActuals} disabled={filling}
              className="px-3 py-1.5 bg-blue-950 border border-blue-800 hover:bg-blue-900 text-xs text-blue-300 rounded-lg transition-colors disabled:opacity-40">
              {filling ? '⟳ Filling…' : '⬇ Fill Today\'s Actuals'}
            </button>
            {fillMsg && <span className="text-xs text-score-green">{fillMsg}</span>}
            <span className="ml-auto text-[10px] text-muted">Auto-fills at 3:45 PM IST on weekdays</span>
          </div>

          {/* No data state */}
          {!loading && (!data || data.total_predictions === 0) && (
            <div className="text-center py-8 space-y-2">
              <div className="text-3xl">📭</div>
              <div className="text-sm text-white font-medium">No evaluated predictions yet</div>
              <div className="text-xs text-muted max-w-md mx-auto">
                Predictions are generated when you click "Load next session prediction" on any stock.
                After market close (3:30 PM IST), click "Fill Today's Actuals" to evaluate them.
                The system will auto-fill every weekday at 3:45 PM going forward.
              </div>
            </div>
          )}

          {/* Overall stats */}
          {data && data.total_predictions > 0 && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Total Evaluated</div>
                  <div className="text-xl font-bold text-white">{data.total_predictions}</div>
                </div>
                <div className="bg-green-950/40 border border-green-800/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Overall Hit Rate</div>
                  <div className={`text-xl font-bold ${rateColor(data.overall_hit_rate_pct)}`}>
                    {data.overall_hit_rate_pct != null ? `${data.overall_hit_rate_pct}%` : '—'}
                  </div>
                  <div className="text-[9px] text-muted">HIT + NEAR</div>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Symbols Tracked</div>
                  <div className="text-xl font-bold text-white">{data.by_symbol.length}</div>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-0.5">Scoring</div>
                  <div className="text-[10px] text-slate-300 mt-1">HIT = in range<br/>NEAR = ±0.5% outside<br/>MISS = beyond</div>
                </div>
              </div>

              {/* Leaderboard table */}
              <div className="bg-slate-800/30 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-muted border-b border-border bg-slate-800/60">
                      <th className="text-left px-4 py-2.5">Symbol</th>
                      <th className="text-right px-3 py-2.5">Predictions</th>
                      <th className="text-right px-3 py-2.5 text-score-green">HIT</th>
                      <th className="text-right px-3 py-2.5 text-amber-400">NEAR</th>
                      <th className="text-right px-3 py-2.5 text-score-red">MISS</th>
                      <th className="text-right px-3 py-2.5">Hit Rate</th>
                      <th className="px-3 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_symbol.map(row => (
                      <tr key={row.symbol}
                        className="border-b border-border/30 hover:bg-slate-800/30 cursor-pointer"
                        onClick={() => detailSym === row.symbol ? setDetailSym(null) : loadHistory(row.symbol)}>
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-white">{row.symbol.replace('.NS','').replace('^','')}</div>
                          <div className="text-[10px] text-muted truncate max-w-[140px]">{row.name}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-300">{row.total}</td>
                        <td className="px-3 py-2.5 text-right text-score-green font-semibold">{row.hits}</td>
                        <td className="px-3 py-2.5 text-right text-amber-400 font-semibold">{row.nears}</td>
                        <td className="px-3 py-2.5 text-right text-score-red font-semibold">{row.misses}</td>
                        <td className="px-3 py-2.5 text-right">
                          <span className={`font-bold text-sm ${rateColor(row.hit_rate_pct)}`}>
                            {row.hit_rate_pct != null ? `${row.hit_rate_pct}%` : '—'}
                          </span>
                          {row.total >= 3 && (
                            <div className="w-full bg-slate-700 rounded-full h-1 mt-1">
                              <div className={`h-1 rounded-full ${
                                (row.hit_rate_pct ?? 0) >= 60 ? 'bg-score-green' :
                                (row.hit_rate_pct ?? 0) >= 40 ? 'bg-amber-400' : 'bg-score-red'
                              }`} style={{ width: `${row.hit_rate_pct ?? 0}%` }} />
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-[10px] text-muted">
                          {detailSym === row.symbol ? '▲ hide' : '▼ history'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Per-symbol prediction history — two columns */}
              {detailSym && history.length > 0 && (
                <div className="bg-slate-900/60 rounded-xl p-4 space-y-3">
                  <div className="text-xs font-semibold text-white">
                    {detailSym.replace('.NS','').replace('^','')} — last {history.length} predictions
                  </div>

                  {/* Two-column header */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="text-[9px] text-muted font-semibold uppercase tracking-wide">Top-Down (Macro)</div>
                    <div className="text-[9px] text-muted font-semibold uppercase tracking-wide">
                      Constituent-Based {constHistory.length === 0 && CONST_INDEX_MAP[detailSym] ? <span className="text-slate-600 normal-case">— no data yet, click Sync</span> : ''}
                    </div>
                  </div>

                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {history.map((p: Record<string,unknown>, i) => {
                      const range   = p.range as Record<string,unknown>
                      const acc     = p.accuracy as string | null
                      const oacc    = p.open_accuracy as string | null
                      // Find matching constituent prediction by session_date
                      const cPred   = constHistory.find((c: Record<string,unknown>) => c.session_date === p.session_date) as Record<string,unknown> | undefined
                      const cAcc    = cPred?.accuracy as string | null
                      const cOAcc   = cPred?.open_accuracy as string | null

                      const accBadgeCls = (a: string | null) =>
                        a === 'HIT'  ? 'bg-green-950 text-green-400 border-green-800' :
                        a === 'NEAR' ? 'bg-amber-950 text-amber-400 border-amber-800' :
                        a === 'MISS' ? 'bg-red-950 text-red-400 border-red-800' : ''

                      return (
                        <div key={i} className="grid grid-cols-2 gap-3 border-b border-border/20 pb-1.5 last:border-0">
                          {/* Left: top-down */}
                          <div className="flex items-center gap-2 text-[10px]">
                            <span className="text-muted w-20 shrink-0">{(p.session_date as string)}</span>
                            <div className="flex-1 min-w-0">
                              <span className="text-slate-400">
                                {(range?.low as number)?.toFixed(0)}–{(range?.high as number)?.toFixed(0)}
                              </span>
                              {p.actual_close != null ? (
                                <span className="text-white ml-1">act {p.actual_close as number}</span>
                              ) : (
                                <span className="text-muted ml-1">pending</span>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-0.5 shrink-0">
                              {acc ? (
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${accBadgeCls(acc)}`}>{acc}</span>
                              ) : <span className="text-[9px] text-slate-600">—</span>}
                              {oacc && (
                                <span className={`px-1 py-0.5 rounded text-[8px] font-bold border ${accBadgeCls(oacc)}`}>O:{oacc}</span>
                              )}
                            </div>
                          </div>

                          {/* Right: constituent */}
                          {cPred ? (
                            <div className="flex items-center gap-2 text-[10px]">
                              <div className="flex-1 min-w-0">
                                <span className="text-slate-400">
                                  {(cPred.close_low as number)?.toFixed(0)}–{(cPred.close_high as number)?.toFixed(0)}
                                </span>
                                {cPred.actual_close != null ? (
                                  <span className="text-white ml-1">act {cPred.actual_close as number}</span>
                                ) : (
                                  <span className="text-muted ml-1">pending</span>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-0.5 shrink-0">
                                {cAcc ? (
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${accBadgeCls(cAcc)}`}>{cAcc}</span>
                                ) : <span className="text-[9px] text-slate-600">—</span>}
                                {cOAcc && (
                                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold border ${accBadgeCls(cOAcc)}`}>O:{cOAcc}</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[10px] text-slate-700 italic flex items-center">no constituent data</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface QuickQuestion {
  label: string
  icon: string
  endpoint: string
  type: 'market' | 'stock' | 'news'
  description: string
}

const QUICK_QUESTIONS: QuickQuestion[] = [
  {
    label: 'Global Trend',
    icon: '🌍',
    endpoint: '/market/global-indices',
    type: 'market',
    description: 'How are global markets performing today?',
  },
  {
    label: 'Market Overview',
    icon: '📊',
    endpoint: '/market/macro',
    type: 'market',
    description: 'Current macro environment and market mode for India',
  },
  {
    label: 'NSE Impacting News',
    icon: '📰',
    endpoint: '/market/news',
    type: 'news',
    description: 'Top headlines that could move Indian markets',
  },
  {
    label: 'Sector Strength',
    icon: '🏭',
    endpoint: '/market/sectors',
    type: 'market',
    description: 'Which sectors are leading or lagging right now?',
  },
]

// ─── Result renderers ─────────────────────────────────────────────────────────

function GlobalTrendResult({ data }: { data: Record<string, unknown> }) {
  const indices = (data.indices as Record<string, unknown>[]) || []
  const upCount  = indices.filter(i => (i.change_pct as number ?? 0) >= 0).length
  const downCount = indices.length - upCount
  const regions = ['Asia', 'Americas', 'Europe']
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="bg-green-950 border border-green-800 rounded-xl px-5 py-3 text-center flex-1">
          <div className="text-2xl font-bold text-score-green">{upCount}</div>
          <div className="text-xs text-muted mt-0.5">Indices Up</div>
        </div>
        <div className="bg-red-950 border border-red-800 rounded-xl px-5 py-3 text-center flex-1">
          <div className="text-2xl font-bold text-score-red">{downCount}</div>
          <div className="text-xs text-muted mt-0.5">Indices Down</div>
        </div>
        <div className="bg-card border border-border rounded-xl px-5 py-3 text-center flex-1">
          <div className="text-2xl font-bold text-white">{indices.length}</div>
          <div className="text-xs text-muted mt-0.5">Total Tracked</div>
        </div>
      </div>
      {regions.map(region => {
        const items = indices.filter(i => i.region === region)
        if (!items.length) return null
        return (
          <div key={region}>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{region}</div>
            <div className="grid grid-cols-2 gap-2">
              {items.map((idx: Record<string, unknown>) => {
                const pct = idx.change_pct as number | null
                const up = (pct ?? 0) >= 0
                return (
                  <div key={idx.symbol as string}
                    className={`rounded-lg px-3 py-2.5 border flex items-center justify-between ${
                      up ? 'bg-green-950/30 border-green-900' : 'bg-red-950/30 border-red-900'
                    }`}>
                    <div>
                      <div className="text-sm font-semibold text-white">{idx.name as string}</div>
                      <div className="text-[10px] text-muted">{idx.country as string}</div>
                    </div>
                    <div className="text-right">
                      <div className={`text-sm font-bold ${up ? 'text-score-green' : 'text-score-red'}`}>
                        {up ? '▲' : '▼'} {pct != null ? Math.abs(pct).toFixed(2) + '%' : '—'}
                      </div>
                      <div className="text-[10px] text-muted">
                        {idx.price != null ? (idx.price as number).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MacroResult({ data }: { data: Record<string, unknown> }) {
  const score = (data.score as number) || 0
  const mode = (data.market_mode as string) || 'NEUTRAL'
  // breakdown values are objects { score, weight, details } — extract score from each
  const rawBreakdown = (data.breakdown as Record<string, unknown> | undefined) ?? {}
  const breakdown: Record<string, { score: number; weight: number }> = {}
  for (const [k, v] of Object.entries(rawBreakdown)) {
    if (v && typeof v === 'object' && 'score' in v) {
      breakdown[k] = v as { score: number; weight: number }
    }
  }
  const hasBreakdown = Object.keys(breakdown).length > 0
  const modeColors: Record<string, string> = {
    BULL:    'text-score-green bg-green-950 border-green-800',
    BEAR:    'text-score-red bg-red-950 border-red-800',
    NEUTRAL: 'text-score-blue bg-blue-950 border-blue-800',
    CAUTION: 'text-score-amber bg-amber-950 border-amber-800',
  }
  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-center">
        <div className="bg-card border border-border rounded-xl p-5 text-center">
          <div className="text-xs text-muted mb-1">Macro Score</div>
          <div className="text-4xl font-bold" style={{ color: scoreToColor(score) }}>{score}</div>
          <div className="text-xs text-muted mt-1">/100</div>
        </div>
        <div className={`flex-1 rounded-xl p-5 border text-center ${modeColors[mode] || modeColors['NEUTRAL']}`}>
          <div className="text-xs mb-1 opacity-70">Market Mode</div>
          <div className="text-3xl font-bold">{mode}</div>
          <div className="text-xs mt-2 opacity-70">
            {score >= 80 ? 'Favourable for deployment' :
             score >= 60 ? 'Selective entries only' :
             'Capital preservation mode'}
          </div>
        </div>
      </div>
      {hasBreakdown && (
        <div>
          <div className="text-xs text-muted mb-2">Score Breakdown</div>
          <div className="space-y-2">
            {Object.entries(breakdown).map(([k, v]) => {
              // Each factor score is out of 10, weight shown alongside
              const pct = v.score * 10  // normalise to 0-100 for bar width
              return (
                <div key={k} className="flex items-center gap-3">
                  <div className="text-xs text-slate-400 w-40 capitalize">{k.replace(/_/g, ' ')}</div>
                  <div className="flex-1 bg-slate-800 rounded-full h-2">
                    <div className="h-2 rounded-full" style={{ width: `${pct}%`, backgroundColor: scoreToColor(pct) }} />
                  </div>
                  <div className="text-xs font-semibold w-10 text-right" style={{ color: scoreToColor(pct) }}>
                    {v.score}/10
                  </div>
                  <div className="text-[10px] text-muted w-14 text-right">wt {v.weight}%</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function NewsResult({ data }: { data: Record<string, unknown> }) {
  const news = (data.news as Record<string, unknown>[]) || []
  const impactColor = (s: number) =>
    s >= 4 ? 'bg-red-950 border border-red-800 text-score-red' :
    s >= 3 ? 'bg-orange-950 border border-orange-700 text-orange-400' :
    s >= 2 ? 'bg-amber-950 border border-amber-700 text-amber-400' :
    'bg-slate-700 text-muted'
  const impactLabel = (s: number) =>
    s >= 4 ? 'Very High' : s >= 3 ? 'High' : s >= 2 ? 'Medium' : 'Low'

  return (
    <div className="space-y-3">
      {news.map((item, i) => (
        <a key={i} href={item.link as string} target="_blank" rel="noopener noreferrer"
          className="block bg-slate-800/50 border border-border/50 rounded-xl p-3.5 hover:border-blue-500/50 group transition-colors">
          <div className="flex items-start gap-3">
            <div className="text-xl font-bold text-slate-600 w-6 shrink-0">{i + 1}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="text-sm font-semibold text-white group-hover:text-blue-300 transition-colors leading-snug">
                  {item.title as string}
                </div>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${impactColor(item.impact_score as number)}`}>
                  {impactLabel(item.impact_score as number)}
                </span>
              </div>
              {item.summary ? <div className="text-xs text-muted line-clamp-2">{item.summary as string}</div> : null}
              <div className="text-[10px] text-slate-600 mt-1">{(item.source as string).replace('Google News ', '')}</div>
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}

function SectorResult({ data }: { data: Record<string, unknown> }) {
  const sectors = (data.sectors as { sector: string; score: number }[]) || []
  return (
    <div className="space-y-2">
      {sectors.map(s => (
        <div key={s.sector} className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-3 py-2.5">
          <div className="text-sm text-white w-32 truncate">{s.sector}</div>
          <div className="flex-1 bg-slate-700 rounded-full h-2">
            <div className="h-2 rounded-full transition-all" style={{ width: `${s.score}%`, backgroundColor: scoreToColor(s.score) }} />
          </div>
          <div className="text-sm font-bold w-8 text-right" style={{ color: scoreToColor(s.score) }}>{s.score}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Stock Analysis Result ────────────────────────────────────────────────────

function StockResult({ data }: { data: Record<string, unknown> }) {
  const verdict  = data.verdict as Record<string, unknown> | undefined
  const score    = (data.overall_score as number) || 0
  const cmp      = data.current_price as number | null
  const prev     = data.prev_close   as number | null
  const chgInr   = data.change_inr   as number | null
  const chgPct   = data.change_pct   as number | null
  const scores   = (data.scores as Record<string, number>) || {}
  const aiPowered = (verdict as Record<string, unknown> | undefined)?.ai_powered as boolean | undefined
  const aiError   = data.ai_error as string | null

  const SCORE_LABELS: Record<string, string> = {
    company_health:    'Health',
    growth_trend:      'Growth',
    technical_strength:'Technical',
    sector_strength:   'Sector',
    business_events:   'Events',
    macro_environment: 'Macro',
  }

  if (!verdict) return <div className="text-muted text-sm">No analysis data</div>
  const action = (verdict.action as string) || 'HOLD'
  const actionColors: Record<string, string> = {
    BUY:  'bg-green-950 border-green-800 text-score-green',
    HOLD: 'bg-blue-950 border-blue-800 text-score-blue',
    SELL: 'bg-red-950 border-red-800 text-score-red',
    AVOID:'bg-red-950 border-red-800 text-score-red',
  }
  return (
    <div className="space-y-4">
      {/* CMP + day change strip */}
      {cmp != null && (
        <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-4">
          <div>
            <div className="text-[10px] text-muted mb-0.5">Current Price</div>
            <div className="text-2xl font-bold text-white">₹{cmp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
          </div>
          {prev != null && (
            <div>
              <div className="text-[10px] text-muted mb-0.5">Prev Close</div>
              <div className="text-sm text-slate-400">₹{prev.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
          )}
          {chgPct != null && (
            <div className={`ml-2 px-3 py-1.5 rounded-xl border ${chgPct >= 0 ? 'bg-green-950 border-green-800' : 'bg-red-950 border-red-800'}`}>
              <div className={`text-lg font-bold ${chgPct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {chgPct >= 0 ? '▲' : '▼'} {Math.abs(chgPct).toFixed(2)}%
              </div>
              {chgInr != null && (
                <div className={`text-xs ${chgPct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {chgInr >= 0 ? '+' : ''}₹{Math.abs(chgInr).toFixed(2)}
                </div>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {aiPowered ? (
              <span className="px-2 py-1 bg-blue-950 border border-blue-800 text-score-blue rounded-lg text-[10px] font-bold">◆ AI Powered</span>
            ) : aiError ? (
              <span className="px-2 py-1 bg-red-950 border border-red-800 text-score-red rounded-lg text-[10px] font-medium" title={aiError}>⚠ AI Error — Rule-based fallback</span>
            ) : (
              <span className="px-2 py-1 bg-slate-700 text-muted rounded-lg text-[10px]">Rule-based</span>
            )}
          </div>
        </div>
      )}

      {/* Score + Recommendation + Stars */}
      <div className="flex items-center gap-4">
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-xs text-muted mb-1">Overall Score</div>
          <div className="text-3xl font-bold" style={{ color: scoreToColor(score) }}>{score}</div>
        </div>
        <div className={`flex-1 rounded-xl p-4 border text-center ${actionColors[action] || actionColors['HOLD']}`}>
          <div className="text-xs mb-1 opacity-70">AI Recommendation</div>
          <div className="text-2xl font-bold">{action}</div>
          {verdict.confidence != null ? (
            <div className="text-xs mt-1 opacity-70">Confidence: {verdict.confidence as number}%</div>
          ) : null}
        </div>
        {verdict.stars != null ? (
          <div className="bg-card border border-border rounded-xl p-4 text-center">
            <div className="text-xs text-muted mb-1">Rating</div>
            <div className="text-xl text-score-amber">{'★'.repeat(verdict.stars as number)}{'☆'.repeat(5 - (verdict.stars as number))}</div>
          </div>
        ) : null}
      </div>

      {/* 6 sub-scores */}
      {Object.keys(scores).length > 0 && (
        <div className="grid grid-cols-6 gap-2">
          {Object.entries(scores).map(([key, val]) => (
            <div key={key} className="bg-slate-800/60 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted mb-0.5">{SCORE_LABELS[key] || key}</div>
              <div className="text-sm font-bold" style={{ color: scoreToColor(val) }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {typeof verdict.summary === 'string' && verdict.summary ? (
        <div className="bg-slate-800 rounded-xl p-4">
          <div className="text-xs text-muted mb-2">AI Summary</div>
          <p className="text-sm text-slate-200 leading-relaxed">{verdict.summary}</p>
        </div>
      ) : null}

      {/* Entry / Target / Stop */}
      {(verdict.entry_range || verdict.target_price || verdict.stop_loss) ? (
        <div className="grid grid-cols-3 gap-3">
          {verdict.entry_range ? (
            <div className="bg-card border border-border rounded-xl p-3 text-center">
              <div className="text-xs text-muted mb-1">Entry Range</div>
              <div className="text-sm font-semibold text-white">
                ₹{(verdict.entry_range as Record<string, number>).low} – ₹{(verdict.entry_range as Record<string, number>).high}
              </div>
            </div>
          ) : null}
          {verdict.target_price ? (
            <div className="bg-green-950 border border-green-800 rounded-xl p-3 text-center">
              <div className="text-xs text-muted mb-1">Target</div>
              <div className="text-sm font-semibold text-score-green">₹{verdict.target_price as number}</div>
            </div>
          ) : null}
          {verdict.stop_loss ? (
            <div className="bg-red-950 border border-red-800 rounded-xl p-3 text-center">
              <div className="text-xs text-muted mb-1">Stop Loss</div>
              <div className="text-sm font-semibold text-score-red">₹{verdict.stop_loss as number}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Reasons + Risks */}
      <div className="grid grid-cols-2 gap-4">
        {Array.isArray(verdict.reasons) && (verdict.reasons as string[]).length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted mb-3">Key Reasons</div>
            <ul className="space-y-2">
              {(verdict.reasons as string[]).map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                  <span className="text-score-green mt-0.5 shrink-0">✓</span> {r}
                </li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(verdict.risks) && (verdict.risks as string[]).length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted mb-3">Risks to Monitor</div>
            <ul className="space-y-2">
              {(verdict.risks as string[]).map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-400">
                  <span className="text-score-amber mt-0.5 shrink-0">⚠</span> {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── Prediction Result (Index / ETF) ─────────────────────────────────────────

function PredictResult({ data }: { data: Record<string, unknown> }) {
  const name    = data.name as string
  const curr    = data.current as number
  const prev    = data.prev_close as number | null
  const chgInr  = data.change_inr as number | null
  const chgPct  = data.change_pct as number | null
  const trend   = data.trend as string
  const signal  = data.signal as string
  const score   = data.score as number
  const bias    = data.news_bias as string
  const narrative = data.narrative as string
  const note    = data.note as string
  const outlooks = (data.outlooks as Record<string, unknown>[]) || []
  const factors  = (data.factors as Record<string, unknown>[]) || []

  const signalColor = signal === 'BUY' ? 'text-score-green' : signal === 'AVOID' ? 'text-score-red' : 'text-score-blue'
  const trendColor  = trend?.includes('Up') ? 'text-score-green' : trend === 'Downtrend' ? 'text-score-red' : 'text-score-amber'
  const chgColor    = (chgPct ?? 0) >= 0 ? 'text-score-green' : 'text-score-red'

  return (
    <div className="space-y-4">
      {/* CMP + day change strip */}
      {curr != null && (
        <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-4">
          <div>
            <div className="text-[10px] text-muted mb-0.5">CMP</div>
            <div className="text-2xl font-bold text-white">{curr?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
          </div>
          {prev != null && (
            <div>
              <div className="text-[10px] text-muted mb-0.5">Prev Close</div>
              <div className="text-sm text-slate-400">{prev.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
          )}
          {chgPct != null && (
            <div className={`ml-2 px-3 py-1.5 rounded-xl border ${(chgPct) >= 0 ? 'bg-green-950 border-green-800' : 'bg-red-950 border-red-800'}`}>
              <div className={`text-lg font-bold ${chgColor}`}>
                {chgPct >= 0 ? '▲' : '▼'} {Math.abs(chgPct).toFixed(2)}%
              </div>
              {chgInr != null && (
                <div className={`text-xs ${chgColor}`}>
                  {chgInr >= 0 ? '+' : ''}{chgInr.toFixed(2)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-[10px] text-muted mb-1">Score</div>
          <div className="text-lg font-bold" style={{ color: scoreToColor(score) }}>{score}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-[10px] text-muted mb-1">Trend</div>
          <div className={`text-sm font-bold ${trendColor}`}>{trend}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-[10px] text-muted mb-1">Signal</div>
          <div className={`text-sm font-bold ${signalColor}`}>{signal}</div>
        </div>
      </div>

      {/* Near-term outlooks */}
      <div>
        <div className="text-xs text-muted mb-2 px-1">Near-Term Outlook</div>
        <div className="grid grid-cols-3 gap-3">
          {outlooks.map((o, i) => {
            const bp = o.bull_pct as number
            const low = o.low as number
            const high = o.high as number
            const bearColor = bp < 50 ? 'text-score-red' : bp > 55 ? 'text-score-green' : 'text-score-amber'

            // CMP tracker — only meaningful for 1-day; for others it's indicative
            const rangeSpan = high - low
            const cmPct = curr && rangeSpan > 0 ? Math.max(2, Math.min(98, ((curr - low) / rangeSpan) * 100)) : null
            const insideRange = curr != null && curr >= low && curr <= high
            const aboveRange  = curr != null && curr > high
            const belowRange  = curr != null && curr < low

            return (
              <div key={i} className="bg-card border border-border rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-300">{o.period as string}</span>
                  {i === 0 && curr != null && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                      insideRange ? 'bg-green-950 border-green-800 text-green-400' :
                      aboveRange  ? 'bg-blue-950 border-blue-800 text-blue-400' :
                      'bg-red-950 border-red-800 text-red-400'
                    }`}>
                      {insideRange ? '✓ In Range' : aboveRange ? '▲ Above' : '▼ Below'}
                    </span>
                  )}
                </div>
                <div className="flex justify-between text-xs mb-2">
                  <span className="text-score-green font-bold">▲ {bp}%</span>
                  <span className="text-score-red font-bold">▼ {o.bear_pct as number}%</span>
                </div>
                {/* Probability bar */}
                <div className="w-full bg-red-950 rounded-full h-2 mb-2">
                  <div className="h-2 rounded-full bg-score-green" style={{ width: `${bp}%` }} />
                </div>
                <div className={`text-[11px] font-bold text-center ${bearColor}`}>
                  {bp > 55 ? 'Leaning Bullish' : bp < 45 ? 'Leaning Bearish' : 'Neutral'}
                </div>

                {/* Range with CMP marker */}
                <div className="mt-2 pt-2 border-t border-border/40">
                  <div className="flex justify-between text-[10px] text-muted mb-1">
                    <span>{low.toLocaleString('en-IN')}</span>
                    <span>{high.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="relative h-3 bg-slate-700 rounded-full overflow-visible">
                    <div className={`absolute inset-0 rounded-full opacity-40 ${
                      insideRange ? 'bg-green-500' : 'bg-slate-600'
                    }`} />
                    {cmPct != null && (
                      <>
                        <div className="absolute top-0 bottom-0 w-1 bg-blue-400 rounded"
                             style={{ left: `${cmPct}%`, transform: 'translateX(-50%)' }} />
                      </>
                    )}
                  </div>
                  {curr != null && (
                    <div className="text-[9px] text-center mt-0.5 text-blue-400">
                      CMP {curr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Key factors */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs text-muted mb-3">Key Factors</div>
        <div className="space-y-2">
          {factors.map((f, i) => {
            const impact = f.impact as string
            const dot = impact === 'bullish' ? 'text-score-green' : impact === 'bearish' ? 'text-score-red' : 'text-score-amber'
            return (
              <div key={i} className="flex items-start gap-2">
                <span className={`text-xs font-bold mt-0.5 shrink-0 ${dot}`}>●</span>
                <div>
                  <span className="text-xs font-semibold text-white">{f.factor as string}</span>
                  <span className="text-xs text-muted ml-2">{f.detail as string}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* AI narrative */}
      {narrative && (
        <div className="bg-slate-800/60 border border-border rounded-xl p-4">
          <div className="text-[10px] text-muted mb-1.5 flex items-center gap-1.5">
            <span>Analysis</span>
            <span className="px-1.5 py-0.5 bg-blue-950 border border-blue-800 text-score-blue rounded text-[10px] font-medium">AUTO</span>
            <span className={`ml-auto text-[10px] font-medium capitalize ${bias === 'positive' ? 'text-score-green' : bias === 'negative' ? 'text-score-red' : 'text-muted'}`}>
              News: {bias}
            </span>
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{narrative}</p>
        </div>
      )}

      {note && <div className="text-[10px] text-muted italic px-1">{note}</div>}
    </div>
  )
}

type ResultType = 'global' | 'macro' | 'news' | 'sectors' | 'stock' | 'predict' | null

export default function AIInsights() {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null)
  const [resultType, setResultType] = useState<ResultType>(null)
  const [benchmarkOpen, setBenchmarkOpen] = useState(true)
  const [resultData, setResultData] = useState<Record<string, unknown> | null>(null)

  const fetchQuestion = async (q: QuickQuestion) => {
    setLoading(true)
    setError('')
    setActiveQuestion(q.label)
    setResultData(null)
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), 20000)
      const res = await client.get(q.endpoint, { signal: controller.signal })
      clearTimeout(tid)
      setResultData(res.data)
      if (q.endpoint.includes('global')) setResultType('global')
      else if (q.endpoint.includes('macro')) setResultType('macro')
      else if (q.endpoint.includes('news')) setResultType('news')
      else if (q.endpoint.includes('sectors')) setResultType('sectors')
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || ''
      setError(msg.includes('abort') ? 'Request timed out. Try again.' : 'Failed to load data.')
    } finally { setLoading(false) }
  }

  const analyzeStock = async (symbol: string, name: string) => {
    if (!symbol) return
    setSelectedSymbol(symbol)
    setSelectedName(name)
    setLoading(true)
    setError('')
    const displayName = symbol.replace('.NS', '').replace('^', '')
    setActiveQuestion(`${displayName}: ${name}`)
    setResultData(null)

    try {
      // /ai/explain works for stocks, indices (^NSEI, ^NSEBANK) and ETFs alike
      const res = await client.get(`/ai/explain/${encodeURIComponent(symbol)}`)
      setResultData(res.data)
      setResultType('stock')
    } catch {
      setError('Analysis failed. Check connection or try again.')
    } finally { setLoading(false) }
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-950 to-slate-800 border border-blue-800 rounded-xl p-5">
        <div className="text-sm font-semibold text-blue-300 mb-1">AI Investment Advisor</div>
        <p className="text-xs text-blue-400">
          Ask predefined questions about global markets, news, and sectors — or analyze any stock with AI.
          Configure your API key in Settings for stock-level AI verdicts.
        </p>
      </div>

      {/* Benchmark Index Predictions */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => setBenchmarkOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/20 transition-colors"
        >
          <div className="text-sm font-semibold text-white flex items-center gap-2">
            <span>🔮</span> Next Session Predictions — Benchmark Indices
          </div>
          <span className="text-muted text-sm">{benchmarkOpen ? '▲' : '▼'}</span>
        </button>
        {benchmarkOpen && (
          <div className="px-4 pb-4">
            <div className="grid grid-cols-3 gap-4">
              {[
                { symbol: '^NSEI',    name: 'NIFTY 50'   },
                { symbol: '^NSEBANK', name: 'Bank Nifty' },
                { symbol: '^BSESN',   name: 'Sensex'     },
              ].map(({ symbol, name }) => (
                <div key={symbol}>
                  <div className="text-xs font-semibold text-slate-400 mb-1.5 px-1">{name}</div>
                  <NextSessionPredictCard symbol={symbol} name={name} compact />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Prediction Accuracy Tracker */}
      <PredictionLeaderboard />

      {/* Quick questions */}
      <div>
        <div className="text-xs text-muted mb-3 px-1">Quick Market Questions</div>
        <div className="grid grid-cols-2 gap-3">
          {QUICK_QUESTIONS.map(q => (
            <button
              key={q.label}
              onClick={() => fetchQuestion(q)}
              disabled={loading}
              className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-colors ${
                activeQuestion === q.label
                  ? 'bg-blue-950 border-blue-600 text-white'
                  : 'bg-card border-border text-slate-300 hover:border-blue-500 hover:bg-slate-800/60'
              } disabled:opacity-50`}
            >
              <span className="text-2xl">{q.icon}</span>
              <div>
                <div className="font-semibold text-sm">{q.label}</div>
                <div className="text-xs text-muted mt-0.5 leading-snug">{q.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Stock / ETF / Index analysis */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs text-muted mb-3">
          Analyze NSE Stock, ETF, or Index — type 3+ characters (e.g. NIFTY, HDFC, BEL, BANKBEES)
        </div>
        <NseStockSearch
          onSelect={analyzeStock}
          placeholder="Search stocks, ETFs or indices (e.g. NIFTY, BANKBEES, INFY)"
          includeEtfIndex
        />
        {selectedSymbol && !loading && (
          <div className="mt-2 text-xs text-muted">
            Selected: <span className="text-white font-medium">{selectedSymbol.replace('.NS', '').replace('^', '')}</span>
            {selectedName && <span className="ml-1 text-muted">— {selectedName}</span>}
          </div>
        )}
        {error && <p className="mt-2 text-xs text-score-red">{error}</p>}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-muted text-sm animate-pulse">
          Loading {activeQuestion}…
        </div>
      )}

      {/* Results */}
      {!loading && resultData && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="text-sm font-semibold text-white">{activeQuestion}</div>
            <span className="px-2 py-0.5 bg-blue-950 border border-blue-800 text-score-blue rounded text-[10px] font-medium">LIVE</span>
          </div>
          {resultType === 'global'  && <GlobalTrendResult data={resultData} />}
          {resultType === 'macro'   && <MacroResult data={resultData} />}
          {resultType === 'news'    && <NewsResult data={resultData} />}
          {resultType === 'sectors' && <SectorResult data={resultData} />}
          {resultType === 'stock'   && <StockResult data={resultData} />}
          {resultType === 'predict' && <PredictResult data={resultData} />}
        </div>
      )}

      {/* Next Session Prediction — shown when a stock is selected after analysis */}
      {selectedSymbol && !loading && resultType === 'stock' && (
        <NextSessionPredictCard symbol={selectedSymbol} name={selectedName} />
      )}
    </div>
  )
}
