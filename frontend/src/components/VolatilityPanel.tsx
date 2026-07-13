import { useState, useEffect } from 'react'
import client from '../api/client'

interface VolatilityData {
  symbol: string
  sessions_analysed: number
  threshold_pct: number
  large_day_moves_count: number
  large_gaps_count: number
  max_up_day_pct: number
  max_down_day_pct: number
  max_gap_up_pct: number
  max_gap_down_pct: number
  avg_abs_daily_move: number
  nifty_alignment_pct: number | null
  confidence_score: number
  suggested_min_otm: number
  safe_strike_note: string
  large_day_moves: {
    date: string; change_pct: number; close: number
    direction: string; nifty_pct: number | null; aligned_nifty: string
  }[]
  large_gaps: {
    date: string; gap_pct: number; open: number
    prev_close: number; direction: string; nifty_pct: number | null
  }[]
  expiry_windows: {
    from: string; to: string
    start_price: number; end_price: number
    net_pct: number; max_up_pct: number; max_down_pct: number
    breached_10pct: boolean; breached_up: boolean; breached_down: boolean
    sessions: number
  }[]
  expiry_windows_total: number
  expiry_windows_breached: number
  expiry_windows_up_breach: number    // up >10% — bad for CALL sellers
  expiry_windows_dn_breach: number    // down >10% — bad for PUT sellers
  expiry_breach_rate_pct: number | null
}

function scoreColor(score: number): string {
  if (score >= 75) return 'text-score-green'
  if (score >= 50) return 'text-score-amber'
  return 'text-score-red'
}
function scoreLabel(score: number): string {
  if (score >= 75) return 'Low volatility — safer for options selling'
  if (score >= 50) return 'Moderate volatility — proceed with caution'
  return 'High volatility — widen OTM% or avoid'
}

interface Props {
  symbol: string
  currentStrike: number
  currentOtmPct: number
  optionType: 'CE' | 'PE'
}

