/**
 * Cushion Strangle — two modes:
 *   Stock: Buy 25% shares (cushion) + Sell 1 CE + 1 PE at Δ0.20, 35-40 DTE
 *          Adjust at 1SD, exit CE at Δ0.50
 *   Index Futures: Buy 1 Futures lot + Sell 2 CE + 2 PE at Δ0.20, 35-40 DTE
 *                  Exit CE at Δ0.50; no adjustments (set-and-forget)
 */

import { useState } from 'react'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'
import {
  ComposedChart, Line, Area, ReferenceLine, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Label,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChartPoint { price: number; stage1: number; stage2: number | null; opt: number }

interface AnalysisResult {
  symbol: string; cmp: number; lot_size: number; iv: number; dte: number; sigma_pct: number
  instrument_type: 'stock' | 'future'
  ce_lots: number; pe_lots: number
  ce_strike: number; pe_strike: number; ce_premium: number; pe_premium: number
  ce_delta: number; pe_delta: number; ce_income: number; pe_income: number
  total_income: number; daily_theta: number
  sd1_up: number; sd1_down: number; init_shares: number; add_shares: number
  share_capital: number; add_capital: number; total_capital: number
  be_down: number; be_up: number; max_profit: number; ce_exit_price: number
  // Scenario analysis
  p_in_range: number; p_below_pe: number; p_above_ce: number
  ref_neutral: number; ref_bearish: number; ref_bullish: number
  pnl_neutral: number; pnl_bearish: number; pnl_bullish: number
  pnl_at_pe_k: number; pnl_at_ce_k: number
  // Management scenarios
  avg_cost_s2: number | null
  pnl_s2_at_pe: number | null; pnl_s2_at_cmp: number | null; pnl_s2_deep: number | null
  ce_buyback: number; pe_close_val: number; eq_at_exit: number; net_ce_exit: number
  chart_data: ChartPoint[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number, dec = 0) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })

const fmtRs = (n: number, dec = 0) => `₹${fmt(n, dec)}`

function MetricCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-[#0d1425] border border-[#1e2d40] rounded-xl p-3">
      <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-bold ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CushionStrangle() {
  const [symbol, setSymbol]             = useState('INFY.NS')
  const [symbolDisplay, setSymbolDisplay] = useState('INFY')
  const [isIndex, setIsIndex]           = useState(false)
  const [dte, setDte]                   = useState(37)
  const [targetDelta, setTargetDelta]   = useState(0.20)
  const [equityPct, setEquityPct]       = useState(0.25)
  const [ivOverride, setIvOverride]     = useState<string>('')
  const [loading, setLoading]           = useState(false)
  const [result, setResult]             = useState<AnalysisResult | null>(null)
  const [error, setError]               = useState<string | null>(null)
  const [selectedScenarioId, setSelectedScenarioId] = useState('flat')

  function handleStockSelect(sym: string, _name: string) {
    setSymbol(sym)
    const display = sym.replace(/^\^/, '').replace(/\.NS$/, '').replace(/\.BO$/, '')
    setSymbolDisplay(display)
    const idx = sym.startsWith('^') || sym.toUpperCase().includes('NIFTY_FIN_SERVICE')
    setIsIndex(idx)
    setResult(null)
  }

  async function analyze() {
    setLoading(true); setError(null)
    try {
      const r = await client.post('/cushion-strangle/analyze', {
        symbol,
        instrument_type: isIndex ? 'future' : 'stock',
        dte,
        target_delta:   targetDelta,
        equity_pct:     equityPct,
        add_equity_pct: equityPct,
        iv_override:    ivOverride ? parseFloat(ivOverride) : null,
      })
      setResult(r.data)
    } catch (e: any) {
      setError(e.response?.data?.error ?? 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  // ── Chart setup ────────────────────────────────────────────────────────────
  const refLineStyle = { strokeDasharray: '4 3', strokeWidth: 1.5, opacity: 0.85 }
  const isFutures    = result?.instrument_type === 'future'

  const chartData = result?.chart_data?.map(d => ({
    ...d,
    profit1: d.stage1 >= 0 ? d.stage1 : 0,
    loss1:   d.stage1 <  0 ? d.stage1 : 0,
  })) ?? []

  const yDomain: [number, number] = (() => {
    if (!chartData.length) return [-50000, 50000]
    const vals = chartData.flatMap(d => [d.stage1, ...(d.stage2 != null ? [d.stage2] : [])])
    const mn = Math.min(...vals); const mx = Math.max(...vals)
    const pad = (mx - mn) * 0.12
    return [Math.floor((mn - pad) / 1000) * 1000, Math.ceil((mx + pad) / 1000) * 1000]
  })()

  // ── Custom tooltip (closure over result) ──────────────────────────────────
  const PayoffTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const s1  = payload.find((p: any) => p.dataKey === 'stage1')?.value
    const s2  = payload.find((p: any) => p.dataKey === 'stage2')?.value
    const opt = payload.find((p: any) => p.dataKey === 'opt')?.value
    const pnlColor = (v: number) => v >= 0 ? 'text-emerald-400' : 'text-red-400'
    return (
      <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-3 text-xs shadow-xl">
        <div className="text-slate-400 mb-2 font-medium">At expiry: <span className="text-white font-bold">{fmtRs(label)}</span></div>
        {s1 != null && (
          <div className="flex justify-between gap-6 mb-1">
            <span className="text-blue-400">
              {isFutures ? '● Futures + Strangle' : `● Stage 1 (${result?.init_shares} shares)`}
            </span>
            <span className={`font-bold ${pnlColor(s1)}`}>{s1 >= 0 ? '+' : ''}{fmtRs(s1)}</span>
          </div>
        )}
        {!isFutures && s2 != null && (
          <div className="flex justify-between gap-6 mb-1">
            <span className="text-violet-400">● Stage 2 (+{result?.add_shares} shares)</span>
            <span className={`font-bold ${pnlColor(s2)}`}>{s2 >= 0 ? '+' : ''}{fmtRs(s2)}</span>
          </div>
        )}
        {opt != null && (
          <div className="flex justify-between gap-6 border-t border-[#1e2d40] pt-1 mt-1">
            <span className="text-slate-400">Options only</span>
            <span className={pnlColor(opt)}>{opt >= 0 ? '+' : ''}{fmtRs(opt)}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Cushion Strangle 🛡️</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          {isIndex
            ? 'Index Futures mode: Buy 1 futures lot · Sell 2× CE + 2× PE at Δ0.20 · Exit CE at Δ0.50'
            : 'Buy 25% shares (cushion) · Sell OTM CE + PE at Δ0.20 · Add shares at 1SD · Exit CE at Δ0.50'}
        </p>
      </div>

      {/* Setup form */}
      <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4 mb-6">
        <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-3">Strategy Setup</div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">

          {/* Symbol search (3-char autocomplete) */}
          <div className="col-span-2">
            <label className="text-[10px] text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-1">
              Symbol
              {symbolDisplay && (
                <span className="bg-[#0d1425] border border-[#1e2d40] text-white text-[11px] font-bold px-2 py-0.5 rounded normal-case">
                  {symbolDisplay}
                  {isIndex && <span className="ml-1 text-violet-400">· Futures</span>}
                </span>
              )}
            </label>
            <NseStockSearch
              includeEtfIndex={true}
              placeholder="Search stock or index (3+ chars)…"
              onSelect={handleStockSelect}
            />
          </div>

          {/* DTE */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">DTE ({dte} days)</label>
            <input type="range" min={28} max={45} value={dte} onChange={e => setDte(+e.target.value)}
              className="w-full mt-2 accent-blue-500" />
          </div>

          {/* Target Delta */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">Target Δ ({targetDelta.toFixed(2)})</label>
            <input type="range" min={0.10} max={0.30} step={0.01} value={targetDelta}
              onChange={e => setTargetDelta(parseFloat(e.target.value))}
              className="w-full mt-2 accent-violet-500" />
          </div>

          {/* Equity % (stock mode only) OR Futures badge */}
          {!isIndex ? (
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">Equity % ({(equityPct * 100).toFixed(0)}%)</label>
              <input type="range" min={0.10} max={0.40} step={0.05} value={equityPct}
                onChange={e => setEquityPct(parseFloat(e.target.value))}
                className="w-full mt-2 accent-emerald-500" />
            </div>
          ) : (
            <div className="flex items-center">
              <div className="bg-violet-950/40 border border-violet-800/40 rounded-lg px-3 py-2 w-full">
                <div className="text-[10px] text-violet-400 uppercase tracking-wider">Mode</div>
                <div className="text-sm font-bold text-violet-300">Index Futures</div>
                <div className="text-[10px] text-slate-400">1 lot long · 2×CE + 2×PE short</div>
              </div>
            </div>
          )}

          {/* IV Override */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">IV Override (%)</label>
            <input type="number" placeholder="Auto" value={ivOverride}
              onChange={e => setIvOverride(e.target.value)} min={5} max={100} step={0.5}
              className="bg-[#0d1425] border border-[#1e2d40] text-white rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:border-blue-500" />
          </div>
        </div>

        <button onClick={analyze} disabled={loading || !symbol}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-5 py-2 rounded-lg transition-colors">
          {loading ? '⏳ Analysing…' : `⚡ Analyse ${symbolDisplay || 'Strategy'}`}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-800/50 text-red-300 text-sm rounded-xl p-3 mb-4">{error}</div>
      )}

      {result && (
        <>
          {/* ── Key metrics row ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
            <MetricCard label="CMP" value={fmtRs(result.cmp)} sub={`${result.symbol} · Lot ${result.lot_size}`} />
            <MetricCard label="IV Used" value={`${result.iv}%`} sub={`σ ${result.sigma_pct.toFixed(1)}%`} />
            <MetricCard
              label={`CE Strike${isFutures ? ' ×2' : ''}`}
              value={fmtRs(result.ce_strike)}
              sub={`Δ ${result.ce_delta} · Px ₹${result.ce_premium}`}
              color="text-emerald-400"
            />
            <MetricCard
              label={`PE Strike${isFutures ? ' ×2' : ''}`}
              value={fmtRs(result.pe_strike)}
              sub={`Δ ${result.pe_delta} · Px ₹${result.pe_premium}`}
              color="text-red-400"
            />
            <MetricCard
              label="Total Premium"
              value={fmtRs(result.total_income)}
              sub={isFutures
                ? `₹${result.ce_income} CE + ₹${result.pe_income} PE (2 lots each)`
                : `₹${result.ce_income} CE + ₹${result.pe_income} PE`}
              color="text-emerald-400"
            />
            <MetricCard label="Daily Θ Gain" value={fmtRs(result.daily_theta)}
              sub={`over ${result.dte} days`} color="text-amber-400" />
            <MetricCard
              label="Capital Req."
              value={fmtRs(result.total_capital)}
              sub={isFutures ? 'Futures + 4 lots margin' : `${result.init_shares} shares + margins`}
            />
          </div>

          {/* ── Payoff Chart ──────────────────────────────────────────────── */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm font-semibold text-white">Payoff at Expiry</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {isFutures
                    ? `1 futures lot (${result.lot_size} units) · 2× CE + 2× PE lots`
                    : `Stage 1 = ${result.init_shares} shares · Stage 2 = ${result.init_shares + result.add_shares} shares (added at 1SD ↓)`}
                </div>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-slate-500">
                <span><span className="text-blue-400">●</span> {isFutures ? 'Futures + Strangle' : 'Stage 1'}</span>
                {!isFutures && <span><span className="text-violet-400">●</span> Stage 2</span>}
                <span><span className="text-slate-500">●</span> Options only</span>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={380}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 24, bottom: 24, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d40" strokeOpacity={0.6} />
                <XAxis
                  dataKey="price"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#1e2d40' }}
                >
                  <Label value="Stock price at expiry" position="insideBottom" offset={-12} fill="#64748b" fontSize={11} />
                </XAxis>
                <YAxis
                  tickFormatter={v => v >= 0 ? `+₹${(v / 1000).toFixed(0)}k` : `-₹${(Math.abs(v) / 1000).toFixed(0)}k`}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#1e2d40' }}
                  domain={yDomain}
                >
                  <Label value="P&L (₹)" angle={-90} position="insideLeft" offset={12} fill="#64748b" fontSize={11} />
                </YAxis>
                <Tooltip content={<PayoffTooltip />} cursor={{ stroke: '#3b5270', strokeWidth: 1 }} />

                <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
                <Area dataKey="profit1" fill="#10b981" fillOpacity={0.10} stroke="none" legendType="none" tooltipType="none" />
                <Area dataKey="loss1"   fill="#ef4444" fillOpacity={0.10} stroke="none" legendType="none" tooltipType="none" />

                <ReferenceLine x={result.pe_strike} stroke="#f87171" {...refLineStyle}>
                  <Label value={`PE ₹${fmt(result.pe_strike)}`} position="insideTopRight" fill="#f87171" fontSize={10} offset={4} />
                </ReferenceLine>
                <ReferenceLine x={result.ce_strike} stroke="#34d399" {...refLineStyle}>
                  <Label value={`CE ₹${fmt(result.ce_strike)}`} position="insideTopLeft" fill="#34d399" fontSize={10} offset={4} />
                </ReferenceLine>
                <ReferenceLine x={result.cmp} stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3">
                  <Label value="CMP" position="insideTopRight" fill="#f59e0b" fontSize={10} offset={4} />
                </ReferenceLine>

                {!isFutures && (
                  <ReferenceLine x={result.sd1_down} stroke="#a78bfa" {...refLineStyle}>
                    <Label value={`1SD↓ ₹${fmt(result.sd1_down)} +${result.add_shares}sh`}
                      position="insideTopLeft" fill="#a78bfa" fontSize={10} offset={4} />
                  </ReferenceLine>
                )}
                <ReferenceLine x={result.sd1_up} stroke="#a78bfa" {...refLineStyle}>
                  <Label value={`1SD↑ ₹${fmt(result.sd1_up)}`}
                    position="insideTopRight" fill="#a78bfa" fontSize={10} offset={4} />
                </ReferenceLine>

                <ReferenceLine x={result.be_down} stroke="#64748b" strokeWidth={1} strokeDasharray="2 4">
                  <Label value={`BE ₹${fmt(result.be_down)}`} position="insideTopLeft" fill="#64748b" fontSize={9} offset={4} />
                </ReferenceLine>
                <ReferenceLine x={result.be_up} stroke="#64748b" strokeWidth={1} strokeDasharray="2 4">
                  <Label value={`BE ₹${fmt(result.be_up)}`} position="insideTopRight" fill="#64748b" fontSize={9} offset={4} />
                </ReferenceLine>

                <Line dataKey="opt"    dot={false} strokeWidth={1.5} stroke="#64748b" strokeDasharray="4 3" name="Options only" legendType="none" />
                <Line dataKey="stage1" dot={false} strokeWidth={2.5} stroke="#3b82f6" name={isFutures ? 'Futures + Strangle' : 'Stage 1'} strokeLinejoin="round" />
                {!isFutures && (
                  <Line dataKey="stage2" dot={false} strokeWidth={2} stroke="#8b5cf6" strokeDasharray="5 3" name="Stage 2" strokeLinejoin="round" />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── Scenario P&L Breakdown ────────────────────────────────────── */}
          {(() => {
            // ── Scenario definitions ─────────────────────────────────────────
            interface ScenarioDef {
              id: string; label: string; price: number
              prob: number | null; probLabel: string
              isMidCycle: boolean; addShares: boolean; description: string
            }
            const scenarios: ScenarioDef[] = [
              { id: 'flat',        label: `📊  Flat — CMP ${fmtRs(result.cmp)}`,                   price: result.cmp,           prob: result.p_in_range, probLabel: 'price stays in range',   isMidCycle: false, addShares: false, description: `Both options expire worthless · keep full premium` },
              { id: 'range_top',   label: `📈  Range top — CE strike ${fmtRs(result.ce_strike)}`,  price: result.ce_strike,     prob: result.p_in_range, probLabel: 'price stays in range',   isMidCycle: false, addShares: false, description: `Price at CE strike at expiry · CE at ATM (zero intrinsic) · PE expires worthless` },
              { id: 'range_floor', label: `📉  Range floor — PE strike ${fmtRs(result.pe_strike)}`,price: result.pe_strike,     prob: result.p_in_range, probLabel: 'price stays in range',   isMidCycle: false, addShares: false, description: `Price at PE strike at expiry · CE expires worthless · PE at ATM (zero intrinsic)` },
              { id: 'bearish',     label: `📉  Bearish — Below PE ${fmtRs(result.ref_bearish)}`,   price: result.ref_bearish,   prob: result.p_below_pe, probLabel: 'price below PE at expiry',isMidCycle: false, addShares: false, description: `Price at ${fmtRs(result.ref_bearish)} at expiry · both CE worthless · PE deep ITM` },
              { id: 'bullish',     label: `📈  Bullish — Above CE ${fmtRs(result.ref_bullish)}`,   price: result.ref_bullish,   prob: result.p_above_ce, probLabel: 'price above CE at expiry',isMidCycle: false, addShares: false, description: `Price at ${fmtRs(result.ref_bullish)} at expiry · CE deep ITM · PE worthless` },
              { id: 'ce_exit',     label: `⚡  CE Δ0.50 exit — ${fmtRs(result.ce_exit_price)}`,   price: result.ce_exit_price, prob: result.p_above_ce, probLabel: 'exit mid-cycle at Δ0.50', isMidCycle: true,  addShares: false, description: `CE delta hits 0.50 — exit all positions · ~${Math.round(result.dte * 0.35)} DTE remaining` },
              ...(!isFutures && result.avg_cost_s2 != null ? [
                { id: 's2_recover', label: `📉+📈  Add shares → recover to CMP`,                 price: result.cmp,           prob: null, probLabel: 'after 1SD add-shares triggered', isMidCycle: false, addShares: true, description: `Add ${result.add_shares} shares at ${fmtRs(result.sd1_down)} · stock recovers to CMP at expiry` },
                { id: 's2_pe',      label: `📉+⚠️  Add shares → assigned at PE`,                 price: result.pe_strike,     prob: null, probLabel: 'after 1SD add-shares triggered', isMidCycle: false, addShares: true, description: `Add ${result.add_shares} shares at ${fmtRs(result.sd1_down)} · stock below PE at expiry → assignment` },
                { id: 's2_deep',    label: `📉+📉  Add shares → deep fall`,                      price: result.ref_bearish,   prob: null, probLabel: 'after 1SD add-shares triggered', isMidCycle: false, addShares: true, description: `Add ${result.add_shares} shares at ${fmtRs(result.sd1_down)} · stock continues to ${fmtRs(result.ref_bearish)} · worst case` },
              ] : []),
            ]

            const sc = scenarios.find(s => s.id === selectedScenarioId) ?? scenarios[0]
            const lot  = result.lot_size
            const nL   = result.ce_lots

            // ── Breakdown computation ────────────────────────────────────────
            let sharesLabel: string, sharesReceived: number, sharesPaid: number
            let sharesRecNote: string, sharesPaidNote: string

            if (sc.isMidCycle) {
              const qty = isFutures ? lot : result.init_shares
              sharesLabel      = isFutures ? `Futures (${lot} units)` : `Shares (${result.init_shares} sh)`
              sharesReceived   = qty * sc.price
              sharesPaid       = qty * result.cmp
              sharesRecNote    = `sold / settled at ${fmtRs(sc.price)}`
              sharesPaidNote   = `${isFutures ? 'entered' : 'bought'} at ${fmtRs(result.cmp)}`
            } else if (isFutures) {
              sharesLabel      = `Futures (${lot} units)`
              sharesReceived   = lot * sc.price
              sharesPaid       = lot * result.cmp
              sharesRecNote    = `settlement at ${fmtRs(sc.price)}`
              sharesPaidNote   = `entered at ${fmtRs(result.cmp)}`
            } else if (sc.addShares) {
              const totalSh    = result.init_shares + result.add_shares
              sharesLabel      = `Shares (${result.init_shares}+${result.add_shares} sh)`
              sharesReceived   = totalSh * sc.price
              sharesPaid       = result.init_shares * result.cmp + result.add_shares * result.sd1_down
              sharesRecNote    = `${totalSh} sh sold at ${fmtRs(sc.price)}`
              sharesPaidNote   = `${result.init_shares}@${fmtRs(result.cmp)} + ${result.add_shares}@${fmtRs(result.sd1_down)}`
            } else {
              sharesLabel      = `Shares (${result.init_shares} sh)`
              sharesReceived   = result.init_shares * sc.price
              sharesPaid       = result.init_shares * result.cmp
              sharesRecNote    = `${result.init_shares} sh sold at ${fmtRs(sc.price)}`
              sharesPaidNote   = `bought at ${fmtRs(result.cmp)}`
            }
            const sharesPnl = sharesReceived - sharesPaid

            let ceReceived: number, cePaid: number, ceRecNote: string, cePaidNote: string
            let peReceived: number, pePaid: number, peRecNote: string, pePaidNote: string

            if (sc.isMidCycle) {
              ceReceived = result.ce_income;  cePaid = result.ce_buyback
              ceRecNote  = 'premium at entry'; cePaidNote = `buyback (${result.ce_lots} lot${result.ce_lots>1?'s':''})`
              peReceived = result.pe_income;  pePaid = result.pe_close_val
              peRecNote  = 'premium at entry'; pePaidNote = `close value (OTM residual)`
            } else {
              const ceIntr = Math.max(0, sc.price - result.ce_strike) * lot * nL
              const peIntr = Math.max(0, result.pe_strike - sc.price) * lot * nL
              ceReceived = result.ce_income;  cePaid = ceIntr
              ceRecNote  = 'premium collected'
              cePaidNote = ceIntr > 0
                ? `ITM: (${fmtRs(sc.price)}−${fmtRs(result.ce_strike)}) × ${lot * nL}`
                : 'expires worthless'
              peReceived = result.pe_income;  pePaid = peIntr
              peRecNote  = 'premium collected'
              pePaidNote = peIntr > 0
                ? `ITM: (${fmtRs(result.pe_strike)}−${fmtRs(sc.price)}) × ${lot * nL}`
                : 'expires worthless'
            }
            const ceNet = ceReceived - cePaid
            const peNet = peReceived - pePaid
            const total = sharesPnl + ceNet + peNet

            const rows = [
              { label: sharesLabel,                        received: sharesReceived, paid: sharesPaid, net: sharesPnl, recNote: sharesRecNote, paidNote: sharesPaidNote, color: 'text-blue-400' },
              { label: `CE ${fmtRs(result.ce_strike)} × ${nL} lot`, received: ceReceived,   paid: cePaid,    net: ceNet,    recNote: ceRecNote,    paidNote: cePaidNote,    color: 'text-emerald-400' },
              { label: `PE ${fmtRs(result.pe_strike)} × ${nL} lot`, received: peReceived,   paid: pePaid,    net: peNet,    recNote: peRecNote,    paidNote: pePaidNote,    color: 'text-red-400' },
            ]
            const maxAbs = Math.max(...rows.map(r => Math.abs(r.net)), 1)

            return (
              <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4 mb-6">
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <div className="text-xs font-semibold text-white">Scenario P&L Breakdown</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">Pick a scenario to see exactly what each component contributes</div>
                  </div>
                  {/* Probability pills */}
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: 'In range', prob: result.p_in_range, color: 'bg-emerald-950 border-emerald-800 text-emerald-400' },
                      { label: 'Below PE', prob: result.p_below_pe, color: 'bg-red-950 border-red-800 text-red-400' },
                      { label: 'Above CE', prob: result.p_above_ce, color: 'bg-amber-950 border-amber-800 text-amber-400' },
                    ].map(p => (
                      <div key={p.label} className={`border rounded-lg px-2 py-1 text-center ${p.color}`}>
                        <div className="text-base font-bold">{p.prob}%</div>
                        <div className="text-[9px]">{p.label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Dropdown */}
                <select
                  value={selectedScenarioId}
                  onChange={e => setSelectedScenarioId(e.target.value)}
                  className="w-full bg-[#0d1425] border border-[#1e2d40] text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500 mb-4"
                >
                  {scenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>

                {/* Scenario context bar */}
                <div className="bg-[#0d1425] rounded-lg px-4 py-3 mb-4 flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-300 leading-relaxed">{sc.description}</div>
                  <div className="text-right shrink-0">
                    {sc.prob != null
                      ? <><div className="text-lg font-bold text-white">{sc.prob}%</div><div className="text-[9px] text-slate-400">{sc.probLabel}</div></>
                      : <><div className="text-xs font-bold text-violet-400">Triggered</div><div className="text-[9px] text-slate-400">{sc.probLabel}</div></>}
                  </div>
                </div>

                {/* Breakdown table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#1e2d40]">
                        <th className="text-left py-2 pr-2 text-slate-400 font-medium w-[30%]">Component</th>
                        <th className="text-right py-2 px-2 font-medium w-[23%]"><span className="text-emerald-400">Received</span> <span className="text-slate-500 font-normal">(+)</span></th>
                        <th className="text-right py-2 px-2 font-medium w-[23%]"><span className="text-red-400">Paid</span> <span className="text-slate-500 font-normal">(−)</span></th>
                        <th className="text-right py-2 pl-2 text-slate-200 font-medium w-[24%]">Net Contribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.label} className="border-b border-[#1e2d40]/60 hover:bg-[#0d1425]/50 transition-colors">
                          <td className="py-3 pr-2">
                            <div className={`font-semibold ${row.color}`}>{row.label}</div>
                          </td>
                          <td className="py-3 px-2 text-right">
                            <div className="text-emerald-400 font-medium">+{fmtRs(row.received)}</div>
                            <div className="text-[9px] text-slate-500 mt-0.5">{row.recNote}</div>
                          </td>
                          <td className="py-3 px-2 text-right">
                            {row.paid > 0
                              ? <><div className="text-red-400 font-medium">−{fmtRs(row.paid)}</div><div className="text-[9px] text-slate-500 mt-0.5">{row.paidNote}</div></>
                              : <><div className="text-slate-500">₹0</div><div className="text-[9px] text-slate-500 mt-0.5">{row.paidNote}</div></>}
                          </td>
                          <td className="py-3 pl-2 text-right">
                            <div className={`text-base font-bold ${row.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.net >= 0 ? '+' : '−'}{fmtRs(Math.abs(row.net))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-600">
                        <td colSpan={3} className="pt-3 pb-1 pr-2 text-sm font-bold text-white">Total P&L</td>
                        <td className="pt-3 pb-1 pl-2 text-right">
                          <span className={`text-xl font-bold ${total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {total >= 0 ? '+' : '−'}{fmtRs(Math.abs(total))}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Contribution bar chart */}
                <div className="mt-4 pt-3 border-t border-[#1e2d40]">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Contribution by component</div>
                  <div className="space-y-2">
                    {rows.map(row => {
                      const pct = Math.abs(row.net) / maxAbs * 100
                      const isPos = row.net >= 0
                      return (
                        <div key={row.label} className="flex items-center gap-2">
                          <div className={`text-[10px] font-medium w-28 shrink-0 truncate ${row.color}`}>{row.label}</div>
                          <div className="flex-1 bg-[#0d1425] rounded-full h-5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${isPos ? 'bg-emerald-500/40' : 'bg-red-500/40'}`}
                              style={{ width: `${Math.max(pct, 2)}%` }}
                            />
                          </div>
                          <div className={`text-xs font-bold w-24 text-right shrink-0 ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.net >= 0 ? '+' : '−'}{fmtRs(Math.abs(row.net))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })()}


          {/* ── Two-panel: management rules + position details ────────────── */}          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">

            {/* Management Playbook */}
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-3">Management Playbook</div>
              <div className="space-y-3">

                {/* Step 1: Entry (both modes) */}
                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-900/60 border border-blue-700/50 flex items-center justify-center shrink-0 text-[10px] font-bold text-blue-300">1</div>
                  <div>
                    <div className="text-sm font-medium text-white">Entry</div>
                    {isFutures ? (
                      <div className="text-xs text-slate-400 mt-0.5">
                        Buy <strong className="text-white">1 {result.symbol} Futures lot</strong> at {fmtRs(result.cmp)}.
                        Sell <strong className="text-emerald-400">2× CE {fmtRs(result.ce_strike)}</strong> ({fmtRs(result.ce_premium, 2)}/sh)
                        + <strong className="text-red-400">2× PE {fmtRs(result.pe_strike)}</strong> ({fmtRs(result.pe_premium, 2)}/sh) · {result.dte} DTE.
                        Total premium: <strong className="text-emerald-400">{fmtRs(result.total_income)}</strong>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 mt-0.5">
                        Buy <strong className="text-white">{result.init_shares} shares</strong> at {fmtRs(result.cmp)}.
                        Sell <strong className="text-emerald-400">CE {fmtRs(result.ce_strike)}</strong> ({fmtRs(result.ce_premium, 2)}/sh)
                        + <strong className="text-red-400">PE {fmtRs(result.pe_strike)}</strong> ({fmtRs(result.pe_premium, 2)}/sh) · {result.dte} DTE
                      </div>
                    )}
                  </div>
                </div>

                {/* Step 2: stock mode → add shares; futures mode → CE management */}
                <div className="flex gap-3">
                  <div className={`w-6 h-6 rounded-full ${isFutures ? 'bg-emerald-900/60 border-emerald-700/50' : 'bg-violet-900/60 border-violet-700/50'} border flex items-center justify-center shrink-0 text-[10px] font-bold ${isFutures ? 'text-emerald-300' : 'text-violet-300'}`}>2</div>
                  <div>
                    {isFutures ? (
                      <>
                        <div className="text-sm font-medium text-white">CE exit — if index rallies</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          If CE delta ≥ 0.50 (near <strong className="text-emerald-400">{fmtRs(result.ce_exit_price)}</strong>),
                          buy back <strong className="text-white">both 2 CE lots</strong> immediately.
                          Futures gains help offset the buyback cost.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-medium text-white">Adjustment — stock falls to 1SD</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          If price drops to <strong className="text-violet-400">{fmtRs(result.sd1_down)}</strong>,
                          add <strong className="text-white">{result.add_shares} more shares</strong> ({fmtRs(result.add_capital)} approx).
                          Now holding {result.init_shares + result.add_shares} shares. Average cost reduces.
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex gap-3">
                  <div className={`w-6 h-6 rounded-full ${isFutures ? 'bg-red-900/60 border-red-700/50' : 'bg-amber-900/60 border-amber-700/50'} border flex items-center justify-center shrink-0 text-[10px] font-bold ${isFutures ? 'text-red-300' : 'text-amber-300'}`}>3</div>
                  <div>
                    {isFutures ? (
                      <>
                        <div className="text-sm font-medium text-white">PE side — if index declines</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          If index drops below <strong className="text-red-400">{fmtRs(result.pe_strike)}</strong>,
                          consider closing both PE lots to cap loss. Index options are <strong className="text-white">cash-settled</strong> — no assignment risk.
                          Futures loss partially offsets PE gain.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-medium text-white">CE exit — delta reaches 0.50</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          If stock rises and CE delta ≥ 0.50 (near <strong className="text-emerald-400">{fmtRs(result.ce_exit_price)}</strong>),
                          buy back CE immediately. The {result.init_shares + result.add_shares} shares held provide a natural cushion.
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Step 4 */}
                {!isFutures && (
                  <div className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-red-900/60 border border-red-700/50 flex items-center justify-center shrink-0 text-[10px] font-bold text-red-300">4</div>
                    <div>
                      <div className="text-sm font-medium text-white">Assignment — PE in-the-money at expiry</div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        If stock expires below <strong className="text-red-400">{fmtRs(result.pe_strike)}</strong>,
                        you get assigned the remaining {result.lot_size - result.init_shares - result.add_shares} shares
                        at {fmtRs(result.pe_strike)}. You now hold a full lot at a discounted average.
                      </div>
                    </div>
                  </div>
                )}

                {/* Last step: profit target */}
                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-emerald-900/60 border border-emerald-700/50 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-300">{isFutures ? 4 : 5}</div>
                  <div>
                    <div className="text-sm font-medium text-white">Profit target — both options expire worthless</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {isFutures
                        ? <>If index stays between {fmtRs(result.pe_strike)}–{fmtRs(result.ce_strike)}, keep full premium <strong className="text-emerald-400">{fmtRs(result.total_income)}</strong> + futures P&amp;L. Book at 75% = {fmtRs(result.total_income * 0.75)}. Then roll: close futures and re-enter next month.</>
                        : <>If price stays between {fmtRs(result.pe_strike)}–{fmtRs(result.ce_strike)} at expiry, keep full premium <strong className="text-emerald-400">{fmtRs(result.total_income)}</strong>. Book at 75% = {fmtRs(result.total_income * 0.75)}.</>}
                    </div>
                  </div>
                </div>

              </div>
            </div>

            {/* Position Summary */}
            <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-3">Position Summary</div>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-[#1e2d40]">
                  {(isFutures ? [
                    ['Lot Size',             `${result.lot_size} units`],
                    ['Futures Position',     `Long 1 lot @ ${fmtRs(result.cmp)}`],
                    ['Short CE (2 lots)',    `${fmtRs(result.ce_strike)} · Δ ${result.ce_delta} · ${fmtRs(result.ce_income)}`],
                    ['Short PE (2 lots)',    `${fmtRs(result.pe_strike)} · Δ ${result.pe_delta} · ${fmtRs(result.pe_income)}`],
                    ['Net Premium Collected',fmtRs(result.total_income)],
                    ['Daily Theta Gain',     fmtRs(result.daily_theta)],
                    ['Futures Margin',       fmtRs(result.share_capital)],
                    ['Options Margin',       fmtRs(result.total_capital - result.share_capital)],
                    ['Total Capital Req.',   fmtRs(result.total_capital)],
                    ['Breakeven (Downside)', fmtRs(result.be_down)],
                    ['Breakeven (Upside)',   fmtRs(result.be_up)],
                    ['1σ Range',             `${fmtRs(result.sd1_down)} – ${fmtRs(result.sd1_up)}`],
                  ] : [
                    ['Lot Size',             `${result.lot_size} shares`],
                    ['Initial Shares (25%)', `${result.init_shares} @ ${fmtRs(result.cmp)}`],
                    ['Add Shares (25%)',     `${result.add_shares} @ ~${fmtRs(result.sd1_down)} (if triggered)`],
                    ['Short CE',             `${fmtRs(result.ce_strike)} · Δ ${result.ce_delta} · ${fmtRs(result.ce_income)}`],
                    ['Short PE',             `${fmtRs(result.pe_strike)} · Δ ${result.pe_delta} · ${fmtRs(result.pe_income)}`],
                    ['Net Premium Collected',fmtRs(result.total_income)],
                    ['Daily Theta Gain',     fmtRs(result.daily_theta)],
                    ['Share Capital (Entry)', fmtRs(result.share_capital)],
                    ['Margin Required',      fmtRs(result.total_capital - result.share_capital)],
                    ['Total Capital Req.',   fmtRs(result.total_capital)],
                    ['Breakeven (Downside)', fmtRs(result.be_down)],
                    ['Breakeven (Upside)',   fmtRs(result.be_up)],
                    ['1σ Range',             `${fmtRs(result.sd1_down)} – ${fmtRs(result.sd1_up)}`],
                  ]).map(([label, value]) => (
                    <tr key={label as string}>
                      <td className="py-2 text-slate-400">{label}</td>
                      <td className="py-2 text-right font-medium text-white">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Strategy insight strip ─────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-blue-950/30 to-violet-950/20 border border-blue-800/30 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <span className="text-xl shrink-0 mt-0.5">🛡️</span>
              <div>
                {isFutures ? (
                  <>
                    <div className="text-sm font-semibold text-white mb-1">Why Index Futures Strangle works</div>
                    <div className="text-xs text-slate-400 leading-relaxed">
                      Buying <strong className="text-blue-300">1 {result.symbol} futures lot</strong> gives directional upside while
                      selling <strong className="text-violet-300">2× CE + 2× PE</strong> collects 4× the premium of a single lot strangle
                      ({fmtRs(result.total_income)} total, Δθ {fmtRs(result.daily_theta)}/day).
                      The long futures position naturally hedges the 2 short CE lots — if the index rises, futures gains offset CE losses
                      until delta hits 0.50. On the downside, double PE premium provides a wider cushion before losses mount.
                      Cash settlement removes assignment risk. No adjustments required — this is a set-and-forget income strategy.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-semibold text-white mb-1">Why Cushion Strangle works</div>
                    <div className="text-xs text-slate-400 leading-relaxed">
                      A plain short strangle has unlimited upside risk on the CE leg. By holding{' '}
                      <strong className="text-blue-300">{result.init_shares} shares ({(equityPct * 100).toFixed(0)}% of lot)</strong>,
                      you convert the naked CE into a partially covered call — capping your effective loss as stock rises.
                      The PE leg behaves like a cash-secured put: if assigned, you own the stock at a discount.
                      The IV-rich premium ({fmtRs(result.total_income)} per cycle, Δθ {fmtRs(result.daily_theta)}/day)
                      generates consistent income while the equity position provides long-term appreciation.
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="bg-[#111827] border border-[#1e2d40] rounded-xl p-10 text-center">
          <div className="text-3xl mb-3">🛡️</div>
          <div className="text-white font-semibold text-sm">Configure and analyse a Cushion Strangle</div>
          <div className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
            Search for any NSE stock or index (NIFTY/BANKNIFTY) — type 3+ characters to get suggestions.
            For indices, the strategy switches to Index Futures mode automatically.
          </div>
        </div>
      )}
    </div>
  )
}
