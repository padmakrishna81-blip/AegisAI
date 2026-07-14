import { useState, useEffect } from 'react'
import client from '../api/client'

interface StockDetailData {
  symbol: string
  name: string
  news: { title: string; summary: string; url: string; published_at: number | null; source: string }[]
  analyst: {
    recommendation: string
    target_mean: number | null
    target_high: number | null
    target_low: number | null
    num_analysts: number
    current_price: number | null
  } | null
  earnings_date: string | null
  year_end_targets: {
    methodology: string
    targets: { year: number; low: number; base: number; high: number }[]
  } | null
}

interface Props {
  symbol: string
  name: string
  onClose: () => void
}

function formatDate(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function recColor(rec: string): string {
  const r = rec.toLowerCase()
  if (r === 'buy' || r === 'strong_buy' || r === 'strongbuy') return 'text-green-400 bg-green-950 border-green-800'
  if (r === 'hold' || r === 'neutral') return 'text-amber-400 bg-amber-950 border-amber-800'
  if (r === 'sell' || r === 'strong_sell' || r === 'underperform') return 'text-red-400 bg-red-950 border-red-800'
  return 'text-slate-300 bg-slate-800 border-slate-700'
}

export default function GlobalStockDetailModal({ symbol, name, onClose }: Props) {
  const [data, setData] = useState<StockDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    client.get(`/global-stocks/${encodeURIComponent(symbol)}/detail`)
      .then(r => setData(r.data))
      .catch(e => setError(e?.response?.data?.detail || 'Failed to fetch details'))
      .finally(() => setLoading(false))
  }, [symbol])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl m-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between z-10">
          <div>
            <div className="text-lg font-bold text-white">{symbol}</div>
            <div className="text-xs text-muted">{name || data?.name}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl font-bold px-2">✕</button>
        </div>

        <div className="p-6 space-y-6">
          {loading && (
            <div className="text-center py-16">
              <div className="text-muted text-sm animate-pulse">Loading detailed analysis for {symbol}…</div>
              <div className="text-[10px] text-muted mt-2">Fetching news, analyst data & AI targets</div>
            </div>
          )}

          {error && !loading && (
            <div className="text-center py-10 text-red-400 text-sm">{error}</div>
          )}

          {data && !loading && (
            <>
              {/* ── Analyst Expectations ── */}
              <div className="bg-slate-800/50 border border-border rounded-xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white flex items-center gap-2">📊 Analyst Expectations</div>
                {data.analyst ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`px-3 py-1 rounded-lg text-xs font-bold border capitalize ${recColor(data.analyst.recommendation)}`}>
                        {data.analyst.recommendation.replace('_', ' ')}
                      </span>
                      <span className="text-xs text-muted">{data.analyst.num_analysts} analyst{data.analyst.num_analysts !== 1 ? 's' : ''}</span>
                      {data.analyst.current_price && (
                        <span className="text-xs text-slate-300 ml-auto">Current: <span className="font-bold text-white">${data.analyst.current_price}</span></span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">Low Target</div>
                        <div className="text-lg font-bold text-red-400">{data.analyst.target_low ? `$${data.analyst.target_low}` : '—'}</div>
                      </div>
                      <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">Mean Target</div>
                        <div className="text-lg font-bold text-blue-400">{data.analyst.target_mean ? `$${data.analyst.target_mean}` : '—'}</div>
                      </div>
                      <div className="bg-slate-900/50 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">High Target</div>
                        <div className="text-lg font-bold text-green-400">{data.analyst.target_high ? `$${data.analyst.target_high}` : '—'}</div>
                      </div>
                    </div>
                    {data.analyst.current_price && data.analyst.target_mean && (
                      <div className="text-xs text-muted">
                        Upside potential: <span className={`font-bold ${((data.analyst.target_mean / data.analyst.current_price - 1) * 100) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {((data.analyst.target_mean / data.analyst.current_price - 1) * 100).toFixed(1)}%
                        </span> to mean target
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-muted">No analyst data available for this stock.</div>
                )}
              </div>

              {/* ── Quarterly Result Date ── */}
              <div className="bg-slate-800/50 border border-border rounded-xl p-5 space-y-2">
                <div className="text-sm font-semibold text-white flex items-center gap-2">📅 Next Quarterly Result</div>
                {data.earnings_date ? (
                  <div className="flex items-center gap-3">
                    <span className="px-3 py-1.5 bg-blue-950 border border-blue-800 rounded-lg text-blue-300 text-sm font-bold">{data.earnings_date}</span>
                    <span className="text-xs text-muted">Upcoming earnings announcement</span>
                  </div>
                ) : (
                  <div className="text-xs text-muted">Earnings date not available at this time.</div>
                )}
              </div>

              {/* ── Year-End Targets (AI) ── */}
              <div className="bg-slate-800/50 border border-border rounded-xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white flex items-center gap-2">🎯 Year-End Price Targets (AI-Generated)</div>
                {data.year_end_targets ? (
                  <div className="space-y-3">
                    <div className="text-[11px] text-muted italic">{data.year_end_targets.methodology}</div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] text-muted border-b border-border/50">
                          <th className="text-left py-2 px-2">Year</th>
                          <th className="text-right py-2 px-2">Bear (Low)</th>
                          <th className="text-right py-2 px-2">Base</th>
                          <th className="text-right py-2 px-2">Bull (High)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.year_end_targets.targets.map(t => (
                          <tr key={t.year} className="border-b border-border/30">
                            <td className="py-2.5 px-2 font-bold text-white">{t.year}</td>
                            <td className="py-2.5 px-2 text-right text-red-400 font-mono">${t.low}</td>
                            <td className="py-2.5 px-2 text-right text-blue-400 font-mono font-bold">${t.base}</td>
                            <td className="py-2.5 px-2 text-right text-green-400 font-mono">${t.high}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="text-[10px] text-muted">⚠️ AI-generated estimates based on current fundamentals. Not financial advice.</div>
                  </div>
                ) : (
                  <div className="text-xs text-muted">Year-end targets not available. Ensure AI (LLM) is configured in Settings.</div>
                )}
              </div>

              {/* ── Recent News ── */}
              <div className="bg-slate-800/50 border border-border rounded-xl p-5 space-y-3">
                <div className="text-sm font-semibold text-white flex items-center gap-2">📰 Recent News</div>
                {data.news.length > 0 ? (
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {data.news.map((n, i) => (
                      <div key={i} className="border-b border-border/30 pb-2 last:border-0">
                        <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-white hover:text-blue-300 transition-colors leading-snug block">
                          {n.title}
                        </a>
                        {n.summary && <div className="text-[11px] text-muted mt-0.5 line-clamp-1">{n.summary}</div>}
                        <div className="flex items-center gap-2 text-[10px] text-muted mt-1">
                          <span>{n.source}</span>
                          {n.published_at && <span>· {formatDate(n.published_at)}</span>}
                          {n.url && <a href={n.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-blue-500 hover:underline">Read →</a>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted">No recent news found for this stock.</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}