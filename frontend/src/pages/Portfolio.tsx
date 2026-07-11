import { useState } from 'react'
import { usePortfolio } from '../hooks/usePortfolio'
import { formatINR, formatPct, shortSymbol, recommendationColor } from '../utils/formatters'

export default function Portfolio() {
  const { portfolio, loading, addHolding, removeHolding } = usePortfolio()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ symbol: '', quantity: '', avg_price: '' })
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!form.symbol || !form.quantity || !form.avg_price) return
    setAdding(true)
    await addHolding(form.symbol, Number(form.quantity), Number(form.avg_price))
    setForm({ symbol: '', quantity: '', avg_price: '' })
    setShowAdd(false)
    setAdding(false)
  }

  return (
    <div className="p-6 space-y-6">
      {/* Summary bar */}
      {portfolio && (
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Total Value', val: formatINR(portfolio.total_value), color: 'text-white' },
            { label: 'Invested', val: formatINR(portfolio.total_invested), color: 'text-muted' },
            { label: 'Total P&L', val: `${formatINR(portfolio.total_pnl)} (${formatPct(portfolio.total_pnl_pct)})`, color: portfolio.total_pnl >= 0 ? 'text-score-green' : 'text-score-red' },
            { label: 'Cash', val: formatINR(portfolio.cash_available), color: 'text-score-blue' },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs text-muted mb-1">{label}</div>
              <div className={`text-lg font-bold ${color}`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Holdings table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold text-white">Holdings</div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium"
          >
            + Add Holding
          </button>
        </div>

        {showAdd && (
          <div className="px-5 py-4 bg-slate-800/50 border-b border-border">
            <div className="flex gap-3">
              <input
                value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
                placeholder="Symbol (e.g. BEL.NS)"
                className="flex-1 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
              />
              <input
                type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                placeholder="Quantity"
                className="w-24 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <input
                type="number" value={form.avg_price} onChange={(e) => setForm({ ...form, avg_price: e.target.value })}
                placeholder="Avg Price ₹"
                className="w-32 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleAdd} disabled={adding}
                className="px-4 py-2 bg-score-green hover:bg-green-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
              >
                {adding ? '...' : 'Add'}
              </button>
              <button onClick={() => setShowAdd(false)} className="px-3 py-2 text-muted hover:text-white text-sm">Cancel</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="p-10 text-center text-muted text-sm">Loading holdings...</div>
        ) : portfolio?.holdings.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-3xl mb-2">📋</div>
            <div className="text-sm text-muted">No holdings yet. Add your first holding above.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-border">
                <th className="text-left px-5 py-3">Holding</th>
                <th className="text-right px-3 py-3">Qty</th>
                <th className="text-right px-3 py-3">Avg Price</th>
                <th className="text-right px-3 py-3">CMP</th>
                <th className="text-right px-3 py-3">P&L</th>
                <th className="text-center px-3 py-3">CC Eligible</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {portfolio?.holdings.map((h) => (
                <tr key={h.id} className="border-b border-border/50 hover:bg-slate-800/30">
                  <td className="px-5 py-3">
                    <div className="font-medium text-white">{shortSymbol(h.symbol)}</div>
                    <div className="text-xs text-muted truncate max-w-[160px]">{h.company_name}</div>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-300">{h.quantity.toLocaleString()}</td>
                  <td className="px-3 py-3 text-right text-slate-300">₹{h.avg_price.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-3 text-right text-slate-300">₹{h.current_price.toLocaleString('en-IN')}</td>
                  <td className={`px-3 py-3 text-right font-medium ${h.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                    <div>{formatINR(h.pnl)}</div>
                    <div className="text-xs">{formatPct(h.pnl_pct)}</div>
                  </td>
                  <td className="px-3 py-3 text-center">
                    {h.covered_call_eligible ? (
                      <span className="text-xs text-score-green">✓ Yes</span>
                    ) : (
                      <span className="text-xs text-muted">&lt;100 shares</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <button
                      onClick={() => removeHolding(h.id)}
                      className="text-xs text-muted hover:text-score-red transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
