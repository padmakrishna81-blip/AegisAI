import { useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import type { MonitoredStrategy, StrategyReviewResult } from '../types'

const ACTION_STYLE: Record<string, string> = {
  hold:          'bg-green-900 border-green-700 text-score-green',
  close:         'bg-amber-900 border-amber-700 text-score-amber',
  roll:          'bg-blue-900 border-blue-700 text-score-blue',
  partial_close: 'bg-amber-900 border-amber-700 text-score-amber',
  close_all:     'bg-red-900 border-red-800 text-score-red',
  add_hedge:     'bg-purple-900 border-purple-700 text-purple-300',
}

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_STYLE[action] || 'bg-slate-800 border-border text-muted'
  return (
    <span className={`px-2 py-0.5 text-xs font-bold rounded border ${cls}`}>
      {action.replace('_', ' ').toUpperCase()}
    </span>
  )
}

function fmt(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

interface AlertSummary {
  id: string
  name: string
  action: string
  pnl: number
  last_checked: string | null
}

export default function StrategyMonitor() {
  const [strategies, setStrategies]     = useState<MonitoredStrategy[]>([])
  const [loading, setLoading]           = useState(true)
  const [checkingAll, setCheckingAll]   = useState(false)
  const [checkingId, setCheckingId]     = useState<string | null>(null)
  const [alertSummary, setAlertSummary] = useState<AlertSummary[]>([])
  const [lastRefresh, setLastRefresh]   = useState<Date | null>(null)

  const load = useCallback(async () => {
    try {
      const [listRes, alertRes] = await Promise.all([
        client.get('/wheel/agent/monitor/list'),
        client.get('/wheel/agent/monitor/alerts'),
      ])
      setStrategies(listRes.data.strategies ?? listRes.data ?? [])
      setAlertSummary(alertRes.data.strategies ?? [])
      setLastRefresh(new Date())
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const checkAll = async () => {
    setCheckingAll(true)
    try {
      await client.post('/wheel/agent/monitor/check', { id: '' })
      await load()
    } catch {
      // ignore
    } finally { setCheckingAll(false) }
  }

  const checkOne = async (id: string) => {
    setCheckingId(id)
    try {
      await client.post('/wheel/agent/monitor/check', { id })
      await load()
    } catch {
      // ignore
    } finally { setCheckingId(null) }
  }

  const remove = async (id: string) => {
    try {
      await client.delete(`/wheel/agent/monitor/${id}`)
      setStrategies(prev => prev.filter(s => s.id !== id))
    } catch {
      // ignore
    }
  }

  const actionOf = (s: MonitoredStrategy): string =>
    s.last_alert?.overall_action ?? 'unknown'

  const nonHoldCount = alertSummary.filter(a => a.action !== 'hold' && a.action !== 'unknown').length

  if (loading) {
    return (
      <div className="p-8 text-center text-muted">
        <div className="animate-pulse text-lg">Loading saved strategies…</div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            📡 Strategy Monitor
            {nonHoldCount > 0 && (
              <span className="px-2 py-0.5 bg-amber-600 text-white text-xs font-bold rounded-full">
                {nonHoldCount} alert{nonHoldCount !== 1 ? 's' : ''}
              </span>
            )}
          </h1>
          <p className="text-xs text-muted mt-1">
            Agent checks saved strategies every 30 min during market hours.
            {lastRefresh && (
              <span className="ml-1">Last refreshed: {lastRefresh.toLocaleTimeString('en-IN')}</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium"
          >
            ↻ Refresh
          </button>
          <button
            onClick={checkAll}
            disabled={checkingAll || strategies.length === 0}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium whitespace-nowrap"
          >
            {checkingAll ? 'Checking…' : '▶ Check All Now'}
          </button>
        </div>
      </div>

      {/* Empty state */}
      {strategies.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <div className="text-4xl mb-4">📡</div>
          <div className="text-white font-semibold text-lg mb-2">No strategies saved yet</div>
          <div className="text-sm text-muted max-w-sm mx-auto">
            Build a strategy in <a href="/custom-strangle" className="underline text-indigo-400">Custom Builder</a> or{' '}
            <a href="/multi-builder" className="underline text-indigo-400">Multi-Asset Builder</a>,
            then use "🤖 Review Strategy with Agent" → "💾 Save to Monitor".
          </div>
        </div>
      )}

      {/* Strategy cards */}
      <div className="grid grid-cols-1 gap-4">
        {strategies.map(s => {
          const action  = actionOf(s)
          const result  = s.last_alert as StrategyReviewResult | null
          const isChecking = checkingId === s.id

          return (
            <div
              key={s.id}
              className="bg-card border border-border rounded-xl overflow-hidden"
            >
              {/* Card header */}
              <div className="flex items-center justify-between px-4 py-3 bg-slate-800/40 border-b border-border/50">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="font-semibold text-white text-sm">{s.name}</div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {s.legs.length} leg{s.legs.length !== 1 ? 's' : ''} · Saved {fmt(s.saved_at)}
                    </div>
                  </div>
                  {action !== 'unknown' && <ActionBadge action={action} />}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => checkOne(s.id)}
                    disabled={isChecking}
                    className="px-3 py-1 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white rounded text-xs"
                  >
                    {isChecking ? 'Checking…' : '▶ Check Now'}
                  </button>
                  <button
                    onClick={() => remove(s.id)}
                    className="px-3 py-1 bg-red-900/50 hover:bg-red-800/70 text-score-red rounded text-xs border border-red-800/50"
                  >
                    ✕ Remove
                  </button>
                </div>
              </div>

              {/* Last check info */}
              <div className="px-4 pt-3 pb-1 text-[10px] text-muted">
                Last checked: {fmt(s.last_checked)}
                {result && (
                  <span className={`ml-3 font-semibold ${result.total_pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                    P&L: {result.total_pnl >= 0 ? '+' : ''}₹{Math.abs(result.total_pnl).toLocaleString('en-IN')}
                    {result.pct_of_max != null && ` (${result.pct_of_max}% of max)`}
                  </span>
                )}
              </div>

              {/* Leg summary mini-table */}
              {result && result.leg_actions.length > 0 && (
                <div className="px-4 py-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-muted">
                        <th className="text-left py-1 pr-3">Leg</th>
                        <th className="text-right py-1 pr-3">P&L</th>
                        <th className="text-right py-1 pr-3">%</th>
                        <th className="text-center py-1 pr-3">Action</th>
                        <th className="text-left py-1">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.leg_actions.map((la, i) => (
                        <tr key={i} className="border-t border-border/30">
                          <td className="py-1.5 pr-3">
                            <span className="text-white font-medium">{la.symbol}</span>
                            {la.strike ? <span className="text-muted ml-1 text-[10px]">₹{la.strike}</span> : null}
                            <div className="text-[10px] text-muted">{la.type.replace('_', ' ')}</div>
                          </td>
                          <td className={`py-1.5 pr-3 text-right font-semibold ${la.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                            {la.pnl >= 0 ? '+' : ''}₹{Math.abs(la.pnl).toLocaleString('en-IN')}
                          </td>
                          <td className={`py-1.5 pr-3 text-right ${la.pnl_pct >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                            {la.pnl_pct >= 0 ? '+' : ''}{la.pnl_pct}%
                          </td>
                          <td className="py-1.5 pr-3 text-center">
                            <ActionBadge action={la.action} />
                          </td>
                          <td className="py-1.5 text-muted leading-tight max-w-[240px]">{la.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Reasoning + flags */}
              {result && (
                <div className="px-4 pb-3 space-y-1">
                  {result.reasoning.slice(0, 2).map((r, i) => (
                    <div key={i} className="flex gap-2 text-xs text-blue-300">
                      <span className="text-blue-500 shrink-0">→</span>
                      <span>{r}</span>
                    </div>
                  ))}
                  {result.risk_flags.length > 0 && (
                    <div className="flex items-start gap-2 mt-1 text-xs bg-amber-950/30 border border-amber-800/30 rounded-lg px-3 py-1.5 text-amber-300">
                      <span className="shrink-0">⚠</span>
                      <span>{result.risk_flags[0]}</span>
                    </div>
                  )}
                  {result.next_trigger && (
                    <div className="text-[10px] text-score-green flex gap-1 mt-1">
                      <span>🎯</span>
                      <span>{result.next_trigger}</span>
                    </div>
                  )}
                </div>
              )}

              {/* No assessment yet */}
              {!result && (
                <div className="px-4 pb-4 pt-2 text-xs text-muted italic">
                  No assessment yet — click "Check Now" to run the agent.
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
