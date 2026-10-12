import { useState } from 'react'
import apiClient from '../api/client'

const api = {
  get: (url: string, params?: Record<string, unknown>) =>
    apiClient.get(url, { params }).then(r => r.data),
  post: (url: string, body?: unknown) =>
    apiClient.post(url, body).then(r => r.data),
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScannedStock {
  symbol: string
  sector: string
  cmp: number
  actual_range: number
  expected_1sd: number
  ratio: number
  consolidating: boolean
  hv_pct: number
  safety_rank: number | null
  rank_reason: string
}

interface FlyLeg {
  strike: number
  premium: number
  delta: number
  volume: number
  oi: number
  liq_ok: boolean
}

interface HedgeIronFly {
  buy_pe_strike: number
  buy_pe_premium: number
  buy_ce_strike: number
  buy_ce_premium: number
  wing_width: number
  hedge_debit: number
  capped_max_loss: number | null
}

interface HedgeStock {
  side: string
  shares: number
  value: number
}

interface FlySetup {
  symbol: string
  spot: number
  lot_size: number
  expiry: string
  dte: number
  atm_iv: number
  sd_move: number
  sell_pe: FlyLeg
  sell_ce: FlyLeg
  net_credit: number
  net_delta: number
  premium_diff_pct: number
  breakeven_up: number
  breakeven_down: number
  hedge_iron_fly: HedgeIronFly
  hedge_stock: HedgeStock
  source: string
  dte_warning: string | null
  error: string | null
}

// ─── Helper components ────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="text-gray-500 text-xs">—</span>
  const cls =
    rank === 1 ? 'bg-green-900 text-green-300' :
    rank === 2 ? 'bg-amber-900 text-amber-300' :
    'bg-red-900 text-red-300'
  const label = rank === 1 ? 'Rank 1 Safe' : rank === 2 ? 'Rank 2 Moderate' : 'Rank 3 Avoid'
  return <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>{label}</span>
}

