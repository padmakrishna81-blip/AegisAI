import { useState, useEffect, useRef } from 'react'
import client from '../api/client'
import {
  ComposedChart, Area, Line, ReferenceLine, ReferenceArea,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketData {
  nifty_spot: number | null
  india_vix: number | null
  vix_sma20: number | null
  nifty_5d_ret: number | null
  nifty_20d_ret: number | null
  banknifty_spot: number | null
  banknifty_5d_ret: number | null
  sp500_5d_ret: number | null
  inrusd_rate: number | null
  inrusd_5d_ret: number | null
  crude_5d_ret: number | null
  fetched_at: string
}

interface Assessment {
  trend: 'NEUTRAL' | 'BULLISH' | 'BEARISH'
  iv_regime: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME'
  recommended_strategy: 'IRON_FLY' | 'IRON_CONDOR' | 'BULL_PUT_SPREAD' | 'BEAR_CALL_SPREAD' | 'WAIT'
  underlying: 'NIFTY' | 'BANKNIFTY'
  entry_timing: string
  risks: string[]
  reasoning: string[]
  ai_powered: boolean
}

interface OptionLeg {
  role: 'short' | 'long'
  option_type: 'CE' | 'PE'
  strike: number
  premium: number
  exchange: string
  current_price?: number
}

interface TradePlan {
  strategy: string
  symbol: string
  expiry: string
  dte: number
  spot: number
  atm: number
  iv_used: number
  sd_move: number
  legs: OptionLeg[]
  lot_size: number
  lots: number
  qty: number
  net_credit: number
  max_profit: number
  max_loss: number
  pop_estimate: number
  breakevens: number[]
  profit_zone: string
  exit_targets: { profit: number; stop: number; dte_stop: number }
  oi_context?: OIContext
}

interface OIAnalysis {
  expiry: string
  spot: number
  pcr: number
  pcr_signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  max_pain: number
  max_pain_diff: number
  max_pain_bias: 'ABOVE_SPOT' | 'BELOW_SPOT' | 'AT_SPOT'
  nearest_resistance: number | null
  nearest_support: number | null
  resistance_walls: number[]
  support_walls: number[]
  ce_oi: Record<string, number>
  pe_oi: Record<string, number>
  error?: string
}

interface WingCheck {
  ce_wing_beyond_wall: boolean
  pe_wing_beyond_wall: boolean
  both_wings_safe: boolean
  note: string
}

interface OIContext extends OIAnalysis {
  wing_check: WingCheck
}

interface LivePnl {
  current_debit: number
  pnl_per_unit: number
  pnl_total: number
  pnl_pct: number
  dte_remaining: number
  exit_flag: 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_STOP' | null
  legs: OptionLeg[]
  error?: string
}

interface ActiveTrade {
  id: string
  strategy_type: string
  symbol: string
  expiry: string
  dte_at_entry: number
  lots: number
  lot_size: number
  qty: number
  atm_at_entry: number
  entry_credit: number
  max_profit: number
  max_loss: number
  auto_exit: boolean
  broker: string
  entered_at: string
  status: string
  live: LivePnl
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const COLORS = {
  NEUTRAL:  'bg-slate-700 text-slate-200',
  BULLISH:  'bg-green-900 text-green-300',
  BEARISH:  'bg-red-900 text-red-300',
  LOW:      'bg-slate-700 text-slate-300',
  NORMAL:   'bg-blue-900 text-blue-300',
  HIGH:     'bg-amber-900 text-amber-300',
  EXTREME:  'bg-red-900 text-red-300',
  IRON_FLY:         'bg-purple-900 text-purple-200',
  IRON_CONDOR:      'bg-blue-900 text-blue-200',
  BULL_PUT_SPREAD:  'bg-green-900 text-green-200',
  BEAR_CALL_SPREAD: 'bg-red-900 text-red-200',
  WAIT:             'bg-slate-700 text-slate-300',
}

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded ${className ?? 'bg-slate-700 text-slate-300'}`}>
      {label}
    </span>
  )
}

function Num({ v, prefix = '', suffix = '', decimals = 1 }: {
  v: number | null | undefined; prefix?: string; suffix?: string; decimals?: number
}) {
  if (v == null) return <span className="text-muted">—</span>
  const colored = v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-slate-300'
  const sign = v > 0 ? '+' : ''
  return (
    <span className={colored}>
      {prefix}{sign}{v.toFixed(decimals)}{suffix}
    </span>
  )
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-card rounded-lg p-3 border border-border">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  )
}

// ── OI Analysis Panel ─────────────────────────────────────────────────────────

const PCR_COLORS: Record<string, string> = {
  BULLISH: 'bg-green-900 text-green-300',
  BEARISH: 'bg-red-900 text-red-300',
  NEUTRAL: 'bg-slate-700 text-slate-300',
}

function OIPanel({ oi }: { oi: OIAnalysis }) {
  if (oi.error) return (
    <div className="bg-card rounded-xl border border-border p-4 text-xs text-muted">
      OI analysis unavailable: {oi.error}
    </div>
  )

  const mpDiff = oi.max_pain_diff ?? 0
  const mpColor = mpDiff > 0 ? 'text-green-400' : mpDiff < 0 ? 'text-red-400' : 'text-slate-300'

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-white text-xs font-semibold">OI Analysis</span>
        <span className="text-[10px] text-muted">({oi.expiry})</span>
      </div>

      {/* Key numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="PCR" value={
          <div className="flex items-center gap-1.5">
            <span className="text-white">{oi.pcr?.toFixed(2) ?? '—'}</span>
            <Badge label={oi.pcr_signal} className={PCR_COLORS[oi.pcr_signal] || ''} />
          </div>
        } />
        <Tile label="Max Pain" value={
          <span>
            <span className="text-white">{oi.max_pain?.toLocaleString('en-IN') ?? '—'}</span>
            {' '}
            <span className={`text-xs ${mpColor}`}>
              {mpDiff !== 0 ? `${mpDiff > 0 ? '+' : ''}${mpDiff}` : 'at spot'}
            </span>
          </span>
        } />
        <Tile label="Resistance Wall" value={
          <span className="text-red-400">{oi.nearest_resistance?.toLocaleString('en-IN') ?? '—'}</span>
        } />
        <Tile label="Support Wall" value={
          <span className="text-green-400">{oi.nearest_support?.toLocaleString('en-IN') ?? '—'}</span>
        } />
      </div>

      {/* Top OI walls table */}
      {(oi.resistance_walls.length > 0 || oi.support_walls.length > 0) && (
        <div className="grid grid-cols-2 gap-3">
          {/* CE (resistance) walls */}
          <div>
            <div className="text-[10px] text-red-400 uppercase tracking-wider mb-1.5">
              Call OI — Resistance
            </div>
            <div className="space-y-1">
              {oi.resistance_walls.map(sk => (
                <div key={sk} className="flex justify-between text-xs">
                  <span className="text-white font-mono">{sk.toLocaleString('en-IN')}</span>
                  <span className="text-muted">
                    {((oi.ce_oi[sk] ?? 0) / 100000).toFixed(1)}L lots
                  </span>
                </div>
              ))}
            </div>
          </div>
          {/* PE (support) walls */}
          <div>
            <div className="text-[10px] text-green-400 uppercase tracking-wider mb-1.5">
              Put OI — Support
            </div>
            <div className="space-y-1">
              {oi.support_walls.map(sk => (
                <div key={sk} className="flex justify-between text-xs">
                  <span className="text-white font-mono">{sk.toLocaleString('en-IN')}</span>
                  <span className="text-muted">
                    {((oi.pe_oi[sk] ?? 0) / 100000).toFixed(1)}L lots
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Interpretation */}
      <div className="text-[11px] text-slate-400 bg-slate-800/40 rounded-lg p-2.5 space-y-0.5">
        {oi.pcr_signal === 'BULLISH' && (
          <div>• PCR &gt; 1.2 — heavy put writing signals bullish bias; market expects support</div>
        )}
        {oi.pcr_signal === 'BEARISH' && (
          <div>• PCR &lt; 0.8 — heavy call writing signals bearish bias; market expects resistance</div>
        )}
        {oi.nearest_resistance && (
          <div>• {oi.nearest_resistance.toLocaleString('en-IN')} CE has max call OI — strong resistance ceiling</div>
        )}
        {oi.nearest_support && (
          <div>• {oi.nearest_support.toLocaleString('en-IN')} PE has max put OI — strong support floor</div>
        )}
        {oi.max_pain && (
          <div>• Max pain at {oi.max_pain.toLocaleString('en-IN')} — index likely drifts here near expiry</div>
        )}
      </div>
    </div>
  )
}

// ── OI Context in Plan ────────────────────────────────────────────────────────

function OIContextPanel({ oi }: { oi: OIContext }) {
  const wc = oi.wing_check
  return (
    <div className="bg-slate-800/40 rounded-lg p-3 space-y-2">
      <div className="text-[10px] text-muted uppercase tracking-wider">OI Context</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <div className="text-muted text-[10px]">Max Pain</div>
          <div className="text-white font-mono">{oi.max_pain?.toLocaleString('en-IN') ?? '—'}</div>
          <div className={`text-[10px] ${(oi.max_pain_diff ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {(oi.max_pain_diff ?? 0) > 0 ? '+' : ''}{oi.max_pain_diff ?? 0} from spot
          </div>
        </div>
        <div>
          <div className="text-muted text-[10px]">PCR</div>
          <div className="text-white font-mono">{oi.pcr?.toFixed(2) ?? '—'}</div>
          <Badge label={oi.pcr_signal} className={`text-[9px] ${PCR_COLORS[oi.pcr_signal] || ''}`} />
        </div>
        <div>
          <div className="text-muted text-[10px]">CE Wall (resistance)</div>
          <div className="text-red-400 font-mono">{oi.nearest_resistance?.toLocaleString('en-IN') ?? '—'}</div>
        </div>
        <div>
          <div className="text-muted text-[10px]">PE Wall (support)</div>
          <div className="text-green-400 font-mono">{oi.nearest_support?.toLocaleString('en-IN') ?? '—'}</div>
        </div>
      </div>

      {/* Wing safety check */}
      <div className={`flex items-start gap-2 text-xs rounded p-2 ${
        wc.both_wings_safe ? 'bg-green-900/30 text-green-300' : 'bg-amber-900/30 text-amber-300'
      }`}>
        <span className="mt-0.5">{wc.both_wings_safe ? '✓' : '⚠'}</span>
        <div>
          <span className="font-medium">{wc.both_wings_safe ? 'Wings clear OI walls' : 'Wings inside OI walls'}</span>
          {' — '}{wc.note}
          {!wc.ce_wing_beyond_wall && oi.nearest_resistance && (
            <div className="text-[10px] mt-0.5 opacity-80">
              Consider CE wing ≥ {oi.nearest_resistance.toLocaleString('en-IN')}
            </div>
          )}
          {!wc.pe_wing_beyond_wall && oi.nearest_support && (
            <div className="text-[10px] mt-0.5 opacity-80">
              Consider PE wing ≤ {oi.nearest_support.toLocaleString('en-IN')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Payoff Chart ──────────────────────────────────────────────────────────────

function computePayoff(legs: OptionLeg[], spot: number, qty: number): { price: number; pnl: number }[] {
  const strikes = legs.map(l => l.strike)
  const minS = Math.min(...strikes) * 0.93
  const maxS = Math.max(...strikes) * 1.07
  const step  = (maxS - minS) / 200

  const points: { price: number; pnl: number }[] = []
  for (let s = minS; s <= maxS + step / 2; s += step) {
    let pnl = 0
    for (const leg of legs) {
      const intrinsic = leg.option_type === 'CE'
        ? Math.max(0, s - leg.strike)
        : Math.max(0, leg.strike - s)
      if (leg.role === 'short') {
        pnl += (leg.premium - intrinsic) * qty
      } else {
        pnl += (intrinsic - leg.premium) * qty
      }
    }
    points.push({ price: Math.round(s), pnl: Math.round(pnl) })
  }
  return points
}

interface PayoffChartProps {
  plan: TradePlan
}

function PayoffChart({ plan }: PayoffChartProps) {
  const data     = computePayoff(plan.legs, plan.spot, plan.qty)
  const maxPnl   = plan.max_profit
  const minPnl   = -plan.max_loss
  const spot     = plan.spot
  const [be1, be2] = plan.breakevens.length === 2 ? plan.breakevens : [null, null]

  const fmtK = (v: number) =>
    Math.abs(v) >= 1000
      ? `${v >= 0 ? '' : '-'}₹${(Math.abs(v) / 1000).toFixed(1)}K`
      : `${v >= 0 ? '' : '-'}₹${Math.abs(v)}`

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: { value: number; payload: { price: number } }[] }) => {
    if (!active || !payload?.length) return null
    const pnl = payload[0].value
    const price = payload[0].payload.price
    return (
      <div className="bg-slate-900 border border-border rounded-lg px-3 py-2 text-xs shadow-xl">
        <div className="text-slate-300 mb-0.5">Underlying: <span className="text-white font-mono">{price.toLocaleString('en-IN')}</span></div>
        <div className={`font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          P&L: {pnl >= 0 ? '+' : ''}₹{Math.abs(pnl).toLocaleString('en-IN')}
        </div>
      </div>
    )
  }

  // Split data into profit (≥0) and loss (<0) series for dual coloring
  const profitData = data.map(d => ({ ...d, profit: d.pnl >= 0 ? d.pnl : 0 }))
  const lossData   = data.map(d => ({ ...d, loss: d.pnl < 0 ? d.pnl : 0 }))

  return (
    <div className="bg-slate-900/60 rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs font-semibold text-white">Payoff at Expiry</div>
        <div className="flex gap-3 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-3 h-1 bg-emerald-500 inline-block rounded" /> Max Profit ₹{maxPnl.toLocaleString('en-IN')}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-1 bg-red-500 inline-block rounded" /> Max Loss ₹{plan.max_loss.toLocaleString('en-IN')}</span>
          {be1 && <span className="text-muted">BE: {be1.toLocaleString('en-IN')} / {be2?.toLocaleString('en-IN')}</span>}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="price"
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={v => v.toLocaleString('en-IN')}
            tickCount={8}
            domain={['dataMin', 'dataMax']}
            type="number"
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={fmtK}
            domain={[Math.min(minPnl * 1.15, -1000), Math.max(maxPnl * 1.3, 1000)]}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* Profit fill (green) */}
          <Area
            data={profitData}
            dataKey="profit"
            fill="#059669"
            fillOpacity={0.25}
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            baseValue={0}
          />
          {/* Loss fill (red) */}
          <Area
            data={lossData}
            dataKey="loss"
            fill="#dc2626"
            fillOpacity={0.25}
            stroke="#ef4444"
            strokeWidth={2}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            baseValue={0}
          />
          {/* Zero line */}
          <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />

          {/* Spot price */}
          <ReferenceLine x={Math.round(spot)} stroke="#60a5fa" strokeWidth={1.5} strokeDasharray="4 3"
            label={{ value: `Spot ${Math.round(spot).toLocaleString('en-IN')}`, position: 'top', fontSize: 8, fill: '#60a5fa', offset: 4 }} />

          {/* Breakevens */}
          {be1 && <ReferenceLine x={be1} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3"
            label={{ value: `BE`, position: 'insideTopLeft', fontSize: 7, fill: '#fbbf24' }} />}
          {be2 && <ReferenceLine x={be2} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3"
            label={{ value: `BE`, position: 'insideTopRight', fontSize: 7, fill: '#fbbf24' }} />}

          {/* Profit zone shading between breakevens */}
          {be1 && be2 && (
            <ReferenceArea x1={be1} x2={be2} fill="#10b981" fillOpacity={0.06} />
          )}

          {/* Wing strikes */}
          {plan.legs.filter(l => l.role === 'long').map((leg, i) => (
            <ReferenceLine key={i} x={leg.strike} stroke="#6366f1" strokeWidth={1} strokeDasharray="2 4"
              label={{ value: `${leg.option_type} Wing`, position: i === 0 ? 'insideTopLeft' : 'insideTopRight', fontSize: 7, fill: '#818cf8' }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Strike legend */}
      <div className="mt-2 flex flex-wrap gap-3 text-[9px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-3 h-px border-t border-dashed border-blue-400 inline-block" /> Spot</span>
        <span className="flex items-center gap-1"><span className="w-3 h-px border-t border-dashed border-amber-400 inline-block" /> Breakeven</span>
        <span className="flex items-center gap-1"><span className="w-3 h-px border-t border-dashed border-indigo-400 inline-block" /> Wing strikes</span>
      </div>
    </div>
  )
}

function AssessmentTab() {
  const [loading, setLoading] = useState(false)
  const [marketData, setMarketData] = useState<MarketData | null>(null)
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [oiAnalysis, setOiAnalysis] = useState<OIAnalysis | null>(null)
  const [error, setError] = useState('')

  const fetchAssessment = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await client.get('/market-brain/assess')
      setMarketData(r.data.market_data)
      setAssessment(r.data.assessment)
      setOiAnalysis(r.data.oi_analysis ?? null)
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to fetch assessment')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <h2 className="text-white font-semibold">Market Assessment</h2>
        <button
          onClick={fetchAssessment}
          disabled={loading}
          className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded-lg disabled:opacity-50 font-medium"
        >
          {loading ? 'Analysing…' : '⟳  Refresh'}
        </button>
        {assessment?.ai_powered && <span className="text-[10px] bg-purple-900 text-purple-300 px-2 py-0.5 rounded">AI powered</span>}
      </div>

      {error && <div className="bg-red-900/40 text-red-300 text-xs p-3 rounded-lg">{error}</div>}

      {/* Market data tiles */}
      {marketData && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Tile label="Nifty" value={<><span className="text-white">{marketData.nifty_spot?.toLocaleString('en-IN') ?? '—'}</span>{' '}<Num v={marketData.nifty_5d_ret} suffix="%" /></>} />
          <Tile label="India VIX" value={<><span className="text-white">{marketData.india_vix?.toFixed(1) ?? '—'}</span>{' '}<span className="text-muted text-xs">avg {marketData.vix_sma20?.toFixed(1) ?? '—'}</span></>} />
          <Tile label="BankNifty" value={<><span className="text-white">{marketData.banknifty_spot?.toLocaleString('en-IN') ?? '—'}</span>{' '}<Num v={marketData.banknifty_5d_ret} suffix="%" /></>} />
          <Tile label="S&P 500 (5d)" value={<Num v={marketData.sp500_5d_ret} suffix="%" />} />
          <Tile label="INR/USD" value={<><span className="text-white">{marketData.inrusd_rate?.toFixed(2) ?? '—'}</span>{' '}<Num v={marketData.inrusd_5d_ret} suffix="%" /></>} />
          <Tile label="Crude (5d)" value={<Num v={marketData.crude_5d_ret} suffix="%" />} />
        </div>
      )}

      {/* AI verdict */}
      {assessment && (
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Badge label={`Trend: ${assessment.trend}`} className={COLORS[assessment.trend] || ''} />
            <Badge label={`IV: ${assessment.iv_regime}`} className={COLORS[assessment.iv_regime] || ''} />
            <Badge label={assessment.recommended_strategy} className={COLORS[assessment.recommended_strategy] || ''} />
            <Badge label={`Underlying: ${assessment.underlying}`} className="bg-indigo-900 text-indigo-200" />
          </div>

          <div className="text-xs text-amber-300 font-medium">⏱  {assessment.entry_timing}</div>

          {assessment.reasoning.length > 0 && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Reasoning</div>
              <ul className="space-y-1">
                {assessment.reasoning.map((r, i) => (
                  <li key={i} className="text-xs text-slate-300 flex gap-1.5">
                    <span className="text-blue-400 mt-0.5">•</span>{r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {assessment.risks.length > 0 && (
            <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-2.5">
              <div className="text-[10px] text-red-400 uppercase tracking-wider mb-1">Risk Flags</div>
              {assessment.risks.map((r, i) => (
                <div key={i} className="text-xs text-red-300 flex gap-1.5">
                  <span>⚠</span>{r}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {oiAnalysis && <OIPanel oi={oiAnalysis} />}

      {!marketData && !loading && (
        <div className="bg-card rounded-xl border border-dashed border-border p-8 text-center text-muted text-sm">
          Click "Refresh" to fetch live market data and AI assessment
        </div>
      )}
    </div>
  )
}

// ── Tab: Plan Trade ───────────────────────────────────────────────────────────

function PlanTab() {
  const [strategyType, setStrategyType] = useState<'IRON_FLY' | 'IRON_CONDOR'>('IRON_FLY')
  const [symbol, setSymbol] = useState<'NIFTY' | 'BANKNIFTY'>('NIFTY')
  const [lots, setLots] = useState(1)
  const [autoExit, setAutoExit] = useState(false)
  const [broker, setBroker] = useState('angelone')
  const [plan, setPlan] = useState<TradePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [entering, setEntering] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const calcPlan = async () => {
    setLoading(true)
    setError('')
    setPlan(null)
    try {
      const r = await client.post('/market-brain/plan', { strategy_type: strategyType, symbol, lots })
      setPlan(r.data)
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to calculate plan')
    } finally {
      setLoading(false)
    }
  }

  const enterTrade = async () => {
    if (!plan) return
    setEntering(true)
    setError('')
    setSuccess('')
    try {
      const r = await client.post('/market-brain/enter', { plan, broker, auto_exit: autoExit })
      setSuccess(`Trade entered! ID: ${r.data.trade_id} — ${r.data.message}`)
      if (r.data.errors?.length) setError(r.data.errors.join('; '))
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to enter trade')
    } finally {
      setEntering(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Strategy toggle */}
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Strategy</div>
            <div className="flex rounded-lg overflow-hidden border border-border text-xs">
              {(['IRON_FLY', 'IRON_CONDOR'] as const).map(s => (
                <button key={s} onClick={() => setStrategyType(s)}
                  className={`px-3 py-1.5 font-medium transition-colors ${strategyType === s ? 'bg-purple-800 text-purple-200' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          {/* Underlying */}
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Underlying</div>
            <div className="flex rounded-lg overflow-hidden border border-border text-xs">
              {(['NIFTY', 'BANKNIFTY'] as const).map(s => (
                <button key={s} onClick={() => setSymbol(s)}
                  className={`px-3 py-1.5 font-medium transition-colors ${symbol === s ? 'bg-indigo-800 text-indigo-200' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Lots */}
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Lots</div>
            <input type="number" min={1} max={10} value={lots}
              onChange={e => setLots(Math.max(1, +e.target.value))}
              className="w-16 bg-slate-800 text-white text-xs rounded border border-border px-2 py-1.5 text-center" />
          </div>

          <button onClick={calcPlan} disabled={loading}
            className="px-5 py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded-lg disabled:opacity-50 font-medium self-end">
            {loading ? 'Calculating…' : '⚡ Calculate'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 text-red-300 text-xs p-3 rounded-lg">{error}</div>}
      {success && <div className="bg-green-900/40 text-green-300 text-xs p-3 rounded-lg">{success}</div>}

      {plan && (
        <>
          {/* Plan summary */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-4">
            {/* Header info */}
            <div className="flex flex-wrap gap-3 items-center">
              <Badge label={plan.strategy.replace('_', ' ')} className={COLORS[plan.strategy as keyof typeof COLORS] || 'bg-slate-700 text-slate-200'} />
              <span className="text-white text-sm font-semibold">{plan.symbol}</span>
              <span className="text-muted text-xs">Expiry: {plan.expiry} ({plan.dte} DTE)</span>
              <span className="text-muted text-xs">Spot: {plan.spot.toLocaleString('en-IN')}</span>
              <span className="text-muted text-xs">IV: {plan.iv_used}%</span>
            </div>

            {/* Key metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Net Credit" value={<span className="text-green-400">₹{plan.net_credit} × {plan.qty}</span>} />
              <Tile label="Max Profit" value={<span className="text-green-400">₹{plan.max_profit.toLocaleString('en-IN')}</span>} />
              <Tile label="Max Loss" value={<span className="text-red-400">₹{plan.max_loss.toLocaleString('en-IN')}</span>} />
              <Tile label="Est. POP" value={<span className="text-blue-300">{plan.pop_estimate}%</span>} />
            </div>

            {/* Payoff chart */}
            <PayoffChart plan={plan} />

            {/* Legs table */}
            {plan.oi_context && <OIContextPanel oi={plan.oi_context} />}

            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Option Legs</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted text-left">
                      <th className="pb-1.5 pr-4">Action</th>
                      <th className="pb-1.5 pr-4">Type</th>
                      <th className="pb-1.5 pr-4">Strike</th>
                      <th className="pb-1.5 pr-4">Premium</th>
                      <th className="pb-1.5 pr-4">Exchange</th>
                      <th className="pb-1.5 text-[9px]">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.legs.map((leg, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="py-1.5 pr-4">
                          <span className={`font-bold ${leg.role === 'short' ? 'text-red-400' : 'text-green-400'}`}>
                            {leg.role === 'short' ? 'SELL' : 'BUY'}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4">
                          <span className={leg.option_type === 'CE' ? 'text-blue-300' : 'text-amber-300'}>
                            {leg.option_type}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-white font-mono">{leg.strike}</td>
                        <td className="py-1.5 pr-4 text-white font-mono">₹{leg.premium || '—'}</td>
                        <td className="py-1.5 pr-4 text-muted">{leg.exchange}</td>
                        <td className="py-1.5 text-[9px] text-muted">{leg.premium > 0 ? 'live' : 'BS est.'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Exit targets */}
            <div className="bg-slate-800/40 rounded-lg p-3 text-xs space-y-1">
              <div className="text-[10px] text-muted uppercase tracking-wider">Auto-Exit Targets (per unit)</div>
              <div className="flex flex-wrap gap-4 text-slate-300">
                <span>🎯 Profit: close when debit ≤ <span className="text-green-400">₹{plan.exit_targets.profit}</span> (50% of credit)</span>
                <span>🛑 Stop: close when debit ≥ <span className="text-red-400">₹{plan.exit_targets.stop}</span> (2× credit)</span>
                <span>⏱ Time: close at <span className="text-amber-400">{plan.exit_targets.dte_stop} DTE</span></span>
              </div>
              {plan.legs.every(l => l.premium === 0) && (
                <div className="text-amber-400 text-[10px] mt-1">⚠ Premiums estimated via Black-Scholes (market closed) — verify at open</div>
              )}
            </div>

            {/* Enter trade controls */}
            <div className="flex flex-wrap gap-3 items-center border-t border-border pt-3">
              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Broker</div>
                <select value={broker} onChange={e => setBroker(e.target.value)}
                  className="bg-slate-800 text-white text-xs rounded border border-border px-2 py-1.5">
                  <option value="angelone">Angel One</option>
                  <option value="kotak">Kotak Neo</option>
                </select>
              </div>

              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Auto-Exit</div>
                <button onClick={() => setAutoExit(!autoExit)}
                  className={`px-3 py-1.5 text-xs rounded border font-medium transition-colors ${
                    autoExit ? 'bg-amber-800 border-amber-600 text-amber-200' : 'bg-slate-800 border-border text-slate-400'
                  }`}>
                  {autoExit ? '⚡ ON' : 'OFF'}
                </button>
              </div>

              <button onClick={enterTrade} disabled={entering}
                className="px-5 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-lg disabled:opacity-50 font-bold self-end">
                {entering ? 'Placing Orders…' : '▶  Enter Trade'}
              </button>
            </div>
          </div>
        </>
      )}

      {!plan && !loading && (
        <div className="bg-card rounded-xl border border-dashed border-border p-8 text-center text-muted text-sm">
          Select strategy + underlying, then click Calculate to see the strike plan
        </div>
      )}
    </div>
  )
}

// ── Tab: Active Trades ────────────────────────────────────────────────────────

function ActiveTradesTab() {
  const [trades, setTrades] = useState<ActiveTrade[]>([])
  const [loading, setLoading] = useState(false)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchTrades = async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const r = await client.get('/market-brain/trades')
      setTrades(r.data.trades || [])
    } catch (e: any) {
      if (!quiet) setError(e.response?.data?.error || 'Failed to fetch trades')
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    fetchTrades()
    intervalRef.current = setInterval(() => fetchTrades(true), 120_000) // auto-refresh 2 min
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const closeTrade = async (trade: ActiveTrade) => {
    setClosingId(trade.id)
    try {
      await client.post(`/market-brain/exit/${trade.id}`, { broker: trade.broker })
      fetchTrades()
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to close trade')
    } finally {
      setClosingId(null)
    }
  }

  const toggleAutoExit = async (trade: ActiveTrade) => {
    setTogglingId(trade.id)
    try {
      await client.post(`/market-brain/toggle-auto-exit/${trade.id}`)
      setTrades(prev => prev.map(t => t.id === trade.id ? { ...t, auto_exit: !t.auto_exit } : t))
    } catch {
    } finally {
      setTogglingId(null)
    }
  }

  const exitFlagColor: Record<string, string> = {
    PROFIT_TARGET: 'bg-green-900 text-green-300',
    STOP_LOSS:     'bg-red-900 text-red-300',
    TIME_STOP:     'bg-amber-900 text-amber-300',
  }

  const exitFlagLabel: Record<string, string> = {
    PROFIT_TARGET: '🎯 Profit Target',
    STOP_LOSS:     '🛑 Stop Loss',
    TIME_STOP:     '⏱ Time Stop',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-white font-semibold">Active Trades</h2>
        <button onClick={() => fetchTrades()}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg font-medium">
          ⟳  Refresh
        </button>
        <span className="text-[10px] text-muted">Auto-refreshes every 2 min</span>
      </div>

      {error && <div className="bg-red-900/40 text-red-300 text-xs p-3 rounded-lg">{error}</div>}

      {loading && (
        <div className="text-muted text-sm p-4 text-center">Loading trades…</div>
      )}

      {!loading && trades.length === 0 && (
        <div className="bg-card rounded-xl border border-dashed border-border p-8 text-center text-muted text-sm">
          No active AI trades. Go to "Plan Trade" to enter a position.
        </div>
      )}

      {trades.map(trade => {
        const live = trade.live || {} as LivePnl
        const pnlColor = (live.pnl_total ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
        const pnlPctColor = (live.pnl_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
        const rowBg = live.exit_flag ? 'border-amber-700/50' : 'border-border'

        return (
          <div key={trade.id} className={`bg-card rounded-xl border ${rowBg} p-4 space-y-3`}>
            {/* Row header */}
            <div className="flex flex-wrap gap-2 items-center justify-between">
              <div className="flex flex-wrap gap-2 items-center">
                <Badge label={trade.strategy_type.replace('_', ' ')} className={COLORS[trade.strategy_type as keyof typeof COLORS] || 'bg-slate-700 text-slate-200'} />
                <span className="text-white text-sm font-semibold">{trade.symbol}</span>
                <span className="text-muted text-xs">{trade.expiry} ({live.dte_remaining ?? '—'} DTE left)</span>
                <span className="text-muted text-xs">{trade.lots} lot{trade.lots > 1 ? 's' : ''} × {trade.lot_size}</span>
                {live.exit_flag && (
                  <Badge label={exitFlagLabel[live.exit_flag] || live.exit_flag}
                    className={exitFlagColor[live.exit_flag] || 'bg-slate-700 text-slate-200'} />
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Auto-exit toggle */}
                <button onClick={() => toggleAutoExit(trade)} disabled={togglingId === trade.id}
                  className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors ${
                    trade.auto_exit ? 'bg-amber-800 border-amber-600 text-amber-200' : 'bg-slate-800 border-border text-slate-400'
                  }`}
                  title={trade.auto_exit ? 'Auto-exit ON — click to disable' : 'Auto-exit OFF — click to enable'}>
                  {trade.auto_exit ? '⚡ Auto' : '— Manual'}
                </button>
                {/* Close button */}
                <button onClick={() => closeTrade(trade)} disabled={closingId === trade.id}
                  className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-red-200 rounded border border-red-700 font-medium disabled:opacity-50">
                  {closingId === trade.id ? 'Closing…' : '✕ Close All'}
                </button>
              </div>
            </div>

            {/* P&L summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Entry Credit" value={<span className="text-white">₹{trade.entry_credit} × {trade.qty}</span>} />
              <Tile label="Current P&L" value={
                <span className={pnlColor}>
                  {(live.pnl_total ?? 0) >= 0 ? '+' : ''}₹{(live.pnl_total ?? 0).toLocaleString('en-IN')}
                </span>
              } />
              <Tile label="P&L %" value={
                <span className={pnlPctColor}>
                  {(live.pnl_pct ?? 0) >= 0 ? '+' : ''}{(live.pnl_pct ?? 0).toFixed(1)}%
                </span>
              } />
              <Tile label="Max Profit / Loss" value={
                <span className="text-slate-300 text-[11px]">
                  ₹{trade.max_profit.toLocaleString('en-IN')} / ₹{trade.max_loss.toLocaleString('en-IN')}
                </span>
              } />
            </div>

            {/* Legs mini-table */}
            {live.legs && live.legs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-muted text-left">
                      <th className="pb-1 pr-3">Leg</th>
                      <th className="pb-1 pr-3">Strike</th>
                      <th className="pb-1 pr-3">Entry</th>
                      <th className="pb-1">LTP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.legs.map((leg, i) => (
                      <tr key={i} className="border-b border-border/20">
                        <td className="py-1 pr-3">
                          <span className={leg.role === 'short' ? 'text-red-400' : 'text-green-400'}>
                            {leg.role === 'short' ? 'S' : 'B'}
                          </span>
                          {' '}
                          <span className={leg.option_type === 'CE' ? 'text-blue-300' : 'text-amber-300'}>
                            {leg.option_type}
                          </span>
                        </td>
                        <td className="py-1 pr-3 font-mono text-white">{leg.strike}</td>
                        <td className="py-1 pr-3 font-mono text-muted">₹{leg.premium}</td>
                        <td className="py-1 font-mono text-white">₹{leg.current_price ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {live.error && <div className="text-red-400 text-[11px]">⚠ P&L error: {live.error}</div>}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'assess' | 'plan' | 'trades'

export default function MarketBrain() {
  const [tab, setTab] = useState<Tab>('assess')

  const tabs: { key: Tab; label: string }[] = [
    { key: 'assess', label: '🌐 Market Assessment' },
    { key: 'plan',   label: '📐 Plan Trade' },
    { key: 'trades', label: '📊 Active Trades' },
  ]

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <span className="text-2xl">🧠</span>
        <div>
          <h1 className="text-lg font-bold text-white">Market Brain</h1>
          <div className="text-xs text-muted">AI-driven Iron Fly / Iron Condor auto-trader for Nifty & BankNifty</div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'assess' && <AssessmentTab />}
        {tab === 'plan'   && <PlanTab />}
        {tab === 'trades' && <ActiveTradesTab />}
      </div>
    </div>
  )
}
