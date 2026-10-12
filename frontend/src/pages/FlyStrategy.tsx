import { useState, useEffect } from 'react'
import apiClient from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

const api = {
  get:    (url: string, params?: Record<string, unknown>) => apiClient.get(url, { params }).then(r => r.data),
  post:   (url: string, body?: unknown)                   => apiClient.post(url, body).then(r => r.data),
  delete: (url: string)                                   => apiClient.delete(url).then(r => r.data),
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScannedStock {
  symbol: string; sector: string; cmp: number
  actual_range: number; expected_1sd: number; ratio: number
  consolidating: boolean; hv_pct: number; hv_rank: number
  safety_rank: number | null; rank_reason: string; highly_recommended: boolean
}

interface ExpiryInfo { expiry: string; dte: number; calls_count: number; puts_count: number }

interface FlyLeg {
  strike: number; premium: number; delta: number
  volume: number; oi: number; liq_ok: boolean
}

interface HedgeIronFly {
  buy_pe_strike: number; buy_pe_premium: number
  buy_ce_strike: number; buy_ce_premium: number
  wing_width: number; hedge_debit: number; capped_max_loss: number | null
}

interface HedgeStock { side: string; shares: number; value: number }

interface FlySetup {
  symbol: string; spot: number; lot_size: number
  expiry: string; dte: number; atm_iv: number; sd_move: number
  sell_pe: FlyLeg; sell_ce: FlyLeg
  net_credit: number; return_pct: number; est_5d_theta_pct: number
  net_delta: number; premium_diff_pct: number
  breakeven_up: number; breakeven_down: number
  hedge_iron_fly: HedgeIronFly; hedge_stock: HedgeStock
  source: string; dte_warning: string | null; error: string | null
  put_strikes: number[]; call_strikes: number[]
}

interface MtmPoint { ts: string; pe_ltp: number; ce_ltp: number; mtm_pnl: number; pct_of_target: number }

interface FlyPosition {
  id: string; symbol: string; expiry: string; lot_size: number; lots: number
  spot_at_entry: number; dte_at_entry: number
  sell_pe: { strike: number; entry_premium: number; order_id: string }
  sell_ce: { strike: number; entry_premium: number; order_id: string }
  net_credit_total: number; entered_at: string; status: string
  current_pe_ltp: number; current_ce_ltp: number
  mtm_pnl: number; pct_of_target: number; mtm_pct_of_position: number
  last_checked: string; mtm_history: MtmPoint[]
  exit_reason: string | null; exited_at: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="text-gray-500 text-xs">—</span>
  const cls = rank === 1 ? 'bg-green-900 text-green-300' : rank === 2 ? 'bg-amber-900 text-amber-300' : 'bg-red-900 text-red-300'
  return <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>{rank === 1 ? 'Safe' : rank === 2 ? 'Moderate' : 'Avoid'}</span>
}
function RatioBar({ ratio }: { ratio: number }) {
  const color = ratio <= 0.7 ? 'bg-green-500' : ratio <= 1.0 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-1 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-gray-700 rounded overflow-hidden">
        <div className={`h-full rounded ${color}`} style={{ width: `${Math.min(ratio * 100, 100)}%` }} />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-8">{ratio.toFixed(2)}</span>
    </div>
  )
}
function LiqDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
}
function SourceBadge({ source }: { source: string }) {
  const cls = source === 'angel_one' ? 'bg-purple-900 text-purple-300' : source === 'jugaad' ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'
  return <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>{source.replace('_', ' ').toUpperCase()}</span>
}
function StrikeSelect({ value, options, onChange }: { value: number; options: number[]; onChange: (v: number) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="bg-gray-600 border border-gray-500 text-white text-sm rounded px-2 py-1 focus:outline-none focus:border-blue-400 cursor-pointer"
    >
      {options.map(s => (
        <option key={s} value={s}>₹{s}</option>
      ))}
    </select>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FlyStrategy() {
  // Scanner
  const [days, setDays] = useState<5 | 10>(10)
  const [scanning, setScanning] = useState(false)
  const [stocks, setStocks] = useState<ScannedStock[]>([])
  const [scanInfo, setScanInfo] = useState<{ total: number; consolidating: number; cachedAt?: string } | null>(null)
  const [scanError, setScanError] = useState('')

  // Setup
  const [symbolInput, setSymbolInput] = useState('')
  const [loadingExpiries, setLoadingExpiries] = useState(false)
  const [expiries, setExpiries] = useState<ExpiryInfo[]>([])
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null)
  const [loadingSetup, setLoadingSetup] = useState(false)
  const [flySetup, setFlySetup] = useState<FlySetup | null>(null)
  const [setupError, setSetupError] = useState('')
  const [activeSymbol, setActiveSymbol] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // Strike overrides
  const [peStrike, setPeStrike] = useState<number | null>(null)
  const [ceStrike, setCeStrike] = useState<number | null>(null)

  // Hedges
  const [hedgeAEnabled, setHedgeAEnabled] = useState(false)
  const [hedgeBEnabled, setHedgeBEnabled] = useState(false)

  // Order modal
  const [showOrderModal, setShowOrderModal] = useState(false)
  const [lots, setLots] = useState(1)
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')

  // Positions
  const [positions, setPositions] = useState<FlyPosition[]>([])
  const [closingId, setClosingId] = useState<string | null>(null)

  // Poll positions every 60s
  useEffect(() => {
    fetchPositions()
    const id = setInterval(fetchPositions, 60000)
    return () => clearInterval(id)
  }, [])

  async function fetchPositions() {
    try {
      const res = await api.get('/fly/positions')
      setPositions(res.positions || [])
    } catch { /* silent */ }
  }

  // ── Scanner ───────────────────────────────────────────────────────────────

  async function doScan() {
    setScanning(true); setScanError('')
    try {
      const res = await api.get('/fly/scan', { days })
      setStocks(res.stocks || [])
      setScanInfo({ total: res.total, consolidating: res.consolidating_count, cachedAt: res.cached_at })
    } catch { setScanError('Scan failed') } finally { setScanning(false) }
  }

  // ── Expiry + setup flow ───────────────────────────────────────────────────

  async function fetchExpiries(sym: string) {
    const clean = sym.trim().toUpperCase()
    if (!clean) return
    setActiveSymbol(clean); setLoadingExpiries(true)
    setExpiries([]); setSelectedExpiry(null); setFlySetup(null)
    setSetupError(''); setPeStrike(null); setCeStrike(null)
    setHedgeAEnabled(false); setHedgeBEnabled(false)
    try {
      const res = await api.get(`/fly/expiries/${clean}`)
      const list: ExpiryInfo[] = res.expiries || []
      setExpiries(list)
      const preferred = list.find(e => e.dte > 30) ?? list[0]
      if (preferred) { setSelectedExpiry(preferred.expiry); await loadFlySetup(clean, preferred.expiry, null, null) }
      else setSetupError('No option expiries found')
    } catch { setSetupError('Failed to fetch expiries') } finally { setLoadingExpiries(false) }
  }

  async function loadFlySetup(sym: string, expiry: string, pe?: number | null, ce?: number | null, refresh = false) {
    setLoadingSetup(true); setFlySetup(null); setSetupError('')
    if (!refresh) { setHedgeAEnabled(false); setHedgeBEnabled(false) }
    try {
      const params: Record<string, unknown> = { expiry }
      if (pe) params.pe_strike = pe
      if (ce) params.ce_strike = ce
      if (refresh) params.refresh = true
      const res = await api.get(`/fly/setup/${sym}`, params)
      if (res.error) { setSetupError(res.error) }
      else {
        setFlySetup(res)
        if (!pe) setPeStrike(res.sell_pe.strike)
        if (!ce) setCeStrike(res.sell_ce.strike)
      }
    } catch { setSetupError('Failed to load fly setup') } finally { setLoadingSetup(false) }
  }

  async function changeExpiry(expiry: string) {
    setSelectedExpiry(expiry)
    setPeStrike(null); setCeStrike(null)
    if (activeSymbol) await loadFlySetup(activeSymbol, expiry)
  }

  async function applyStrikes() {
    if (!activeSymbol || !selectedExpiry) return
    await loadFlySetup(activeSymbol, selectedExpiry, peStrike, ceStrike)
  }

  async function refreshPrices() {
    if (!activeSymbol || !selectedExpiry) return
    setRefreshing(true)
    try { await loadFlySetup(activeSymbol, selectedExpiry, peStrike, ceStrike, true) }
    finally { setRefreshing(false) }
  }

  // ── Order placement ───────────────────────────────────────────────────────

  async function placeOrder() {
    if (!flySetup) return
    setPlacingOrder(true); setOrderError('')
    try {
      const body = {
        symbol: flySetup.symbol, expiry: flySetup.expiry,
        sell_pe: { strike: flySetup.sell_pe.strike, premium: flySetup.sell_pe.premium },
        sell_ce: { strike: flySetup.sell_ce.strike, premium: flySetup.sell_ce.premium },
        lot_size: flySetup.lot_size, lots,
        spot_at_entry: flySetup.spot,
        net_credit_total: flySetup.net_credit * lots,
        dte: flySetup.dte,
      }
      await api.post('/fly/order', body)
      setShowOrderModal(false)
      await fetchPositions()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Order failed'
      setOrderError(msg)
    } finally { setPlacingOrder(false) }
  }

  async function closePosition(posId: string) {
    setClosingId(posId)
    try { await api.post(`/fly/position/${posId}/close`); await fetchPositions() }
    catch (e: unknown) { alert((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Close failed') }
    finally { setClosingId(null) }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  function computeSummary() {
    if (!flySetup) return null
    const { sell_pe, sell_ce, lot_size, breakeven_up, breakeven_down, hedge_iron_fly, net_delta } = flySetup
    const gross = sell_pe.premium + sell_ce.premium
    let debit = 0; let cappedLoss: number | null = null
    if (hedgeAEnabled) { debit += hedge_iron_fly.buy_pe_premium + hedge_iron_fly.buy_ce_premium; cappedLoss = hedge_iron_fly.capped_max_loss }
    const netPS = gross - debit
    const netTotal = r2(netPS * lot_size * lots)
    const beUp  = hedgeAEnabled ? r2(sell_ce.strike + netPS) : breakeven_up
    const beDown = hedgeAEnabled ? r2(sell_pe.strike - netPS) : breakeven_down
    return { netTotal, netDelta: net_delta, maxProfit: netTotal, maxLoss: cappedLoss, beUp, beDown }
  }

  function r2(n: number) { return Math.round(n * 100) / 100 }
  const summary = computeSummary()

  const activePositions = positions.filter(p => p.status === 'active')
  const closedPositions = positions.filter(p => p.status === 'exited')

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 pb-16 md:pb-0 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Custom Fly Strategy</h1>
        <p className="text-gray-400 text-sm mt-1">Target: 2-3% return in under 5 days via theta + IV crush. Naked fly — premium-matched short CE + short PE.</p>
      </div>

      {/* ── Active positions ── */}
      {activePositions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-white font-semibold">Active Positions</h2>
          {activePositions.map(p => <PositionCard key={p.id} pos={p} onClose={closePosition} closingId={closingId} />)}
        </div>
      )}

      {/* ── Scanner ── */}
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-gray-300 text-sm font-medium">Consolidation over</span>
          {([5, 10] as const).map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}>
              {d} days
            </button>
          ))}
          <button onClick={doScan} disabled={scanning}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-wait text-white text-sm rounded font-medium">
            {scanning ? 'Scanning…' : 'Scan Nifty 50'}
          </button>
          {scanInfo && !scanning && (
            <span className="text-gray-400 text-xs ml-auto">{scanInfo.consolidating}/{scanInfo.total} consolidating{scanInfo.cachedAt && ` · cached ${scanInfo.cachedAt}`}</span>
          )}
        </div>
        {scanning && <div className="mt-2 text-amber-400 text-sm animate-pulse">Downloading 50 stocks + AI safety ranking… ~20s</div>}
        {scanError && <div className="mt-2 text-red-400 text-sm">{scanError}</div>}
      </div>

      {/* ── Stock table ── */}
      {stocks.length > 0 && (
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-gray-700">
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Sector</th>
                  <th className="px-3 py-2 text-right">CMP</th>
                  <th className="px-3 py-2 text-right">{days}d Range</th>
                  <th className="px-3 py-2 text-right">1 SD</th>
                  <th className="px-3 py-2 text-center">Range/SD</th>
                  <th className="px-3 py-2 text-center">HV%</th>
                  <th className="px-3 py-2 text-center">IV Rank</th>
                  <th className="px-3 py-2 text-center">Safety</th>
                  <th className="px-3 py-2 text-left max-w-[180px]">Reason</th>
                  <th className="px-3 py-2 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map(s => (
                  <tr key={s.symbol} className={`border-b border-gray-700/50 transition-colors ${s.consolidating ? 'hover:bg-gray-700/40' : 'opacity-30'}`}>
                    <td className="px-3 py-2 font-medium text-white">{s.highly_recommended && <span className="mr-1 text-amber-400">🔥</span>}{s.symbol}</td>
                    <td className="px-3 py-2 text-gray-400">{s.sector}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.cmp.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.actual_range.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">₹{s.expected_1sd.toFixed(1)}</td>
                    <td className="px-3 py-2"><RatioBar ratio={s.ratio} /></td>
                    <td className="px-3 py-2 text-center text-gray-400">{s.hv_pct}%</td>
                    <td className="px-3 py-2 text-center">
                      {s.consolidating
                        ? <span className={`text-xs font-medium tabular-nums ${s.hv_rank >= 70 ? 'text-amber-400' : s.hv_rank >= 50 ? 'text-gray-300' : 'text-gray-500'}`}>{s.hv_rank}/100</span>
                        : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {s.consolidating
                        ? s.highly_recommended
                          ? <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-900 text-amber-200">★ Hi-Rec</span>
                          : <RankBadge rank={s.safety_rank} />
                        : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-400 max-w-[180px] truncate text-xs">{s.rank_reason || '—'}</td>
                    <td className="px-3 py-2 text-center">
                      {s.consolidating && (s.safety_rank === 1 || s.safety_rank === 2 || s.highly_recommended)
                        ? <button onClick={() => { setSymbolInput(s.symbol); fetchExpiries(s.symbol) }}
                            className="px-2 py-0.5 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded">Setup Fly</button>
                        : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Symbol input ── */}
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-white font-semibold">Fly Setup</h2>
          {activeSymbol && (
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-xs">Showing: <span className="text-white font-medium">{activeSymbol}</span></span>
              <button onClick={refreshPrices} disabled={refreshing || loadingSetup || !flySetup}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs rounded flex items-center gap-1.5 transition-colors">
                <span className={refreshing ? 'animate-spin inline-block' : ''}>↻</span>
                {refreshing ? 'Refreshing…' : 'Refresh Prices'}
              </button>
            </div>
          )}
        </div>
        <NseStockSearch
          placeholder="Search any NSE F&O stock (e.g. SBIN, INFY, RELIANCE…)"
          onSelect={(sym) => { setSymbolInput(sym); fetchExpiries(sym) }}
        />

        {/* Expiry picker */}
        {expiries.length > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-gray-400 text-xs font-medium">Expiry:</span>
            {expiries.slice(0, 3).map(e => (
              <button key={e.expiry} onClick={() => changeExpiry(e.expiry)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${selectedExpiry === e.expiry ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'}`}>
                {e.expiry}
                <span className={`ml-1 ${e.dte < 30 ? 'text-amber-400' : 'text-gray-400'}`}>({e.dte}d)</span>
              </button>
            ))}
            {loadingSetup && <span className="text-gray-400 text-xs animate-pulse">Fetching…</span>}
          </div>
        )}
        {loadingExpiries && <p className="mt-2 text-amber-400 text-sm animate-pulse">Loading expiries…</p>}
      </div>

      {setupError && <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl p-4 text-sm">{setupError}</div>}

      {/* ── Fly setup card ── */}
      {flySetup && !flySetup.error && (
        <div className="space-y-4">
          {flySetup.dte_warning && (
            <div className="bg-amber-900/30 border border-amber-700 text-amber-300 rounded-xl px-4 py-2 text-sm">⚠ {flySetup.dte_warning}</div>
          )}

          {/* Header */}
          <div className="bg-gray-800 rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-4">
              {[['Symbol', flySetup.symbol], ['CMP', `₹${flySetup.spot.toLocaleString()}`], ['Expiry', flySetup.expiry],
                ['DTE', `${flySetup.dte}d`], ['ATM IV', `${flySetup.atm_iv}%`],
                ['1SD', `±₹${flySetup.sd_move.toFixed(1)}`], ['Lot', `${flySetup.lot_size}`]
              ].map(([l, v]) => (
                <div key={l}><div className="text-gray-400 text-xs">{l}</div><div className="text-white font-semibold text-sm">{v}</div></div>
              ))}
              <div className="ml-auto"><SourceBadge source={flySetup.source} /></div>
            </div>
            {/* Return metrics */}
            <div className="mt-3 flex flex-wrap gap-3 border-t border-gray-700 pt-3">
              <div className={`flex items-center rounded-lg px-3 py-2 ${flySetup.return_pct >= 2 ? 'bg-green-900/30 border border-green-700' : 'bg-gray-700/40'}`}>
                <div>
                  <div className="text-gray-400 text-xs">Credit Yield</div>
                  <div className={`font-bold text-sm ${flySetup.return_pct >= 2 ? 'text-green-400' : 'text-gray-300'}`}>
                    {flySetup.return_pct.toFixed(2)}% of spot{flySetup.return_pct >= 2 && <span className="ml-1 text-xs text-green-300">✓ 2% target</span>}
                  </div>
                </div>
              </div>
              <div className={`flex items-center rounded-lg px-3 py-2 ${flySetup.est_5d_theta_pct >= 1.5 ? 'bg-blue-900/30 border border-blue-700' : 'bg-gray-700/40'}`}>
                <div>
                  <div className="text-gray-400 text-xs">Est. 5-day Theta</div>
                  <div className={`font-bold text-sm ${flySetup.est_5d_theta_pct >= 1.5 ? 'text-blue-400' : 'text-gray-300'}`}>~{flySetup.est_5d_theta_pct.toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* Naked position + strike pickers */}
          <div className="bg-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-white font-semibold flex items-center gap-2">
                Naked Position
                {flySetup.premium_diff_pct > 10 && (
                  <span className="text-xs bg-amber-900 text-amber-300 px-2 py-0.5 rounded">Premium gap {flySetup.premium_diff_pct.toFixed(1)}%</span>
                )}
              </h3>
              {/* Apply strikes button shows when overrides differ from current */}
              {(peStrike !== flySetup.sell_pe.strike || ceStrike !== flySetup.sell_ce.strike) && peStrike && ceStrike && (
                <button onClick={applyStrikes} disabled={loadingSetup}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded font-medium">
                  Recalculate with new strikes
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-700">
                    <th className="px-3 py-2 text-left">Action</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-center">Strike</th>
                    <th className="px-3 py-2 text-right">Premium</th>
                    <th className="px-3 py-2 text-right">Position Δ</th>
                    <th className="px-3 py-2 text-right">Vol</th>
                    <th className="px-3 py-2 text-right">OI</th>
                    <th className="px-3 py-2 text-center">Liq</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-700/50">
                    <td className="px-3 py-2 text-red-400 font-medium">SELL</td>
                    <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded font-medium bg-rose-900 text-rose-300">PE</span></td>
                    <td className="px-3 py-2">
                      {peStrike != null && (flySetup.put_strikes?.length ?? 0) > 0
                        ? <StrikeSelect value={peStrike} options={flySetup.put_strikes} onChange={setPeStrike} />
                        : <span className="text-white font-medium">₹{flySetup.sell_pe.strike}</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-green-400 font-medium">₹{flySetup.sell_pe.premium}</td>
                    <td className="px-3 py-2 text-right text-emerald-400">+{flySetup.sell_pe.delta.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{flySetup.sell_pe.volume.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{flySetup.sell_pe.oi.toLocaleString()}</td>
                    <td className="px-3 py-2 text-center"><LiqDot ok={flySetup.sell_pe.liq_ok} /></td>
                  </tr>
                  <tr className="border-b border-gray-700/50">
                    <td className="px-3 py-2 text-red-400 font-medium">SELL</td>
                    <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded font-medium bg-sky-900 text-sky-300">CE</span></td>
                    <td className="px-3 py-2">
                      {ceStrike != null && (flySetup.call_strikes?.length ?? 0) > 0
                        ? <StrikeSelect value={ceStrike} options={flySetup.call_strikes} onChange={setCeStrike} />
                        : <span className="text-white font-medium">₹{flySetup.sell_ce.strike}</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-green-400 font-medium">₹{flySetup.sell_ce.premium}</td>
                    <td className="px-3 py-2 text-right text-rose-400">-{flySetup.sell_ce.delta.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{flySetup.sell_ce.volume.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{flySetup.sell_ce.oi.toLocaleString()}</td>
                    <td className="px-3 py-2 text-center"><LiqDot ok={flySetup.sell_ce.liq_ok} /></td>
                  </tr>
                  <tr className="bg-gray-700/30">
                    <td colSpan={3} className="px-3 py-2 text-gray-300 font-medium text-sm">Net Credit (1 lot)</td>
                    <td className="px-3 py-2 text-right text-green-400 font-bold">₹{flySetup.net_credit.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-300 text-sm">{flySetup.net_delta >= 0 ? '+' : ''}{flySetup.net_delta.toFixed(3)}</td>
                    <td colSpan={3} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Hedges */}
          <div className="bg-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold mb-1">Proposed Hedges</h3>
            <p className="text-gray-400 text-xs mb-4">Optional — toggle to include in summary.</p>
            <div className={`rounded-lg border p-4 mb-3 transition-colors ${hedgeAEnabled ? 'border-blue-600 bg-blue-900/20' : 'border-gray-700 bg-gray-700/30'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-white font-medium text-sm mb-1">Hedge A — Iron Fly <span className="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded ml-1">Caps Loss</span></div>
                  <div className="text-gray-400 text-xs space-y-0.5 mt-1">
                    <div>Buy PE @ ₹{flySetup.hedge_iron_fly.buy_pe_strike} · ₹{flySetup.hedge_iron_fly.buy_pe_premium}</div>
                    <div>Buy CE @ ₹{flySetup.hedge_iron_fly.buy_ce_strike} · ₹{flySetup.hedge_iron_fly.buy_ce_premium}</div>
                    <div className="text-amber-400">Debit: ₹{flySetup.hedge_iron_fly.hedge_debit.toLocaleString()} per lot</div>
                    {flySetup.hedge_iron_fly.capped_max_loss != null && <div className="text-red-400">Max loss capped: ₹{flySetup.hedge_iron_fly.capped_max_loss.toLocaleString()}</div>}
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={hedgeAEnabled} onChange={e => setHedgeAEnabled(e.target.checked)} className="w-4 h-4 accent-blue-500" />
                  <span className="text-gray-400 text-xs">Include</span>
                </label>
              </div>
            </div>
            {flySetup.hedge_stock.side !== 'NONE' && (
              <div className={`rounded-lg border p-4 transition-colors ${hedgeBEnabled ? 'border-purple-600 bg-purple-900/20' : 'border-gray-700 bg-gray-700/30'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-white font-medium text-sm mb-1">Hedge B — Stock Delta <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded ml-1">Flattens Δ</span></div>
                    <div className="text-gray-400 text-xs space-y-0.5 mt-1">
                      <div>{flySetup.hedge_stock.side} {flySetup.hedge_stock.shares} shares @ ₹{flySetup.spot.toLocaleString()}</div>
                      <div className="text-amber-400">Capital: ₹{flySetup.hedge_stock.value.toLocaleString()}</div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={hedgeBEnabled} onChange={e => setHedgeBEnabled(e.target.checked)} className="w-4 h-4 accent-purple-500" />
                    <span className="text-gray-400 text-xs">Include</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Summary + Place Order */}
          {summary && (
            <div className="bg-gray-800 rounded-xl p-4">
              <h3 className="text-white font-semibold mb-3">Position Summary</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-2">
                {[
                  { label: 'Net Credit', value: `₹${summary.netTotal.toLocaleString()}`, cls: 'text-green-400' },
                  { label: 'Net Δ', value: `${summary.netDelta >= 0 ? '+' : ''}${summary.netDelta.toFixed(3)}`, cls: 'text-gray-300' },
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
              <p className="text-gray-500 text-xs text-center">Informational only. Use the button below to place orders.</p>
            </div>
          )}

          {/* ── Place Order CTA ── */}
          {flySetup && (
            <div className="bg-gradient-to-r from-green-900/40 to-emerald-900/40 border border-green-700 rounded-xl p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="text-white font-semibold text-base mb-1">Ready to trade?</div>
                  <div className="text-gray-300 text-sm">
                    SELL {flySetup.symbol} PE@{peStrike ?? flySetup.sell_pe.strike} + CE@{ceStrike ?? flySetup.sell_ce.strike} · {flySetup.expiry}
                  </div>
                  <div className="text-gray-400 text-xs mt-1">
                    Net credit ~₹{flySetup.net_credit.toLocaleString()} / lot · Monitor runs automatically after placement
                  </div>
                </div>
                <button
                  onClick={() => { setLots(1); setOrderError(''); setShowOrderModal(true) }}
                  className="shrink-0 px-6 py-3 bg-green-600 hover:bg-green-500 text-white text-sm font-bold rounded-lg shadow-lg shadow-green-900/50 transition-all hover:shadow-green-800/70 flex items-center gap-2"
                >
                  🚀 Place Order via Angel One
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Closed positions ── */}
      {closedPositions.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-4">
          <h3 className="text-gray-400 font-medium text-sm mb-3">Closed Positions</h3>
          <div className="space-y-2">
            {closedPositions.slice(-5).reverse().map(p => (
              <div key={p.id} className="flex items-center justify-between text-xs text-gray-500 border-b border-gray-700 pb-1">
                <span>{p.symbol} | {p.expiry} | PE@{p.sell_pe.strike} CE@{p.sell_ce.strike}</span>
                <span className={p.mtm_pnl >= 0 ? 'text-green-500' : 'text-red-500'}>₹{p.mtm_pnl?.toLocaleString()}</span>
                <span>{p.exit_reason || 'Closed'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Order modal ── */}
      {showOrderModal && flySetup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl p-6 max-w-md w-full space-y-4">
            <h3 className="text-white font-bold text-lg">Confirm Fly Order</h3>
            <div className="bg-gray-700 rounded-lg p-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-gray-400">Symbol</span><span className="text-white font-medium">{flySetup.symbol}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Expiry</span><span className="text-white">{flySetup.expiry}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">SELL PE</span><span className="text-rose-300">₹{flySetup.sell_pe.strike} @ ₹{flySetup.sell_pe.premium}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">SELL CE</span><span className="text-sky-300">₹{flySetup.sell_ce.strike} @ ₹{flySetup.sell_ce.premium}</span></div>
              <div className="flex justify-between border-t border-gray-600 pt-1.5"><span className="text-gray-400">Net Credit / lot</span><span className="text-green-400 font-bold">₹{flySetup.net_credit.toLocaleString()}</span></div>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-gray-300 text-sm">Lots:</label>
              <div className="flex items-center gap-2">
                <button onClick={() => setLots(l => Math.max(1, l - 1))} className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white">−</button>
                <span className="text-white font-medium w-8 text-center">{lots}</span>
                <button onClick={() => setLots(l => l + 1)} className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white">+</button>
              </div>
              <span className="text-gray-400 text-xs">= ₹{r2(flySetup.net_credit * lots).toLocaleString()} total credit</span>
            </div>
            <div className="bg-amber-900/30 border border-amber-700 text-amber-300 text-xs rounded-lg p-3">
              Auto-monitor active: AI will alert you at 2% MTM gain and auto-exit at 50% of target credit captured. Loss warning at 150%.
            </div>
            {orderError && <div className="text-red-400 text-sm">{orderError}</div>}
            <div className="flex gap-3">
              <button onClick={() => setShowOrderModal(false)} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm">Cancel</button>
              <button onClick={placeOrder} disabled={placingOrder}
                className="flex-1 py-2 bg-green-600 hover:bg-green-500 disabled:bg-green-800 text-white rounded text-sm font-medium">
                {placingOrder ? 'Placing…' : 'Confirm & Place'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Position card ─────────────────────────────────────────────────────────────

function PositionCard({ pos, onClose, closingId }: { pos: FlyPosition; onClose: (id: string) => void; closingId: string | null }) {
  const pct = pos.pct_of_target ?? 0
  const positionPct = pos.mtm_pct_of_position ?? 0
  const isProfit = pos.mtm_pnl >= 0
  const barWidth = Math.min(Math.abs(pct), 100)
  const barColor = pct >= 50 ? 'bg-green-500' : pct >= 20 ? 'bg-blue-500' : pct >= 0 ? 'bg-gray-400' : 'bg-red-500'

  return (
    <div className={`bg-gray-800 rounded-xl p-4 border ${pct >= 50 ? 'border-green-700' : pct < -50 ? 'border-red-700' : 'border-gray-700'}`}>
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-white font-semibold">{pos.symbol} <span className="text-gray-400 text-sm font-normal">Naked Fly</span></div>
          <div className="text-gray-400 text-xs mt-0.5">
            PE@{pos.sell_pe.strike} · CE@{pos.sell_ce.strike} · {pos.expiry} · {pos.lots} lot{pos.lots !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`text-lg font-bold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
            {isProfit ? '+' : ''}₹{pos.mtm_pnl?.toLocaleString() ?? 0}
          </div>
          <button onClick={() => onClose(pos.id)} disabled={closingId === pos.id}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs rounded font-medium">
            {closingId === pos.id ? 'Closing…' : 'Close Position'}
          </button>
        </div>
      </div>

      {/* Progress bar toward 50% target */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>Target progress: {pct.toFixed(1)}% of max credit</span>
          <span className="text-gray-500">+{positionPct.toFixed(1)}% of position value</span>
        </div>
        <div className="h-2 bg-gray-700 rounded overflow-hidden">
          <div className={`h-full rounded transition-all ${barColor}`} style={{ width: `${barWidth}%` }} />
        </div>
        <div className="flex justify-between text-xs mt-1">
          <span className="text-gray-500">Entry ₹{pos.net_credit_total.toLocaleString()}</span>
          <span className={pct >= 50 ? 'text-green-400 font-medium' : 'text-gray-500'}>50% = ₹{r2(pos.net_credit_total * 0.5).toLocaleString()}</span>
        </div>
      </div>

      {/* Current prices */}
      <div className="flex gap-4 text-xs text-gray-400">
        <div>PE: <span className="text-white">₹{pos.current_pe_ltp?.toFixed(2)}</span> <span className="text-gray-600">(entry ₹{pos.sell_pe.entry_premium})</span></div>
        <div>CE: <span className="text-white">₹{pos.current_ce_ltp?.toFixed(2)}</span> <span className="text-gray-600">(entry ₹{pos.sell_ce.entry_premium})</span></div>
        <div className="ml-auto text-gray-600">checked {pos.last_checked ? new Date(pos.last_checked).toLocaleTimeString() : '—'}</div>
      </div>
    </div>
  )
}

function r2(n: number) { return Math.round(n * 100) / 100 }
