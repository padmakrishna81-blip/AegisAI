import { useState } from 'react'
import client from '../api/client'
import SmartRangeBar from './SmartRangeBar'

interface Constituent {
  symbol: string
  weight_pct: number
  cmp: number | null
  predicted_move_pct: number
  predicted_move_pts: number
  contribution_pts: number
  contribution_pct_idx: number
  direction: 'bullish' | 'bearish' | 'neutral'
  open_low: number; open_base: number; open_high: number
  close_low: number; close_base: number; close_high: number
  rsi_proxy: number
  pct_from_high: number
  event_warning: string
  event_type?: string
  earnings_detail?: string
  earn_surprise: number
  macd_signal: string
  volume_signal: string
  dma_signal: string
  fii_sensitivity: string
  above_200dma: boolean
  source?: 'full_prediction' | 'quick_calc'
}

interface ConstituentData {
  index_key: string
  index_name: string
  index_cmp: number
  coverage_pct: number
  direction: 'bullish' | 'bearish' | 'neutral'
  summary: string
  event_warnings: string[]
  // Aggregation steps
  total_contribution_pts: number
  extrapolated_pts: number
  global_multiplier: number
  multiplier_factors: Record<string, string>
  midpoint_pts: number
  half_width: number
  // Ranges
  open_base: number; open_low: number; open_high: number
  close_base: number; close_low: number; close_high: number
  open_bias_pts: number
  constituents: Constituent[]
  predicted_at: string
}

interface Props { symbol: string; name?: string; compact?: boolean }

const INDEX_KEY_MAP: Record<string, string> = {
  '^NSEI': 'nifty', '^NSEBANK': 'banknifty', '^BSESN': 'sensex',
}

