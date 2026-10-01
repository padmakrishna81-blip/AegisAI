import { useState } from 'react'
import client from '../api/client'
import type { StrategyLeg, StrategyReviewResult } from '../types'

interface Props {
  legs: StrategyLeg[]
  strategyName?: string
  totalPnl?: number
  maxProfit?: number
}

const ACTION_STYLE: Record<string, string> = {
  hold:          'bg-green-900 border-green-700 text-score-green',
  close:         'bg-amber-900 border-amber-700 text-score-amber',
  roll:          'bg-blue-900 border-blue-700 text-score-blue',
  partial_close: 'bg-amber-900 border-amber-700 text-score-amber',
  close_all:     'bg-red-900 border-red-800 text-score-red',
  add_hedge:     'bg-purple-900 border-purple-700 text-purple-300',
}

function ActionBadge({ action, size = 'sm' }: { action: string; size?: 'xs' | 'sm' }) {
  const cls = ACTION_STYLE[action] || 'bg-slate-800 border-border text-muted'
  const px  = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
  return (
    <span className={`${px} font-bold rounded border ${cls}`}>
      {action.replace('_', ' ').toUpperCase()}
    </span>
  )
}

export default function AgentStrategyReview({ legs, strategyName = '', totalPnl = 0, maxProfit }: Props) {
  const [open, setOpen]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<StrategyReviewResult | null>(null)
  const [error, setError]       = useState<string | null>(null)

  // Save-to-monitor state
  const [saveName, setSaveName]   = useState(strategyName || '')
  const [saving, setSaving]       = useState(false)
  const [savedId, setSavedId]     = useState<string | null>(null)

  const run = async () => {
    if (legs.length === 0) return
    setLoading(true); setError(null)
    try {
      const r = await client.post('/wheel/agent/strategy-review', {
        legs,
        strategy_name: strategyName,
      })
      setResult(r.data)
      setOpen(true)
      if (!saveName) setSaveName(strategyName || `Strategy ${new Date().toLocaleDateString('en-IN')}`)
    } catch {
      setError('Agent unavailable — check backend logs')
    } finally { setLoading(false) }
  }

  const saveToMonitor = async () => {
    if (!saveName.trim() || !result) return
    setSaving(true)
    try {
      const r = await client.post('/wheel/agent/monitor/save', {
        name: saveName.trim(),
        legs,
        id: savedId || '',
      })
      setSavedId(r.data.id)
    } catch {
      setError('Save failed')
    } finally { setSaving(false) }
  }

  const pnlColor = totalPnl >= 0 ? 'text-score-green' : 'text-score-red'
  const pnlStr   = `${totalPnl >= 0 ? '+' : ''}₹${Math.abs(totalPnl).toLocaleString('en-IN')}`

  return (
    <div className="bg-slate-900/60 border border-indigo-800/40 rounded-xl overflow-hidden">
      {/* Collapsed header */}
      <button
        onClick={result ? () => setOpen(!open) : run}
        disabled={loading || legs.length === 0}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/40 transition-colors disabled:opacity-50"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-indigo-300">
          <span>🤖</span>
          <span>Review Strategy with Agent</span>
          {legs.length > 0 && (
            <span className="text-[10px] text-muted font-normal">({legs.length} leg{legs.length !== 1 ? 's' : ''})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {totalPnl !== 0 && (
            <span className={`text-xs font-semibold ${pnlColor}`}>{pnlStr}</span>
          )}
          {loading
            ? <span className="text-xs text-indigo-400 animate-pulse">Analysing…</span>
            : result
              ? <div className="flex items-center gap-2">
                  <ActionBadge action={result.overall_action} size="xs" />
                  <span className="text-muted text-sm">{open ? '▲' : '▼'}</span>
                </div>
              : legs.length === 0
                ? <span className="text-xs text-muted">Add legs first</span>
                : <span className="text-xs text-indigo-400 hover:text-indigo-300">Run →</span>}
        </div>
      </button>

      {error && <div className="px-4 pb-3 text-xs text-score-red">{error}</div>}

      {open && result && (
        <div className="border-t border-indigo-800/30 p-4 space-y-4">

          {/* Overall verdict bar */}
          <div className="bg-indigo-950/30 border border-indigo-800/30 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ActionBadge action={result.overall_action} />
              <span className={`text-xs font-medium ${
                result.confidence === 'high' ? 'text-score-green'
                : result.confidence === 'medium' ? 'text-score-amber'
                : 'text-muted'
              }`}>{result.confidence.toUpperCase()} confidence</span>
            </div>
            <div className="text-right">
              <div className={`text-sm font-bold ${result.total_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {result.total_pnl >= 0 ? '+' : ''}₹{Math.abs(result.total_pnl).toLocaleString('en-IN')}
              </div>
              {result.pct_of_max != null && (
                <div className="text-[10px] text-muted">{result.pct_of_max}% of max profit</div>
              )}
            </div>
          </div>

          {/* Per-leg table */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                  <th className="text-left px-3 py-2">Leg</th>
                  <th className="text-right px-3 py-2">P&L</th>
                  <th className="text-right px-3 py-2">%</th>
                  <th className="text-center px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.leg_actions.map((la, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-slate-800/20">
                    <td className="px-3 py-2">
                      <div className="font-medium text-white">
                        {la.symbol}{la.strike ? ` ₹${la.strike}` : ''}
                      </div>
                      <div className="text-[10px] text-muted">{la.type.replace('_', ' ')}</div>
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold ${la.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {la.pnl >= 0 ? '+' : ''}₹{Math.abs(la.pnl).toLocaleString('en-IN')}
                    </td>
                    <td className={`px-3 py-2 text-right ${la.pnl_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {la.pnl_pct >= 0 ? '+' : ''}{la.pnl_pct}%
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ActionBadge action={la.action} size="xs" />
                    </td>
                    <td className="px-3 py-2 text-muted leading-tight max-w-xs">{la.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Reasoning bullets */}
          {result.reasoning.length > 0 && (
            <div className="space-y-1">
              {result.reasoning.map((r, i) => (
                <div key={i} className="text-xs text-blue-300 flex gap-2">
                  <span className="text-blue-500 shrink-0">→</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>
          )}

          {/* Risk flags */}
          {result.risk_flags.length > 0 && (
            <div className="space-y-1">
              {result.risk_flags.map((flag, i) => (
                <div key={i} className="flex items-start gap-2 text-xs bg-amber-950/30 border border-amber-800/30 rounded-lg px-3 py-2 text-amber-300">
                  <span className="shrink-0">⚠</span>
                  <span>{flag}</span>
                </div>
              ))}
            </div>
          )}

          {/* Next trigger */}
          <div className="bg-green-950/20 border border-green-800/30 rounded-lg px-3 py-2 text-xs text-score-green flex gap-2">
            <span className="shrink-0">🎯</span>
            <span>{result.next_trigger}</span>
          </div>

          {/* Save to Monitor */}
          <div className="bg-slate-800/60 border border-border rounded-xl px-4 py-3 space-y-2">
            <div className="text-[10px] text-muted font-semibold uppercase tracking-wide">
              📡 Save to Strategy Monitor
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="Strategy name…"
                className="flex-1 bg-slate-700 border border-border rounded-lg px-3 py-1.5 text-sm text-white placeholder-muted focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={saveToMonitor}
                disabled={saving || !saveName.trim()}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium whitespace-nowrap"
              >
                {saving ? 'Saving…' : savedId ? '✓ Saved' : '💾 Save'}
              </button>
            </div>
            {savedId && (
              <div className="text-[10px] text-score-green">
                ✓ Saved — agent will check this strategy every 30 min during market hours. View in <a href="/strategy-monitor" className="underline">Strategy Monitor</a>.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
