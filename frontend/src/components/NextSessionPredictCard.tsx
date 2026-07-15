import { useState } from 'react'
import client from '../api/client'

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
  low: number
  base: number
  high: number
  current_price: number
  bias_pct: number
  direction: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  iv_used: number
  one_sd_pts: number
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

  const load = () => {
    if (loading || triggered) return
    setTriggered(true)
    setLoading(true)
    setError('')
    Promise.all([
      client.get(`/predict/${encodeURIComponent(symbol)}`),
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

  // Range bar: position of current_price and base within low-high
  const rangeSpan = r.high - r.low
  const basePos   = rangeSpan > 0 ? ((r.base - r.low) / rangeSpan) * 100 : 50
  const currPos   = rangeSpan > 0 ? ((r.current_price - r.low) / rangeSpan) * 100 : 50

  const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const fmtPct = (v: number | null) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'

  const accColor = (a: string | null) =>
    a === 'HIT' ? 'text-score-green' : a === 'NEAR' ? 'text-amber-400' : a === 'MISS' ? 'text-score-red' : 'text-muted'

  return (
    <div className={`bg-card border border-border rounded-xl ${compact ? 'p-3' : 'p-5'} space-y-4`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">🔮</span>
          <div>
            <div className="text-sm font-semibold text-white">Next Session Prediction</div>
            <div className="text-[10px] text-muted">{name || pred.company_name} · {pred.session_date}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {history?.hit_rate_pct != null && (
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
        </div>
      </div>

      {/* Range bar */}
      <div>
        <div className="flex justify-between text-[10px] text-muted mb-1">
          <span>Low ₹{fmt(r.low)}</span>
          <span className="text-white font-semibold">Base ₹{fmt(r.base)}</span>
          <span>High ₹{fmt(r.high)}</span>
        </div>
        {/* Bar container — extra top padding for the CMP label above */}
        <div className="relative pt-5">
          {/* CMP label pinned above the bar */}
          <div className="absolute top-0 flex flex-col items-center"
               style={{ left: `${Math.max(2, Math.min(94, currPos))}%`, transform: 'translateX(-50%)' }}>
            <span className="text-[10px] font-bold text-blue-400 whitespace-nowrap bg-slate-900 px-1 rounded">
              ₹{fmt(r.current_price)}
            </span>
            <span className="text-blue-400 text-[9px] leading-none">▼</span>
          </div>

          <div className="relative h-5 bg-slate-700 rounded-full overflow-hidden">
            {/* Coloured range fill */}
            <div className={`absolute inset-y-0 left-0 right-0 ${up ? 'bg-green-900/60' : down ? 'bg-red-900/60' : 'bg-blue-900/40'}`} />
            {/* Base marker — white line */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white/70"
                 style={{ left: `${Math.max(1, Math.min(99, basePos))}%` }} />
            {/* CMP marker — solid blue bar inside the range */}
            <div className="absolute top-0 bottom-0 w-1.5 bg-blue-400 rounded"
                 style={{ left: `${Math.max(0, Math.min(98, currPos))}%` }} />
          </div>
        </div>

        {/* Below bar: IV info + bias + position note */}
        <div className="flex justify-between text-[10px] mt-1">
          <span className="text-muted">1SD range · IV {r.iv_used}%</span>
          <span className={`font-medium ${
            currPos > 85 ? 'text-score-red' : currPos < 15 ? 'text-score-green' :
            currPos > 65 ? 'text-amber-400' : 'text-slate-400'
          }`}>
            CMP is {currPos > 85 ? 'near High' : currPos < 15 ? 'near Low' :
                    currPos > 65 ? 'upper range' : currPos < 35 ? 'lower range' : 'mid-range'}
          </span>
          <span className={dirColor}>Bias {r.bias_pct >= 0 ? '+' : ''}{r.bias_pct.toFixed(2)}%</span>
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

      <div className="text-[9px] text-slate-600 text-center">
        IV-based statistical range · Not financial advice · Outside market hours only
      </div>
    </div>
  )
}
