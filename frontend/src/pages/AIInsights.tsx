import { useState } from 'react'
import client from '../api/client'
import { scoreToColor } from '../utils/formatters'
import NseStockSearch from '../components/NseStockSearch'

// ─── Predefined questions ─────────────────────────────────────────────────────

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
  const verdict = data.verdict as Record<string, unknown> | undefined
  const score = (data.overall_score as number) || 0
  if (!verdict) return <div className="text-muted text-sm">No analysis data</div>
  const action = (verdict.action as string) || 'HOLD'
  const actionColors: Record<string, string> = {
    BUY: 'bg-green-950 border-green-800 text-score-green',
    HOLD: 'bg-blue-950 border-blue-800 text-score-blue',
    SELL: 'bg-red-950 border-red-800 text-score-red',
    AVOID: 'bg-red-950 border-red-800 text-score-red',
  }
  return (
    <div className="space-y-4">
      {/* Header */}
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-xl p-3 text-center">
          <div className="text-[10px] text-muted mb-1">Current</div>
          <div className="text-lg font-bold text-white">{curr?.toLocaleString('en-IN')}</div>
        </div>
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
            const bearColor = bp < 50 ? 'text-score-red' : bp > 55 ? 'text-score-green' : 'text-score-amber'
            return (
              <div key={i} className="bg-card border border-border rounded-xl p-3">
                <div className="text-xs font-semibold text-slate-300 mb-2">{o.period as string}</div>
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
                <div className="text-[10px] text-muted text-center mt-1">
                  Range: {(o.low as number).toLocaleString('en-IN')} – {(o.high as number).toLocaleString('en-IN')}
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

    const isIndex = symbol.startsWith('^')
    const isEtf   = symbol.endsWith('.NS') && !symbol.match(/^[A-Z]{1,6}\.NS$/)?.index  // ETFs tend to have longer names like NIFTYBEES.NS

    // Use predict endpoint for indices and ETFs; stock analysis for equities
    const isIndexOrEtf = isIndex || ['NIFTYBEES','BANKBEES','GOLDBEES','MOM100','ITBEES','PHARMABEES','JUNIORBEES','AUTOBEES','SHARIABEES','MAFANG'].some(e => symbol.includes(e))

    try {
      if (isIndexOrEtf) {
        const res = await client.get(`/etf/predict/${encodeURIComponent(symbol)}`)
        setResultData(res.data)
        setResultType('predict')
      } else {
        const res = await client.get(`/ai/explain/${symbol}`)
        setResultData(res.data)
        setResultType('stock')
      }
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
    </div>
  )
}
