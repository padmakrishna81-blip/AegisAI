import { useEffect, useState, useCallback } from 'react'
import client from '../api/client'
import { usePortfolio } from '../hooks/usePortfolio'
import { formatINR, formatPct, scoreToColor, marketModeColor, recommendationColor, shortSymbol } from '../utils/formatters'
import type { MacroResult } from '../types'
import { useAuthStore } from '../store/authStore'

export default function Dashboard() {
  const { user } = useAuthStore()
  const { portfolio, loading: portfolioLoading, fetchPortfolio } = usePortfolio()
  const [macro, setMacro] = useState<MacroResult | null>(null)
  const [briefing, setBriefing] = useState<{ best_action?: { symbol: string; action: string; reason: string; score: number }; market_outlook?: string } | null>(null)

  // Add funds state
  const [addFundsVal, setAddFundsVal] = useState('')
  const [addingFunds, setAddingFunds] = useState(false)

  // Monthly target edit
  const [targetVal, setTargetVal] = useState('')
  const [savingTarget, setSavingTarget] = useState(false)

  useEffect(() => {
    client.get('/market/macro').then(r => setMacro(r.data)).catch(() => {})
    client.get('/ai/briefing').then(r => setBriefing(r.data)).catch(() => {})

    // Background: pre-generate full predictions for all Nifty/BankNifty/Sensex constituents
    // Fire-and-forget — skips already-cached stocks, no spinner, no blocking
    const constituents = [
      // All Nifty 50
      'RELIANCE.NS','HDFCBANK.NS','ICICIBANK.NS','INFY.NS','TCS.NS',
      'BHARTIARTL.NS','KOTAKBANK.NS','SBIN.NS','ITC.NS','LT.NS',
      'AXISBANK.NS','BAJFINANCE.NS','HCLTECH.NS','MARUTI.NS','SUNPHARMA.NS',
      'HINDUNILVR.NS','M&M.NS','BAJAJFINSV.NS','TMPV.NS','ONGC.NS',
      'ADANIPORTS.NS','WIPRO.NS','BAJAJ-AUTO.NS','CIPLA.NS','DRREDDY.NS',
      'NTPC.NS','COALINDIA.NS','TITAN.NS','POWERGRID.NS','HINDALCO.NS',
      'ULTRACEMCO.NS','ETERNAL.NS','GRASIM.NS','INDUSINDBK.NS','JSWSTEEL.NS',
      'APOLLOHOSP.NS','EICHERMOT.NS','DIVISLAB.NS','HDFCLIFE.NS','SBILIFE.NS',
      'HEROMOTOCO.NS','TECHM.NS','ASIANPAINT.NS','ADANIENT.NS','NESTLEIND.NS',
      'BRITANNIA.NS','TATACONSUM.NS','TATASTEEL.NS','BEL.NS','BPCL.NS',
      // BankNifty extras not in Nifty50
      'BANDHANBNK.NS','FEDERALBNK.NS','IDFCFIRSTB.NS','AUBANK.NS','PNB.NS','BANKBARODA.NS',
    ]
    client.post('/predict/pre-generate', { symbols: constituents, force: false })
      .catch(() => {})  // silent — never blocks dashboard
  }, [])

  const marketMode = macro?.market_mode || 'NEUTRAL'
  const macroScore = macro?.score || 0

  const target = portfolio?.monthly_income_target || 0
  const achieved = portfolio?.monthly_income_achieved || 0
  const targetPct = target > 0 ? Math.min(100, Math.round(achieved / target * 100)) : 0

  const handleAddFunds = async () => {
    const amt = parseFloat(addFundsVal)
    if (isNaN(amt)) return
    setAddingFunds(true)
    try {
      await client.post('/portfolio/cash', { amount: amt })
      setAddFundsVal('')
      fetchPortfolio()
    } finally { setAddingFunds(false) }
  }

  const handleSetTarget = async () => {
    const amt = parseFloat(targetVal)
    if (isNaN(amt) || amt < 0) return
    setSavingTarget(true)
    try {
      await client.post('/portfolio/target', { amount: amt })
      setTargetVal('')
      fetchPortfolio()
    } finally { setSavingTarget(false) }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Welcome header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">
            Welcome{user?.full_name ? `, ${user.full_name.split(' ')[0]}` : ''}
          </h2>
          <p className="text-sm text-muted">Your investment overview</p>
        </div>
        <span className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide ${marketModeColor(marketMode)}`}>
          {marketMode}
        </span>
      </div>

      {/* Top row — Portfolio + Monthly Income + Market Mode */}
      <div className="grid grid-cols-3 gap-4">
        {/* Portfolio Card */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="text-xs text-muted mb-2">Portfolio Value</div>
          {portfolioLoading ? (
            <div className="h-8 bg-slate-700 animate-pulse rounded" />
          ) : (
            <>
              <div className="text-2xl font-bold text-white">
                {formatINR(portfolio?.total_value || 0)}
              </div>
              <div className={`text-sm mt-1 ${(portfolio?.total_pnl || 0) >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {formatINR(portfolio?.total_pnl || 0)} ({formatPct(portfolio?.total_pnl_pct || 0)})
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted">Cash: </span><span className="text-white">{formatINR(portfolio?.cash_available || 0)}</span></div>
                <div><span className="text-muted">Holdings: </span><span className="text-white">{portfolio?.holdings?.length || 0}</span></div>
              </div>

              {/* Add Funds inline */}
              <div className="mt-3 flex gap-2 items-center">
                <input
                  type="number"
                  value={addFundsVal}
                  onChange={e => setAddFundsVal(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddFunds()}
                  placeholder="Add / set funds ₹"
                  className="flex-1 bg-slate-800 border border-border rounded px-2 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleAddFunds}
                  disabled={addingFunds || !addFundsVal}
                  className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-xs font-medium"
                >
                  {addingFunds ? '…' : 'Set'}
                </button>
              </div>
              <div className="text-[10px] text-muted mt-1">Enter any value to set available funds (0 to clear)</div>
            </>
          )}
        </div>

        {/* Monthly Income */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="text-xs text-muted mb-2">Monthly Income Progress</div>
          <div className="text-2xl font-bold text-white">{formatINR(achieved)}</div>
          <div className="text-xs text-muted mt-0.5">
            Target: {target > 0 ? formatINR(target) : <span className="text-score-amber">Not set</span>}
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-muted">Progress</span>
              <span className="text-white">{targetPct}%</span>
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-score-green rounded-full transition-all"
                style={{ width: `${targetPct}%` }}
              />
            </div>
          </div>
          {target > 0 && (
            <div className={`mt-2 text-xs ${achieved >= target ? 'text-score-green' : 'text-score-amber'}`}>
              {achieved >= target ? '✓ Target achieved!' : `${formatINR(target - achieved)} remaining`}
            </div>
          )}

          {/* Set target inline */}
          <div className="mt-3 flex gap-2 items-center">
            <input
              type="number"
              value={targetVal}
              onChange={e => setTargetVal(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSetTarget()}
              placeholder="Set monthly target ₹"
              className="flex-1 bg-slate-800 border border-border rounded px-2 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSetTarget}
              disabled={savingTarget || targetVal === ''}
              className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white rounded text-xs font-medium"
            >
              {savingTarget ? '…' : 'Set'}
            </button>
          </div>
        </div>

        {/* Market Overview */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="text-xs text-muted mb-2">Market Overview</div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs text-slate-300">Macro</span>
              <span className="text-xs font-bold" style={{ color: scoreToColor(macroScore) }}>{macroScore}/100</span>
            </div>
            <div className="h-1.5 bg-border rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${macroScore}%`, backgroundColor: scoreToColor(macroScore) }} />
            </div>
            <div className="text-xs text-muted mt-2">
              {macro ? `${Object.keys(macro.breakdown || {}).length} macro indicators tracked` : 'Loading macro data...'}
            </div>
          </div>
        </div>
      </div>

      {/* Today's Best Action */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="text-xs text-muted mb-3">Today's Best Action</div>
        {briefing?.best_action ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${recommendationColor(briefing.best_action.action)}`}>
                {briefing.best_action.action}
              </span>
              <div>
                <div className="font-semibold text-white">{shortSymbol(briefing.best_action.symbol)}</div>
                <div className="text-xs text-muted">{briefing.best_action.reason}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted">Score</div>
              <div className="text-xl font-bold" style={{ color: scoreToColor(briefing.best_action.score || 0) }}>
                {briefing.best_action.score}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted">Analyzing opportunities… Visit Discover for stock analysis.</div>
        )}
        {briefing?.market_outlook && (
          <p className="mt-3 text-xs text-slate-400 border-t border-border pt-3">{briefing.market_outlook}</p>
        )}
      </div>

      {/* Portfolio Holdings Summary */}
      {portfolio && portfolio.holdings.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="text-xs text-muted mb-3">Portfolio Holdings</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted border-b border-border">
                  <th className="text-left pb-2">Symbol</th>
                  <th className="text-right pb-2">Qty</th>
                  <th className="text-right pb-2">Avg</th>
                  <th className="text-right pb-2">CMP</th>
                  <th className="text-right pb-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.holdings.slice(0, 5).map((h) => (
                  <tr key={h.id} className="border-b border-border/50">
                    <td className="py-2 text-white font-medium">{shortSymbol(h.symbol)}</td>
                    <td className="py-2 text-right text-slate-300">{h.quantity.toLocaleString()}</td>
                    <td className="py-2 text-right text-slate-300">₹{h.avg_price.toLocaleString('en-IN')}</td>
                    <td className="py-2 text-right text-slate-300">₹{h.current_price.toLocaleString('en-IN')}</td>
                    <td className={`py-2 text-right font-medium ${h.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                      {formatPct(h.pnl_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {portfolio?.holdings.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-white font-semibold mb-1">No holdings yet</div>
          <div className="text-sm text-muted">Add holdings in the Portfolio section to track your investments</div>
        </div>
      )}
    </div>
  )
}
