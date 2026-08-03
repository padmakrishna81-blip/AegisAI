import { useState } from 'react'
import client from '../api/client'
import ConstituentsPredictCard from './ConstituentsPredictCard'
import SmartRangeBar from './SmartRangeBar'

const _HIGH_IMPACT_BEARISH_KEYWORDS = [
  "war","invasion","missile","attack","bomb","nuclear","sanctions","default",
  "bankruptcy","fraud","scam","probe","arrested","raid","crash","collapse",
  "delisted","writeoff","penalty","downgrade","recall","shut down","sebi notice",
  "money laundering","ed notice","cbi notice","tax evasion","loss warning",
  "profit warning","revenue miss","earnings miss","guidance cut",
  "geopolitical","conflict","tension","escalation","terror attack",
  "resigned","sacked","suspended trading",
]

interface PredRange {
  // Closing range (backward compat)
  low: number
  base: number
  high: number
  close_width?: number
  // Opening range (new)
  open_base?: number
  open_low?: number
  open_high?: number
  open_width?: number
  open_gap_pts?: number
  // Common
  current_price: number
  bias_pts?: number
  bias_pct: number
  direction: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  iv_used: number
  large_move?: boolean
  plain_english: string
  news_alerts?: { keyword: string; headline: string }[]
  factors: {
    overall_score: number
    rsi: number | null
    macd_direction: string
    global_bias: string
    gift_nifty_gap: number | null
    sp500_chg_pct: number | null
    vix: number | null
    crude_chg_pct: number | null
  }
}

interface PredData {
  symbol: string
  company_name: string
  session_date: string
  predicted_at: string
  prediction_mode?: 'overnight' | 'intraday' | 'end_of_day'
  range: PredRange
  commentary: string | null
  actual_close: number | null
  accuracy: 'HIT' | 'NEAR' | 'MISS' | null
  market_hours?: boolean
  message?: string
}

interface HistoryData {
  symbol: string
  total_evaluated: number
  hit_rate_pct: number | null
  hits: number
  nears: number
  misses: number
}

interface Props {
  symbol: string
  name?: string
  compact?: boolean   // compact mode for Stock Detail Modal
}