function RatioBar({ ratio }: { ratio: number }) {
  const pct = Math.min(ratio * 100, 150)
  const color = ratio <= 0.7 ? 'bg-green-500' : ratio <= 1.0 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-1 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-gray-700 rounded overflow-hidden">
        <div className={`h-full rounded ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-8">{ratio.toFixed(2)}</span>
    </div>
  )
}

function LiqDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FlyStrategy() {
  const [days, setDays] = useState<5 | 10>(10)
  const [scanning, setScanning] = useState(false)
  const [stocks, setStocks] = useState<ScannedStock[]>([])
  const [scanInfo, setScanInfo] = useState<{ total: number; consolidating: number; cachedAt?: string } | null>(null)
  const [scanError, setScanError] = useState('')

  const [manualSymbol, setManualSymbol] = useState('')
  const [loadingSetup, setLoadingSetup] = useState(false)
  const [flySetup, setFlySetup] = useState<FlySetup | null>(null)
  const [setupError, setSetupError] = useState('')
  const [selectedSymbol, setSelectedSymbol] = useState('')

  const [hedgeAEnabled, setHedgeAEnabled] = useState(false)
  const [hedgeBEnabled, setHedgeBEnabled] = useState(false)

  // ── Scanner ──────────────────────────────────────────────────────────────

  async function doScan() {
    setScanning(true)
    setScanError('')
    try {
      const res = await api.get('/fly/scan', { days })
      setStocks(res.stocks || [])
      setScanInfo({
        total: res.total,
        consolidating: res.consolidating_count,
        cachedAt: res.cached_at,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Scan failed'
      setScanError(msg)
    } finally {
      setScanning(false)
    }
  }

  // ── Fly setup ────────────────────────────────────────────────────────────

  async function loadFlySetup(symbol: string) {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setSelectedSymbol(sym)
    setLoadingSetup(true)
    setFlySetup(null)
    setSetupError('')
    setHedgeAEnabled(false)
    setHedgeBEnabled(false)
    try {
      const res = await api.get(`/fly/setup/${sym}`)
      if (res.error) {
        setSetupError(res.error)
      } else {
        setFlySetup(res)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch fly setup'
      setSetupError(msg)
    } finally {
      setLoadingSetup(false)
    }
  }

  // ── Derived summary (with optional hedges) ───────────────────────────────

  function computeSummary() {
    if (!flySetup) return null
    const { sell_pe, sell_ce, lot_size, breakeven_up, breakeven_down, hedge_iron_fly, hedge_stock, net_delta, net_credit } = flySetup
    let credit = sell_pe.premium + sell_ce.premium
    let debit = 0
    let cappedLoss: number | null = null

    if (hedgeAEnabled) {
      debit += hedge_iron_fly.buy_pe_premium + hedge_iron_fly.buy_ce_premium
      cappedLoss = hedge_iron_fly.capped_max_loss
    }
    if (hedgeBEnabled && hedge_stock.side !== 'NONE') {
      debit += hedge_stock.value / lot_size  // approximate per-share cost per lot
    }

    const netPerShare = credit - debit
    const netTotal = round2(netPerShare * lot_size)
    const adjBEUp = hedgeAEnabled
      ? round2(sell_ce.strike + (credit - debit))
      : breakeven_up
    const adjBEDown = hedgeAEnabled
      ? round2(sell_pe.strike - (credit - debit))
      : breakeven_down

    return {
      netTotal,
      netDelta: net_delta,
      maxProfit: round2(netTotal),
      maxLoss: hedgeAEnabled && cappedLoss != null ? cappedLoss : null,
      beUp: adjBEUp,
      beDown: adjBEDown,
    }
  }

  function round2(n: number) { return Math.round(n * 100) / 100 }

  const summary = computeSummary()

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 pb-16 md:pb-0">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Custom Fly Strategy</h1>
        <p className="text-gray-400 text-sm mt-1">
          Scan Nifty 50 for consolidating stocks and build a delta-neutral naked fly (premium-matched short CE + PE).
        </p>
      </div>

      {/* ── Scanner ── */}
      <div className="bg-gray-800 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-gray-300 text-sm font-medium">Scan for consolidation over</span>
          {([5, 10] as const).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                days === d ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {d} days
            </button>
          ))}
          <button
            onClick={doScan}
            disabled={scanning}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-wait text-white text-sm rounded font-medium transition-colors"
          >
            {scanning ? 'Scanning…' : 'Scan Nifty 50'}
          </button>
          {scanInfo && !scanning && (
            <span className="text-gray-400 text-xs ml-auto">
              {scanInfo.consolidating}/{scanInfo.total} consolidating
              {scanInfo.cachedAt && ` · cached ${scanInfo.cachedAt}`}
            </span>
          )}
        </div>

        {scanning && (
          <div className="mt-3 text-amber-400 text-sm animate-pulse">
            Downloading 50 stocks + AI safety ranking… this takes ~20s
          </div>
        )}

        {scanError && (
          <div className="mt-3 text-red-400 text-sm">Error: {scanError}</div>
        )}
      </div>

      {/* ── Stock table ── */}
      {stocks.length > 0 && (
        <div className="bg-gray-800 rounded-xl overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-gray-700">
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Sector</th>
                  <th className="px-3 py-2 text-right">CMP</th>
                  <th className="px-3 py-2 text-right">{days}d Range</th>
                  <th className="px-3 py-2 text-right">1 SD</th>
                  <th className="px-3 py-2 text-center">Range/1SD</th>
                  <th className="px-3 py-2 text-center">HV%</th>
                  <th className="px-3 py-2 text-center">Safety</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map(s => (
                  <tr
                    key={s.symbol}
                    className={`border-b border-gray-700/50 transition-colors ${
                      s.consolidating ? 'hover:bg-gray-700/40' : 'opacity-35'
                    }`}
                  >
                    <td className="px-3 py-2 font-medium text-white">{s.symbol}</td>
                    <td className="px-3 py-2 text-gray-400">{s.sector}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.cmp.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.actual_range.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.expected_1sd.toFixed(1)}</td>
                    <td className="px-3 py-2">
                      <RatioBar ratio={s.ratio} />
                    </td>
                    <td className="px-3 py-2 text-center text-gray-400">{s.hv_pct}%</td>
                    <td className="px-3 py-2 text-center">
                      {s.consolidating ? <RankBadge rank={s.safety_rank} /> : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-400 max-w-[200px] truncate text-xs">
                      {s.rank_reason || '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {s.consolidating && (s.safety_rank === 1 || s.safety_rank === 2) ? (
                        <button
                          onClick={() => loadFlySetup(s.symbol)}
                          className="px-2 py-0.5 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded transition-colors"
                        >
                          Setup Fly
                        </button>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Manual override + fly setup ── */}
      <div className="bg-gray-800 rounded-xl p-4 mb-4">
        <h2 className="text-white font-semibold mb-3">Fly Setup</h2>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={manualSymbol}
            onChange={e => setManualSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && loadFlySetup(manualSymbol)}
            placeholder="Enter any NSE F&O symbol (e.g. INFY)"
            className="flex-1 max-w-xs bg-gray-700 text-white px-3 py-2 rounded text-sm border border-gray-600 focus:border-blue-500 focus:outline-none uppercase placeholder:normal-case placeholder:text-gray-500"
          />
          <button
            onClick={() => loadFlySetup(manualSymbol)}
            disabled={loadingSetup || !manualSymbol.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white text-sm rounded font-medium transition-colors"
          >
            {loadingSetup ? 'Loading…' : 'Get Fly Setup'}
          </button>
          {selectedSymbol && (
            <span className="text-gray-400 text-sm">Showing: <span className="text-white font-medium">{selectedSymbol}</span></span>
          )}
        </div>
      </div>

      {setupError && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl p-4 mb-4 text-sm">
          {setupError}
        </div>
      )}

      {flySetup && !flySetup.error && (
        <div className="space-y-4">
          {flySetup.dte_warning && (
            <div className="bg-amber-900/30 border border-amber-700 text-amber-300 rounded-xl px-4 py-2 text-sm">
              ⚠ {flySetup.dte_warning}
            </div>
          )}
          {/* Header card */}
          <div className="bg-gray-800 rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <div className="text-gray-400 text-xs">Symbol</div>
                <div className="text-white font-bold text-lg">{flySetup.symbol}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">CMP</div>
                <div className="text-white font-semibold">₹{flySetup.spot.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Expiry</div>
                <div className="text-white font-semibold">{flySetup.expiry}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">DTE</div>
                <div className="text-white font-semibold">{flySetup.dte} days</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">ATM IV</div>
                <div className="text-white font-semibold">{flySetup.atm_iv}%</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">1SD Move</div>
                <div className="text-white font-semibold">±₹{flySetup.sd_move.toFixed(1)}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Lot Size</div>
                <div className="text-white font-semibold">{flySetup.lot_size}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Data Source</div>
                <div className={`text-xs px-2 py-0.5 rounded ${flySetup.source === 'nse' ? 'bg-green-900 text-green-300' : 'bg-amber-900 text-amber-300'}`}>
                  {flySetup.source.toUpperCase()}
                </div>
              </div>
            </div>
          </div>

          {/* Naked position */}
          <div className="bg-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold mb-3">
              Naked Position
              {flySetup.premium_diff_pct > 10 && (
                <span className="ml-2 text-xs bg-amber-900 text-amber-300 px-2 py-0.5 rounded">
                  Δ premium {flySetup.premium_diff_pct.toFixed(1)}% — not perfectly balanced
                </span>
              )}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-700">
                    <th className="px-3 py-2 text-left">Action</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Strike</th>
                    <th className="px-3 py-2 text-right">Premium</th>
                    <th className="px-3 py-2 text-right">Delta</th>
                    <th className="px-3 py-2 text-right">Volume</th>
                    <th className="px-3 py-2 text-right">OI</th>
                    <th className="px-3 py-2 text-center">Liq</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { ...flySetup.sell_pe, label: 'PE' },
                    { ...flySetup.sell_ce, label: 'CE' },
                  ].map(leg => (
                    <tr key={leg.label} className="border-b border-gray-700/50">
                      <td className="px-3 py-2 text-red-400 font-medium">SELL</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${leg.label === 'PE' ? 'bg-rose-900 text-rose-300' : 'bg-sky-900 text-sky-300'}`}>
                          {leg.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-white">₹{leg.strike}</td>
                      <td className="px-3 py-2 text-right text-green-400 font-medium">₹{leg.premium}</td>
                      <td className="px-3 py-2 text-right text-gray-300">
                        {leg.label === 'PE' ? (-(leg.delta)).toFixed(3) : leg.delta.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">{leg.volume.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-gray-400">{leg.oi.toLocaleString()}</td>
                      <td className="px-3 py-2 text-center"><LiqDot ok={leg.liq_ok} /></td>
                    </tr>
                  ))}
                  <tr className="bg-gray-700/30">
                    <td colSpan={3} className="px-3 py-2 text-gray-300 font-medium text-sm">Net Credit (1 lot)</td>
                    <td className="px-3 py-2 text-right text-green-400 font-bold text-sm">₹{flySetup.net_credit.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-300 text-sm">Δ {flySetup.net_delta.toFixed(3)}</td>
                    <td colSpan={3} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Proposed hedges */}
          <div className="bg-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold mb-1">Proposed Hedges</h3>
            <p className="text-gray-400 text-xs mb-4">Optional — toggle to include in summary. User decides which positions to take.</p>

            {/* Hedge A: Iron Fly */}
            <div className={`rounded-lg border p-4 mb-3 transition-colors ${hedgeAEnabled ? 'border-blue-600 bg-blue-900/20' : 'border-gray-700 bg-gray-700/30'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-white font-medium text-sm">Hedge A — Convert to Iron Fly</span>
                    <span className="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded">Caps Max Loss</span>
                  </div>
                  <div className="text-gray-400 text-xs space-y-1 mt-2">
                    <div>Buy PE @ ₹{flySetup.hedge_iron_fly.buy_pe_strike} · Premium ₹{flySetup.hedge_iron_fly.buy_pe_premium}</div>
                    <div>Buy CE @ ₹{flySetup.hedge_iron_fly.buy_ce_strike} · Premium ₹{flySetup.hedge_iron_fly.buy_ce_premium}</div>
                    <div className="text-amber-400">Hedge debit: ₹{flySetup.hedge_iron_fly.hedge_debit.toLocaleString()} per lot</div>
                    {flySetup.hedge_iron_fly.capped_max_loss != null && (
                      <div className="text-red-400">Max loss capped at: ₹{flySetup.hedge_iron_fly.capped_max_loss.toLocaleString()} per lot</div>
                    )}
                    <div className="text-gray-500">Wing width: ₹{flySetup.hedge_iron_fly.wing_width} (≈1 SD)</div>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    checked={hedgeAEnabled}
                    onChange={e => setHedgeAEnabled(e.target.checked)}
                    className="w-4 h-4 accent-blue-500"
                  />
                  <span className="text-gray-400 text-xs">Include</span>
                </label>
              </div>
            </div>

            {/* Hedge B: Stock delta */}
            {flySetup.hedge_stock.side !== 'NONE' && (
              <div className={`rounded-lg border p-4 transition-colors ${hedgeBEnabled ? 'border-purple-600 bg-purple-900/20' : 'border-gray-700 bg-gray-700/30'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-white font-medium text-sm">Hedge B — Stock Delta Hedge</span>
                      <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded">Flattens Delta</span>
                    </div>
                    <div className="text-gray-400 text-xs space-y-1 mt-2">
                      <div>
                        {flySetup.hedge_stock.side} {flySetup.hedge_stock.shares} shares of {flySetup.symbol} @ ₹{flySetup.spot.toLocaleString()}
                      </div>
                      <div className="text-amber-400">Capital required: ₹{flySetup.hedge_stock.value.toLocaleString()}</div>
                      <div className="text-gray-500">Net delta to neutralise: {flySetup.net_delta.toFixed(3)}</div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer mt-1">
                    <input
                      type="checkbox"
                      checked={hedgeBEnabled}
                      onChange={e => setHedgeBEnabled(e.target.checked)}
                      className="w-4 h-4 accent-purple-500"
                    />
                    <span className="text-gray-400 text-xs">Include</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Summary */}
          {summary && (
            <div className="bg-gray-800 rounded-xl p-4">
              <h3 className="text-white font-semibold mb-3">Position Summary</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                {[
                  { label: 'Net Credit', value: `₹${summary.netTotal.toLocaleString()}`, cls: summary.netTotal >= 0 ? 'text-green-400' : 'text-red-400' },
                  { label: 'Net Delta', value: summary.netDelta.toFixed(3), cls: 'text-gray-300' },
                  { label: 'Max Profit', value: `₹${summary.maxProfit.toLocaleString()}`, cls: 'text-green-400' },
                  { label: 'Max Loss', value: summary.maxLoss != null ? `₹${summary.maxLoss.toLocaleString()}` : 'Unlimited', cls: summary.maxLoss != null ? 'text-red-400' : 'text-orange-400' },
                  { label: 'BE Upper', value: `₹${summary.beUp.toLocaleString()}`, cls: 'text-gray-300' },
                  { label: 'BE Lower', value: `₹${summary.beDown.toLocaleString()}`, cls: 'text-gray-300' },
                ].map(item => (
                  <div key={item.label} className="bg-gray-700/50 rounded-lg p-3 text-center">
                    <div className="text-gray-400 text-xs mb-1">{item.label}</div>
                    <div className={`font-bold text-sm ${item.cls}`}>{item.value}</div>
                  </div>
                ))}
              </div>
              <p className="text-gray-500 text-xs mt-3 text-center">
                This is informational only. No orders are placed by the application.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
