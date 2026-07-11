import { useState } from 'react'
import client from '../api/client'
import { usePortfolio } from '../hooks/usePortfolio'
import { shortSymbol, normalizeSymbol } from '../utils/formatters'

interface ChainRow {
  strike: number
  expiry: string
  ce_ltp: number
  ce_iv: number
  ce_oi: number
  ce_bid: number
  ce_ask: number
  ce_volume: number
  ce_change: number
  pe_ltp: number
  pe_iv: number
  pe_oi: number
}

interface Suggestion {
  strike: number
  strike_pct_above_spot: number
  ltp: number
  bid: number
  ask: number
  iv: number
  oi: number
  volume: number
  change: number
  monthly_yield_pct: number
  expiry_date: string
  days_to_expiry: number
  label: string
  recommendation: string
}

interface OptionChainData {
  symbol: string
  underlying_symbol: string
  company_name: string
  current_price: number
  expiry_dates: string[]
  selected_expiry: string
  days_to_expiry: number
  suggestions: Suggestion[]
  chain: ChainRow[]
  data_source: string
}

export default function CoveredCalls() {
  const { portfolio } = usePortfolio()
  const [symbol, setSymbol] = useState('')
  const [selectedExpiry, setSelectedExpiry] = useState('')
  const [data, setData] = useState<OptionChainData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'suggestions' | 'chain'>('suggestions')

  const fetchCalls = async (sym: string, expiry?: string) => {
    if (!sym.trim()) return
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string> = {}
      if (expiry) params.expiry = expiry
      const res = await client.get(`/covered-calls/${normalizeSymbol(sym)}`, { params })
      setData(res.data)
      if (!expiry && res.data.expiry_dates?.length) {
        setSelectedExpiry(res.data.expiry_dates[0])
      }
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Failed to load option chain. This stock may not have listed NSE options.')
    } finally {
      setLoading(false)
    }
  }

  const changeExpiry = (expiry: string) => {
    setSelectedExpiry(expiry)
    if (symbol) fetchCalls(symbol, expiry)
  }

  const eligibleHoldings = portfolio?.holdings.filter((h) => h.covered_call_eligible) || []

  // Find the ATM strike for highlighting
  const atm = data ? Math.round(data.current_price / 5) * 5 : 0

  return (
    <div className="p-6 space-y-6">
      {/* Search */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-muted">Live NSE Option Chain — covered call opportunities</div>
          {data && (
            <span className="text-[10px] text-score-green bg-green-950 px-2 py-0.5 rounded-full border border-green-800">
              ● Live NSE Data
            </span>
          )}
        </div>
        <div className="flex gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && fetchCalls(symbol)}
            placeholder="NSE symbol (e.g. VEDL, HDFCBANK, INFY)"
            className="flex-1 bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => fetchCalls(symbol)}
            disabled={loading}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? 'Loading...' : 'Get Chain'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-score-red">{error}</p>}
      </div>

      {/* Eligible portfolio holdings */}
      {eligibleHoldings.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted mb-2">Your CC-eligible holdings (≥100 shares)</div>
          <div className="flex flex-wrap gap-2">
            {eligibleHoldings.map((h) => (
              <button
                key={h.id}
                onClick={() => { setSymbol(shortSymbol(h.symbol)); fetchCalls(h.symbol) }}
                className="px-3 py-1.5 bg-slate-800 border border-border rounded-lg text-xs text-white hover:border-blue-500 transition-colors"
              >
                {shortSymbol(h.symbol)} <span className="text-muted">{h.quantity}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <div className="text-xl mb-2 animate-spin inline-block">⊙</div>
          <div className="text-sm text-muted">Fetching live NSE option chain...</div>
        </div>
      )}

      {data && !loading && (
        <div className="space-y-4">
          {/* Stock + Expiry selector */}
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-base font-bold text-white">{data.company_name}</div>
                <div className="text-xs text-muted">{data.underlying_symbol}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted">Spot Price</div>
                <div className="text-2xl font-bold text-white">
                  ₹{data.current_price.toLocaleString('en-IN')}
                </div>
              </div>
            </div>

            {/* Expiry tabs */}
            <div className="mb-4">
              <div className="text-xs text-muted mb-2">Select Expiry</div>
              <div className="flex gap-2 flex-wrap">
                {data.expiry_dates.map((exp) => (
                  <button
                    key={exp}
                    onClick={() => changeExpiry(exp)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      exp === (selectedExpiry || data.expiry_dates[0])
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-800 border-border text-muted hover:text-white'
                    }`}
                  >
                    {exp}
                  </button>
                ))}
              </div>
            </div>

            {/* Expiry info strip */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-blue-950 border border-blue-800 rounded-lg p-3 text-center">
                <div className="text-[10px] text-blue-400 mb-0.5">Expiry Date</div>
                <div className="text-sm font-bold text-white">{data.selected_expiry}</div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-[10px] text-muted mb-0.5">Days to Expiry</div>
                <div className="text-sm font-bold text-white">{data.days_to_expiry} days</div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-[10px] text-muted mb-0.5">Source</div>
                <div className="text-sm font-bold text-score-green">{data.data_source}</div>
              </div>
            </div>
          </div>

          {/* View toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setView('suggestions')}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                view === 'suggestions' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-card border-border text-muted hover:text-white'
              }`}
            >
              Covered Call Picks
            </button>
            <button
              onClick={() => setView('chain')}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                view === 'chain' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-card border-border text-muted hover:text-white'
              }`}
            >
              Full Option Chain
            </button>
          </div>

          {/* Covered Call Picks */}
          {view === 'suggestions' && (
            <div className="space-y-3">
              {data.suggestions.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted">
                  No liquid OTM calls found for this expiry. Try a later expiry date.
                </div>
              ) : (
                data.suggestions.map((s, i) => (
                  <div key={i} className="bg-card border border-border rounded-xl p-5">
                    {/* Strike header */}
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="bg-slate-800 rounded-lg px-3 py-2 text-center min-w-[80px]">
                          <div className="text-[10px] text-muted">Strike</div>
                          <div className="text-xl font-bold text-white">₹{s.strike.toLocaleString('en-IN')}</div>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-white">{s.label}</div>
                          <div className="text-xs text-muted">
                            +{s.strike_pct_above_spot}% above spot · Expires <span className="text-white">{s.expiry_date}</span> ({s.days_to_expiry}d)
                          </div>
                        </div>
                      </div>
                      <span className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                        s.recommendation === 'SELL'
                          ? 'bg-green-950 border border-green-800 text-score-green'
                          : 'bg-slate-700 border border-slate-600 text-slate-300'
                      }`}>
                        SELL CALL
                      </span>
                    </div>

                    {/* Metrics */}
                    <div className="grid grid-cols-4 gap-3">
                      <div className="bg-slate-800 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">LTP (Last)</div>
                        <div className="text-lg font-bold text-white">₹{s.ltp.toFixed(2)}</div>
                        <div className={`text-[10px] mt-0.5 ${s.change >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}
                        </div>
                      </div>
                      <div className="bg-slate-800 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">Bid / Ask</div>
                        <div className="text-sm font-bold text-white">
                          ₹{s.bid.toFixed(2)} / ₹{s.ask.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted mt-0.5">Spread ₹{(s.ask - s.bid).toFixed(2)}</div>
                      </div>
                      <div className="bg-slate-800 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">IV</div>
                        <div className="text-lg font-bold text-score-amber">{s.iv.toFixed(1)}%</div>
                        <div className="text-[10px] text-muted mt-0.5">Implied Vol</div>
                      </div>
                      <div className="bg-slate-800 rounded-lg p-3 text-center">
                        <div className="text-[10px] text-muted mb-1">Monthly Yield</div>
                        <div className="text-lg font-bold text-score-green">{s.monthly_yield_pct}%</div>
                        <div className="text-[10px] text-muted mt-0.5">on spot price</div>
                      </div>
                    </div>

                    {/* OI + Volume bar */}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted w-12">OI</span>
                        <span className="text-white font-medium">{s.oi.toLocaleString('en-IN')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted w-12">Volume</span>
                        <span className="text-white font-medium">{s.volume.toLocaleString('en-IN')}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Full Option Chain Table */}
          {view === 'chain' && (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <div className="text-sm font-semibold text-white">
                  Option Chain — {data.selected_expiry}
                </div>
                <div className="text-xs text-muted">{data.chain.length} strikes · Spot ₹{data.current_price}</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-slate-800/50">
                      {/* CALL side */}
                      <th className="text-right px-3 py-2.5 text-muted font-medium">OI</th>
                      <th className="text-right px-3 py-2.5 text-muted font-medium">IV%</th>
                      <th className="text-right px-3 py-2.5 text-muted font-medium">Call LTP</th>
                      {/* Strike */}
                      <th className="text-center px-4 py-2.5 text-white font-bold bg-slate-700">Strike</th>
                      {/* PUT side */}
                      <th className="text-left px-3 py-2.5 text-muted font-medium">Put LTP</th>
                      <th className="text-left px-3 py-2.5 text-muted font-medium">IV%</th>
                      <th className="text-left px-3 py-2.5 text-muted font-medium">OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.chain.map((row) => {
                      const isAtm = Math.abs(row.strike - data.current_price) / data.current_price < 0.015
                      const isOtmSuggestion = data.suggestions.some((s) => s.strike === row.strike)
                      return (
                        <tr
                          key={row.strike}
                          className={`border-b border-border/40 ${
                            isAtm
                              ? 'bg-blue-950/60'
                              : isOtmSuggestion
                              ? 'bg-green-950/30'
                              : 'hover:bg-slate-800/30'
                          }`}
                        >
                          {/* CALL side */}
                          <td className="text-right px-3 py-2 text-slate-400">
                            {row.ce_oi > 0 ? row.ce_oi.toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="text-right px-3 py-2">
                            {row.ce_iv > 0 ? (
                              <span className="text-score-amber">{row.ce_iv.toFixed(1)}</span>
                            ) : '—'}
                          </td>
                          <td className="text-right px-3 py-2 font-medium">
                            {row.ce_ltp > 0 ? (
                              <span className="text-white">
                                {row.ce_ltp.toFixed(2)}
                                {row.ce_change !== 0 && (
                                  <span className={`ml-1 text-[10px] ${row.ce_change > 0 ? 'text-score-green' : 'text-score-red'}`}>
                                    ({row.ce_change > 0 ? '+' : ''}{row.ce_change.toFixed(2)})
                                  </span>
                                )}
                              </span>
                            ) : <span className="text-muted">—</span>}
                          </td>
                          {/* Strike */}
                          <td className={`text-center px-4 py-2 font-bold ${isAtm ? 'text-score-blue' : 'text-white'} bg-slate-700/50`}>
                            {row.strike.toLocaleString('en-IN')}
                            {isAtm && <span className="ml-1 text-[9px] text-score-blue">ATM</span>}
                            {isOtmSuggestion && !isAtm && <span className="ml-1 text-[9px] text-score-green">●</span>}
                          </td>
                          {/* PUT side */}
                          <td className="text-left px-3 py-2 font-medium">
                            {row.pe_ltp > 0 ? (
                              <span className="text-white">{row.pe_ltp.toFixed(2)}</span>
                            ) : <span className="text-muted">—</span>}
                          </td>
                          <td className="text-left px-3 py-2">
                            {row.pe_iv > 0 ? (
                              <span className="text-score-amber">{row.pe_iv.toFixed(1)}</span>
                            ) : '—'}
                          </td>
                          <td className="text-left px-3 py-2 text-slate-400">
                            {row.pe_oi > 0 ? row.pe_oi.toLocaleString('en-IN') : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-border text-[10px] text-muted flex items-center gap-4">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-blue-950/60 inline-block"></span> ATM strike</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-950/30 inline-block"></span> ● Suggested for covered call</span>
              </div>
            </div>
          )}

          <div className="bg-slate-800 border border-border rounded-xl p-4">
            <p className="text-xs text-slate-400">
              Data from NSE India live option chain. Prices are last traded price (LTP).
              Always check bid/ask spread before writing a covered call — wide spreads reduce effective premium.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
