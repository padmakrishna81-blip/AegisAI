import { useEffect, useState } from 'react'
import client from '../../api/client'
import { useWatchlistStore } from '../../store/watchlistStore'
import AIVerdict from '../scores/AIVerdict'
import ScoreGauge from '../scores/ScoreGauge'
import ScoreBreakdownPanel from '../scores/ScoreBreakdown'
import { scoreToColor, shortSymbol } from '../../utils/formatters'
import type { StockAnalysis } from '../../types'
import NextSessionPredictCard from '../NextSessionPredictCard'

interface StockDetailModalProps {
  symbol: string
  onClose: () => void
}

interface QuoteData {
  cmp: number | null
  prev_close: number | null
  change_inr: number | null
  change_pct: number | null
  high_30d: number | null
  low_30d: number | null
  drop_from_30d_high_pct: number | null
  lift_from_30d_low_pct: number | null
}

const SCORE_LABELS: Record<string, string> = {
  company_health: 'Company Health',
  growth_trend: 'Growth Trend',
  technical_strength: 'Technical',
  sector_strength: 'Sector',
  business_events: 'Business Events',
  macro_environment: 'Macro',
}

const SCORE_WEIGHTS: Record<string, string> = {
  company_health: '30%',
  growth_trend: '25%',
  technical_strength: '20%',
  sector_strength: '10%',
  business_events: '10%',
  macro_environment: '5%',
}

