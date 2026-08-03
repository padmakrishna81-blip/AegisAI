import { useState } from 'react'
import client from '../api/client'
import { usePortfolio } from '../hooks/usePortfolio'
import { shortSymbol, normalizeSymbol, scoreToColor } from '../utils/formatters'
import NseStockSearch from '../components/NseStockSearch'
import VolatilityPanel from '../components/VolatilityPanel'

// ─── Types ─────────────────────────────────────────────────────────────────────

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

interface ScanResult {
  symbol: string
  name: string
  sector: string
  cmp: number
  high_52w: number
  low_52w: number
  pct_from_high: number
  pct_from_low: number
  change_5d: number
  change_1d?: number
  opportunity_score?: number
  opportunity_label?: string
  opportunity_reason?: string
  above_200dma: boolean
  atm_iv: number | null
  lot_size: number
  phase1_qty: number
  phase1_cost: number
  phase2_qty: number
  phase2_trigger: number
  phase2_cost: number
  total_funds_required: number
  strike_8pct: number
  strike_10pct: number
  score: number
}

interface AdjacentStrike {
  strike: number
  ltp: number
  iv: number
  delta: number | null
  pct_otm: number
  is_recommended: boolean
}

interface TradePlan {
  symbol: string
  name: string
  cmp: number
  prev_close?: number | null
  change_inr?: number | null
  change_pct?: number | null
  high_52w: number
  low_52w: number
  change_5d: number
  lot_size: number
  lots: number
  total_shares: number
  avg_pct: number
  trade_setup: {
    phase1_qty: number
    phase1_entry: number
    phase1_limit_default: number
    phase1_cost: number
    strike_recommended: number
    strike_conservative: number
    expiry: string
    days_to_expiry: number
    premium_live: number
    premium_limit_default: number
    premium_income: number
    effective_entry: number
    breakeven: number
    expiry_note: string
  }
  averaging: {
    phase2_trigger: number
    phase2_trigger_pct: number
    phase2_qty: number
    phase2_entry: number
    phase2_limit_default: number
    phase2_cost: number
    avg_cost_after: number
  }
  funds: {
    phase1_only: number
    full_lot_stock: number
    ce_margin_estimate: number
    total_funds_required: number
    note: string
  }
  scenarios: {
    case1_bull:     { label: string; target_price: number; stock_pnl: number; max_profit: number; probable_loss: number; return_pct: number; probability: number; action: string }
    case2_flat:     { label: string; max_profit: number; probable_loss: number; return_pct: number; probability: number; action: string }
    case3_dip:      { label: string; target_price: number; ce_profit: number; phase1_unrealised: number; new_avg_cost: number; max_profit: number; probable_loss: number; probability: number; action: string }
    case4_breakdown:{ label: string; target_price: number; ce_profit: number; stock_unrealised: number; max_profit: number; probable_loss: number; probability: number; action: string }
  }
  price_range: {
    low_1sd: number; high_1sd: number; low_2sd: number; high_2sd: number
    low_1sd_blended: number; high_1sd_blended: number
    low_2sd_blended: number; high_2sd_blended: number
    iv_used: number; has_historical: boolean
    days_to_expiry: number; note: string
    hist_max_cycle_up: number | null; hist_max_cycle_down: number | null
    hist_expiry_p90_up: number | null; hist_expiry_p90_down: number | null
  }
  adjacent_strikes: AdjacentStrike[]
  greeks: Record<string, { value: number; label: string; meaning: string; verdict: string }>
  iv_spike_risk: {
    risk_level: 'low' | 'medium' | 'high'
    current_iv: number
    iv_assessment: string
    risks: string[]
    recommendation: string
  }
  summary: {
    max_profit: number
    max_profit_case: string
    probable_loss_breakdown: number
    probable_loss_note: string
    margin_note: string
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString('en-IN') }
function fmtPnl(n: number) {
  return `${n >= 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN')}`
}

// ─── Trade Plan Panel ──────────────────────────────────────────────────────────

function NumericInput({ label, value, onChange, step, min, unit }: {
  label: string; value: number; onChange: (v: number) => void
  step?: number; min?: number; unit?: string
}) {
  return (
    <div>
      <div className="text-[10px] text-slate-400 mb-1">{label}</div>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(Math.max(min ?? 0, Math.round((value - (step ?? 0.5)) * 100) / 100))}
          className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-bold">−</button>
        <input type="number" value={value} step={step ?? 0.5}
          onChange={e => onChange(parseFloat(e.target.value) || value)}
          className="w-24 text-center bg-slate-800 border border-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
        />
        <button onClick={() => onChange(Math.round((value + (step ?? 0.5)) * 100) / 100)}
          className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-bold">+</button>
        {unit && <span className="text-xs text-slate-400">{unit}</span>}
      </div>
    </div>
  )
}