export default function VolatilityPanel({ symbol, currentStrike, currentOtmPct, optionType }: Props) {
  const [data, setData] = useState<VolatilityData | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    const bare = symbol.replace('.NS', '').replace('^', '')
    client.get(`/analyze/${bare}.NS/volatility`)
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [symbol])

  if (loading) return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-xs text-muted animate-pulse">Analysing 50-session price history…</div>
    </div>
  )
  if (!data) return null

  const otmAbs = Math.abs(currentOtmPct)
  const maxMove = Math.max(data.max_up_day_pct, Math.abs(data.max_down_day_pct))
  const strikeIsIdeal = otmAbs >= data.suggested_min_otm
  const strikeColor   = strikeIsIdeal ? 'text-score-green' : otmAbs >= maxMove ? 'text-score-amber' : 'text-score-red'

  // Build a clear, non-contradictory verdict
  const strikeVerdict = strikeIsIdeal
    ? `✓ Strike ₹${currentStrike} (${otmAbs.toFixed(1)}% OTM) ≥ suggested ${data.suggested_min_otm}% minimum — historically safe buffer`
    : otmAbs >= maxMove
    ? `⚠ Strike ₹${currentStrike} (${otmAbs.toFixed(1)}% OTM) is beyond the ${maxMove.toFixed(1)}% max historical day move, but below the recommended ${data.suggested_min_otm}% buffer (based on 1.5× safety margin). Proceed with caution.`
    : `⚠ Strike ₹${currentStrike} (${otmAbs.toFixed(1)}% OTM) is LESS than the ${maxMove.toFixed(1)}% max single-day move seen in last 50 sessions — this strike could be breached in a single session. Consider ≥${data.suggested_min_otm}% OTM.`

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-white uppercase tracking-wide">
          Price Volatility — Last {data.sessions_analysed} Trading Sessions
        </div>
        <div className="flex items-center gap-2">
          <div className="text-center">
            <div className="text-[10px] text-muted">Confidence</div>
            <div className={`text-lg font-bold ${scoreColor(data.confidence_score)}`}>{data.confidence_score}/100</div>
          </div>
          <button onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted hover:text-white px-2 py-1 bg-slate-800 rounded">
            {expanded ? '▲ Less' : '▼ Details'}
          </button>
        </div>
      </div>

      {/* Score label */}
      <div className={`text-xs font-medium ${scoreColor(data.confidence_score)}`}>
        {scoreLabel(data.confidence_score)}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-800 rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-muted mb-0.5">Day moves &gt;5%</div>
            <div className={`text-base font-bold ${data.large_day_moves_count === 0 ? 'text-score-green' : data.large_day_moves_count <= 2 ? 'text-score-amber' : 'text-score-red'}`}>
              {data.large_day_moves_count}
            </div>
            <div className="text-[9px] text-muted">in {data.sessions_analysed} sessions</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-muted mb-0.5">Gaps &gt;5%</div>
            <div className={`text-base font-bold ${data.large_gaps_count === 0 ? 'text-score-green' : 'text-score-amber'}`}>
              {data.large_gaps_count}
            </div>
            <div className="text-[9px] text-muted">gap opens</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-green-950/50 border border-green-900 rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-muted mb-0.5">Max up (1 day)</div>
            <div className="text-base font-bold text-score-green">+{data.max_up_day_pct}%</div>
          </div>
          <div className="bg-red-950/50 border border-red-900 rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-muted mb-0.5">Max down (1 day)</div>
            <div className="text-base font-bold text-score-red">{data.max_down_day_pct}%</div>
          </div>
        </div>
      </div>

      {/* Gaps row + expiry breach */}
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="bg-slate-800 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted">Max gap up</div>
          <div className="font-semibold text-score-green">+{data.max_gap_up_pct}%</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted">Max gap down</div>
          <div className="font-semibold text-score-red">{data.max_gap_down_pct}%</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted">Nifty aligned</div>
          <div className={`font-semibold ${(data.nifty_alignment_pct || 0) >= 65 ? 'text-score-green' : 'text-score-amber'}`}>
            {data.nifty_alignment_pct != null ? `${data.nifty_alignment_pct}%` : '—'}
          </div>
        </div>
        {data.expiry_breach_rate_pct != null && (
          <div className={`bg-slate-800 rounded-lg p-2 text-center ${data.expiry_breach_rate_pct > 40 ? 'border border-red-900' : data.expiry_breach_rate_pct > 20 ? 'border border-amber-900' : 'border border-green-900'}`}>
            <div className="text-[10px] text-muted">Cycles &gt;10%</div>
            <div className={`font-bold text-sm ${data.expiry_breach_rate_pct > 40 ? 'text-score-red' : data.expiry_breach_rate_pct > 20 ? 'text-score-amber' : 'text-score-green'}`}>
              {data.expiry_windows_breached}/{data.expiry_windows_total}
            </div>
            <div className="text-[9px] flex justify-center gap-2">
              <span className="text-score-green" title="Up >10% (CE seller risk)">↑{data.expiry_windows_up_breach ?? 0}</span>
              <span className="text-score-red"   title="Down >10% (PE seller risk)">↓{data.expiry_windows_dn_breach ?? 0}</span>
            </div>
          </div>
        )}
      </div>

      {/* CE vs PE risk summary */}
      {data.expiry_breach_rate_pct != null && (data.expiry_windows_up_breach ?? 0) + (data.expiry_windows_dn_breach ?? 0) > 0 && (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className={`rounded-lg px-3 py-2 border ${(data.expiry_windows_up_breach ?? 0) > 2 ? 'bg-red-950/30 border-red-900' : 'bg-green-950/20 border-green-900'}`}>
            <div className="font-semibold text-slate-300 mb-0.5">📈 CALL sellers risk</div>
            <div className={`font-bold ${(data.expiry_windows_up_breach ?? 0) > 2 ? 'text-score-red' : 'text-score-green'}`}>
              {data.expiry_windows_up_breach ?? 0}/{data.expiry_windows_total} cycles up &gt;10%
            </div>
            <div className="text-muted text-[10px]">{(data.expiry_windows_up_breach ?? 0) > 2 ? 'High risk — widen CE strike' : 'Low risk for CE selling'}</div>
          </div>
          <div className={`rounded-lg px-3 py-2 border ${(data.expiry_windows_dn_breach ?? 0) > 2 ? 'bg-red-950/30 border-red-900' : 'bg-green-950/20 border-green-900'}`}>
            <div className="font-semibold text-slate-300 mb-0.5">📉 PUT sellers risk</div>
            <div className={`font-bold ${(data.expiry_windows_dn_breach ?? 0) > 2 ? 'text-score-red' : 'text-score-green'}`}>
              {data.expiry_windows_dn_breach ?? 0}/{data.expiry_windows_total} cycles down &gt;10%
            </div>
            <div className="text-muted text-[10px]">{(data.expiry_windows_dn_breach ?? 0) > 2 ? 'High risk — widen PE strike' : 'Low risk for PE selling'}</div>
          </div>
        </div>
      )}

      {/* Strike safety verdict */}
      <div className={`text-[11px] font-medium rounded-lg px-3 py-2 ${strikeIsIdeal ? 'bg-green-950/40 border border-green-900' : 'bg-red-950/40 border border-red-900'} ${strikeColor}`}>
        {strikeVerdict}
      </div>

      {/* Suggested OTM */}
      <div className="text-[11px] text-blue-400 leading-relaxed">
        {data.safe_strike_note}
        {data.nifty_alignment_pct != null && (
          <> Nifty alignment {data.nifty_alignment_pct}% — {data.nifty_alignment_pct >= 70
            ? 'stock moves predictably with market (lower surprise risk).'
            : data.nifty_alignment_pct >= 50
            ? 'moderate market correlation — some idiosyncratic risk.'
            : 'stock often moves independently of Nifty — higher surprise risk.'}</>
        )}
      </div>

      {/* Expanded: event details */}
      {expanded && (
        <div className="space-y-3 pt-2 border-t border-border/50">
          {data.large_day_moves.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Large Day Moves (&gt;{data.threshold_pct}%)
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted border-b border-border/50">
                    <th className="text-left pb-1">Date</th>
                    <th className="text-right pb-1">Change</th>
                    <th className="text-right pb-1">Nifty</th>
                    <th className="text-left pb-1 pl-2">Correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.large_day_moves.map((m, i) => (
                    <tr key={i} className="border-b border-border/30">
                      <td className="py-1 text-muted">{m.date}</td>
                      <td className={`py-1 text-right font-semibold ${m.direction === 'up' ? 'text-score-green' : 'text-score-red'}`}>
                        {m.change_pct > 0 ? '+' : ''}{m.change_pct}%
                      </td>
                      <td className={`py-1 text-right ${(m.nifty_pct || 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {m.nifty_pct != null ? `${m.nifty_pct > 0 ? '+' : ''}${m.nifty_pct}%` : '—'}
                      </td>
                      <td className={`py-1 pl-2 text-[10px] ${m.aligned_nifty === 'with Nifty' ? 'text-muted' : 'text-score-amber font-medium'}`}>
                        {m.aligned_nifty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.large_gaps.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Large Gap Opens (&gt;{data.threshold_pct}%)
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted border-b border-border/50">
                    <th className="text-left pb-1">Date</th>
                    <th className="text-right pb-1">Gap</th>
                    <th className="text-right pb-1">Open</th>
                    <th className="text-right pb-1">Prev Close</th>
                  </tr>
                </thead>
                <tbody>
                  {data.large_gaps.map((g, i) => (
                    <tr key={i} className="border-b border-border/30">
                      <td className="py-1 text-muted">{g.date}</td>
                      <td className={`py-1 text-right font-semibold ${g.direction === 'up' ? 'text-score-green' : 'text-score-red'}`}>
                        {g.gap_pct > 0 ? '+' : ''}{g.gap_pct}%
                      </td>
                      <td className="py-1 text-right text-white">₹{g.open}</td>
                      <td className="py-1 text-right text-muted">₹{g.prev_close}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.large_day_moves.length === 0 && data.large_gaps.length === 0 && (
            <div className="text-[11px] text-score-green text-center py-2">
              ✓ No moves or gaps &gt;{data.threshold_pct}% in the last {data.sessions_analysed} sessions
            </div>
          )}

          {/* Expiry cycle table */}
          {data.expiry_windows && data.expiry_windows.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Monthly Expiry Cycles — Last 12 Months (NSE Last Thursday)
              </div>
              <div className="text-[10px] text-blue-400 mb-2">
                Each row = one expiry cycle (e.g. Jun 25 → Jul 28). Shows net move + intra-cycle high/low from entry price.
                ⚠ means the stock moved &gt;10% within that cycle — a 10% OTM strike would have been challenged.
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted border-b border-border/50">
                    <th className="text-left pb-1">Cycle</th>
                    <th className="text-right pb-1">Entry ₹</th>
                    <th className="text-right pb-1">Net</th>
                    <th className="text-right pb-1 text-score-green">Max Up ↑</th>
                    <th className="text-right pb-1 text-score-red">Max Down ↓</th>
                    <th className="text-center pb-1">CE risk</th>
                    <th className="text-center pb-1">PE risk</th>
                  </tr>
                </thead>
                <tbody>
                  {data.expiry_windows.map((w, i) => (
                    <tr key={i} className={`border-b border-border/30 ${w.breached_10pct ? (w.breached_up && w.breached_down ? 'bg-red-950/20' : w.breached_up ? 'bg-amber-950/10' : 'bg-red-950/10') : ''}`}>
                      <td className="py-1 text-muted text-[10px]">
                        {w.from.slice(5)} → {w.to.slice(5)}
                      </td>
                      <td className="py-1 text-right text-white">₹{w.start_price}</td>
                      <td className={`py-1 text-right font-semibold ${w.net_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {w.net_pct > 0 ? '+' : ''}{w.net_pct}%
                      </td>
                      <td className={`py-1 text-right ${w.breached_up ? 'text-score-red font-bold' : 'text-score-green'}`}>+{w.max_up_pct}%</td>
                      <td className={`py-1 text-right ${w.breached_down ? 'text-score-red font-bold' : 'text-score-red'}`}>{w.max_down_pct}%</td>
                      <td className="py-1 text-center text-[10px]">
                        {w.breached_up ? <span className="text-score-red font-bold">⚠ CE</span> : <span className="text-muted">✓</span>}
                      </td>
                      <td className="py-1 text-center text-[10px]">
                        {w.breached_down ? <span className="text-score-red font-bold">⚠ PE</span> : <span className="text-muted">✓</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.expiry_breach_rate_pct != null && (
                <div className={`mt-2 text-[11px] font-medium ${data.expiry_breach_rate_pct > 40 ? 'text-score-red' : data.expiry_breach_rate_pct > 20 ? 'text-score-amber' : 'text-score-green'}`}>
                  {data.expiry_windows_breached} of {data.expiry_windows_total} cycles had a &gt;10% move ({data.expiry_breach_rate_pct}% breach rate).
                  {' '}↑{data.expiry_windows_up_breach ?? 0} cycles rose &gt;10% (CE risk)
                  {' '}· ↓{data.expiry_windows_dn_breach ?? 0} cycles fell &gt;10% (PE risk).
                  {data.expiry_breach_rate_pct > 40
                    ? ' High frequency — widen both CE and PE strikes significantly.'
                    : data.expiry_breach_rate_pct > 20
                    ? ' Moderate — consider 12-15% OTM.'
                    : ' Low — 10% OTM strikes are historically adequate.'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