export default function NextSessionPredictCard({ symbol, name, compact }: Props) {
  const [pred, setPred]       = useState<PredData | null>(null)
  const [history, setHistory] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [triggered, setTriggered] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const load = () => {
    if (loading || triggered) return
    setTriggered(true)
    setLoading(true)
    setError('')
    Promise.all([
      client.get(`/predict/${encodeURIComponent(symbol)}?force=true`),
      client.get(`/predict/history/${encodeURIComponent(symbol)}?days=30`),
    ])
      .then(([pRes, hRes]) => {
        setPred(pRes.data)
        setHistory(hRes.data)
      })
      .catch(() => setError('Could not fetch prediction'))
      .finally(() => setLoading(false))
  }

  // Show button until user clicks
  if (!triggered) return (
    <div className={`bg-card border border-border rounded-xl ${compact ? 'p-3' : 'p-4'}`}>
      <button
        onClick={load}
        className="w-full flex items-center justify-center gap-2 text-xs text-muted hover:text-white transition-colors py-1"
      >
        <span>🔮</span>
        <span className="font-medium">Load next session prediction</span>
      </button>
    </div>
  )

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-4 text-center text-muted text-xs animate-pulse">
      Computing next session prediction…
    </div>
  )

  if (error) return (
    <div className="bg-card border border-border rounded-xl p-4 text-score-red text-xs">{error}</div>
  )

  if (!pred) return null

  // Market hours — prediction not available
  if (pred.market_hours) return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-base">🔮</span>
        <span className="text-sm font-semibold text-white">Next Session Prediction</span>
      </div>
      <div className="text-xs text-amber-400">{pred.message}</div>
    </div>
  )

  const r = pred.range
  const up   = r.direction === 'bullish'
  const down = r.direction === 'bearish'
  const dirColor  = up ? 'text-score-green' : down ? 'text-score-red' : 'text-slate-400'
  const dirBg     = up ? 'bg-green-950 border-green-800' : down ? 'bg-red-950 border-red-800' : 'bg-slate-800 border-slate-700'
  const dirLabel  = up ? '▲ Bullish' : down ? '▼ Bearish' : '● Neutral'

  const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const fmtPct = (v: number | null) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'

  const accColor = (a: string | null) =>
    a === 'HIT' ? 'text-score-green' : a === 'NEAR' ? 'text-amber-400' : a === 'MISS' ? 'text-score-red' : 'text-muted'

  const hasOpen = r.open_base != null && r.open_low != null && r.open_high != null

  return (
    <div className={`bg-card border border-border rounded-xl ${compact ? 'p-3' : 'p-5'}`}>
      {/* Header — always visible, click anywhere to collapse/expand */}
      <div
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between cursor-pointer select-none"
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && setCollapsed(c => !c)}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">🔮</span>
          <div className="text-left">
            <div className="text-sm font-semibold text-white">Next Session Prediction</div>
            <div className="text-[10px] text-muted flex items-center gap-1.5">
              {name || pred.company_name} · {pred.session_date}
              {pred.prediction_mode && (
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                  pred.prediction_mode === 'intraday'    ? 'bg-amber-950 border-amber-700 text-amber-400' :
                  pred.prediction_mode === 'end_of_day'  ? 'bg-blue-950 border-blue-800 text-blue-400' :
                  'bg-slate-800 border-slate-700 text-slate-400'
                }`}>
                  {pred.prediction_mode === 'intraday' ? '📈 Intraday' :
                   pred.prediction_mode === 'end_of_day' ? '🌙 End-of-Day' : '🌙 Overnight'}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {history?.hit_rate_pct != null && !collapsed && (
            <div className="text-center">
              <div className="text-[10px] text-muted">Accuracy</div>
              <div className={`text-xs font-bold ${history.hit_rate_pct >= 60 ? 'text-score-green' : history.hit_rate_pct >= 40 ? 'text-amber-400' : 'text-score-red'}`}>
                {history.hit_rate_pct}%
              </div>
              <div className="text-[9px] text-muted">{history.total_evaluated} pred</div>
            </div>
          )}
          <span className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${dirBg} ${dirColor}`}>
            {dirLabel}
          </span>
          <span className="text-muted text-xs ml-1">{collapsed ? '▼' : '▲'}</span>
        </div>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <div className={`space-y-4 ${compact ? 'mt-3' : 'mt-4'}`}>

      {/* Two range bars */}
      <div className="space-y-4">
        {/* Opening Range */}
        {hasOpen && (
          <div className="bg-slate-800/40 rounded-xl p-3">
            <SmartRangeBar
              low={r.open_low!} base={r.open_base!} high={r.open_high!}
              cmp={r.current_price}
              label="🔔 Opening Range (9:15 AM)"
              sublabel={r.open_width != null ? `±${(r.open_width/2).toFixed(0)} pts range` : undefined}
              biasNote={r.open_gap_pts != null
                ? `Expected gap: ${r.open_gap_pts >= 0 ? '+' : ''}${r.open_gap_pts.toFixed(0)} pts  (GIFT Nifty + US + global cues)`
                : undefined}
              biasColor={r.open_gap_pts != null ? (r.open_gap_pts >= 0 ? 'text-score-green' : 'text-score-red') : undefined}
            />
            {r.large_move && (
              <div className="mt-1.5 text-[9px] text-amber-400 font-bold">⚡ Large move expected</div>
            )}
          </div>
        )}

        {/* Closing Range */}
        <div className="bg-slate-800/40 rounded-xl p-3">
          <SmartRangeBar
            low={r.low} base={r.base} high={r.high}
            cmp={r.current_price}
            label="🎯 Closing Range (3:30 PM)"
            sublabel={r.close_width != null ? `±${(r.close_width/2).toFixed(0)} pts range` : undefined}
            biasNote={`Bias ${r.bias_pct >= 0 ? '+' : ''}${r.bias_pct.toFixed(2)}%`}
            biasColor={dirColor}
          />
        </div>
      </div>

      {/* Plain English summary */}
      <div className="bg-slate-800/60 border border-border rounded-lg px-3 py-2.5 text-xs text-slate-200 leading-relaxed">
        {r.plain_english}
      </div>

      {/* News alerts — high-impact headlines */}
      {r.news_alerts && r.news_alerts.length > 0 && (
        <div className="space-y-1.5">
          {r.news_alerts.map((a, i) => {
            const isBearish = _HIGH_IMPACT_BEARISH_KEYWORDS.some(k => a.headline.toLowerCase().includes(k) || a.keyword.includes(k))
            return (
              <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs border ${
                isBearish
                  ? 'bg-red-950/50 border-red-800/60 text-red-300'
                  : 'bg-green-950/50 border-green-800/60 text-green-300'
              }`}>
                <span className="shrink-0 font-bold">{isBearish ? '⚠' : '✦'}</span>
                <span className="leading-snug">{a.headline}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* LLM commentary (if configured) */}
      {pred.commentary && (
        <div className="bg-blue-950/40 border border-blue-900/50 rounded-lg px-3 py-2 text-xs text-blue-200 italic flex items-start gap-1.5">
          <span className="text-blue-400 shrink-0">✦</span>
          {pred.commentary}
        </div>
      )}

      {/* Factors grid */}
      {!compact && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Score', val: `${r.factors.overall_score}/100`, color: r.factors.overall_score >= 65 ? 'text-score-green' : r.factors.overall_score < 45 ? 'text-score-red' : 'text-amber-400' },
            { label: 'RSI', val: r.factors.rsi != null ? r.factors.rsi.toFixed(0) : '—', color: (r.factors.rsi ?? 50) > 70 ? 'text-score-red' : (r.factors.rsi ?? 50) < 35 ? 'text-score-green' : 'text-white' },
            { label: 'MACD', val: r.factors.macd_direction, color: r.factors.macd_direction === 'bullish' ? 'text-score-green' : 'text-score-red' },
            { label: 'Global', val: r.factors.global_bias, color: r.factors.global_bias === 'bullish' ? 'text-score-green' : r.factors.global_bias === 'bearish' ? 'text-score-red' : 'text-slate-400' },
            { label: 'GIFT Gap', val: r.factors.gift_nifty_gap != null ? `${r.factors.gift_nifty_gap >= 0 ? '+' : ''}${r.factors.gift_nifty_gap.toFixed(0)}pts` : '—', color: (r.factors.gift_nifty_gap ?? 0) >= 0 ? 'text-score-green' : 'text-score-red' },
            { label: 'S&P 500', val: fmtPct(r.factors.sp500_chg_pct), color: (r.factors.sp500_chg_pct ?? 0) >= 0 ? 'text-score-green' : 'text-score-red' },
            { label: 'VIX', val: r.factors.vix != null ? r.factors.vix.toFixed(1) : '—', color: (r.factors.vix ?? 20) > 25 ? 'text-score-red' : 'text-white' },
            { label: 'Crude', val: fmtPct(r.factors.crude_chg_pct), color: (r.factors.crude_chg_pct ?? 0) <= 0 ? 'text-score-green' : 'text-score-red' },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-slate-800/50 rounded-lg p-2 text-center">
              <div className="text-[9px] text-muted mb-0.5">{label}</div>
              <div className={`text-[11px] font-bold capitalize ${color}`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Confidence bar */}
      <div>
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-muted">Prediction confidence</span>
          <span className="text-white font-semibold">{r.confidence}%</span>
        </div>
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${r.confidence >= 65 ? 'bg-score-green' : r.confidence >= 45 ? 'bg-amber-500' : 'bg-score-red'}`}
               style={{ width: `${r.confidence}%` }} />
        </div>
      </div>

      {/* Accuracy history */}
      {history && history.total_evaluated > 0 && !compact && (
        <div className="border-t border-border/40 pt-3">
          <div className="text-[10px] text-muted mb-2">Past 30 days accuracy</div>
          <div className="flex gap-3 text-xs">
            <span className="text-score-green font-bold">{history.hits} HIT</span>
            <span className="text-amber-400 font-bold">{history.nears} NEAR</span>
            <span className="text-score-red font-bold">{history.misses} MISS</span>
            <span className="ml-auto text-muted">{history.hit_rate_pct}% success rate</span>
          </div>
        </div>
      )}

      {/* Current accuracy if filled */}
      {pred.accuracy && (
        <div className={`text-xs font-bold text-center ${accColor(pred.accuracy)}`}>
          Last prediction: {pred.accuracy} (actual ₹{pred.actual_close != null ? fmt(pred.actual_close) : '—'})
        </div>
      )}

      <div className="text-[9px] text-slate-400 text-center">
        IV-based statistical range · Not financial advice · Outside market hours only
      </div>

      {/* Constituent-based prediction — only for tracked indices */}
      {['^NSEI', '^NSEBANK', '^BSESN'].includes(symbol) && (
        <ConstituentsPredictCard symbol={symbol} name={name} compact={compact} />
      )}
        </div>
      )}  {/* end collapsed body */}
    </div>
  )
}
