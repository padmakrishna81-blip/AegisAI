/**
 * Wheel Strategy Page
 * Combines Cash-Secured Put (Phase 1) + Covered Call (Phase 2) into a continuous income cycle.
 *
 * Phase 1 — Sell Cash-Secured Put:
 *   Collect premium. If stock falls to strike → get assigned at a discount.
 * Phase 2 — Sell Covered Call on assigned stock:
 *   Collect more premium. If stock rises to strike → get called away at profit.
 * Repeat from Phase 1.
 */

import { useState } from 'react'
import client from '../api/client'
import { shortSymbol, scoreToColor } from '../utils/formatters'
import NseStockSearch from '../components/NseStockSearch'
import VolatilityPanel from '../components/VolatilityPanel'

// ─── Types ────────────────────────────────────────────────────────────────────

function _erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  return sign * (1 - p * Math.exp(-x * x))
}
function _normCDF(x: number) { return (1 + _erf(x / Math.sqrt(2))) / 2 }
function probPutWorthless(spot: number, strike: number, ivPct: number, days = 30, rf = 0.065): number {
  const T = days / 365, s = ivPct / 100
  if (T <= 0 || s <= 0 || spot <= 0 || strike <= 0) return 50
  const d2 = (Math.log(spot / strike) + (rf - 0.5 * s * s) * T) / (s * Math.sqrt(T))
  return Math.round(_normCDF(d2) * 100)
}

interface WheelScanResult {
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
  score: number
  // Wheel-specific
  put_strike_otm5: number
  put_strike_otm8: number
  effective_buy_otm5: number
  effective_buy_otm8: number
  total_funds_required: number
  // Computed columns
  put_premium_5pct: number | null   // est. income from selling 5% OTM PE, 1 lot
  put_premium_8pct: number | null   // est. income from selling 8% OTM PE, 1 lot
  max_1sd_move: number | null       // 1σ expected move over 30d in ₹
  expiry_chg_inr: number | null     // ₹ move between last two monthly expiries
  expiry_chg_pct: number | null     // % move between last two monthly expiries
  risk_score_5pct: number | null    // % prob 5% OTM put expires worthless
  risk_score_8pct: number | null    // % prob 8% OTM put expires worthless
}

interface PutPlan {
  symbol: string
  name: string
  cmp: number
  prev_close?: number | null
  change_inr?: number | null
  change_pct?: number | null
  lot_size: number
  lots: number
  high_52w: number
  low_52w: number
  atm_iv: number | null
  // Put leg
  put_strike: number
  put_expiry: string
  put_days_to_expiry: number
  put_premium_live: number
  put_premium_income: number
  put_delta: number | null
  put_theta: number | null
  put_vega:  number | null
  put_oi:    number | null
  effective_buy: number
  margin_required: number    // SPAN margin for short put (~12% of contract value)
  // Planned CC after assignment
  planned_call_strike: number
  planned_call_expiry: string
  planned_call_premium: number
  // Income summary
  total_wheel_income_estimate: number   // put_premium + call_premium
  breakeven: number                      // effective_buy - call_premium/share
  // Adjacent put strikes for user selection
  adjacent_strikes: {
    strike: number; ltp: number; iv: number
    delta: number | null; pct_otm: number; is_recommended: boolean
  }[]
  // Scenario P&L
  scenarios: {
    put_expires_worthless: { probability: number; income: number; action: string }
    assigned_stock_rises:  { probability: number; income: number; effective_buy: number; action: string }
    assigned_stock_flat:   { probability: number; income: number; effective_buy: number; action: string }
    assigned_stock_falls:  { probability: number; probable_loss: number; action: string }
  }
}

interface OrderOptions {
  putLimit: number
  phase2PctDown: number
  plannedCallLimit: number
  lots: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString('en-IN') }
function fmtPnl(n: number) { return `${n >= 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN')}` }

// ─── Put Plan Panel ───────────────────────────────────────────────────────────