export default function StockDetailModal({ symbol, onClose }: StockDetailModalProps) {
  const [data, setData] = useState<StockAnalysis | null>(null)
  const [quote, setQuote] = useState<QuoteData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { add, remove, has } = useWatchlistStore()
  const inWatchlist = has(symbol)

  useEffect(() => {
    setLoading(true)
    setError('')
    // Fetch analysis and quote in parallel
    Promise.all([
      client.get(`/analyze/${symbol}`),
      client.get(`/watchlist/quotes?symbols=${encodeURIComponent(symbol)}`),
    ])
      .then(([analysisRes, quoteRes]) => {
        setData(analysisRes.data)
        const sym = symbol.includes('.') ? symbol.toUpperCase() : symbol.toUpperCase() + '.NS'
        const q = quoteRes.data[sym] || quoteRes.data[symbol] || Object.values(quoteRes.data)[0]
        if (q) setQuote(q as QuoteData)
      })
      .catch(() => setError('Analysis failed'))
      .finally(() => setLoading(false))
  }, [symbol])

  const toggleWatchlist = () => {
    if (inWatchlist) {
      remove(symbol)
    } else {
      add({
        symbol,
        company_name: data?.company_name || symbol,
        last_score: data?.overall_score,
        last_recommendation: data?.recommendation,
      })
    }
  }

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="relative w-full max-w-2xl bg-background border-l border-border overflow-y-auto flex flex-col z-10">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 py-4 flex items-center justify-between">
          <div>
            <div className="font-bold text-white text-base">
              {data?.company_name || shortSymbol(symbol)}
            </div>
            <div className="text-xs text-muted">{symbol}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleWatchlist}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                inWatchlist
                  ? 'bg-amber-950 border-amber-700 text-amber-400 hover:bg-amber-900'
                  : 'bg-card border-border text-muted hover:text-white hover:border-score-blue'
              }`}
            >
              {inWatchlist ? '★ Watchlist' : '☆ Add to Watchlist'}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-muted hover:text-white hover:bg-slate-800 text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 p-5 space-y-4">
          {loading && (
            <div className="py-20 text-center">
              <div className="text-2xl animate-spin inline-block mb-3">⊙</div>
              <div className="text-sm text-muted">Running all 6 analysis engines...</div>
            </div>
          )}

          {error && (
            <div className="py-10 text-center text-score-red text-sm">{error}</div>
          )}

          {data && !loading && (
            <>
              {/* ── Market Data Strip ───────────────────────────────────── */}
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                {/* Row 1: CMP + change + score + rec */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted mb-0.5">CMP (LTP)</div>
                    <div className="text-2xl font-bold text-white">
                      ₹{(quote?.cmp ?? data.current_price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </div>
                    {/* Use quote change if available, fall back to data (from /analyze) */}
                    {(quote?.change_inr ?? data.change_inr) != null && (() => {
                      const chgInr = (quote?.change_inr ?? data.change_inr) as number
                      const chgPct = (quote?.change_pct ?? data.change_pct) as number | null
                      const prevCl = (quote?.prev_close ?? data.prev_close) as number | null
                      return (
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-sm font-semibold ${chgInr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                            {chgInr >= 0 ? '+' : ''}₹{Math.abs(chgInr).toFixed(2)}
                          </span>
                          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                            chgInr >= 0 ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'
                          }`}>
                            {chgPct != null ? `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%` : ''}
                          </span>
                          {prevCl != null && (
                            <span className="text-xs text-muted">prev ₹{prevCl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-center">
                      <div className="text-xs text-muted mb-1">Score</div>
                      <div className="text-3xl font-bold" style={{ color: scoreToColor(data.overall_score) }}>
                        {data.overall_score}
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs text-muted mb-1">Signal</div>
                      <div className={`text-sm font-bold px-3 py-1.5 rounded-lg border ${
                        data.recommendation === 'BUY' ? 'bg-green-950 border-green-800 text-score-green'
                        : data.recommendation === 'SELL' ? 'bg-red-950 border-red-800 text-score-red'
                        : 'bg-blue-950 border-blue-800 text-score-blue'
                      }`}>
                        {data.recommendation}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Row 2: 52W range + 30D range strip */}
                <div className="grid grid-cols-4 gap-2 border-t border-border pt-3">
                  <div className="bg-slate-800 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-muted mb-0.5">52W High</div>
                    <div className="text-xs font-semibold text-white">
                      {data.high_52w != null ? `₹${data.high_52w.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </div>
                    {data.high_52w != null && (quote?.cmp ?? data.current_price) > 0 && (
                      <div className="text-[10px] text-score-red mt-0.5">
                        {(((quote?.cmp ?? data.current_price) / data.high_52w - 1) * 100).toFixed(1)}%
                      </div>
                    )}
                  </div>
                  <div className="bg-slate-800 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-muted mb-0.5">52W Low</div>
                    <div className="text-xs font-semibold text-white">
                      {data.low_52w != null ? `₹${data.low_52w.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </div>
                    {data.low_52w != null && (quote?.cmp ?? data.current_price) > 0 && (
                      <div className="text-[10px] text-score-green mt-0.5">
                        +{(((quote?.cmp ?? data.current_price) / data.low_52w - 1) * 100).toFixed(1)}%
                      </div>
                    )}
                  </div>
                  <div className="bg-slate-800 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-muted mb-0.5">30D High</div>
                    <div className="text-xs font-semibold text-white">
                      {quote?.high_30d != null ? `₹${quote.high_30d.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </div>
                    {quote?.drop_from_30d_high_pct != null && (
                      <div className="text-[10px] text-score-red mt-0.5">{quote.drop_from_30d_high_pct.toFixed(1)}%</div>
                    )}
                  </div>
                  <div className="bg-slate-800 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-muted mb-0.5">30D Low</div>
                    <div className="text-xs font-semibold text-white">
                      {quote?.low_30d != null ? `₹${quote.low_30d.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </div>
                    {quote?.lift_from_30d_low_pct != null && (
                      <div className="text-[10px] text-score-green mt-0.5">+{quote.lift_from_30d_low_pct.toFixed(1)}%</div>
                    )}
                  </div>
                </div>
              </div>

              {/* AI Verdict */}
              <AIVerdict
                verdict={data.verdict}
                symbol={data.symbol}
                companyName={data.company_name}
                currentPrice={data.current_price}
                overallScore={data.overall_score}
              />

              {/* Score Gauges — all 6 */}
              <div className="bg-card border border-border rounded-xl p-4">
                <div className="text-xs text-muted mb-1">Score Breakdown</div>
                <div className="text-[10px] text-slate-500 mb-3">
                  Company Health 30% · Growth 25% · Technical 20% · Sector 10% · Events 10% · Macro 5%
                </div>
                <div className="grid grid-cols-6 gap-2">
                  {Object.entries(data.scores).map(([key, score]) => (
                    <ScoreGauge
                      key={key}
                      score={score}
                      label={SCORE_LABELS[key] || key}
                      size="sm"
                    />
                  ))}
                </div>
              </div>

              {/* All 6 breakdown panels */}
              <div className="space-y-2">
                {Object.entries(data.scores).map(([key, score]) =>
                  data.breakdowns[key] ? (
                    <div key={key}>
                      <ScoreBreakdownPanel
                        title={`${SCORE_LABELS[key] || key} — ${SCORE_WEIGHTS[key] || ''} weight`}
                        score={score}
                        breakdown={data.breakdowns[key]}
                        defaultOpen={key === 'company_health'}
                      />
                    </div>
                  ) : null
                )}
              </div>

              {/* Technical indicators */}
              {data.technical_indicators && (
                <div className="bg-card border border-border rounded-xl p-4">
                  <div className="text-xs text-muted mb-3">Technical Indicators</div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: 'SMA 20', val: data.technical_indicators.sma20, note: 'Short-term MA' },
                      { label: 'SMA 50', val: data.technical_indicators.sma50, note: 'Medium-term MA' },
                      { label: 'SMA 200', val: data.technical_indicators.sma200, note: 'Long-term MA' },
                      {
                        label: 'RSI (14)', val: data.technical_indicators.rsi,
                        note: (data.technical_indicators.rsi ?? 0) > 70 ? 'Overbought' : (data.technical_indicators.rsi ?? 0) < 30 ? 'Oversold' : 'Neutral'
                      },
                      {
                        label: 'MACD', val: data.technical_indicators.macd,
                        note: (data.technical_indicators.macd ?? 0) > 0 ? 'Bullish' : 'Bearish'
                      },
                      { label: 'ATR %', val: data.technical_indicators.atr_pct, note: 'Volatility' },
                    ].map(({ label, val, note }) => (
                      <div key={label} className="bg-slate-800 rounded-lg p-2.5">
                        <div className="text-[10px] text-muted">{label}</div>
                        <div className="text-sm font-semibold text-white">{val != null ? val.toFixed(2) : '—'}</div>
                        <div className="text-[10px] text-muted">{note}</div>
                      </div>
                    ))}
                  </div>
                  {data.entry_range?.low > 0 && (
                    <div className="mt-2 flex items-center gap-3 bg-slate-800 rounded-lg p-2.5">
                      <span className="text-xs text-muted">Entry Zone:</span>
                      <span className="text-sm font-bold text-score-green">
                        ₹{data.entry_range.low} – ₹{data.entry_range.high}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Recent News */}
              {data.recent_news?.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-4">
                  <div className="text-xs text-muted mb-3">Recent News</div>
                  <ul className="space-y-2">
                    {data.recent_news.map((n, i) => (
                      <li key={i} className="text-xs text-slate-300 border-b border-border/50 pb-2 last:border-0">
                        {n.title}
                        <span className="text-muted ml-1">— {n.source}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Next Session Prediction */}
              <NextSessionPredictCard symbol={symbol} name={data.company_name} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