export default function ConstituentsPredictCard({ symbol, name, compact }: Props) {
  const [data, setData]               = useState<ConstituentData | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [triggered, setTriggered]     = useState(false)
  const [expanded, setExpanded]       = useState(false)
  const [expandedStock, setExpandedStock] = useState<string | null>(null)
  const [showMultiplier, setShowMultiplier] = useState(false)
  const [syncMsg, setSyncMsg]         = useState('')
  const [syncing, setSyncing]         = useState(false)

  const indexKey = INDEX_KEY_MAP[symbol]
  if (!indexKey) return null

  const load = () => {
    if (loading || triggered) return
    setTriggered(true); setLoading(true); setError('')
    client.get(`/predict/constituents/${indexKey}`)
      .then(r => setData(r.data))
      .catch(() => setError('Could not fetch constituent prediction'))
      .finally(() => setLoading(false))
  }

  const sync = async () => {
    setSyncing(true); setSyncMsg(''); setError('')
    try {
      const s = await client.post(`/predict/constituents/${indexKey}/sync`)
      setSyncMsg(`✓ ${s.data.message}`)
      // Reload the constituent card with fresh cached data
      const r = await client.get(`/predict/constituents/${indexKey}`)
      setData(r.data)
      if (!triggered) setTriggered(true)
    } catch {
      setError('Sync failed — try again')
    } finally { setSyncing(false) }
  }

  const fmt   = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 1 })
  const dcol  = (d: string) => d === 'bullish' ? 'text-score-green' : d === 'bearish' ? 'text-score-red' : 'text-slate-400'
  const dbg   = (d: string) => d === 'bullish' ? 'bg-green-950 border-green-800' : d === 'bearish' ? 'bg-red-950 border-red-800' : 'bg-slate-800 border-slate-700'
  const dlbl  = (d: string) => d === 'bullish' ? '▲ Bullish' : d === 'bearish' ? '▼ Bearish' : '● Neutral'

  if (!triggered) return (
    <div className={`bg-card border border-dashed border-slate-700 rounded-xl ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between gap-3">
        <button onClick={load} className="flex-1 flex items-center justify-center gap-2 text-xs text-muted hover:text-white transition-colors py-1">
          <span>🧩</span>
          <span className="font-medium">Load constituent-based prediction</span>
          <span className="text-[10px] text-slate-400 hidden sm:inline">— bottom-up from index constituents</span>
        </button>
        <button onClick={sync} disabled={syncing}
          className="shrink-0 text-[10px] text-blue-400 hover:text-blue-300 px-2.5 py-1 border border-blue-800 bg-blue-950 rounded-lg hover:bg-blue-900 transition-colors disabled:opacity-40 flex items-center gap-1">
          <span className={syncing ? 'animate-spin inline-block' : ''}>⟳</span>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      {syncMsg && <div className="text-[10px] text-score-green text-center mt-1">{syncMsg}</div>}
    </div>
  )

  if (loading && !data) return (
    <div className="bg-card border border-dashed border-slate-700 rounded-xl p-4 text-center text-xs text-muted animate-pulse">
      🧩 Analysing all constituents for next session prediction…
    </div>
  )
  if (error) return (
    <div className="bg-card border border-dashed border-slate-700 rounded-xl p-4 text-xs text-score-red flex items-center justify-between">
      <span>{error}</span>
      <button onClick={() => { setError(''); setTriggered(false) }} className="ml-3 px-2 py-1 bg-card border border-border rounded text-muted hover:text-white text-[10px]">Retry</button>
    </div>
  )
  if (!data) return null

  const d = data
  const fullCount  = d.constituents.filter(c => c.source === 'full_prediction').length
  const quickCount = d.constituents.filter(c => c.source !== 'full_prediction').length

  return (
    <div className={`bg-card border border-dashed border-slate-600 rounded-xl ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">🧩</span>
          <div>
            <div className="text-xs font-semibold text-white flex items-center gap-1.5">
              Constituents Prediction
              <span className="text-[9px] px-1.5 py-0.5 bg-slate-700 border border-slate-600 text-slate-400 rounded">BETA</span>
            </div>
            <div className="text-[10px] text-muted">
              Top {d.constituents.length} stocks · {d.coverage_pct.toFixed(0)}% index weight
              {fullCount > 0 && <span className="ml-1.5 text-score-green">● {fullCount} Full</span>}
              {quickCount > 0 && <span className="ml-1 text-amber-400">● {quickCount} Quick</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-[9px] text-score-green">{syncMsg}</span>}
          <button onClick={sync} disabled={syncing || loading}
            className="text-[10px] text-blue-400 hover:text-blue-300 px-2.5 py-1 border border-blue-800 bg-blue-950 rounded-lg hover:bg-blue-900 transition-colors disabled:opacity-40 flex items-center gap-1">
            <span className={syncing ? 'animate-spin inline-block' : ''}>⟳</span>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border ${dbg(d.direction)} ${dcol(d.direction)}`}>
            {dlbl(d.direction)}
          </span>
        </div>
      </div>

      {/* Event warnings */}
      {d.event_warnings.length > 0 && (
        <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-1.5 text-[10px] text-amber-300">
          ⚠ {d.event_warnings.join(' · ')}
        </div>
      )}

      {/* Opening Range */}
      <div className="bg-slate-800/40 rounded-xl p-3">
        <SmartRangeBar
          low={d.open_low} base={d.open_base} high={d.open_high}
          cmp={d.index_cmp}
          label="🔔 Opening Range (9:15 AM)"
          sublabel={`±${Math.round(d.open_high - d.open_base)} pts range`}
          biasNote={`Expected gap: ${(d.open_bias_pts ?? 0) >= 0 ? '+' : ''}${(d.open_bias_pts ?? 0).toFixed(0)} pts  (GIFT Nifty + US + global cues)`}
          biasColor={(d.open_bias_pts ?? 0) >= 0 ? 'text-score-green' : 'text-score-red'}
        />
      </div>

      {/* Closing Range */}
      <div className="bg-slate-800/40 rounded-xl p-3">
        <SmartRangeBar
          low={d.close_low} base={d.close_base} high={d.close_high}
          cmp={d.index_cmp}
          label="🎯 Closing Range (3:30 PM)"
          sublabel={`±${d.half_width} pts range`}
          biasNote={`Bias ${d.midpoint_pts >= 0 ? '+' : ''}${(d.midpoint_pts / d.index_cmp * 100).toFixed(2)}%`}
          biasColor={d.midpoint_pts >= 0 ? 'text-score-green' : 'text-score-red'}
        />
      </div>

      {/* Aggregation steps — the math chain */}
      <div className="bg-slate-900/60 rounded-lg px-3 py-2 space-y-1">
        <div className="text-[9px] text-muted uppercase tracking-wide mb-1.5">How this range was computed</div>
        {[
          { label: `${d.constituents.length} stocks sum (next session)`, val: `${d.total_contribution_pts >= 0 ? '+' : ''}${d.total_contribution_pts.toFixed(0)} pts`, color: d.total_contribution_pts >= 0 ? 'text-score-green' : 'text-score-red' },
          { label: `÷ ${d.coverage_pct.toFixed(0)}% coverage → extrapolated`, val: `${d.extrapolated_pts >= 0 ? '+' : ''}${d.extrapolated_pts.toFixed(0)} pts`, color: d.extrapolated_pts >= 0 ? 'text-score-green' : 'text-score-red' },
          { label: `× ${d.global_multiplier} global multiplier (${d.global_multiplier < 1 ? 'bearish env — amplifies bearish, dampens bullish' : 'bullish env — amplifies bullish, dampens bearish'})`, val: `${d.midpoint_pts >= 0 ? '+' : ''}${d.midpoint_pts.toFixed(0)} pts`, color: 'text-white font-semibold' },
          { label: `±${d.half_width} pts range`, val: `${fmt(d.close_low)} – ${fmt(d.close_high)}`, color: 'text-blue-400' },
        ].map((row, i) => (
          <div key={i} className="flex justify-between text-[10px]">
            <span className="text-slate-400">{row.label}</span>
            <span className={row.color}>{row.val}</span>
          </div>
        ))}
        {/* Multiplier breakdown toggle */}
        {Object.keys(d.multiplier_factors).length > 0 && (
          <div>
            <button onClick={() => setShowMultiplier(s => !s)}
              className="text-[9px] text-slate-600 hover:text-slate-400 mt-1">
              {showMultiplier ? '▲ hide multiplier detail' : '▼ multiplier breakdown'}
            </button>
            {showMultiplier && (
              <div className="mt-1 space-y-0.5">
                {Object.values(d.multiplier_factors).map((v, i) => (
                  <div key={i} className="text-[9px] text-slate-500">{v as string}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Constituent table toggle */}
      <button onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-[10px] text-muted hover:text-white py-1 transition-colors">
        <span>Individual stock predictions for <span className="text-white font-semibold">{d.index_name || 'index'} next session</span> ({d.constituents.length} stocks) — click row for detail</span>
        <span>{expanded ? '▲ hide' : '▼ show'}</span>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[9px] text-muted border-b border-border/40 bg-slate-800/30">
                <th className="text-left py-1.5 px-2">Stock</th>
                <th className="text-right py-1.5 px-2">Wt%</th>
                <th className="text-right py-1.5 px-2">CMP</th>
                <th className="text-right py-1.5 px-2" title="Predicted move for this stock">Move%</th>
                <th className="text-right py-1.5 px-2" title="Contribution to index in points = weight × move">Contrib pts</th>
                <th className="text-right py-1.5 px-2" title="% contribution to index move">Idx%</th>
                <th className="text-center py-1.5 px-2">Signals</th>
              </tr>
            </thead>
            <tbody>
              {d.constituents.map((c) => (
                <>
                  <tr key={c.symbol}
                    className={`border-b border-border/20 cursor-pointer transition-colors ${
                      expandedStock === c.symbol ? 'bg-blue-950/20' :
                      c.event_warning ? 'bg-amber-950/10 hover:bg-amber-950/20' : 'hover:bg-slate-800/30'
                    }`}
                    onClick={() => setExpandedStock(expandedStock === c.symbol ? null : c.symbol)}>
                    <td className="py-1.5 px-2">
                      <div className="font-semibold text-white flex items-center gap-1">
                        {c.symbol}
                        {c.source === 'full_prediction'
                          ? <span className="text-[8px] px-1 py-0.5 bg-green-950 border border-green-800 text-green-400 rounded">Full</span>
                          : <span className="text-[8px] px-1 py-0.5 bg-slate-800 border border-slate-700 text-slate-500 rounded">Quick</span>
                        }
                        {c.event_type === 'announced_beat' && <span className="text-[8px] text-score-green">✦Beat</span>}
                        {c.event_type === 'announced_miss' && <span className="text-[8px] text-score-red">▼Miss</span>}
                        {c.event_type === 'upcoming' && <span className="text-[8px] text-amber-400">📅</span>}
                        {c.event_warning && c.event_type !== 'upcoming' && <span className="text-amber-400 text-[9px]">⚠</span>}
                        <span className="text-[9px] text-slate-600 ml-auto">▶</span>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right text-slate-400">{c.weight_pct}%</td>
                    <td className="py-1.5 px-2 text-right text-slate-300">
                      {c.cmp ? `₹${c.cmp.toLocaleString('en-IN', { maximumFractionDigits: 1 })}` : '—'}
                    </td>
                    <td className={`py-1.5 px-2 text-right font-bold ${dcol(c.direction)}`}>
                      {c.predicted_move_pct >= 0 ? '+' : ''}{c.predicted_move_pct.toFixed(2)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right font-bold ${(c.contribution_pts || 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {(c.contribution_pts || 0) >= 0 ? '+' : ''}{(c.contribution_pts || 0).toFixed(0)}
                    </td>
                    <td className="py-1.5 px-2 text-right text-slate-500">
                      {c.contribution_pct_idx != null ? `${(c.contribution_pct_idx * 100).toFixed(3)}%` : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <span title={`MACD: ${c.macd_signal}`} className={c.macd_signal === 'bullish' ? 'text-score-green' : c.macd_signal === 'bearish' ? 'text-score-red' : 'text-slate-600'}>M</span>
                        <span title={`Volume: ${c.volume_signal}`} className={c.volume_signal === 'high' ? 'text-score-green' : c.volume_signal === 'low' ? 'text-slate-600' : 'text-slate-400'}>V</span>
                        <span title={`DMA: ${c.dma_signal}`} className={c.dma_signal === 'above' ? 'text-score-green' : c.dma_signal === 'below' ? 'text-score-red' : 'text-slate-400'}>D</span>
                        <span title={`FII sensitivity: ${c.fii_sensitivity}`} className={c.fii_sensitivity === 'high' ? 'text-amber-400' : c.fii_sensitivity === 'medium' ? 'text-slate-400' : 'text-slate-600'}>F</span>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedStock === c.symbol && (
                    <tr key={`${c.symbol}-detail`} className="bg-blue-950/15 border-b border-blue-900/30">
                      <td colSpan={7} className="px-3 py-2.5">
                        <div className="grid grid-cols-2 gap-3 text-[10px]">
                          {/* Left: ranges */}
                          <div className="space-y-1.5">
                            <div className="font-semibold text-white mb-1">{c.symbol} — Individual Ranges</div>
                            <div className="flex justify-between">
                              <span className="text-muted">Open range:</span>
                              <span className="text-slate-200">{fmt(c.open_low)} – <span className="text-white font-bold">{fmt(c.open_base)}</span> – {fmt(c.open_high)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">Close range:</span>
                              <span className="text-slate-200">{fmt(c.close_low)} – <span className="text-white font-bold">{fmt(c.close_base)}</span> – {fmt(c.close_high)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">Predicted move:</span>
                              <span className={`font-bold ${dcol(c.direction)}`}>
                                {c.predicted_move_pct >= 0 ? '+' : ''}{c.predicted_move_pct.toFixed(2)}%
                                ({c.predicted_move_pts >= 0 ? '+' : ''}₹{c.predicted_move_pts?.toFixed(1)})
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">Index contribution:</span>
                              <span className={`font-bold ${(c.contribution_pts || 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                                {(c.contribution_pts || 0) >= 0 ? '+' : ''}{(c.contribution_pts || 0).toFixed(1)} pts
                                <span className="text-slate-500 font-normal ml-1">
                                  ({c.weight_pct}% wt × {c.predicted_move_pct >= 0 ? '+' : ''}{c.predicted_move_pct.toFixed(2)}%)
                                </span>
                              </span>
                            </div>
                            {c.event_warning && (
                              <div className="text-amber-400">⚠ {c.event_warning}</div>
                            )}
                            {/* Earnings intelligence section */}
                            {c.earnings_detail && (
                              <div className={`mt-1 p-2 rounded-lg text-[10px] leading-snug border ${
                                c.event_type === 'announced_beat' ? 'bg-green-950/40 border-green-800/50 text-green-300' :
                                c.event_type === 'announced_miss' ? 'bg-red-950/40 border-red-800/50 text-red-300' :
                                c.event_type === 'upcoming' ? 'bg-amber-950/40 border-amber-800/50 text-amber-300' :
                                'bg-slate-800/40 border-slate-700 text-slate-400'
                              }`}>
                                <div className="font-bold mb-0.5">
                                  {c.event_type === 'announced_beat' ? '✦ Earnings Beat' :
                                   c.event_type === 'announced_miss' ? '▼ Earnings Miss' :
                                   c.event_type === 'announced_inline' ? '● Inline Results' :
                                   c.event_type === 'upcoming' ? '📅 Results Due' : ''}
                                </div>
                                {c.earnings_detail}
                              </div>
                            )}
                          </div>
                          {/* Right: signals */}
                          <div className="space-y-1.5">
                            <div className="font-semibold text-white mb-1">Technical Signals</div>
                            {[
                              { label: 'RSI (10d proxy)', val: c.rsi_proxy?.toFixed(0), extra: c.rsi_proxy > 70 ? '⚠ overbought' : c.rsi_proxy < 35 ? '▲ oversold' : '', color: c.rsi_proxy > 70 ? 'text-score-red' : c.rsi_proxy < 35 ? 'text-score-green' : 'text-slate-300' },
                              { label: 'MACD', val: c.macd_signal, color: c.macd_signal === 'bullish' ? 'text-score-green' : c.macd_signal === 'bearish' ? 'text-score-red' : 'text-slate-400' },
                              { label: 'Volume', val: c.volume_signal, color: c.volume_signal === 'high' ? 'text-score-green' : c.volume_signal === 'low' ? 'text-slate-500' : 'text-slate-300' },
                              { label: '200 DMA', val: c.dma_signal, color: c.dma_signal === 'above' ? 'text-score-green' : 'text-score-red' },
                              { label: 'FII sensitivity', val: c.fii_sensitivity, color: c.fii_sensitivity === 'high' ? 'text-amber-400' : 'text-slate-400' },
                              { label: '52W from high', val: `${c.pct_from_high?.toFixed(1)}%`, color: (c.pct_from_high || 0) < -20 ? 'text-score-green' : (c.pct_from_high || 0) > -5 ? 'text-score-red' : 'text-slate-300' },
                              { label: 'Last earn. surprise', val: c.earn_surprise ? `${c.earn_surprise > 0 ? '+' : ''}${c.earn_surprise.toFixed(1)}%` : '—', color: (c.earn_surprise || 0) > 5 ? 'text-score-green' : (c.earn_surprise || 0) < -5 ? 'text-score-red' : 'text-slate-400' },
                            ].map((row, i) => (
                              <div key={i} className="flex justify-between">
                                <span className="text-muted">{row.label}:</span>
                                <span className={`font-medium capitalize ${row.color}`}>
                                  {row.val} {row.extra || ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/60 bg-slate-800/40">
                <td className="py-1.5 px-2 font-bold text-white" colSpan={3}>Net ({d.constituents.length} stocks · next session predicted)</td>
                <td className="py-1.5 px-2 text-right text-slate-400">—</td>
                <td className={`py-1.5 px-2 text-right font-bold ${d.total_contribution_pts >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                  {d.total_contribution_pts >= 0 ? '+' : ''}{d.total_contribution_pts.toFixed(0)} pts
                </td>
                <td colSpan={2} className="py-1.5 px-2 text-right text-muted text-[9px]">
                  → ×{d.global_multiplier} = {d.midpoint_pts >= 0 ? '+' : ''}{d.midpoint_pts.toFixed(0)} pts final
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="text-[9px] text-slate-400 mt-2 px-1">
            M=MACD · V=Volume · D=200DMA · F=FII sensitivity · Click row to expand
            · {new Date(d.predicted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
    </div>
  )
}