function PutPlanPanel({ plan, onClose, onPaperTrade, onRefetch }: {
  plan: PutPlan
  onClose: () => void
  onPaperTrade: (plan: PutPlan, opts: OrderOptions) => void
  onRefetch: (lots: number, strikeOverride: number) => void
}) {
  const [localLots, setLocalLots]         = useState(plan.lots)
  const [selectedStrike, setSelectedStrike] = useState(plan.put_strike)
  const [putLimit, setPutLimit]           = useState(plan.put_premium_live)
  const [phase2Pct, setPhase2Pct]         = useState(3.0)
  const [callLimit, setCallLimit]         = useState(plan.planned_call_premium)
  const [applying, setApplying]           = useState(false)

  const apply = () => { setApplying(true); onRefetch(localLots, selectedStrike === plan.put_strike ? 0 : selectedStrike) }

  const sc = plan.scenarios
  const income1 = Math.round(putLimit * plan.lot_size * localLots)
  const callIncome = Math.round(callLimit * plan.lot_size * localLots)
  const effectiveBuy = Math.round((selectedStrike - putLimit) * 100) / 100
  const breakeven = Math.round((effectiveBuy - callLimit) * 100) / 100

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-background border-l border-border overflow-y-auto z-10 p-5 space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold text-white">{plan.symbol} — Wheel Strategy Plan</div>
            <div className="text-xs text-slate-400">{plan.name} · Phase 1: Sell Cash-Secured Put</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl p-1">✕</button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-2">
          {/* CMP tile — custom to show change below */}
          <div className="bg-card border border-border rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-slate-400 mb-0.5">CMP</div>
            <div className="text-sm font-bold text-white">₹{plan.cmp}</div>
            {plan.change_inr != null && (
              <div className={`text-[10px] font-semibold mt-0.5 ${plan.change_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                {plan.change_inr >= 0 ? '+' : ''}₹{Math.abs(plan.change_inr).toFixed(2)} ({plan.change_pct != null ? `${plan.change_pct >= 0 ? '+' : ''}${plan.change_pct.toFixed(2)}%` : ''})
              </div>
            )}
          </div>
          {[
            { label: 'Lot Size',   val: fmt(plan.lot_size),    color: 'text-white' },
            { label: 'ATM IV',     val: plan.atm_iv ? `${plan.atm_iv}%` : '—', color: plan.atm_iv && plan.atm_iv >= 20 ? 'text-score-green' : 'text-score-amber' },
            { label: '52W High',   val: plan.high_52w ? `₹${plan.high_52w.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—',  color: 'text-slate-300' },
            { label: '52W Low',    val: plan.low_52w  ? `₹${plan.low_52w.toLocaleString('en-IN',  { maximumFractionDigits: 2 })}` : '—',  color: 'text-slate-300' },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-2.5 text-center">
              <div className="text-[10px] text-slate-400">{label}</div>
              <div className={`text-sm font-bold ${color}`}>{val}</div>
            </div>
          ))}
        </div>

        {/* ── INTERACTIVE CONFIGURATION ── */}
        <div className="bg-blue-950/30 border border-blue-800/50 rounded-xl p-4 space-y-4">
          <div className="text-xs font-semibold text-score-blue uppercase tracking-wide">Configure Wheel</div>

          {/* Lots */}
          <div className="flex items-end gap-6">
            <div>
              <div className="text-[10px] text-slate-400 mb-1">Lots</div>
              <div className="flex items-center gap-1">
                <button onClick={() => setLocalLots(Math.max(1, localLots-1))}
                  className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-bold">−</button>
                <input type="number" value={localLots} min={1} max={50}
                  onChange={e => setLocalLots(Math.max(1, parseInt(e.target.value)||1))}
                  className="w-16 text-center bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white font-bold focus:outline-none focus:border-blue-500"
                />
                <button onClick={() => setLocalLots(localLots+1)}
                  className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-bold">+</button>
              </div>
              <div className="text-[10px] text-blue-400 mt-1">{fmt(plan.lot_size * localLots)} shares contracted</div>
            </div>
            <div className="text-slate-400 text-xs">
              Premium income: ₹{fmt(income1)}<br/>
              Margin needed: ≈ ₹{fmt(Math.round(plan.margin_required * localLots / plan.lots))}
            </div>
          </div>

          {/* PUT Strike selector */}
          <div>
            <div className="text-[10px] text-slate-400 mb-2">PUT Strike — select (target delta ~0.25–0.35)</div>
            <div className="flex gap-2 flex-wrap">
              {plan.adjacent_strikes.map(s => {
                const isSel = s.strike === selectedStrike
                const isRec = s.is_recommended
                return (
                  <button key={s.strike}
                    onClick={() => { setSelectedStrike(s.strike); setPutLimit(s.ltp) }}
                    className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs transition-colors ${
                      isSel ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-border text-slate-300 hover:border-blue-500'
                    }`}>
                    <span className="font-bold text-sm">₹{s.strike}</span>
                    <span className={isSel ? 'text-blue-200' : 'text-muted'}>{s.pct_otm}% OTM</span>
                    <span className={isSel ? 'text-blue-200' : 'text-slate-400'}>₹{s.ltp} prem</span>
                    {s.delta != null && <span className={isSel ? 'text-blue-200' : 'text-muted'}>δ {s.delta}</span>}
                    {isRec && <span className="text-[9px] mt-0.5 text-score-green">★ rec</span>}
                  </button>
                )
              })}
            </div>
          </div>

          {applying && (
            <div className="text-xs text-blue-400 animate-pulse">Recalculating plan…</div>
          )}
          {localLots !== plan.lots || selectedStrike !== plan.put_strike ? (
            <button onClick={apply} disabled={applying}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg text-sm font-semibold">
              ↻ Apply & Recalculate
            </button>
          ) : null}
        </div>

        {/* Limit prices */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-amber mb-1 uppercase tracking-wide">Limit Prices — Never Market Orders</div>
          <div className="text-[10px] text-blue-400 mb-3">All prices defaulted to live values. Adjust before placing.</div>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: `PUT Sell Limit (${fmt(plan.lot_size * localLots)} shares)`, value: putLimit, setter: setPutLimit, step: 0.05 },
              { label: `Planned CE Sell Limit (after assignment)`, value: callLimit, setter: setCallLimit, step: 0.05 },
              { label: `Phase 2 Avg Trigger (% below effective buy)`, value: phase2Pct, setter: setPhase2Pct, step: 0.5 },
            ].map(({ label, value, setter, step }) => (
              <div key={label}>
                <div className="text-[10px] text-slate-400 mb-1">{label}</div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setter(Math.round((value - step) * 100) / 100)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-bold">−</button>
                  <input type="number" value={value} step={step}
                    onChange={e => setter(parseFloat(e.target.value) || value)}
                    className="w-24 text-center bg-slate-800 border border-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  <button onClick={() => setter(Math.round((value + step) * 100) / 100)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs font-bold">+</button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-[11px] text-slate-400">
            <div>PUT income: ₹{fmt(income1)}</div>
            <div>CC income estimate: ₹{fmt(callIncome)}</div>
            <div>Wheel breakeven: ₹{breakeven} (stock price at zero net cost)</div>
          </div>
        </div>

        {/* Phase 1 — Put details */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-blue mb-3 uppercase tracking-wide">
            Phase 1 — Sell Cash-Secured Put
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">PUT Strike</span>
                <span className="text-white font-bold">₹{selectedStrike} PE</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Expiry</span>
                <span className="text-white">{plan.put_expiry} ({plan.put_days_to_expiry}d)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">PUT Sell Limit</span>
                <span className="text-score-green font-bold">₹{putLimit} × {fmt(plan.lot_size * localLots)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">PUT Income</span>
                <span className="text-score-green font-bold">₹{fmt(income1)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">Effective buy (if assigned)</span>
                <span className="text-score-amber font-semibold">₹{effectiveBuy}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">vs CMP</span>
                <span className="text-score-green">{((effectiveBuy/plan.cmp - 1)*100).toFixed(1)}% discount</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Margin required</span>
                <span className="text-score-amber">≈ ₹{fmt(Math.round(plan.margin_required * localLots / plan.lots))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Margin yield</span>
                <span className="text-score-green">{((income1 / (plan.margin_required * localLots / plan.lots)) * 100).toFixed(1)}% on margin</span>
              </div>
            </div>
          </div>
          {/* ── Full Greeks Panel — same style as Covered Call ── */}
          {(plan.put_delta != null || plan.put_theta != null) && (
            <div className="mt-4 bg-slate-800/50 border border-border/50 rounded-xl p-4">
              <div className="text-xs font-semibold text-white mb-3 uppercase tracking-wide">
                Option Greeks — {plan.symbol.replace('.NS','')} {Math.round(selectedStrike)} PE
              </div>
              <div className="space-y-2.5">

                {/* Delta */}
                {plan.put_delta != null && (() => {
                  const absD = Math.abs(plan.put_delta)
                  const displayDelta = Math.round(absD * 100) / 100
                  const assignPct   = Math.round(absD * 100)
                  const verdict = absD >= 0.20 && absD <= 0.40 ? 'Sweet spot ✓' : absD < 0.20 ? 'Low premium risk' : 'High assignment risk ⚠'
                  const vColor  = absD >= 0.20 && absD <= 0.40 ? 'text-score-green' : absD < 0.20 ? 'text-score-amber' : 'text-score-red'
                  return (
                    <div className="bg-slate-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white w-20">Δ Delta</span>
                          <span className="text-xs font-semibold text-score-amber">{displayDelta} ({assignPct}% assignment probability)</span>
                        </div>
                        <span className={`text-[10px] font-bold shrink-0 ${vColor}`}>{verdict}</span>
                      </div>
                      <div className="text-[11px] text-blue-400 leading-relaxed">
                        For every ₹1 fall in {plan.symbol.replace('.NS','')}, this PUT gains ₹{displayDelta}.
                        As the seller, you want stock to stay ABOVE ₹{selectedStrike} — {Math.round((1-absD)*100)}% probability it expires worthless.
                        <br/>
                        <span className="text-score-amber font-medium">
                          OTM% rule: Strike at {Math.round((selectedStrike/plan.cmp - 1)*100*10)/10}% from CMP.
                          {Math.abs((selectedStrike/plan.cmp - 1)*100) >= 8 && Math.abs((selectedStrike/plan.cmp - 1)*100) <= 12
                            ? ' ✓ Ideal range (8-12% OTM) — safer wheel strategy.'
                            : Math.abs((selectedStrike/plan.cmp - 1)*100) < 8
                            ? ' ⚠ Too close to CMP (< 8% OTM) — higher assignment risk. Consider going further OTM.'
                            : ' ℹ Far OTM (> 12%) — lower premium but safer. Good for conservative approach.'}
                        </span>
                        <br/>
                        Target: delta 0.20–0.30 (8-12% OTM) for balanced wheel. Note: Sensibull shows absolute delta (positive); ours follows standard -ve convention.
                      </div>
                    </div>
                  )
                })()}

                {/* Theta */}
                {plan.put_theta != null && (() => {
                  const dailyIncome = Math.round(Math.abs(plan.put_theta) * plan.lot_size * localLots)
                  return (
                    <div className="bg-slate-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white w-20">Θ Theta</span>
                          <span className="text-xs font-semibold text-score-green">+₹{dailyIncome.toLocaleString('en-IN')}/day premium decay income</span>
                        </div>
                        <span className="text-[10px] font-bold shrink-0 text-score-green">Working for you ✓</span>
                      </div>
                      <div className="text-[11px] text-blue-400 leading-relaxed">
                        PUT loses ₹{Math.abs(plan.put_theta).toFixed(3)}/share/day due to time decay — YOU collect this as seller.
                        On {(plan.lot_size * localLots).toLocaleString('en-IN')} shares: +₹{dailyIncome.toLocaleString('en-IN')}/day.
                        Theta accelerates in the last 14 days — maximum income near expiry.
                      </div>
                    </div>
                  )
                })()}

                {/* Vega */}
                {plan.put_vega != null && (() => {
                  const vegaRisk = Math.round(plan.put_vega * plan.lot_size * localLots)
                  const isHighIV = (plan.atm_iv || 0) > 45
                  return (
                    <div className="bg-slate-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white w-20">ν Vega</span>
                          <span className="text-xs font-semibold text-score-red">-₹{vegaRisk.toLocaleString('en-IN')} if IV rises 1%</span>
                        </div>
                        <span className={`text-[10px] font-bold shrink-0 ${isHighIV ? 'text-score-red' : 'text-score-amber'}`}>
                          {isHighIV ? '⚠ High IV risk' : 'Manageable'}
                        </span>
                      </div>
                      <div className="text-[11px] text-blue-400 leading-relaxed">
                        If IV rises 1%, PUT price rises ₹{plan.put_vega.toFixed(3)}/share — paper loss of ₹{vegaRisk.toLocaleString('en-IN')}.
                        Quarterly results cause sudden IV spikes — avoid selling puts before results announcements.
                      </div>
                    </div>
                  )
                })()}

                {/* IV Level */}
                {plan.atm_iv != null && (() => {
                  const iv = plan.atm_iv
                  const quality = iv > 38 ? { label: 'Rich — excellent time to sell', color: 'text-score-green' }
                               : iv >= 25 ? { label: 'Normal — acceptable premium', color: 'text-score-amber' }
                               : { label: 'Low — thin premium, consider waiting', color: 'text-score-red' }
                  return (
                    <div className="bg-slate-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white w-20">IV Level</span>
                          <span className={`text-xs font-semibold ${quality.color}`}>{iv}% — {quality.label}</span>
                        </div>
                        <span className={`text-[10px] font-bold shrink-0 ${quality.color}`}>{iv > 38 ? 'Sell now ✓' : iv >= 25 ? 'OK' : 'Wait ⚠'}</span>
                      </div>
                      <div className="text-[11px] text-blue-400 leading-relaxed">
                        Higher IV = richer put premium = more income. Current IV {iv}% means the market is pricing in
                        {iv > 38 ? ' significant uncertainty — sell puts while premium is rich.'
                         : iv >= 25 ? ' moderate uncertainty — premium is acceptable for the wheel.'
                         : ' low uncertainty — premium may not justify the risk. Wait for IV to expand.'}
                      </div>
                    </div>
                  )
                })()}

                {/* OI */}
                {plan.put_oi != null && (
                  <div className="bg-slate-800 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white w-20">Open Interest</span>
                        <span className={`text-xs font-semibold ${plan.put_oi >= 10 ? 'text-score-green' : plan.put_oi >= 3 ? 'text-score-amber' : 'text-score-red'}`}>
                          {plan.put_oi} contracts {plan.put_oi >= 10 ? '— good liquidity' : plan.put_oi >= 3 ? '— moderate' : '— low liquidity ⚠'}
                        </span>
                      </div>
                      <span className={`text-[10px] font-bold shrink-0 ${plan.put_oi >= 10 ? 'text-score-green' : plan.put_oi >= 3 ? 'text-score-amber' : 'text-score-red'}`}>
                        {plan.put_oi >= 10 ? 'Liquid ✓' : plan.put_oi >= 3 ? 'Thin' : 'Avoid ⚠'}
                      </span>
                    </div>
                    <div className="text-[11px] text-blue-400 leading-relaxed">
                      Low OI means wide bid-ask spread — you may not get your target premium. Consider the next strike with better liquidity.
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3 text-[10px] text-blue-400 italic">
                Delta shown as absolute value (Sensibull convention). Our BS model: TATASTEEL 182.5 PE delta ≈ 0.28 (27.5% assignment probability). All greeks per-share; income figures scaled to {plan.lot_size * localLots} shares.
              </div>
            </div>
          )}
          <div className="mt-2 text-[10px] text-blue-400">
            ✅ Only real NSE-listed strikes shown. Strike ₹{selectedStrike} verified to exist with actual traded volume.
          </div>
        </div>

        {/* Planned Phase 2 */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-score-amber mb-3 uppercase tracking-wide">
            Phase 2 — Sell Covered Call (after assignment)
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">Planned CE Strike</span>
                <span className="text-white font-bold">₹{plan.planned_call_strike} CE</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Planned Expiry</span>
                <span className="text-white">{plan.planned_call_expiry}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">CE Sell Limit</span>
                <span className="text-score-green font-bold">₹{callLimit} × {fmt(plan.lot_size * localLots)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-300">CC Income</span>
                <span className="text-score-green font-bold">₹{fmt(callIncome)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Total wheel income</span>
                <span className="text-score-green font-bold">₹{fmt(income1 + callIncome)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Final breakeven</span>
                <span className="text-score-green">₹{breakeven}/share</span>
              </div>
            </div>
          </div>
        </div>

        {/* Volatility analysis */}
        <VolatilityPanel
          symbol={plan.symbol}
          currentStrike={selectedStrike}
          currentOtmPct={Math.round((selectedStrike / plan.cmp - 1) * 100 * 10) / 10}
          optionType="PE"
        />

        {/* 4 Scenarios */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-semibold text-white mb-3 uppercase tracking-wide">Wheel Scenarios</div>
          <div className="space-y-3">
            <div className="bg-blue-950/40 border border-blue-800/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-score-blue">A — Put expires worthless (best case)</span>
                <span className="px-2 py-0.5 bg-blue-900 border border-blue-700 text-score-blue rounded text-[10px] font-bold">{sc.put_expires_worthless.probability}%</span>
              </div>
              <div className="text-[11px] text-slate-300 mb-1">Stock stays above ₹{selectedStrike}. Keep ₹{fmt(income1)} premium. No stock position. Sell another put next expiry.</div>
              <div className="text-[11px] text-blue-400 italic">{sc.put_expires_worthless.action}</div>
            </div>
            <div className="bg-green-950/40 border border-green-800/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-score-green">B — Assigned + stock rises (full wheel)</span>
                <span className="px-2 py-0.5 bg-green-900 border border-green-700 text-score-green rounded text-[10px] font-bold">{sc.assigned_stock_rises.probability}%</span>
              </div>
              <div className="text-[11px] text-slate-300 mb-1">
                Assigned at ₹{effectiveBuy}. Sell CC. Stock rises → called away at ₹{plan.planned_call_strike}.
                Total income: ₹{fmt(income1 + callIncome + (plan.planned_call_strike - effectiveBuy) * plan.lot_size * localLots)}
              </div>
              <div className="text-[11px] text-blue-400 italic">{sc.assigned_stock_rises.action}</div>
            </div>
            <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-score-amber">C — Assigned + stock stays flat</span>
                <span className="px-2 py-0.5 bg-amber-900 border border-amber-700 text-score-amber rounded text-[10px] font-bold">{sc.assigned_stock_flat.probability}%</span>
              </div>
              <div className="text-[11px] text-slate-300 mb-1">
                Own stock at ₹{effectiveBuy}. Keep collecting CC premium each month. Cost basis reduces over time.
                Income so far: ₹{fmt(income1 + callIncome)}
              </div>
              <div className="text-[11px] text-blue-400 italic">{sc.assigned_stock_flat.action}</div>
            </div>
            <div className="bg-red-950/30 border border-red-800/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-score-red">D — Assigned + stock falls further</span>
                <span className="px-2 py-0.5 bg-red-900 border border-red-700 text-score-red rounded text-[10px] font-bold">{sc.assigned_stock_falls.probability}%</span>
              </div>
              <div className="text-[11px] text-slate-300 mb-1">
                Own stock at ₹{effectiveBuy}, paper loss if stock falls. Keep selling CCs to reduce cost basis.
                Premium collected offsets loss over time. No hard stop-loss.
              </div>
              <div className="text-[11px] text-blue-400 italic">{sc.assigned_stock_falls.action}</div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button onClick={() => onPaperTrade(plan, { putLimit, phase2PctDown: phase2Pct, plannedCallLimit: callLimit, lots: localLots })}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold">
            📋 Add to Paper Trade — Wheel ({localLots} lot{localLots > 1 ? 's' : ''})
          </button>
          <button className="flex-1 py-3 bg-slate-700 border border-border text-muted rounded-xl text-sm font-medium cursor-not-allowed opacity-60">
            🔗 Live Trade (After Angel One)
          </button>
        </div>
        <div className="text-[10px] text-blue-400 text-center">
          Phase 2 (Covered Call) is activated manually after put assignment. Always use limit orders.
        </div>
      </div>
    </div>
  )
}

// ─── Main Wheel Page ──────────────────────────────────────────────────────────

const WHEEL_STORAGE_KEY = 'aegisai-wheel-criteria-v1'

const DEFAULT_WHEEL_CRITERIA = {
  flat_pct: '3',
  below_high_pct: '8',
  above_low_pct: '15',
  below_sma50_pct: '12',
  min_iv: '22',
  min_score: '0',
  results_days: '7',
}

export default function Wheel() {
  const [results, setResults]           = useState<WheelScanResult[]>([])
  const [loading, setLoading]           = useState(false)
  const [scanned, setScanned]           = useState<number | null>(null)
  const [whyEmpty, setWhyEmpty]         = useState<string | null>(null)
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null)
  const [criteria, setCriteria]         = useState(() => {
    try {
      const s = localStorage.getItem(WHEEL_STORAGE_KEY)
      return s ? { ...DEFAULT_WHEEL_CRITERIA, ...JSON.parse(s) } : DEFAULT_WHEEL_CRITERIA
    } catch { return DEFAULT_WHEEL_CRITERIA }
  })
  const [showCriteria, setShowCriteria] = useState(false)

  const [planSymbol, setPlanSymbol]     = useState<string | null>(null)
  const [plan, setPlan]                 = useState<PutPlan | null>(null)
  const [planLoading, setPlanLoading]   = useState(false)
  const [lots, setLots]                 = useState('1')
  const [avgPct, setAvgPct]             = useState('3')

  const [assessInput, setAssessInput]   = useState('')
  const [assessLoading, setAssessLoading] = useState(false)
  const [oppScore1, setOppScore1]       = useState('-5')   // wheel: fell ≥5% = score 1
  const [oppScore2, setOppScore2]       = useState('-2')   // wheel: fell ≥2% = score 2
  const [assessResults, setAssessResults] = useState<WheelScanResult[]>([])

  const updateCriteria = (k: string, v: string) => setCriteria((p: typeof DEFAULT_WHEEL_CRITERIA) => ({ ...p, [k]: v }))
  const saveCriteria   = () => localStorage.setItem(WHEEL_STORAGE_KEY, JSON.stringify(criteria))
  const resetCriteria  = () => { setCriteria(DEFAULT_WHEEL_CRITERIA); localStorage.removeItem(WHEEL_STORAGE_KEY) }

  const scan = async () => {
    setLoading(true)
    setAssessResults([])
    try {
      // Reuse the CC scan endpoint — same filters work for Wheel candidates
      const params = new URLSearchParams({
        flat_pct:        criteria.flat_pct,
        below_high_pct:  criteria.below_high_pct,
        above_low_pct:   criteria.above_low_pct,
        below_sma50_pct: criteria.below_sma50_pct,
        min_score:       criteria.min_score,
        min_iv:          criteria.min_iv,
        strategy:        'wheel',
        opp_score1:      String(oppScore1 !== '' ? parseFloat(oppScore1) : -5),
        opp_score2:      String(oppScore2 !== '' ? parseFloat(oppScore2) : -2),
        results_days:    criteria.results_days,
      })
      const r = await client.get(`/covered-calls/scan/strategy?${params}`)
      // Adapt results to WheelScanResult — add put strike estimates
      const stocks = (r.data.stocks || []).map((s: WheelScanResult) => {
        const iv = s.atm_iv || 20
        const sigma = iv / 100 * Math.sqrt(30 / 365)
        const z5 = 0.05 / sigma; const phi5 = Math.exp(-z5*z5/2) / Math.sqrt(2*Math.PI)
        const z8 = 0.08 / sigma; const phi8 = Math.exp(-z8*z8/2) / Math.sqrt(2*Math.PI)
        const si = s.cmp < 100 ? 2.5 : s.cmp < 250 ? 5 : s.cmp < 500 ? 10 : s.cmp < 1000 ? 20 : s.cmp < 2000 ? 50 : 100
        return {
          ...s,
          put_strike_otm5:      Math.round(s.cmp * 0.95 / si) * si,
          put_strike_otm8:      Math.round(s.cmp * 0.92 / si) * si,
          effective_buy_otm5:   Math.round((s.cmp * 0.95 - s.cmp * 0.025) * 100) / 100,
          effective_buy_otm8:   Math.round((s.cmp * 0.92 - s.cmp * 0.02) * 100) / 100,
          put_premium_5pct:     Math.round(s.cmp * sigma * phi5 * (s.lot_size || 1)),
          put_premium_8pct:     Math.round(s.cmp * sigma * phi8 * (s.lot_size || 1)),
          max_1sd_move:         Math.round(s.cmp * sigma),
          risk_score_5pct:      probPutWorthless(s.cmp, Math.round(s.cmp * 0.95 / si) * si, s.atm_iv || 20),
          risk_score_8pct:      probPutWorthless(s.cmp, Math.round(s.cmp * 0.92 / si) * si, s.atm_iv || 20),
        }
      })
      setResults(stocks)
      setScanned(r.data.scanned)
      setWhyEmpty(r.data.why_empty || null)
      setLastUpdated(new Date())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const fetchPlan = async (sym: string, lotsOverride?: number, strikeOverride?: number) => {
    setPlanLoading(true)
    setPlanSymbol(sym)
    setPlan(null)
    try {
      const lotsVal    = lotsOverride ?? parseInt(lots) ?? 1
      const strikeParam = strikeOverride && strikeOverride > 0 ? `&strike_override=${strikeOverride}` : ''
      // Use the dedicated wheel plan endpoint — fetches REAL NSE put strikes
      const r = await client.get(`/paper/wheel/plan/${sym}?avg_pct=${avgPct}&lots=${lotsVal}${strikeParam}`)
      const d = r.data

      const putPlan: PutPlan = {
        symbol:               d.symbol,
        name:                 d.name,
        cmp:                  d.cmp,
        prev_close:           d.prev_close ?? null,
        change_inr:           d.change_inr ?? null,
        change_pct:           d.change_pct ?? null,
        lot_size:             d.lot_size,
        lots:                 d.lots,
        high_52w:             d.high_52w,
        low_52w:              d.low_52w,
        atm_iv:               d.atm_iv ?? null,
        put_strike:           d.put_strike,
        put_expiry:           d.put_expiry,
        put_days_to_expiry:   d.put_days_to_expiry,
        put_premium_live:     d.put_premium_live,
        put_premium_income:   d.put_premium_income,
        put_delta:            d.put_delta ?? null,
        put_theta:            d.put_theta ?? null,
        put_vega:             d.put_vega  ?? null,
        put_oi:               d.put_oi    ?? null,
        effective_buy:        d.effective_buy,
        margin_required:      d.margin_required,
        planned_call_strike:  d.planned_call_strike,
        planned_call_expiry:  d.planned_call_expiry,
        planned_call_premium: d.planned_call_premium,
        total_wheel_income_estimate: d.put_premium_income + Math.round(d.planned_call_premium * d.lot_size * d.lots),
        breakeven: Math.round((d.effective_buy - d.planned_call_premium) * 100) / 100,
        adjacent_strikes: d.adjacent_strikes || [],
        scenarios: {
          put_expires_worthless: d.scenarios?.put_expires_worthless ?? { probability: 70, income: d.put_premium_income, action: '' },
          assigned_stock_rises:  d.scenarios?.assigned_stock_rises  ?? { probability: 18, income: d.put_premium_income, effective_buy: d.effective_buy, action: '' },
          assigned_stock_flat:   d.scenarios?.assigned_stock_flat   ?? { probability: 8,  income: d.put_premium_income, effective_buy: d.effective_buy, action: '' },
          assigned_stock_falls:  d.scenarios?.assigned_stock_falls  ?? { probability: 4,  probable_loss: 0, action: '' },
        },
      }
      setPlan(putPlan)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (msg) alert('Could not load Wheel plan: ' + msg)
    } finally { setPlanLoading(false) }
  }

  const handleRefetch = (newLots: number, strikeOverride: number) => {
    if (planSymbol) fetchPlan(planSymbol, newLots, strikeOverride)
  }

  const handlePaperTrade = async (p: PutPlan, opts: OrderOptions) => {
    try {
      const lotSize = p.lot_size
      const r = await client.post('/paper/wheel', {
        symbol:              p.symbol.replace('.NS',''),
        company_name:        p.name,
        lots:                opts.lots,
        lot_size:            lotSize,
        put_strike:          p.put_strike,
        put_expiry:          p.put_expiry,
        put_premium:         opts.putLimit,
        put_premium_income:  Math.round(opts.putLimit * lotSize * opts.lots),
        planned_call_strike: p.planned_call_strike,
        planned_call_expiry: p.planned_call_expiry,
        planned_call_premium:opts.plannedCallLimit,
        assignment_limit:    p.effective_buy,
        phase2_pct:          opts.phase2PctDown,
      })
      const tid = r.data.trade_id
      alert(
        `✅ Wheel paper trade created!\n\n` +
        `Trade ID: ${tid}\n` +
        `Phase 1: Sell ${p.symbol.replace('.NS','')}${Math.round(p.put_strike)}PE @ ₹${opts.putLimit}\n` +
        `If assigned: buy stock at ₹${p.effective_buy} effective\n` +
        `Then: Sell ${p.symbol.replace('.NS','')}${Math.round(p.planned_call_strike)}CE @ ₹${opts.plannedCallLimit}\n\n` +
        `Go to Paper Trade → Options tab.\nAssign the PUT manually when stock is below strike.`
      )
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      alert('Failed: ' + (msg || 'Unknown error'))
    }
  }

  const displayResults = assessResults.length > 0 ? assessResults : results

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-950/60 to-slate-800 border border-amber-800/40 rounded-xl p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-base font-bold text-white mb-1">🎡 Wheel Strategy</div>
            <div className="text-xs text-slate-300 max-w-2xl leading-relaxed">
              <span className="text-score-amber font-semibold">Phase 1 (CSP):</span> Sell cash-secured puts on stocks you want to own.
              Collect premium. If assigned, own stock at a discount. &nbsp;
              <span className="text-score-green font-semibold">Phase 2 (CC):</span> Sell covered calls on assigned stock.
              Collect more premium. If called away, spin the wheel again.
            </div>
          </div>
          <div className="flex gap-2 ml-4 shrink-0">
            <button onClick={() => setShowCriteria(!showCriteria)}
              className="px-3 py-2 bg-card border border-border text-muted hover:text-white rounded-lg text-xs font-medium">
              ⚙ {showCriteria ? 'Hide' : 'Edit'} Criteria
            </button>
            <button onClick={scan} disabled={loading || assessLoading}
              className="px-5 py-2 bg-score-amber hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
              {loading ? '🔍 Scanning…' : '🎡 Scan for Wheel'}
            </button>
          </div>
        </div>

        {/* Criteria strip */}
        <div className="flex flex-wrap gap-2 text-[10px]">
          {Object.entries({
            '5d Flat': `≤${criteria.flat_pct}%`,
            'Below High': `≥${criteria.below_high_pct}%`,
            'Above Low': `≥${criteria.above_low_pct}%`,
            'Max below 50DMA': `${criteria.below_sma50_pct}%`,
            'Min IV': parseFloat(criteria.min_iv) > 0 ? `≥${criteria.min_iv}%` : 'OFF',
            'Results': `${criteria.results_days}d`,
          }).map(([k, v]) => (
            <span key={k} className="px-2 py-0.5 bg-slate-800 border border-border rounded text-slate-300">
              <span className="text-muted">{k}: </span>{v}
            </span>
          ))}
          <button onClick={resetCriteria} className="px-2 py-0.5 text-amber-400 hover:text-score-amber text-[10px]">Reset</button>
        </div>

        {/* Editable criteria */}
        {showCriteria && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Wheel Scan Criteria</div>
            <div className="grid grid-cols-3 gap-3">
              {([
                { key: 'flat_pct',        label: '5-Session Flat %',   unit: '%',    hint: 'Slightly wider than CC — you want the stock to dip into your put strike' },
                { key: 'below_high_pct',  label: 'Below 52W High',     unit: '%',    hint: 'No point selling puts near highs — limited downside buffer' },
                { key: 'above_low_pct',   label: 'Above 52W Low',      unit: '%',    hint: 'Must have recovery room if assigned' },
                { key: 'below_sma50_pct', label: 'Max below 50 DMA',   unit: '%',    hint: 'Avoid breakdown stocks' },
                { key: 'min_iv',          label: 'Min ATM IV',         unit: '%',    hint: 'Higher IV = richer put premium. 22%+ is ideal.' },
                { key: 'min_score',       label: 'Min AegisAI Score',  unit: '/100', hint: '0 = no filter' },
                { key: 'results_days',    label: 'Results window',     unit: 'days', hint: 'Exclude stocks with results/events within this many days (default 7)' },
              ] as { key: string; label: string; unit: string; hint: string }[]).map(f => (
                <div key={f.key}>
                  <label className="text-[10px] text-slate-300 block mb-1">{f.label}</label>
                  <div className="flex items-center gap-1.5">
                    <input type="number" value={(criteria as Record<string,string>)[f.key]} step="1" min="0"
                      onChange={e => updateCriteria(f.key, e.target.value)}
                      className="w-full bg-slate-800 border border-border rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-xs text-slate-300 shrink-0">{f.unit}</span>
                  </div>
                  <div className="text-[10px] text-blue-400 mt-0.5 leading-tight">{f.hint}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={saveCriteria}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium">
                💾 Save Criteria
              </button>
              <button onClick={resetCriteria} className="text-xs text-slate-400 hover:text-score-blue underline">Reset to defaults</button>
            </div>
          </div>
        )}
      </div>

      {/* Config bar */}
      <div className="flex items-center gap-4 bg-card border border-border rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300">Phase 2 avg trigger:</span>
          <input type="number" value={avgPct} min={1} max={10} step={0.5}
            onChange={e => setAvgPct(e.target.value)}
            className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <span className="text-xs text-slate-400">% below effective buy</span>
          <span className="text-xs text-score-amber font-medium">(rec: 3%)</span>
        </div>
        <div className="h-4 border-l border-border" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300">Lots:</span>
          <input type="number" value={lots} min={1} max={50}
            onChange={e => setLots(e.target.value)}
            className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <span className="text-xs text-blue-400">All figures scale to selected lots</span>
        </div>
      </div>

      {/* Assess section */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Assess Specific Stocks</div>
        <div className="flex gap-3 items-start">
          <div className="flex-1 relative">
            <NseStockSearch
              onSelect={(sym, _name) => {
                const bare = sym.replace('.NS','')
                if (!assessInput.split(/[\s,]+/).map(s => s.trim().toUpperCase()).includes(bare))
                  setAssessInput(prev => prev ? prev + ', ' + bare : bare)
              }}
              placeholder="Search and add stocks (e.g. VEDL, SBIN, TATASTEEL)"
            />
            {assessInput && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {assessInput.split(/[\s,]+/).filter(Boolean).map(s => (
                  <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-950 border border-amber-800 text-score-amber rounded text-xs font-medium">
                    {s}
                    <button onClick={() => setAssessInput(assessInput.split(/[\s,]+/).filter(x => x.trim() !== s).join(', '))}
                      className="text-muted hover:text-score-red ml-0.5">×</button>
                  </span>
                ))}
                <button onClick={() => setAssessInput('')} className="text-[10px] text-muted hover:text-score-red ml-1">Clear all</button>
              </div>
            )}
          </div>
          {/* Opportunity score thresholds */}
          <div className="flex items-center gap-2 text-xs text-muted mt-1">
            <span>🔥 Score 1 if fell ≥</span>
            <input type="number" value={oppScore1} onChange={e => setOppScore1(e.target.value)}
              className="w-14 bg-slate-800 border border-border rounded px-1.5 py-0.5 text-white text-xs text-right"
              step="0.5" placeholder="-5" />
            <span>% · Score 2 if fell ≥</span>
            <input type="number" value={oppScore2} onChange={e => setOppScore2(e.target.value)}
              className="w-14 bg-slate-800 border border-border rounded px-1.5 py-0.5 text-white text-xs text-right"
              step="0.5" placeholder="-2" />
            <span>% (defaults: -5% / -2%)</span>
          </div>
          <button onClick={async () => {
            const syms = assessInput.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
            if (!syms.length) return
            setAssessLoading(true)
            try {
              const r = await client.post('/covered-calls/assess', {
                symbols: syms, min_iv: parseFloat(criteria.min_iv) || 22, strategy: 'wheel',
                opp_score1: oppScore1 !== '' ? parseFloat(oppScore1) : -5,
                opp_score2: oppScore2 !== '' ? parseFloat(oppScore2) : -2,
              })
              const all = (r.data.results || []).map((s: WheelScanResult) => {
                const iv = s.atm_iv || 20
                const sigma = iv / 100 * Math.sqrt(30 / 365)
                const z5 = 0.05 / sigma; const phi5 = Math.exp(-z5*z5/2) / Math.sqrt(2*Math.PI)
                const z8 = 0.08 / sigma; const phi8 = Math.exp(-z8*z8/2) / Math.sqrt(2*Math.PI)
                const si = (s.cmp||0) < 100 ? 2.5 : (s.cmp||0) < 250 ? 5 : (s.cmp||0) < 500 ? 10 : (s.cmp||0) < 1000 ? 20 : (s.cmp||0) < 2000 ? 50 : 100
                return {
                  ...s,
                  put_strike_otm5:    Math.round((s.cmp || 0) * 0.95 / si) * si,
                  put_strike_otm8:    Math.round((s.cmp || 0) * 0.92 / si) * si,
                  effective_buy_otm5: Math.round(((s.cmp || 0) * 0.95 - (s.cmp || 0) * 0.025) * 100) / 100,
                  effective_buy_otm8: Math.round(((s.cmp || 0) * 0.92 - (s.cmp || 0) * 0.020) * 100) / 100,
                  put_premium_5pct:   Math.round((s.cmp || 0) * sigma * phi5 * (s.lot_size || 1)),
                  put_premium_8pct:   Math.round((s.cmp || 0) * sigma * phi8 * (s.lot_size || 1)),
                  max_1sd_move:       Math.round((s.cmp || 0) * sigma),
                  risk_score_5pct:    probPutWorthless(s.cmp || 0, Math.round((s.cmp || 0) * 0.95 / si) * si, s.atm_iv || 20),
                  risk_score_8pct:    probPutWorthless(s.cmp || 0, Math.round((s.cmp || 0) * 0.92 / si) * si, s.atm_iv || 20),
                }
              })
              setAssessResults(all)
            } catch { /* ignore */ }
            finally { setAssessLoading(false) }
          }} disabled={assessLoading || !assessInput.trim() || loading}
            className="px-5 py-2.5 bg-score-amber hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg text-sm font-semibold whitespace-nowrap shrink-0">
            {assessLoading ? '⏳ Assessing…' : '🎡 Assess for Wheel'}
          </button>
        </div>
      </div>

      {(loading || assessLoading) && (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <div className="text-3xl mb-3 animate-spin inline-block">⊙</div>
          <div className="text-sm text-slate-300">{loading ? 'Scanning for Wheel candidates…' : 'Assessing your stocks…'}</div>
          <div className="text-xs text-slate-400 mt-1">This takes 30–60 seconds</div>
        </div>
      )}

      {!loading && !assessLoading && displayResults.length === 0 && scanned !== null && (
        <div className="bg-card border border-border rounded-xl p-6 text-center space-y-3">
          <div className="text-3xl">🎡</div>
          <div className="text-white font-semibold">No stocks qualified from {scanned} scanned</div>
          {whyEmpty && <div className="bg-slate-800/60 border border-border rounded-lg px-4 py-3 text-sm text-slate-300 leading-relaxed max-w-xl mx-auto">{whyEmpty}</div>}
          <div className="text-xs text-blue-400">For Wheel strategy, consider relaxing criteria — you WANT to potentially own the stock at a discount.</div>
        </div>
      )}

      {!loading && !assessLoading && displayResults.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="text-xs text-muted">
              {assessResults.length > 0
                ? `${displayResults.length} stocks — all with Wheel analysis`
                : `${displayResults.length} qualified from ${scanned} scanned`}
              {lastUpdated && <span> · {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
            <div className="text-xs text-muted">Click "Plan" to see full Wheel setup</div>
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
                  <th className="text-right px-3 py-2.5" title="5% OTM put strike + est. premium income (1 lot)">5% OTM</th>
                  <th className="text-right px-3 py-2.5" title="8% OTM put strike + est. premium income (1 lot)">8% OTM</th>
                  <th className="text-right px-3 py-2.5" title="1σ expected move over 30 days">1σ Move</th>
                  <th className="text-right px-3 py-2.5" title="Actual price change over last ~30 trading days">30d Move</th>
                  <th className="text-right px-3 py-2.5">Eff. Buy @5%</th>
                  <th className="text-right px-3 py-2.5">From High</th>
                  <th className="text-center px-3 py-2.5" title="Probability 5%/8% OTM put expires worthless">Risk Score</th>
                  <th className="text-right px-3 py-2.5">Lot</th>
                  <th className="text-center px-3 py-2.5">Score</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {displayResults.map(r => {
                  const ar = r as WheelScanResult & { eligible?: boolean; warnings?: {level: string; category: string; message: string}[] }
                  const hasWarnings = ar.warnings && ar.warnings.length > 0
                  const highRisks = ar.warnings?.filter((w: {level:string}) => w.level === 'high') || []
                  const rowBg = ar.eligible === false && highRisks.length > 0 ? 'bg-red-950/10' : ''
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
                          {r.atm_iv != null
                            ? <span className={r.atm_iv >= parseFloat(criteria.min_iv) ? 'text-score-green' : 'text-score-red'}>{r.atm_iv}%</span>
                            : <span className="text-muted">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right text-xs">
                          <div className="font-medium text-score-green">{r.put_premium_5pct != null ? `₹${r.put_premium_5pct.toLocaleString('en-IN')}` : '—'}</div>
                          {r.put_premium_5pct != null && r.lot_size > 0 && <div className="text-muted">₹{(r.put_premium_5pct / r.lot_size).toFixed(1)}/sh</div>}
                        </td>
                        <td className="px-3 py-3 text-right text-xs">
                          <div className="font-medium text-score-green">{r.put_premium_8pct != null ? `₹${r.put_premium_8pct.toLocaleString('en-IN')}` : '—'}</div>
                          {r.put_premium_8pct != null && r.lot_size > 0 && <div className="text-muted">₹{(r.put_premium_8pct / r.lot_size).toFixed(1)}/sh</div>}
                        </td>
                        <td className="px-3 py-3 text-right text-score-amber text-xs">{r.max_1sd_move != null ? `₹${r.max_1sd_move.toLocaleString('en-IN')}` : '—'}</td>
                        <td className={`px-3 py-3 text-right text-xs ${r.expiry_chg_inr == null ? 'text-muted' : r.expiry_chg_inr >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                          {r.expiry_chg_inr != null ? (
                            <>
                              <div className="font-medium">{r.expiry_chg_inr >= 0 ? '+' : ''}₹{Math.abs(r.expiry_chg_inr).toLocaleString('en-IN')}</div>
                              <div className="opacity-70">{r.expiry_chg_pct != null ? `${r.expiry_chg_pct >= 0 ? '+' : ''}${r.expiry_chg_pct.toFixed(1)}%` : ''}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right text-score-amber text-xs font-medium">₹{r.effective_buy_otm5}</td>
                        <td className="px-3 py-3 text-right text-xs text-score-red">{r.pct_from_high}%</td>
                        <td className="px-3 py-3 text-center text-xs">
                          {r.risk_score_5pct != null ? (
                            <div>
                              <span className={`font-bold ${r.risk_score_5pct >= 75 ? 'text-score-green' : r.risk_score_5pct >= 60 ? 'text-score-amber' : 'text-score-red'}`}>
                                {r.risk_score_5pct}%
                              </span>
                              <div className="text-muted text-[10px]">{r.risk_score_8pct}% @8%</div>
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right text-muted text-xs">{r.lot_size.toLocaleString('en-IN')}</td>
                        <td className="px-3 py-3 text-center">
                          <span className="text-sm font-bold" style={{ color: scoreToColor(r.score) }}>{r.score}</span>
                        </td>
                        <td className="px-3 py-3">
                          <button onClick={() => fetchPlan(r.symbol)}
                            className="px-3 py-1.5 bg-score-amber hover:bg-amber-600 text-white rounded-lg text-xs font-medium whitespace-nowrap">
                            Plan →
                          </button>
                        </td>
                      </tr>
                      {hasWarnings && (
                        <tr key={`${r.symbol}-warn`} className={`border-b border-border/40 ${rowBg}`}>
                          <td colSpan={14} className="px-5 pb-3 pt-0">
                            <div className="space-y-1">
                              {ar.warnings!.map((w: {level:string; category:string; message:string}, wi: number) => (
                                <div key={wi} className={`flex items-start gap-2 text-xs rounded-lg px-3 py-1.5 ${
                                  w.level === 'high' ? 'bg-red-950/60 text-red-300' :
                                  w.level === 'medium' ? 'bg-amber-950/40 text-amber-300' :
                                  'bg-green-950/40 text-score-green'}`}>
                                  <span className="shrink-0 mt-0.5">{w.level==='high'?'🚨':w.level==='medium'?'⚠':'✓'}</span>
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
          <div className="bg-amber-950/20 border border-amber-800/30 rounded-xl px-4 py-3 text-[11px] text-amber-300">
            🎡 Wheel strategy: only sell puts on stocks you'd genuinely be happy to own. Assigns at a discount = intended outcome, not a loss.
          </div>
        </div>
      )}

      {/* Info footer */}
      <div className="bg-slate-800/60 border border-border rounded-xl p-4 text-xs text-muted space-y-1">
        <div className="font-medium text-slate-400 mb-1">How the Wheel Works</div>
        <div>1. <span className="text-score-amber">Sell Cash-Secured Put</span> — collect premium. Hold cash as margin. If stock stays above strike → keep premium, repeat.</div>
        <div>2. <span className="text-score-blue">Assignment</span> — if stock falls to put strike, you're assigned: own {`{lots × lot_size}`} shares at an effective discount.</div>
        <div>3. <span className="text-score-green">Sell Covered Call</span> — collect more premium monthly. Reduces your cost basis. If called away → back to cash, spin again.</div>
        <div>4. Philosophy: no hard stop-loss. Premium income hedges paper losses over time.</div>
      </div>

      {/* Plan slide-over */}
      {planLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <div className="text-3xl mb-3 animate-spin inline-block">⊙</div>
            <div className="text-sm text-muted">Generating Wheel plan for {planSymbol}…</div>
          </div>
        </div>
      )}
      {plan && !planLoading && (
        <PutPlanPanel
          plan={plan}
          onClose={() => { setPlan(null); setPlanSymbol(null) }}
          onPaperTrade={handlePaperTrade}
          onRefetch={handleRefetch}
        />
      )}
    </div>
  )
}