function TradePlanPanel({ plan, onClose, onPaperTrade, onRefetch }: {
  plan: TradePlan
  onClose: () => void
  onPaperTrade: (plan: TradePlan, opts: OrderOptions) => void
  onRefetch: (lots: number, strikeOverride: number) => void
}) {
  const ts = plan.trade_setup
  const av = plan.averaging
  const sc = plan.scenarios
  const fu = plan.funds
  const su = plan.summary

  // Interactive state
  const [localLots, setLocalLots]         = useState(plan.lots)
  const [selectedStrike, setSelectedStrike] = useState(ts.strike_recommended)
  const [phase1Limit, setPhase1Limit]     = useState(ts.phase1_limit_default)
  const [phase2Limit, setPhase2Limit]     = useState(av.phase2_limit_default)
  const [premiumLimit, setPremiumLimit]   = useState(ts.premium_limit_default)
  const [applying, setApplying]           = useState(false)

  // Adjacent strikes are already sorted ascending by strike from backend
  // They include the recommended strike marked with is_recommended=true
  const allStrikes: AdjacentStrike[] = plan.adjacent_strikes

  const apply = () => {
    setApplying(true)
    onRefetch(localLots, selectedStrike === ts.strike_recommended ? 0 : selectedStrike)
  }

  // Reset limit prices when plan updates
  const hasChanges = localLots !== plan.lots || selectedStrike !== ts.strike_recommended

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-background border-l border-border overflow-y-auto z-10 p-5 space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold text-white">{plan.symbol} — Covered Call Plan</div>
            <div className="text-xs text-slate-400">{plan.name} · Avg trigger: {plan.avg_pct}% below entry</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl p-1">✕</button>
        </div>

        {/* Key stats */}
        <div className="grid grid-cols-5 gap-2">
          {/* CMP tile — custom to show change below */}
          <div className="bg-card border border-border rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-muted mb-0.5">CMP (Live)</div>
            <div className="text-sm font-bold text-white">₹{plan.cmp}</div>
            {plan.change_inr != null && (
              <div className={`text-[10px] font-semibold mt-0.5 ${plan.change_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {plan.change_inr >= 0 ? '+' : ''}₹{Math.abs(plan.change_inr).toFixed(2)} ({plan.change_pct != null ? `${plan.change_pct >= 0 ? '+' : ''}${plan.change_pct.toFixed(2)}%` : ''})
              </div>
            )}
          </div>
          {[
            { label: 'Lot Size',   val: fmt(plan.lot_size),   color: 'text-white' },
            { label: 'Avg Trigger',val: `₹${plan.averaging.phase2_trigger}`, color: 'text-score-amber' },
            { label: '52W High',   val: `₹${plan.high_52w}`,  color: 'text-slate-300' },
            { label: '52W Low',    val: `₹${plan.low_52w}`,   color: 'text-slate-300' },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-slate-400">{label}</div>
              <div className={`text-sm font-bold ${color}`}>{val}</div>
            </div>
          ))}
        </div>

        {/* ── INTERACTIVE CONFIGURATION ── */}
        <div className="bg-blue-950/30 border border-blue-800/50 rounded-xl p-4 space-y-4">
          <div className="text-xs font-semibold text-score-blue uppercase tracking-wide">Configure Trade</div>

          {/* Lots */}
          <div className="flex items-end gap-6 flex-wrap">
            <div>
              <div className="text-[10px] text-slate-400 mb-1">Number of Lots</div>
              <div className="flex items-center gap-1">
                <button onClick={() => setLocalLots(Math.max(1, localLots - 1))}
                  className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-bold">−</button>
                <input type="number" value={localLots} min={1} max={50}
                  onChange={e => setLocalLots(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 text-center bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white font-bold focus:outline-none focus:border-blue-500"
                />
                <button onClick={() => setLocalLots(localLots + 1)}
                  className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-bold">+</button>
              </div>
              <div className="text-[10px] text-blue-400 mt-1">{fmt(plan.lot_size * localLots)} shares total</div>
            </div>
            <div className="text-slate-400 text-xs">
              Phase 1: {fmt((plan.lot_size * localLots) / 2)} shares<br/>
              Total funds: ≈ ₹{fmt(Math.round(fu.total_funds_required * localLots / plan.lots))}
            </div>
          </div>

          {/* Strike selector */}
          <div>
            <div className="text-[10px] text-slate-400 mb-2">CE Strike — click to select (delta target 0.20–0.25)</div>
            <div className="flex gap-2 flex-wrap">
              {allStrikes.map(s => {
                const isSelected    = s.strike === selectedStrike
                const isRecommended = s.is_recommended
                return (
                  <button key={s.strike}
                    onClick={() => { setSelectedStrike(s.strike); setPremiumLimit(s.ltp) }}
                    className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs transition-colors ${
                      isSelected
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-800 border-border text-slate-300 hover:border-blue-500'
                    }`}>
                    <span className="font-bold text-sm">₹{s.strike}</span>
                    <span className={isSelected ? 'text-blue-200' : 'text-muted'}>{s.pct_otm}% OTM</span>
                    <span className={isSelected ? 'text-blue-200' : 'text-slate-400'}>₹{s.ltp} ltp</span>
                    {s.delta != null && <span className={isSelected ? 'text-blue-200' : 'text-muted'}>δ {s.delta}</span>}
                    {isRecommended && <span className="text-[9px] mt-0.5 text-score-green">★ rec</span>}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Apply button */}
          {(hasChanges) && (
            <button onClick={apply} disabled={applying}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg text-sm font-semibold">
              {applying ? '⏳ Recalculating…' : '↻ Apply Changes & Recalculate Plan'}
            </button>
          )}
        </div>

        {/* ── LIMIT PRICES ── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-amber mb-1 uppercase tracking-wide">Limit Prices</div>
          <div className="text-[10px] text-blue-400 mb-3">
            Never use market orders for covered calls — always use limit prices to control execution.
            Defaults are set to live prices; adjust as needed.
          </div>
          <div className="grid grid-cols-3 gap-4">
            <NumericInput
              label={`Phase 1 Buy Limit (${fmt((plan.lot_size * localLots) / 2)} shares)`}
              value={phase1Limit} onChange={setPhase1Limit} step={0.5} min={1} unit="₹"
            />
            <NumericInput
              label={`Phase 2 Buy Limit (avg trigger)`}
              value={phase2Limit} onChange={setPhase2Limit} step={0.5} min={1} unit="₹"
            />
            <NumericInput
              label={`CE Sell Premium Limit`}
              value={premiumLimit} onChange={setPremiumLimit} step={0.05} min={0.05} unit="₹"
            />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-4 text-[11px] text-slate-400">
            <div>Income: ₹{fmt(Math.round(premiumLimit * plan.lot_size * localLots))}</div>
            <div>P1 cost: ₹{fmt(Math.round(phase1Limit * (plan.lot_size * localLots) / 2))}</div>
            <div>Breakeven: ₹{Math.round((phase1Limit - premiumLimit * plan.lot_size * localLots / ((plan.lot_size * localLots) / 2)) * 100) / 100}</div>
          </div>
        </div>

        {/* Phase 1 */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-blue mb-3 uppercase tracking-wide">Phase 1 — Initial Entry</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">Buy quantity</span>
                <span className="text-white font-semibold">{fmt(ts.phase1_qty)} shares (½ lot × {localLots})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Limit price</span>
                <span className="text-score-amber font-bold">₹{phase1Limit}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Phase 1 capital</span>
                <span className="text-score-amber font-semibold">₹{fmt(ts.phase1_cost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Breakeven</span>
                <span className="text-score-amber">₹{ts.breakeven}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">Expiry</span>
                <span className="text-white font-semibold">{ts.expiry} ({ts.days_to_expiry}d)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Sell CE Strike</span>
                <span className="text-white font-bold">₹{selectedStrike} CE</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">CE Sell Limit</span>
                <span className="text-score-green font-bold">₹{premiumLimit} × {fmt(plan.lot_size * localLots)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Premium income</span>
                <span className="text-score-green">₹{fmt(Math.round(premiumLimit * plan.lot_size * localLots))}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 bg-blue-950/40 border border-blue-800/40 rounded-lg px-3 py-2 text-xs text-blue-300">
            ⏰ {ts.expiry_note}
          </div>
        </div>

        {/* Phase 2 */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-amber mb-3 uppercase tracking-wide">
            Phase 2 — Add 2nd Chunk ({plan.avg_pct}% below entry)
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">Trigger price</span>
                <span className="text-score-red font-semibold">₹{av.phase2_trigger} ({av.phase2_trigger_pct}%)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Add quantity</span>
                <span className="text-white">{fmt(av.phase2_qty)} shares</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Buy Limit</span>
                <span className="text-score-amber font-bold">₹{phase2Limit}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Phase 2 cost</span>
                <span className="text-score-amber">₹{fmt(av.phase2_cost)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">New avg cost</span>
                <span className="text-white font-semibold">₹{av.avg_cost_after}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Full lot held</span>
                <span className="text-white">{fmt(plan.lot_size * localLots)} shares</span>
              </div>
            </div>
          </div>
        </div>

        {/* Total Funds */}
        <div className="bg-amber-950/30 border border-amber-800/50 rounded-xl p-4">
          <div className="text-xs font-semibold text-score-amber mb-3 uppercase tracking-wide">Total Funds Required</div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-300">Full lot stock (both phases)</span>
              <span className="text-white">₹{fmt(fu.full_lot_stock)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-300">CE Margin (SPAN ~12%)</span>
              <span className="text-white">₹{fmt(fu.ce_margin_estimate)}</span>
            </div>
            <div className="flex justify-between border-t border-amber-800/50 pt-2">
              <span className="text-score-amber font-semibold">TOTAL REQUIRED</span>
              <span className="text-score-amber font-bold text-base">₹{fmt(fu.total_funds_required)}</span>
            </div>
          </div>
          <div className="text-[11px] text-blue-400 mt-2">{fu.note}</div>
        </div>

        {/* 4 Scenarios */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-white mb-3 uppercase tracking-wide">4-Scenario P&L</div>
          <div className="space-y-3">
            {[
              { data: sc.case1_bull, bg: 'bg-green-950/40 border-green-800/50', hdr: 'text-score-green', badge: 'bg-green-900 border-green-700 text-score-green',
                rows: [['Stock P&L', fmtPnl(sc.case1_bull.stock_pnl), 'text-score-green'], ['Max Profit', `${fmtPnl(sc.case1_bull.max_profit)} (${sc.case1_bull.return_pct}%)`, 'text-score-green font-bold'], ['Probable Loss', 'None ✓', 'text-score-green']] },
              { data: sc.case2_flat, bg: 'bg-blue-950/40 border-blue-800/50', hdr: 'text-score-blue', badge: 'bg-blue-900 border-blue-700 text-score-blue',
                rows: [['Max Profit', `${fmtPnl(sc.case2_flat.max_profit)} (${sc.case2_flat.return_pct}%)`, 'text-score-blue font-bold'], ['Probable Loss', 'None ✓', 'text-score-green']] },
              { data: sc.case3_dip, bg: 'bg-amber-950/40 border-amber-800/50', hdr: 'text-score-amber', badge: 'bg-amber-900 border-amber-700 text-score-amber',
                rows: [['CE Profit', fmtPnl(sc.case3_dip.ce_profit), 'text-score-green font-medium'], ['P1 Unrealised', `₹${Math.abs(sc.case3_dip.phase1_unrealised).toLocaleString('en-IN')} (temp)`, 'text-score-red'], ['New Avg', `₹${sc.case3_dip.new_avg_cost}`, 'text-white font-medium'], ['Probable Loss', `₹${fmt(sc.case3_dip.probable_loss)} (recoverable)`, 'text-score-amber']] },
              { data: sc.case4_breakdown, bg: 'bg-red-950/30 border-red-800/50', hdr: 'text-score-red', badge: 'bg-red-900 border-red-700 text-score-red',
                rows: [['CE Profit', fmtPnl(sc.case4_breakdown.ce_profit), 'text-score-green font-medium'], ['Stock Unrealised', `₹${fmt(sc.case4_breakdown.probable_loss)} (hold)`, 'text-score-red'], ['Avg Cost', `₹${av.avg_cost_after}`, 'text-white'], ['Probable Loss', `₹${fmt(sc.case4_breakdown.probable_loss)} (prolonged)`, 'text-score-red']] },
            ].map(({ data, bg, hdr, badge, rows }, i) => (
              <div key={i} className={`${bg} border rounded-lg p-3`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-semibold ${hdr}`}>Case {i+1} — {data.label}</span>
                  <span className={`px-2 py-0.5 border rounded text-[10px] font-bold ${badge}`}>{data.probability}% probability</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] mb-1.5">
                  {rows.map(([label, val, cls]) => (
                    <>
                      <span key={`l-${label}`} className="text-slate-300">{label}</span>
                      <span key={`v-${label}`} className={cls as string}>{val as string}</span>
                    </>
                  ))}
                </div>
                <div className="text-[11px] text-blue-400 italic">{data.action}</div>
              </div>
            ))}
          </div>
        </div>

        {/* IV Spike Risk */}
        {plan.iv_spike_risk && plan.iv_spike_risk.risk_level !== 'low' && (
          <div className={`border rounded-xl p-4 space-y-2 ${plan.iv_spike_risk.risk_level === 'high' ? 'bg-red-950/50 border-red-800' : 'bg-amber-950/40 border-amber-800/60'}`}>
            <div className={`text-xs font-bold uppercase tracking-wide ${plan.iv_spike_risk.risk_level === 'high' ? 'text-score-red' : 'text-score-amber'}`}>
              {plan.iv_spike_risk.risk_level === 'high' ? '🚨 HIGH IV SPIKE RISK' : '⚠ IV SPIKE RISK'}
            </div>
            {plan.iv_spike_risk.risks.map((r, i) => <div key={i} className="text-sm text-white">{r}</div>)}
            <div className={`text-xs font-semibold ${plan.iv_spike_risk.risk_level === 'high' ? 'text-score-red' : 'text-score-amber'}`}>{plan.iv_spike_risk.recommendation}</div>
          </div>
        )}

        {/* Greeks */}
        {plan.greeks && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-white uppercase tracking-wide">Option Greeks — CE ₹{selectedStrike}</div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${plan.iv_spike_risk?.risk_level === 'high' ? 'bg-red-950 border border-red-800 text-score-red' : plan.iv_spike_risk?.risk_level === 'medium' ? 'bg-amber-950 border border-amber-800 text-score-amber' : 'bg-green-950 border border-green-800 text-score-green'}`}>
                IV Spike Risk: {plan.iv_spike_risk?.risk_level?.toUpperCase()}
              </span>
            </div>
            <div className="space-y-3">
              {Object.entries(plan.greeks).map(([key, g]) => {
                const verdictColor = g.verdict.includes('✓') || g.verdict.toLowerCase().includes('good') || g.verdict.toLowerCase().includes('working') || g.verdict.toLowerCase().includes('rich') ? 'text-score-green' : g.verdict.includes('⚠') || g.verdict.toLowerCase().includes('risk') || g.verdict.toLowerCase().includes('elevated') ? 'text-score-red' : 'text-score-amber'
                const greekLabel: Record<string, string> = { delta: 'Δ Delta', theta: 'Θ Theta', vega: 'ν Vega', gamma: 'Γ Gamma', iv_current: 'IV Level' }
                return (
                  <div key={key} className="bg-slate-800/60 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-white shrink-0 w-20">{greekLabel[key] || key}</span>
                        <span className="text-xs font-semibold text-score-amber">{g.label}</span>
                      </div>
                      <span className={`text-[10px] font-bold shrink-0 ${verdictColor}`}>{g.verdict}</span>
                    </div>
                    <div className="text-[11px] text-blue-400 leading-relaxed">{g.meaning}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Volatility analysis */}
        <VolatilityPanel
          symbol={plan.symbol}
          currentStrike={ts.strike_recommended}
          currentOtmPct={Math.round((ts.strike_recommended / plan.cmp - 1) * 100 * 10) / 10}
          optionType="CE"
        />

        {/* Price range */}
        {plan.price_range && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs font-semibold text-white mb-3 uppercase tracking-wide">
              Expected Range by Expiry ({plan.price_range.days_to_expiry}d · IV {plan.price_range.iv_used}%)
            </div>
            <div className="grid grid-cols-2 gap-3 mb-2">
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-400 mb-0.5">IV Model — 68%</div>
                <div className="text-sm font-bold text-white">₹{plan.price_range.low_1sd.toLocaleString('en-IN')} – ₹{plan.price_range.high_1sd.toLocaleString('en-IN')}</div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 text-center">
                <div className="text-[10px] text-slate-400 mb-0.5">IV Model — 95%</div>
                <div className="text-sm font-bold text-slate-300">₹{plan.price_range.low_2sd.toLocaleString('en-IN')} – ₹{plan.price_range.high_2sd.toLocaleString('en-IN')}</div>
              </div>
            </div>
            {plan.price_range.has_historical && (
              <div className="grid grid-cols-2 gap-3 mb-2">
                <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 text-center">
                  <div className="text-[10px] text-score-amber mb-0.5">Blended 68% (wider)</div>
                  <div className="text-sm font-bold text-score-amber">₹{plan.price_range.low_1sd_blended.toLocaleString('en-IN')} – ₹{plan.price_range.high_1sd_blended.toLocaleString('en-IN')}</div>
                </div>
                <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 text-center">
                  <div className="text-[10px] text-score-amber mb-0.5">Worst historical cycle</div>
                  <div className="text-sm font-bold text-score-amber">
                    {plan.price_range.hist_max_cycle_up ? `+${plan.price_range.hist_max_cycle_up}%` : '—'}
                    {' / '}{plan.price_range.hist_max_cycle_down ? `${plan.price_range.hist_max_cycle_down}%` : '—'}
                  </div>
                </div>
              </div>
            )}
            <div className="text-[10px] text-blue-400 italic">{plan.price_range.note}</div>
          </div>
        )}

        {/* Summary */}
        <div className="bg-slate-800/60 border border-border rounded-xl p-4 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-300">Best case max profit</span>
            <span className="text-score-green font-bold">₹{fmt(su.max_profit)} — {su.max_profit_case}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-300">Worst case (if held)</span>
            <span className="text-score-red font-bold">₹{fmt(su.probable_loss_breakdown)} unrealised (recoverable)</span>
          </div>
          <div className="text-slate-300 leading-relaxed">{su.margin_note}</div>
          <div className="text-[11px] text-blue-400 italic">{su.probable_loss_note}</div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button onClick={() => onPaperTrade(plan, { phase1Limit, phase2Limit, premiumLimit, lots: localLots })}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold">
            📋 Add to Paper Trade ({localLots} lot{localLots > 1 ? 's' : ''} · {fmt(plan.lot_size * localLots)} shares)
          </button>
          <button className="flex-1 py-3 bg-slate-700 border border-border text-muted rounded-xl text-sm font-medium cursor-not-allowed opacity-60" title="After Angel One integration">
            🔗 Live Trade (Coming Soon)
          </button>
        </div>
        <div className="text-[10px] text-blue-400 text-center">
          Always use limit orders — never market price. Default limits are live prices; adjust before placing.
        </div>
      </div>
    </div>
  )
}

interface OrderOptions { phase1Limit: number; phase2Limit: number; premiumLimit: number; lots: number }


// ─── Scanner Tab ───────────────────────────────────────────────────────────────

interface ScanCriteria {
  flat_pct: string
  below_high_pct: string
  above_low_pct: string
  below_sma50_pct: string
  min_score: string
  min_iv: string
  results_days: string
}

const DEFAULT_CRITERIA: ScanCriteria = {
  flat_pct:        '2.5',
  below_high_pct:  '5',
  above_low_pct:   '10',
  below_sma50_pct: '10',
  min_score:       '0',
  min_iv:          '20',
  results_days:    '7',
}

interface AssessResult extends ScanResult {
  eligible: boolean
  atm_iv: number | null
  high_risk_count: number
  change_1d?: number
  opportunity_score?: number
  opportunity_label?: string
  opportunity_reason?: string
  warnings: { level: 'ok' | 'medium' | 'high'; category: string; message: string }[]
}

const CRITERIA_STORAGE_KEY = 'aegisai-cc-criteria-v2'   // v2: bumped to clear old saved criteria with stricter defaults

function ScannerTab({ onViewPlan }: { onViewPlan: (symbol: string) => void }) {
  const [results, setResults]       = useState<ScanResult[]>([])
  const [loading, setLoading]       = useState(false)
  const [scanned, setScanned]       = useState<number | null>(null)
  const [whyEmpty, setWhyEmpty]     = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [criteria, setCriteria]     = useState<ScanCriteria>(() => {
    try {
      const saved = localStorage.getItem(CRITERIA_STORAGE_KEY)
      return saved ? { ...DEFAULT_CRITERIA, ...JSON.parse(saved) } : DEFAULT_CRITERIA
    } catch { return DEFAULT_CRITERIA }
  })
  const [showCriteria, setShowCriteria] = useState(false)

  // Multi-stock assess
  const [assessInput, setAssessInput]     = useState('')
  const [assessLoading, setAssessLoading] = useState(false)
  const [oppScore1, setOppScore1]         = useState('3')    // cc: rose ≥3% = score 1
  const [oppScore2, setOppScore2]         = useState('1')    // cc: rose ≥1% = score 2
  const [assessResults, setAssessResults] = useState<AssessResult[]>([])

  const updateCriteria = (k: keyof ScanCriteria, v: string) =>
    setCriteria(prev => ({ ...prev, [k]: v }))

  const saveCriteria = () => {
    localStorage.setItem(CRITERIA_STORAGE_KEY, JSON.stringify(criteria))
    // brief flash to confirm
  }

  const resetCriteria = () => {
    setCriteria(DEFAULT_CRITERIA)
    localStorage.removeItem(CRITERIA_STORAGE_KEY)
  }

  const scan = async () => {
    setLoading(true)
    setAssessResults([])
    try {
      const params = new URLSearchParams({
        flat_pct:        criteria.flat_pct,
        below_high_pct:  criteria.below_high_pct,
        above_low_pct:   criteria.above_low_pct,
        below_sma50_pct: criteria.below_sma50_pct,
        min_score:       criteria.min_score,
        min_iv:          criteria.min_iv,
        strategy:        'cc',
        opp_score1:      String(oppScore1 !== '' ? parseFloat(oppScore1) : 3),
        opp_score2:      String(oppScore2 !== '' ? parseFloat(oppScore2) : 1),
        results_days:    criteria.results_days,
      })
      const r = await client.get(`/covered-calls/scan/strategy?${params}`)
      setResults(r.data.stocks || [])
      setScanned(r.data.scanned)
      setWhyEmpty(r.data.why_empty || null)
      setLastUpdated(new Date())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const assessStocks = async () => {
    const syms = assessInput.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    if (!syms.length) return
    setAssessLoading(true)
    setResults([])
    try {
      const r = await client.post('/covered-calls/assess', {
        symbols: syms, min_iv: parseFloat(criteria.min_iv) || 25,
        opp_score1: oppScore1 !== '' ? parseFloat(oppScore1) : 3,
        opp_score2: oppScore2 !== '' ? parseFloat(oppScore2) : 1,
      })
      setAssessResults(r.data.results || [])  // show ALL, not just eligible
      setLastUpdated(new Date())
    } catch { /* ignore */ }
    finally { setAssessLoading(false) }
  }

  const displayResults = assessResults.length > 0 ? assessResults : results

  return (
    <div className="space-y-4">
      {/* Scanner header */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-white mb-1">Covered Call Strategy Scanner</div>
            <div className="text-xs text-slate-300 max-w-xl leading-relaxed">
              Auto-scans F&O stocks against configurable criteria. Or enter specific stocks below to assess them directly.
            </div>
          </div>
          <div className="flex gap-2 ml-4 shrink-0">
            <button onClick={() => setShowCriteria(!showCriteria)}
              className="px-3 py-2 bg-card border border-border text-muted hover:text-white rounded-lg text-xs font-medium">
              ⚙ {showCriteria ? 'Hide' : 'Edit'} Criteria
            </button>
            <button onClick={scan} disabled={loading || assessLoading}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
              {loading ? '🔍 Scanning…' : '🔍 Scan F&O Universe'}
            </button>
          </div>
        </div>

        {/* Active criteria summary — always visible */}
        <div className="flex flex-wrap gap-2 text-[10px]">
          {[
            { label: '5d Flat', val: `≤${criteria.flat_pct}%` },
            { label: 'Below 52W High', val: `≥${criteria.below_high_pct}%` },
            { label: 'Above 52W Low', val: `≥${criteria.above_low_pct}%` },
            { label: 'Max below 50DMA', val: `${criteria.below_sma50_pct}%` },
            { label: 'Min IV', val: parseFloat(criteria.min_iv) > 0 ? `≥${criteria.min_iv}%` : 'OFF' },
            { label: 'Min Score', val: parseFloat(criteria.min_score) > 0 ? `≥${criteria.min_score}` : 'OFF' },
            { label: 'Results window', val: `${criteria.results_days}d` },
          ].map(({ label, val }) => (
            <span key={label} className="px-2 py-0.5 bg-slate-800 border border-border rounded text-slate-300">
              <span className="text-muted">{label}: </span>{val}
            </span>
          ))}
          <button onClick={resetCriteria} className="px-2 py-0.5 text-blue-400 hover:text-score-blue text-[10px]">
            Reset defaults
          </button>
        </div>

        {/* Editable criteria */}
        {showCriteria && (
          <div className="border-t border-border pt-4">
            <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Scan Criteria (editable)</div>
            <div className="grid grid-cols-3 gap-3">
              {([
                { key: 'flat_pct',        label: '5-Session Flat %',    unit: '%',    hint: 'Max price change over 5 days (both sides)' },
                { key: 'below_high_pct',  label: 'Below 52W High',      unit: '%',    hint: 'Must be at least X% below 52W high' },
                { key: 'above_low_pct',   label: 'Above 52W Low',       unit: '%',    hint: 'Must be at least X% above 52W low' },
                { key: 'below_sma50_pct', label: 'Max below 50 DMA',    unit: '%',    hint: 'Exclude stocks more than X% below 50DMA (breakdown filter)' },
                { key: 'min_iv',          label: 'Min ATM IV',           unit: '%',    hint: 'Exclude if IV below this — premium too thin. Default 20%. Set to 0 to disable.' },
                { key: 'min_score',       label: 'Min AegisAI Score',   unit: '/100', hint: '0 = no score filter' },
                { key: 'results_days',    label: 'Results window',       unit: 'days', hint: 'Exclude stocks with results/events within this many days (default 7)' },
              ] as { key: keyof ScanCriteria; label: string; unit: string; hint: string }[]).map(f => (
                <div key={f.key}>
                  <label className="text-[10px] text-slate-300 block mb-1">{f.label}</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" value={criteria[f.key]} step="1" min="0"
                      onChange={e => updateCriteria(f.key, e.target.value)}
                      className="w-full bg-slate-800 border border-border rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-xs text-slate-300 shrink-0">{f.unit}</span>
                  </div>
                  <div className="text-[10px] text-blue-400 mt-0.5 leading-tight">{f.hint}</div>
                </div>
              ))}
            </div>
            <button onClick={saveCriteria}
              className="mt-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium mr-2">
              💾 Save Criteria
            </button>
            <button onClick={resetCriteria}
              className="mt-3 text-xs text-slate-400 hover:text-score-blue underline">
              Reset to defaults
            </button>
          </div>
        )}

        {/* Multi-stock assess */}
        <div className="border-t border-border pt-4">
          <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Assess Specific Stocks</div>
          <div className="flex gap-3 items-start">
            <div className="flex-1 relative">
              <NseStockSearch
                onSelect={(sym, _name) => {
                  const bare = sym.replace('.NS', '')
                  if (!assessInput.split(/[\s,]+/).map(s => s.trim().toUpperCase()).includes(bare)) {
                    setAssessInput(prev => prev ? prev + ', ' + bare : bare)
                  }
                }}
                placeholder="Search and add NSE stocks (e.g. VEDL, TATASTEEL, BEL)"
                includeEtfIndex={false}
              />
              {assessInput && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {assessInput.split(/[\s,]+/).filter(Boolean).map(s => (
                    <span key={s}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-950 border border-blue-800 text-score-blue rounded text-xs font-medium">
                      {s}
                      <button
                        onClick={() => setAssessInput(
                          assessInput.split(/[\s,]+/).filter(x => x.trim() !== s).join(', ')
                        )}
                        className="text-muted hover:text-score-red ml-0.5">×</button>
                    </span>
                  ))}
                  <button onClick={() => setAssessInput('')} className="text-[10px] text-muted hover:text-score-red ml-1">Clear all</button>
                </div>
              )}
            </div>
            <button onClick={assessStocks}
              disabled={assessLoading || !assessInput.trim() || loading}
              className="px-5 py-2.5 bg-score-green hover:bg-green-600 disabled:opacity-50 text-white rounded-lg text-sm font-semibold whitespace-nowrap shrink-0">
              {assessLoading ? '⏳ Assessing…' : '✓ Assess Covered Call'}
            </button>
          </div>
          {/* Opportunity score thresholds */}
          <div className="flex items-center gap-2 text-xs text-muted mt-1.5">
            <span>🔥 Score 1 if rose ≥</span>
            <input type="number" value={oppScore1} onChange={e => setOppScore1(e.target.value)}
              className="w-14 bg-slate-800 border border-border rounded px-1.5 py-0.5 text-white text-xs text-right"
              step="0.5" placeholder="3" />
            <span>% · Score 2 if rose ≥</span>
            <input type="number" value={oppScore2} onChange={e => setOppScore2(e.target.value)}
              className="w-14 bg-slate-800 border border-border rounded px-1.5 py-0.5 text-white text-xs text-right"
              step="0.5" placeholder="1" />
            <span>% (defaults: 3% / 1%)</span>
          </div>
          <div className="text-[11px] text-blue-400 mt-1.5">
            Search and add multiple stocks — evaluates any F&O stock regardless of auto-scan criteria.
          </div>
        </div>
      </div>

      {(loading || assessLoading) && (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <div className="text-3xl mb-3 animate-spin inline-block">⊙</div>
          <div className="text-sm text-slate-300">{loading ? 'Scanning F&O universe…' : 'Assessing your stocks…'}</div>
          <div className="text-xs text-slate-400 mt-1">This takes 30–60 seconds</div>
        </div>
      )}

      {!loading && !assessLoading && displayResults.length === 0 && scanned !== null && (
        <div className="bg-card border border-border rounded-xl p-6 text-center space-y-3">
          <div className="text-3xl">🔎</div>
          <div className="text-white font-semibold">No stocks qualified from {scanned} scanned</div>
          {whyEmpty && (
            <div className="bg-slate-800/60 border border-border rounded-lg px-4 py-3 text-left text-sm text-slate-300 leading-relaxed max-w-xl mx-auto">
              {whyEmpty}
            </div>
          )}
          <div className="text-xs text-blue-400">
            Tip: Open "⚙ Edit Criteria" and try reducing thresholds — e.g. Below 52W High → 3%, Above 52W Low → 8%, Min IV → 15%
          </div>
        </div>
      )}

      {!loading && !assessLoading && displayResults.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="text-xs text-muted">
              {assessResults.length > 0
                ? `${assessResults.filter(r => (r as AssessResult).eligible !== false).length} eligible, ${assessResults.filter(r => (r as AssessResult).eligible === false).length} with risks — from ${assessInput.split(/[\s,]+/).filter(Boolean).length} stocks`
                : `${displayResults.length} stocks qualified from ${scanned} scanned`}
              {lastUpdated && <span> · {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
            <div className="text-xs text-muted">Click "Plan" for full trade setup</div>
          </div>

          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] text-muted border-b border-border bg-slate-800/40">
                  <th className="text-left px-5 py-2.5">Stock</th>
                  <th className="text-right px-3 py-2.5">CMP</th>
                  <th className="text-right px-3 py-2.5" title="5-day % change">5d %</th>
                  <th className="text-center px-3 py-2.5" title="Opportunity score (1=best)">Opp</th>
                  <th className="text-right px-3 py-2.5">ATM IV</th>
                  <th className="text-right px-3 py-2.5">From High</th>
                  <th className="text-right px-3 py-2.5">From Low</th>
                  <th className="text-center px-3 py-2.5">200DMA</th>
                  <th className="text-right px-3 py-2.5">Lot</th>
                  <th className="text-right px-3 py-2.5">Phase1 Capital</th>
                  <th className="text-right px-3 py-2.5">Total Funds</th>
                  <th className="text-center px-3 py-2.5">Score</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {displayResults.map(r => {
                  const ar = r as AssessResult
                  const hasWarnings = ar.warnings && ar.warnings.length > 0
                  const highRisks = ar.warnings?.filter(w => w.level === 'high') || []
                  const rowBg = !ar.eligible && hasWarnings
                    ? highRisks.length > 0 ? 'bg-red-950/10' : 'bg-amber-950/10'
                    : ''
                  return (
                    <>
                      <tr key={r.symbol} className={`border-b ${hasWarnings ? 'border-border/20' : 'border-border/40'} hover:bg-slate-800/20 ${rowBg}`}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            {ar.eligible === false && highRisks.length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 bg-red-950 border border-red-800 text-score-red rounded font-bold">RISK</span>
                            )}
                            <div>
                              <div className="font-bold text-white">{r.symbol}</div>
                              <div className="text-[10px] text-muted truncate max-w-[120px]">{r.name}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="font-semibold text-white">₹{r.cmp}</div>
                          <div className={`text-[10px] ${r.change_1d == null ? 'text-muted' : r.change_1d > 0 ? 'text-score-green' : r.change_1d < 0 ? 'text-score-red' : 'text-muted'}`}>
                            {r.change_1d != null ? `${r.change_1d >= 0 ? '+' : ''}${r.change_1d.toFixed(2)}%` : ''}
                          </div>
                        </td>
                        {/* 5d % change column */}
                        <td className={`px-3 py-3 text-right text-xs font-medium ${r.change_5d == null ? 'text-muted' : r.change_5d > 0 ? 'text-score-green' : r.change_5d < 0 ? 'text-score-red' : 'text-muted'}`}>
                          {r.change_5d != null ? `${r.change_5d >= 0 ? '+' : ''}${r.change_5d}%` : '—'}
                        </td>
                        {/* Opportunity score */}
                        <td className="px-3 py-3 text-center">
                          {r.opportunity_score != null ? (
                            <span title={r.opportunity_reason} className={`text-xs font-bold px-1.5 py-0.5 rounded border ${
                              r.opportunity_score === 1 ? 'bg-amber-950 border-amber-700 text-amber-300' :
                              r.opportunity_score === 2 ? 'bg-blue-950 border-blue-800 text-blue-300' :
                              'bg-slate-800 border-slate-700 text-slate-400'
                            }`}>
                              {r.opportunity_score}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right text-xs">
                          {(ar.atm_iv ?? r.atm_iv) != null
                            ? <span className={(ar.atm_iv ?? r.atm_iv)! >= parseFloat(criteria.min_iv) ? 'text-score-green' : 'text-score-red'}>{ar.atm_iv ?? r.atm_iv}%</span>
                            : <span className="text-muted">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right text-xs text-score-red">{r.pct_from_high}%</td>
                        <td className="px-3 py-3 text-right text-xs text-score-green">+{r.pct_from_low}%</td>
                        <td className="px-3 py-3 text-center text-xs">
                          <span className={r.above_200dma ? 'text-score-green' : 'text-score-red'}>{r.above_200dma ? '✓' : '✗'}</span>
                        </td>
                        <td className="px-3 py-3 text-right text-muted text-xs">{fmt(r.lot_size)}</td>
                        <td className="px-3 py-3 text-right text-score-amber text-xs font-medium">₹{fmt(r.phase1_cost)}</td>
                        <td className="px-3 py-3 text-right text-muted text-xs">₹{fmt(r.total_funds_required)}</td>
                        <td className="px-3 py-3 text-center">
                          <span className="text-sm font-bold" style={{ color: scoreToColor(r.score) }}>{r.score}</span>
                        </td>
                        <td className="px-3 py-3">
                          <button onClick={() => onViewPlan(r.symbol)}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium whitespace-nowrap">
                            Plan →
                          </button>
                        </td>
                      </tr>
                      {/* Warnings row for assess results */}
                      {hasWarnings && (
                        <tr key={`${r.symbol}-warn`} className={`border-b border-border/60 ${rowBg}`}>
                          <td colSpan={12} className="px-5 pb-3 pt-0">
                            <div className="space-y-1">
                              {ar.warnings.map((w, wi) => (
                                <div key={wi} className={`flex items-start gap-2 text-xs rounded-lg px-3 py-1.5 ${
                                  w.level === 'high' ? 'bg-red-950/60 text-red-300' :
                                  w.level === 'medium' ? 'bg-amber-950/40 text-amber-300' :
                                  'bg-green-950/40 text-score-green'
                                }`}>
                                  <span className="shrink-0 mt-0.5">{w.level === 'high' ? '🚨' : w.level === 'medium' ? '⚠' : '✓'}</span>
                                  <span><span className="font-semibold">{w.category}:</span> {w.message}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-amber-950/30 border border-amber-800/30 rounded-xl px-4 py-3 text-[11px] text-amber-300">
            ⚠️ Scanner excludes stocks with upcoming results and IV below {criteria.min_iv}%. Assess mode shows all stocks with warnings. No hard stop-loss strategy.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Covered Calls Page ───────────────────────────────────────────────────


export default function CoveredCalls() {
  const { portfolio } = usePortfolio()
  const [tab, setTab] = useState<'scanner' | 'chain'>('scanner')

  // Scanner state
  const [planSymbol, setPlanSymbol] = useState<string | null>(null)
  const [plan, setPlan] = useState<TradePlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [avgPct, setAvgPct] = useState('3')
  const [lots, setLots] = useState('1')

  // Chain state
  const [symbol, setSymbol] = useState('')
  const [selectedExpiry, setSelectedExpiry] = useState('')
  const [data, setData] = useState<OptionChainData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'suggestions' | 'chain'>('suggestions')

  const eligibleHoldings = portfolio?.holdings.filter(h => h.covered_call_eligible) || []

  const fetchPlan = async (sym: string, lotsOverride?: number, strikeOverride?: number) => {
    setPlanLoading(true)
    if (!planSymbol || sym !== planSymbol) setPlanSymbol(sym)
    setPlan(null)
    try {
      const lotsVal = lotsOverride ?? parseInt(lots) ?? 1
      const strikeParam = strikeOverride && strikeOverride > 0 ? `&strike_override=${strikeOverride}` : ''
      const r = await client.get(`/covered-calls/plan/${sym}?avg_pct=${avgPct}&lots=${lotsVal}${strikeParam}`)
      setPlan(r.data)
    } catch { /* ignore */ }
    finally { setPlanLoading(false) }
  }

  const handleRefetch = (newLots: number, strikeOverride: number) => {
    if (planSymbol) fetchPlan(planSymbol, newLots, strikeOverride)
  }

  const fetchChain = async (sym: string, expiry?: string) => {
    if (!sym.trim()) return
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string> = {}
      if (expiry) params.expiry = expiry
      const res = await client.get(`/covered-calls/${normalizeSymbol(sym)}`, { params })
      setData(res.data)
      if (!expiry && res.data.expiry_dates?.length) setSelectedExpiry(res.data.expiry_dates[0])
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Failed to load option chain.')
    } finally { setLoading(false) }
  }

  const handlePaperTrade = async (p: TradePlan, opts: OrderOptions) => {
    try {
      const bare = p.symbol.replace('.NS', '')
      const r = await client.post('/paper/covered-call', {
        symbol:         bare,
        company_name:   p.name,
        lots:           opts.lots,
        lot_size:       p.lot_size,
        phase1_qty:     Math.round((p.lot_size * opts.lots) / 2),
        phase1_limit:   opts.phase1Limit,
        phase2_qty:     Math.round((p.lot_size * opts.lots) / 2),
        phase2_limit:   opts.phase2Limit,
        phase2_trigger: p.averaging.phase2_trigger,
        strike:         p.trade_setup.strike_recommended,
        expiry:         p.trade_setup.expiry,
        sell_premium:   opts.premiumLimit,
        premium_income: Math.round(opts.premiumLimit * p.lot_size * opts.lots),
        avg_pct:        p.avg_pct,
        notes:          `CC Plan — ₹${opts.phase1Limit} limit, Sell ${bare}${Math.round(p.trade_setup.strike_recommended)}CE @ ₹${opts.premiumLimit}`,
      })
      const tid = r.data.trade_id
      alert(
        `✅ Covered Call paper trade created!\n\n` +
        `Trade ID: ${tid}\n` +
        `Stock: Buy ${p.symbol} in 2 chunks at ₹${opts.phase1Limit} and ₹${opts.phase2Limit}\n` +
        `Option: Sell ${bare}${Math.round(p.trade_setup.strike_recommended)}CE @ ₹${opts.premiumLimit}\n` +
        `Premium income: ₹${Math.round(opts.premiumLimit * p.lot_size * opts.lots).toLocaleString('en-IN')}\n\n` +
        `Go to Paper Trade → Active Trades to monitor.\nOptions Positions tab shows the short CE.`
      )
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      alert('Failed to create paper trade: ' + (msg || 'Unknown error'))
    }
  }

  return (
    <div className="p-6 space-y-5">

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {([
          { key: 'scanner', label: '🔍 Strategy Scanner' },
          { key: 'chain',   label: '📊 Option Chain' },
        ] as { key: 'scanner' | 'chain'; label: string }[]).map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key ? 'border-blue-500 text-white' : 'border-transparent text-muted hover:text-white'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Scanner Tab ── */}
      {tab === 'scanner' && (
        <>
          {/* Config: avg pct + lots */}
          <div className="flex items-center gap-4 bg-card border border-border rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-300">2nd chunk trigger:</span>
              <input type="number" value={avgPct} min={1} max={10} step={0.5}
                onChange={e => setAvgPct(e.target.value)}
                className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-slate-400">% below entry</span>
              <span className="text-xs text-score-amber font-medium">(rec: 3%)</span>
            </div>
            <div className="h-4 border-l border-border" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-300">Lots to trade:</span>
              <input type="number" value={lots} min={1} max={50} step={1}
                onChange={e => setLots(e.target.value)}
                className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-blue-400">All plan figures scale to selected lots</span>
            </div>
          </div>

          <ScannerTab onViewPlan={fetchPlan} />

          {/* Also allow manual symbol entry for plan */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted mb-3">Or enter any F&O stock manually to generate trade plan:</div>
            <NseStockSearch
              onSelect={(sym) => fetchPlan(sym.replace('.NS', ''))}
              placeholder="Search F&O stock (e.g. VEDL, HDFCBANK, BEL)"
            />
          </div>
        </>
      )}

      {/* ── Option Chain Tab ── */}
      {tab === 'chain' && (
        <div className="space-y-5">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-muted">Live NSE Option Chain — covered call opportunities</div>
              {data && <span className="text-[10px] text-score-green bg-green-950 px-2 py-0.5 rounded-full border border-green-800">● Live NSE Data</span>}
            </div>
            <NseStockSearch
              onSelect={(sym) => { setSymbol(sym.replace('.NS','')); fetchChain(sym) }}
              placeholder="Search NSE F&O stock (e.g. VEDL, HDFCBANK)"
            />
            {error && <p className="mt-2 text-xs text-score-red">{error}</p>}
          </div>

          {eligibleHoldings.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs text-muted mb-2">Your CC-eligible holdings (≥100 shares)</div>
              <div className="flex flex-wrap gap-2">
                {eligibleHoldings.map(h => (
                  <button key={h.id}
                    onClick={() => { setSymbol(shortSymbol(h.symbol)); fetchChain(h.symbol) }}
                    className="px-3 py-1.5 bg-slate-800 border border-border rounded-lg text-xs text-white hover:border-blue-500 transition-colors">
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
              <div className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-base font-bold text-white">{data.company_name}</div>
                    <div className="text-xs text-muted">{data.underlying_symbol}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted">Spot Price</div>
                    <div className="text-2xl font-bold text-white">₹{data.current_price.toLocaleString('en-IN')}</div>
                  </div>
                </div>
                <div className="mb-4">
                  <div className="text-xs text-muted mb-2">Select Expiry</div>
                  <div className="flex gap-2 flex-wrap">
                    {data.expiry_dates.map(exp => (
                      <button key={exp}
                        onClick={() => { setSelectedExpiry(exp); if (symbol) fetchChain(symbol, exp) }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          exp === (selectedExpiry || data.expiry_dates[0])
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-800 border-border text-muted hover:text-white'
                        }`}>{exp}</button>
                    ))}
                  </div>
                </div>
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

              <div className="flex gap-2">
                {(['suggestions', 'chain'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      view === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-card border-border text-muted hover:text-white'
                    }`}>
                    {v === 'suggestions' ? 'Covered Call Picks' : 'Full Option Chain'}
                  </button>
                ))}
              </div>

              {view === 'suggestions' && (
                <div className="space-y-3">
                  {data.suggestions.length === 0 ? (
                    <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted">No liquid OTM calls found. Try a later expiry.</div>
                  ) : data.suggestions.map((s, i) => (
                    <div key={i} className="bg-card border border-border rounded-xl p-5">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="bg-slate-800 rounded-lg px-3 py-2 text-center min-w-[80px]">
                            <div className="text-[10px] text-muted">Strike</div>
                            <div className="text-xl font-bold text-white">₹{s.strike.toLocaleString('en-IN')}</div>
                          </div>
                          <div>
                            <div className="text-sm font-medium text-white">{s.label}</div>
                            <div className="text-xs text-muted">+{s.strike_pct_above_spot}% above spot · {s.expiry_date} ({s.days_to_expiry}d)</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { fetchPlan(symbol || data.underlying_symbol); setTab('scanner') }}
                            className="px-3 py-1.5 bg-green-950 border border-green-800 text-score-green hover:bg-green-900 rounded-lg text-xs font-medium"
                          >
                            Use in Plan
                          </button>
                          <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-950 border border-green-800 text-score-green">SELL CALL</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-3">
                        {[
                          { label: 'LTP', val: `₹${s.ltp.toFixed(2)}`, sub: `${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}`, color: 'text-white' },
                          { label: 'Bid/Ask', val: `₹${s.bid.toFixed(2)} / ₹${s.ask.toFixed(2)}`, sub: `Spread ₹${(s.ask - s.bid).toFixed(2)}`, color: 'text-white' },
                          { label: 'IV', val: `${s.iv.toFixed(1)}%`, sub: 'Implied Vol', color: 'text-score-amber' },
                          { label: 'Monthly Yield', val: `${s.monthly_yield_pct}%`, sub: 'on spot price', color: 'text-score-green' },
                        ].map(m => (
                          <div key={m.label} className="bg-slate-800 rounded-lg p-3 text-center">
                            <div className="text-[10px] text-muted mb-1">{m.label}</div>
                            <div className={`text-lg font-bold ${m.color}`}>{m.val}</div>
                            <div className="text-[10px] text-muted mt-0.5">{m.sub}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {view === 'chain' && (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                    <div className="text-sm font-semibold text-white">Option Chain — {data.selected_expiry}</div>
                    <div className="text-xs text-muted">{data.chain.length} strikes · Spot ₹{data.current_price}</div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-slate-800/50">
                          <th className="text-right px-3 py-2.5 text-muted">OI</th>
                          <th className="text-right px-3 py-2.5 text-muted">IV%</th>
                          <th className="text-right px-3 py-2.5 text-muted">Call LTP</th>
                          <th className="text-center px-4 py-2.5 text-white font-bold bg-slate-700">Strike</th>
                          <th className="text-left px-3 py-2.5 text-muted">Put LTP</th>
                          <th className="text-left px-3 py-2.5 text-muted">IV%</th>
                          <th className="text-left px-3 py-2.5 text-muted">OI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.chain.map(row => {
                          const isAtm = Math.abs(row.strike - data.current_price) / data.current_price < 0.015
                          const isSuggested = data.suggestions.some(s => s.strike === row.strike)
                          return (
                            <tr key={row.strike} className={`border-b border-border/40 ${isAtm ? 'bg-blue-950/60' : isSuggested ? 'bg-green-950/30' : 'hover:bg-slate-800/30'}`}>
                              <td className="text-right px-3 py-2 text-slate-400">{row.ce_oi > 0 ? row.ce_oi.toLocaleString('en-IN') : '—'}</td>
                              <td className="text-right px-3 py-2">{row.ce_iv > 0 ? <span className="text-score-amber">{row.ce_iv.toFixed(1)}</span> : '—'}</td>
                              <td className="text-right px-3 py-2 font-medium">
                                {row.ce_ltp > 0 ? <span className="text-white">{row.ce_ltp.toFixed(2)}{row.ce_change !== 0 && <span className={`ml-1 text-[10px] ${row.ce_change > 0 ? 'text-score-green' : 'text-score-red'}`}>({row.ce_change > 0 ? '+' : ''}{row.ce_change.toFixed(2)})</span>}</span> : <span className="text-slate-300">—</span>}
                              </td>
                              <td className={`text-center px-4 py-2 font-bold ${isAtm ? 'text-score-blue' : 'text-white'} bg-slate-700/50`}>
                                {row.strike.toLocaleString('en-IN')}
                                {isAtm && <span className="ml-1 text-[9px] text-score-blue">ATM</span>}
                                {isSuggested && !isAtm && <span className="ml-1 text-[9px] text-score-green">●</span>}
                              </td>
                              <td className="text-left px-3 py-2 font-medium">{row.pe_ltp > 0 ? <span className="text-white">{row.pe_ltp.toFixed(2)}</span> : <span className="text-slate-300">—</span>}</td>
                              <td className="text-left px-3 py-2">{row.pe_iv > 0 ? <span className="text-score-amber">{row.pe_iv.toFixed(1)}</span> : '—'}</td>
                              <td className="text-left px-3 py-2 text-slate-400">{row.pe_oi > 0 ? row.pe_oi.toLocaleString('en-IN') : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Plan slide-over */}
      {planLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <div className="text-3xl mb-3 animate-spin inline-block">⊙</div>
            <div className="text-sm text-muted">Generating trade plan for {planSymbol}…</div>
          </div>
        </div>
      )}
      {plan && !planLoading && (
        <TradePlanPanel
          plan={plan}
          onClose={() => { setPlan(null); setPlanSymbol(null) }}
          onPaperTrade={handlePaperTrade}
          onRefetch={handleRefetch}
        />
      )}
    </div>
  )
}
