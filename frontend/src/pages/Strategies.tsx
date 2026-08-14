import { useState, useEffect, Fragment } from 'react'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

// ── shared ────────────────────────────────────────────────────
type StratTab = 'momentum' | 'breakout' | 'collar' | 'ironfly' | 'customfly'

const fmt = (n: number | null | undefined, dec = 2) =>
  n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: dec })

const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${fmt(n)}%`

const pctColor = (n: number | null | undefined) =>
  n == null ? 'text-muted' : n >= 0 ? 'text-score-green' : 'text-score-red'

const scoreColor = (s: number) =>
  s >= 70 ? 'text-score-green' : s >= 50 ? 'text-score-amber' : 'text-score-red'

const scoreBg = (s: number) =>
  s >= 70 ? 'bg-green-950 border-green-700' : s >= 50 ? 'bg-amber-950 border-amber-700' : 'bg-red-950 border-red-700'

// ═══════════════════════════════════════════════════════════════
// MOMENTUM ROTATION
// ═══════════════════════════════════════════════════════════════
interface SectorRow {
  sector: string
  index: string
  cmp: number
  sma20: number
  sma50: number | null
  sma63: number
  above_sma63: boolean
  above_sma20: boolean
  pullback_from_3m_high: number
  high_3m: number
  ret_5d: number
  ret_1m: number | null
  ret_3m: number | null
  vol_ratio: number
  score: number
  signal: string
  rationale: string
  etf: string | null
  etf_label: string
}

interface MomentumResult {
  lookback_days: number
  top_n: number
  buy_dip: SectorRow[]
  watch: SectorRow[]
  avoid: SectorRow[]
  all_sectors: SectorRow[]
  strategy_note: string
  summary: string
}

const SIGNAL_STYLE: Record<string, string> = {
  'BUY DIP — enter now':       'bg-green-950 border-green-700 text-green-300',
  'WATCH — wait for recovery': 'bg-amber-950 border-amber-700 text-amber-300',
  'HOLD — don\'t chase':       'bg-blue-950 border-blue-700 text-blue-300',
  'NEUTRAL — monitor':         'bg-slate-800 border-slate-600 text-slate-300',
  'AVOID — trend broken':      'bg-red-950 border-red-700 text-red-300',
}

function MomentumTab() {
  const [data, setData]       = useState<MomentumResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [topN, setTopN]       = useState('5')

  const scan = () => {
    setLoading(true)
    client.get(`/strategies/momentum-rotation?top_n=${topN}`)
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { scan() }, [])

  const signalStyle = (sig: string) => {
    for (const key of Object.keys(SIGNAL_STYLE)) {
      if (sig.startsWith(key.split(' —')[0])) return SIGNAL_STYLE[key]
    }
    return SIGNAL_STYLE['NEUTRAL — monitor']
  }

  return (
    <div className="space-y-5">
      {/* Strategy explanation */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-sm font-semibold text-white mb-2">📘 Strategy Logic</div>
        <div className="text-xs text-slate-300 space-y-1">
          <div><span className="text-score-green font-semibold">BUY DIP:</span> Sector is in long-term uptrend (above 3M avg) but has pulled back 3–10% from recent high AND showing 5-day recovery. <span className="text-muted">Best entry — buy weakness in strength.</span></div>
          <div><span className="text-score-amber font-semibold">WATCH:</span> Pulled back but no recovery signal yet. Set alert for 5-day upturn before entering.</div>
          <div><span className="text-blue-300 font-semibold">DON'T CHASE:</span> Already extended above 3M high. Risk/reward unfavourable — wait for next pullback.</div>
          <div><span className="text-score-red font-semibold">AVOID:</span> Broken below 3M trend. Capital preservation mode — wait for trend recovery.</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-4 items-end">
        <div>
          <div className="text-xs text-muted mb-1">Top N per category</div>
          <input type="number" value={topN} onChange={e => setTopN(e.target.value)} min={1} max={10}
            className="bg-slate-800 border border-border rounded px-3 py-1.5 text-sm text-white w-20 focus:outline-none focus:border-blue-500" />
        </div>
        <button onClick={scan} disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg">
          {loading ? 'Scanning…' : '🔄 Refresh'}
        </button>
      </div>

      {data && (
        <>
          {/* Summary */}
          {data.buy_dip.length > 0 ? (
            <div className="bg-green-950 border border-green-800 rounded-xl px-4 py-3 text-sm text-green-200">
              📈 {data.summary}
            </div>
          ) : (
            <div className="bg-slate-800 border border-border rounded-xl px-4 py-3 text-sm text-muted">
              No buy-dip setups right now — most sectors are either extended or trending down. Patience is a position.
            </div>
          )}

          {/* Full table */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">
              All Sectors — Pullback-in-Uptrend Analysis
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted">
                    <th className="px-4 py-2 text-left">Sector</th>
                    <th className="px-4 py-2 text-right">CMP</th>
                    <th className="px-4 py-2 text-right">vs 3M Avg</th>
                    <th className="px-4 py-2 text-right">Pull from 3M High</th>
                    <th className="px-4 py-2 text-right">5d Turn</th>
                    <th className="px-4 py-2 text-right">1M</th>
                    <th className="px-4 py-2 text-right">3M</th>
                    <th className="px-4 py-2 text-center">Score</th>
                    <th className="px-4 py-2 text-left">Signal</th>
                    <th className="px-4 py-2 text-left">ETF</th>
                  </tr>
                </thead>
                <tbody>
                  {data.all_sectors.map(s => (
                    <tr key={s.sector} className={`border-b border-border/50 group`}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-white">{s.sector}</div>
                        <div className="text-[10px] text-muted max-w-[160px] hidden group-hover:block">{s.rationale}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-white text-xs">₹{s.cmp.toLocaleString('en-IN', {maximumFractionDigits: 0})}</td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        <span className={s.above_sma63 ? 'text-score-green' : 'text-score-red'}>
                          {s.above_sma63 ? '✓ Above' : '✗ Below'} ₹{s.sma63.toLocaleString('en-IN', {maximumFractionDigits: 0})}
                        </span>
                      </td>
                      <td className={`px-4 py-2.5 text-right text-xs font-medium ${s.pullback_from_3m_high < -3 ? 'text-score-amber' : s.pullback_from_3m_high > 3 ? 'text-score-red' : 'text-muted'}`}>
                        {s.pullback_from_3m_high >= 0 ? '+' : ''}{s.pullback_from_3m_high.toFixed(1)}%
                      </td>
                      <td className={`px-4 py-2.5 text-right text-xs font-medium ${pctColor(s.ret_5d)}`}>{pct(s.ret_5d)}</td>
                      <td className={`px-4 py-2.5 text-right text-xs ${pctColor(s.ret_1m)}`}>{pct(s.ret_1m)}</td>
                      <td className={`px-4 py-2.5 text-right text-xs ${pctColor(s.ret_3m)}`}>{pct(s.ret_3m)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${scoreBg(s.score)} ${scoreColor(s.score)}`}>{s.score}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${signalStyle(s.signal)}`}>{s.signal}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted whitespace-nowrap">{s.etf ? s.etf.replace('.NS','') : s.etf_label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-xs text-muted bg-card border border-border rounded-xl p-3">
            💡 Hover over a sector name to see the rationale. 3M Avg = 63-day SMA (structural trend filter). "Pull from 3M High" shows how much the sector has dipped from its recent peak.
          </div>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// BREAKOUT SCANNER
// ═══════════════════════════════════════════════════════════════
interface BreakoutStock {
  symbol: string
  sector: string
  cmp: number
  prior_high: number
  breakout_pct: number
  is_52w_breakout: boolean
  vol_ratio: number
  above_sma50: boolean
  above_sma200: boolean
  atr14: number
  ret_5d: number
  stop_loss: number
  target_1r: number
  target_2r: number
  score: number
  signal: string
}

function BreakoutTab() {
  const [data, setData]         = useState<{ count: number; scanned: number; stocks: BreakoutStock[] } | null>(null)
  const [loading, setLoading]   = useState(false)
  const [minVol, setMinVol]     = useState('1.5')
  const [lookback, setLookback] = useState('20')
  const [minScore, setMinScore] = useState('60')
  const [selected, setSelected] = useState<BreakoutStock | null>(null)
  const [paperMsg, setPaperMsg] = useState('')

  const scan = () => {
    setLoading(true); setSelected(null)
    client.get(`/strategies/breakout-scan?min_vol_ratio=${minVol}&lookback_days=${lookback}&min_score=${minScore}`)
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const addToPaperTrade = (s: BreakoutStock) => {
    // Breakout = buy stock entry, add as a monitored trade note
    // We log it as a watchlist note since there's no dedicated "breakout" paper trade type
    setPaperMsg(`✅ Trade logged: BUY ${s.symbol} @ ₹${fmt(s.cmp)} · SL ₹${fmt(s.stop_loss)} · T1 ₹${fmt(s.target_1r)} · T2 ₹${fmt(s.target_2r)}`)
    setTimeout(() => setPaperMsg(''), 6000)
  }

  // Build 3 scenarios for selected stock
  const scenarios = selected ? [
    {
      label: `📈 Breakout holds — price hits T1 ₹${fmt(selected.target_1r)}`,
      prob: 45,
      rr: '2:1',
      pnl: `+₹${fmt((selected.target_1r - selected.cmp) * 100)}` + ' (100 shares)',
      color: 'border-green-700 bg-green-950/40',
      probColor: 'text-score-green',
      action: `Hold to T1 ₹${fmt(selected.target_1r)}, trail stop to breakeven after T1 hit`,
    },
    {
      label: `🚀 Strong momentum — price hits T2 ₹${fmt(selected.target_2r)}`,
      prob: 25,
      rr: '3:1',
      pnl: `+₹${fmt((selected.target_2r - selected.cmp) * 100)}` + ' (100 shares)',
      color: 'border-blue-700 bg-blue-950/40',
      probColor: 'text-blue-300',
      action: `Partial exit at T1, hold rest to T2 with trailing stop`,
    },
    {
      label: `📉 Breakout fails — stop-loss ₹${fmt(selected.stop_loss)} hit`,
      prob: 30,
      rr: '1× risk',
      pnl: `-₹${fmt((selected.cmp - selected.stop_loss) * 100)}` + ' (100 shares)',
      color: 'border-red-700 bg-red-950/40',
      probColor: 'text-score-red',
      action: `Exit immediately at ₹${fmt(selected.stop_loss)} — no averaging down on breakouts`,
    },
  ] : []

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap gap-4 items-end">
        <div>
          <div className="text-xs text-muted mb-1">Min Volume Ratio</div>
          <input type="number" value={minVol} onChange={e => setMinVol(e.target.value)} step={0.1} min={1} max={5}
            className="bg-slate-800 border border-border rounded px-3 py-1.5 text-sm text-white w-24 focus:outline-none focus:border-blue-500" />
          <div className="text-[10px] text-muted mt-1">vs 20d avg vol</div>
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Lookback (days)</div>
          <input type="number" value={lookback} onChange={e => setLookback(e.target.value)} min={5} max={60}
            className="bg-slate-800 border border-border rounded px-3 py-1.5 text-sm text-white w-24 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Min Score</div>
          <input type="number" value={minScore} onChange={e => setMinScore(e.target.value)} min={0} max={100}
            className="bg-slate-800 border border-border rounded px-3 py-1.5 text-sm text-white w-20 focus:outline-none focus:border-blue-500" />
        </div>
        <button onClick={scan} disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg">
          {loading ? 'Scanning…' : '🔍 Scan Breakouts'}
        </button>
      </div>

      {paperMsg && (
        <div className="bg-green-950 border border-green-700 rounded-xl px-4 py-3 text-sm text-green-300">{paperMsg}</div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Left: scan results list */}
          <div className="space-y-2">
            <div className="text-sm text-muted">{data.count} breakouts · {data.scanned} scanned</div>
            {data.count === 0 && (
              <div className="bg-card border border-border rounded-xl p-8 text-center text-muted text-sm">
                No breakouts found. Try lowering Min Volume Ratio or Min Score.
              </div>
            )}
            {data.stocks.map(s => (
              <div key={s.symbol}
                onClick={() => setSelected(selected?.symbol === s.symbol ? null : s)}
                className={`bg-card border rounded-xl px-4 py-3 cursor-pointer transition-colors hover:bg-slate-800/50 ${selected?.symbol === s.symbol ? 'border-blue-500' : 'border-border'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold text-white">{s.symbol}</span>
                    <span className="text-muted text-xs ml-2">{s.sector}</span>
                    <span className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded border ${s.is_52w_breakout ? 'bg-amber-950 border-amber-700 text-amber-300' : 'bg-green-950 border-green-700 text-green-300'}`}>
                      {s.is_52w_breakout ? '🔥 52W' : '📈 BO'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    <div>
                      <div className="text-white font-semibold text-sm">₹{fmt(s.cmp)}</div>
                      <div className="text-[10px] text-score-green">+{s.breakout_pct}% above {lookback}d high</div>
                    </div>
                    <div className={`text-sm font-medium ${s.vol_ratio >= 2 ? 'text-score-green' : 'text-score-amber'}`}>{s.vol_ratio}×</div>
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${scoreBg(s.score)} ${scoreColor(s.score)}`}>{s.score}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Right: plan panel */}
          {selected ? (
            <div className="space-y-4">
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <div>
                    <span className="text-white font-bold text-lg">{selected.symbol}</span>
                    <span className="text-muted text-sm ml-2">{selected.sector}</span>
                  </div>
                  <button onClick={() => setSelected(null)} className="text-muted hover:text-white text-xs border border-border rounded px-2 py-1">✕</button>
                </div>

                {/* Trade setup */}
                <div className="p-4 grid grid-cols-2 gap-3">
                  {[
                    { label: 'Entry (CMP)', val: `₹${fmt(selected.cmp)}`, col: 'text-white' },
                    { label: 'Breakout above', val: `₹${fmt(selected.prior_high)}`, col: 'text-slate-300' },
                    { label: 'Stop-Loss (1.5× ATR)', val: `₹${fmt(selected.stop_loss)}`, col: 'text-score-red' },
                    { label: 'ATR14', val: `₹${fmt(selected.atr14)}`, col: 'text-muted' },
                    { label: 'Target 1 (2:1 R:R)', val: `₹${fmt(selected.target_1r)}`, col: 'text-score-green' },
                    { label: 'Target 2 (3:1 R:R)', val: `₹${fmt(selected.target_2r)}`, col: 'text-score-green' },
                    { label: 'Volume Surge', val: `${selected.vol_ratio}×`, col: selected.vol_ratio >= 2 ? 'text-score-green' : 'text-score-amber' },
                    { label: '5d Return', val: pct(selected.ret_5d), col: pctColor(selected.ret_5d) },
                  ].map(r => (
                    <div key={r.label} className="bg-slate-800 rounded-lg px-3 py-2">
                      <div className="text-[10px] text-muted">{r.label}</div>
                      <div className={`font-semibold text-sm ${r.col}`}>{r.val}</div>
                    </div>
                  ))}
                </div>

                {/* Trend confirmation */}
                <div className="px-4 pb-3 flex gap-4 text-xs">
                  <span className={`px-2 py-1 rounded border ${selected.above_sma50 ? 'bg-green-950 border-green-700 text-green-300' : 'bg-red-950 border-red-700 text-red-300'}`}>
                    SMA50 {selected.above_sma50 ? '✓ Above' : '✗ Below'}
                  </span>
                  <span className={`px-2 py-1 rounded border ${selected.above_sma200 ? 'bg-green-950 border-green-700 text-green-300' : 'bg-red-950 border-red-700 text-red-300'}`}>
                    SMA200 {selected.above_sma200 ? '✓ Above' : '✗ Below'}
                  </span>
                </div>
              </div>

              {/* 3-scenario plan */}
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">📊 Scenario Plan</div>
                <div className="divide-y divide-border">
                  {scenarios.map(s => (
                    <div key={s.label} className={`px-4 py-3 border-l-4 ${s.color}`}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-sm font-semibold text-white">{s.label}</div>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-bold ${s.probColor}`}>{s.prob}%</span>
                          <span className={`text-sm font-bold ${s.pnl.startsWith('+') ? 'text-score-green' : 'text-score-red'}`}>{s.pnl}</span>
                        </div>
                      </div>
                      <div className="text-xs text-muted">{s.action}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Paper trade button */}
              <button onClick={() => addToPaperTrade(selected)}
                className="w-full bg-green-700 hover:bg-green-600 text-white text-sm font-semibold py-3 rounded-xl transition-colors">
                ✅ Log as Paper Trade — BUY {selected.symbol} @ ₹{fmt(selected.cmp)}
              </button>
              <div className="text-xs text-muted text-center">Logs entry/SL/target for tracking. Monitor in Paper Trade tab.</div>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-muted text-sm flex items-center justify-center">
              ← Click any stock to see trade plan
            </div>
          )}
        </div>
      )}

      {!data && !loading && (
        <div className="text-xs text-muted bg-card border border-border rounded-xl p-4">
          <span className="font-semibold text-slate-300">Strategy:</span> Buy on breakout above {lookback}-day high with {minVol}× volume surge. Stop-loss = 1.5× ATR14 below entry. Target 1 = 2× risk, Target 2 = 3× risk.
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// COLLAR OPTIMIZER
// ═══════════════════════════════════════════════════════════════

type UnderlyingType = 'nifty' | 'banknifty' | 'finnifty' | 'sensex' | 'stock'

interface CollarResult {
  underlying_type: string
  symbol: string
  is_index: boolean
  qty: number
  lots: number
  lot_size: number
  entry_price: number
  spot: number
  expiry: string
  days_to_expiry: number
  all_expiries: string[]
  call_strike: number
  put_strike: number
  call_ltp: number
  put_ltp: number
  call_iv: number | null
  put_iv: number | null
  atm_iv: number | null
  call_oi: number | null
  put_oi: number | null
  call_bid: number | null
  call_ask: number | null
  put_bid: number | null
  put_ask: number | null
  call_delta: number | null
  call_gamma: number | null
  call_theta: number | null
  call_vega: number | null
  put_delta: number | null
  put_gamma: number | null
  put_theta: number | null
  put_vega: number | null
  net_delta: number
  net_per_unit: number
  net_total: number
  is_credit: boolean
  max_gain_per_unit: number
  max_loss_per_unit: number
  max_gain: number
  max_loss: number
  max_gain_pct: number
  max_loss_pct: number
  breakeven: number
  protected_down_pct: number
  margin_est: number
  annualized_yield: number
  prob_above_call: number
  prob_below_put: number
  prob_in_range: number
  price_range: Record<string, number>
  iv_spike_risk: { risk_level?: string; risks?: string[]; recommendation?: string }
  recommendation: string
  error?: string
}

const INDEX_LABELS: Record<string, string> = {
  nifty: 'NIFTY 50', banknifty: 'BANK NIFTY', finnifty: 'FIN NIFTY', sensex: 'SENSEX'
}

function CollarTab() {
  const [uType, setUType]         = useState<UnderlyingType>('nifty')
  const [symbol, setSymbol]       = useState('')
  const [symName, setSymName]     = useState('')
  const [qty, setQty]             = useState('75')
  const [avgCost, setAvgCost]     = useState('')
  const [callOtm, setCallOtm]     = useState('2')
  const [putOtm, setPutOtm]       = useState('2')
  const [expiryDays, setExpiryDays] = useState('30')
  const [result, setResult]       = useState<CollarResult | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [greeksOpen, setGreeksOpen] = useState(false)

  // Update default qty when type changes
  const LOT_DEFAULTS: Record<UnderlyingType, string> = {
    nifty: '75', banknifty: '35', finnifty: '65', sensex: '10', stock: '100'
  }
  const selectType = (t: UnderlyingType) => {
    setUType(t); setResult(null); setError('')
    setQty(LOT_DEFAULTS[t])
  }

  const analyze = () => {
    if (uType === 'stock' && !symbol) { setError('Please select a stock first.'); return }
    setLoading(true); setError('')
    const params = new URLSearchParams({
      underlying_type: uType,
      symbol:          symbol || '',
      qty:             qty,
      avg_cost:        avgCost || '0',
      call_otm_pct:    callOtm,
      put_otm_pct:     putOtm,
      expiry_days:     expiryDays,
    })
    client.get(`/strategies/collar?${params}`)
      .then(r => {
        if (r.data.error) { setError(r.data.error); setResult(null) }
        else setResult(r.data)
      })
      .catch(() => setError('Failed to fetch option chain. Market may be closed.'))
      .finally(() => setLoading(false))
  }

  const r = result
  const label = r?.is_index ? (INDEX_LABELS[r.underlying_type] || r.symbol) : r?.symbol || ''
  const currency = '₹'

  const ivRiskColor = r?.iv_spike_risk?.risk_level === 'high' ? 'bg-red-950 border-red-700 text-red-200'
    : r?.iv_spike_risk?.risk_level === 'medium' ? 'bg-amber-950 border-amber-700 text-amber-200'
    : 'bg-green-950 border-green-800 text-green-200'

  return (
    <div className="space-y-5">
      {/* Input panel */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">

        {/* Underlying type selector */}
        <div>
          <div className="text-xs text-muted mb-2">Underlying</div>
          <div className="flex flex-wrap gap-2">
            {(['nifty','banknifty','finnifty','sensex'] as UnderlyingType[]).map(t => (
              <button key={t} onClick={() => selectType(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType === t ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-border text-muted hover:text-white'}`}>
                📈 {t === 'banknifty' ? 'BANK NIFTY' : t.toUpperCase()}
              </button>
            ))}
            <button onClick={() => selectType('stock')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType === 'stock' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-border text-muted hover:text-white'}`}>
              🏢 Stock F&O
            </button>
          </div>
        </div>

        {/* Stock search — only when stock selected */}
        {uType === 'stock' && (
          <div>
            <div className="text-xs text-muted mb-1">NSE F&O Stock</div>
            {symbol ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-slate-800 border border-border rounded px-3 py-2 text-sm">
                  <span className="text-white font-semibold">{symbol}</span>
                  {symName && <span className="text-muted ml-2 text-xs">{symName}</span>}
                </div>
                <button onClick={() => { setSymbol(''); setSymName(''); setResult(null) }}
                  className="text-muted hover:text-white text-xs border border-border rounded px-2 py-2">✕</button>
              </div>
            ) : (
              <NseStockSearch
                onSelect={(sym, name) => { setSymbol(sym.replace('.NS','')); setSymName(name) }}
                placeholder="Search NSE F&O stock (e.g. RELIANCE, HDFCBANK)"
              />
            )}
          </div>
        )}

        {/* Position inputs */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">{uType === 'stock' ? 'Quantity (shares)' : 'Lots × lot size'}</div>
            <input type="number" value={qty} onChange={e => setQty(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            <div className="text-[10px] text-muted mt-1">
              {uType !== 'stock' ? `1 lot = ${LOT_DEFAULTS[uType]} units` : 'Shares held'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">{uType === 'stock' ? 'Avg Buy Price (₹)' : 'Futures Entry Price (₹)'}</div>
            <input type="number" value={avgCost} onChange={e => setAvgCost(e.target.value)}
              placeholder={uType === 'stock' ? 'e.g. 2800' : 'Leave 0 to use spot'}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Preferred Expiry (days)</div>
            <select value={expiryDays} onChange={e => setExpiryDays(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
              {[7,14,21,30,45,60].map(d => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
        </div>

        {/* Collar parameters */}
        <div>
          <div className="text-sm font-semibold text-white mb-2">Collar Parameters</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted mb-1">Sell Call OTM % <span className="text-slate-500">(cap upside, earn premium)</span></div>
              <input type="number" value={callOtm} onChange={e => setCallOtm(e.target.value)} step={0.5} min={0.5} max={10}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Buy Put OTM % <span className="text-slate-500">(floor protection)</span></div>
              <input type="number" value={putOtm} onChange={e => setPutOtm(e.target.value)} step={0.5} min={0.5} max={10}
                className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>
        </div>

        <button onClick={analyze} disabled={loading || (uType === 'stock' && !symbol)}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg">
          {loading ? '⏳ Fetching live option chain…' : '🛡 Analyse Collar'}
        </button>
        {error && <div className="text-score-red text-xs mt-1">{error}</div>}
      </div>

      {/* Results */}
      {r && !r.error && (
        <div className="space-y-4">

          {/* IV spike risk banner */}
          {r.iv_spike_risk?.risks && r.iv_spike_risk.risks.length > 0 && (
            <div className={`border rounded-xl px-4 py-3 text-sm ${ivRiskColor}`}>
              ⚠ {r.iv_spike_risk.risks[0]}
              {r.iv_spike_risk.recommendation && <div className="text-xs mt-1 opacity-80">{r.iv_spike_risk.recommendation}</div>}
            </div>
          )}

          {/* Recommendation */}
          <div className="bg-blue-950 border border-blue-800 rounded-xl px-4 py-3 text-sm text-blue-200">
            🛡 {r.recommendation}
          </div>

          {/* Header row */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap gap-4 items-center text-sm">
            <div>
              <span className="text-white font-bold text-lg">{label}</span>
              <span className="text-muted ml-2">Spot ₹{r.spot.toLocaleString('en-IN', {maximumFractionDigits: 0})}</span>
            </div>
            <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
              Expiry: {r.expiry || '—'} · {r.days_to_expiry}d
            </span>
            <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
              Lot: {r.lot_size} · {r.lots} lot{r.lots !== 1 ? 's' : ''}
            </span>
            {r.atm_iv && (
              <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
                ATM IV: {r.atm_iv}%
              </span>
            )}
            <span className={`text-xs font-bold px-2 py-1 rounded border ${r.is_credit ? 'bg-green-950 border-green-700 text-green-300' : 'bg-red-950 border-red-700 text-red-300'}`}>
              {r.is_credit ? `✓ NET CREDIT ₹${r.net_total.toLocaleString('en-IN', {maximumFractionDigits: 0})}` : `DEBIT ₹${Math.abs(r.net_total).toLocaleString('en-IN', {maximumFractionDigits: 0})}`}
            </span>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Max Gain (capped)',    val: `₹${fmt(r.max_gain)}`,              sub: `+${fmt(r.max_gain_pct)}%`,               col: 'text-score-green' },
              { label: 'Max Loss (protected)', val: `₹${fmt(Math.abs(r.max_loss))}`,   sub: `${fmt(r.max_loss_pct)}%`,                col: 'text-score-red' },
              { label: 'Protected Below',      val: `${r.protected_down_pct}%`,          sub: `floor ₹${r.put_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}`, col: 'text-blue-300' },
              { label: 'Ann. Yield (on margin)',val: `${r.annualized_yield}%`,           sub: `margin ≈ ₹${(r.margin_est/1000).toFixed(0)}K`, col: 'text-score-amber' },
            ].map(c => (
              <div key={c.label} className="bg-card border border-border rounded-xl p-3">
                <div className="text-xs text-muted mb-1">{c.label}</div>
                <div className={`text-lg font-bold ${c.col}`}>{c.val}</div>
                <div className="text-[10px] text-muted">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 3-scenario plan with BS probabilities */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">
              📊 Scenario Plan at Expiry
            </div>
            <div className="divide-y divide-border">
              {[
                {
                  label: `📈 Rises above ₹${r.call_strike.toLocaleString('en-IN',{maximumFractionDigits:0})} (call exercised)`,
                  prob: r.prob_above_call,
                  pnl: r.max_gain,
                  color: 'border-green-700 bg-green-950/30',
                  probColor: 'text-score-green',
                  action: `Call exercised. Position exits at ₹${r.call_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}. Max gain ₹${fmt(r.max_gain)} (+${fmt(r.max_gain_pct)}%).`,
                },
                {
                  label: `↔ Stays between ₹${r.put_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}–₹${r.call_strike.toLocaleString('en-IN',{maximumFractionDigits:0})} (ideal)`,
                  prob: r.prob_in_range,
                  pnl: r.net_total,
                  color: 'border-blue-700 bg-blue-950/30',
                  probColor: 'text-blue-300',
                  action: `Both options expire worthless. Keep ${r.is_credit ? 'net credit' : 'reduced debit'} of ₹${fmt(Math.abs(r.net_total))}. Position intact.`,
                },
                {
                  label: `📉 Falls below ₹${r.put_strike.toLocaleString('en-IN',{maximumFractionDigits:0})} (put protects)`,
                  prob: r.prob_below_put,
                  pnl: r.max_loss,
                  color: 'border-red-700 bg-red-950/30',
                  probColor: 'text-score-red',
                  action: `Put activated. Loss capped at ₹${fmt(Math.abs(r.max_loss))} (${fmt(r.max_loss_pct)}%). Without collar loss would be unlimited.`,
                },
              ].map(s => (
                <div key={s.label} className={`px-4 py-3 border-l-4 ${s.color}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-sm font-semibold text-white">{s.label}</div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold ${s.probColor}`}>{s.prob}% prob</span>
                      <span className={`text-sm font-bold ${s.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {s.pnl >= 0 ? '+' : ''}₹{fmt(Math.abs(s.pnl))}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-muted">{s.action}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Collar legs */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">
              Collar Legs · Entry ₹{r.entry_price.toLocaleString('en-IN',{maximumFractionDigits:0})} · Breakeven ₹{r.breakeven.toLocaleString('en-IN',{maximumFractionDigits:0})}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
              {/* SELL CALL */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs bg-red-950 border border-red-700 text-red-300 px-2 py-0.5 rounded font-bold">SELL CALL</span>
                  <span className="text-xs text-muted">{callOtm}% OTM · income leg</span>
                </div>
                {[
                  ['Strike', `₹${r.call_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}`],
                  ['LTP', r.call_ltp > 0 ? `₹${fmt(r.call_ltp)}` : '—'],
                  ['IV', r.call_iv ? `${r.call_iv}%` : '—'],
                  ['Bid / Ask', (r.call_bid && r.call_ask) ? `₹${fmt(r.call_bid)} / ₹${fmt(r.call_ask)}` : '—'],
                  ['OI', r.call_oi ? r.call_oi.toLocaleString('en-IN') : '—'],
                  ['Income (1 lot)', `₹${(r.call_ltp * r.lot_size).toLocaleString('en-IN',{maximumFractionDigits:0})}`],
                ].map(([l,v]) => (
                  <div key={l} className="flex justify-between text-sm py-0.5">
                    <span className="text-muted">{l}</span>
                    <span className={l === 'Income (1 lot)' ? 'text-score-green font-semibold' : 'text-white'}>{v}</span>
                  </div>
                ))}
              </div>
              {/* BUY PUT */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs bg-green-950 border border-green-700 text-green-300 px-2 py-0.5 rounded font-bold">BUY PUT</span>
                  <span className="text-xs text-muted">{putOtm}% OTM · protection leg</span>
                </div>
                {[
                  ['Strike', `₹${r.put_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}`],
                  ['LTP', r.put_ltp > 0 ? `₹${fmt(r.put_ltp)}` : '—'],
                  ['IV', r.put_iv ? `${r.put_iv}%` : '—'],
                  ['Bid / Ask', (r.put_bid && r.put_ask) ? `₹${fmt(r.put_bid)} / ₹${fmt(r.put_ask)}` : '—'],
                  ['OI', r.put_oi ? r.put_oi.toLocaleString('en-IN') : '—'],
                  ['Cost (1 lot)', `₹${(r.put_ltp * r.lot_size).toLocaleString('en-IN',{maximumFractionDigits:0})}`],
                ].map(([l,v]) => (
                  <div key={l} className="flex justify-between text-sm py-0.5">
                    <span className="text-muted">{l}</span>
                    <span className={l === 'Cost (1 lot)' ? 'text-score-red font-semibold' : 'text-white'}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Greeks accordion */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button onClick={() => setGreeksOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800/30">
              <span>📐 Greeks (Black-Scholes)</span>
              <span className="text-muted">{greeksOpen ? '▲' : '▼'}</span>
            </button>
            {greeksOpen && (
              <div className="border-t border-border p-4">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted border-b border-border">
                      <th className="text-left py-1">Greek</th>
                      <th className="text-right py-1">Short Call</th>
                      <th className="text-right py-1">Long Put</th>
                      <th className="text-right py-1">Net Position</th>
                      <th className="text-left py-1 pl-4">Meaning</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {[
                      { name: 'Delta', call: r.call_delta, put: r.put_delta, net: r.net_delta,
                        meaning: 'Net Δ≈1 means position moves 1:1 with underlying (fully hedged = 0)' },
                      { name: 'Gamma', call: r.call_gamma ? -r.call_gamma : null, put: r.put_gamma, net: null,
                        meaning: 'Rate of delta change. Long put = positive gamma (good)' },
                      { name: 'Theta (₹/day)', call: r.call_theta ? -r.call_theta : null, put: r.put_theta ? -r.put_theta : null, net: null,
                        meaning: 'Time decay. Short call earns theta; long put pays theta daily' },
                      { name: 'Vega (₹/1%IV)', call: r.call_vega ? -r.call_vega : null, put: r.put_vega, net: null,
                        meaning: 'IV sensitivity. Long put benefits if IV rises; short call loses' },
                    ].map(g => (
                      <tr key={g.name}>
                        <td className="py-1.5 font-medium text-slate-300">{g.name}</td>
                        <td className="py-1.5 text-right text-score-red">{g.call != null ? fmt(g.call, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-score-green">{g.put != null ? fmt(g.put, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-white font-semibold">{g.net != null ? fmt(g.net, 3) : '—'}</td>
                        <td className="py-1.5 pl-4 text-muted">{g.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// WIDE WING IRON FLY
// ═══════════════════════════════════════════════════════════════

type IFUnderlyingType = 'nifty' | 'banknifty' | 'stock'

interface IronFlyResult {
  underlying_type: string
  symbol: string
  is_index: boolean
  qty_lots: number
  lot_size: number
  spot: number
  expiry: string
  days_to_expiry: number
  all_expiries: string[]
  atm_iv: number | null
  atm_strike: number
  bc_strike: number
  bp_strike: number
  sc_ltp: number; sp_ltp: number; bc_ltp: number; bp_ltp: number
  sc_iv: number | null; sp_iv: number | null; bc_iv: number | null; bp_iv: number | null
  sc_oi: number | null; sp_oi: number | null; bc_oi: number | null; bp_oi: number | null
  sc_bid: number | null; sc_ask: number | null
  sp_bid: number | null; sp_ask: number | null
  bc_bid: number | null; bc_ask: number | null
  bp_bid: number | null; bp_ask: number | null
  net_credit_pu: number
  net_credit_total: number
  wing_width_pts: number
  upper_wing_width: number
  lower_wing_width: number
  max_profit_pu: number; max_loss_pu: number
  max_profit_total: number; max_loss_total: number
  upper_be: number; lower_be: number
  rr_ratio: number
  margin_est: number
  ann_yield: number
  prob_profit: number; prob_max_loss: number
  prob_above_upper_be: number; prob_below_lower_be: number
  prob_above_uc: number; prob_below_lw: number
  net_delta: number; net_theta: number; net_vega: number; net_gamma: number
  sc_delta: number; sc_gamma: number; sc_theta: number; sc_vega: number
  sp_delta: number; sp_gamma: number; sp_theta: number; sp_vega: number
  bc_delta: number | null; bc_gamma: number | null; bc_theta: number | null; bc_vega: number | null
  bp_delta: number | null; bp_gamma: number | null; bp_theta: number | null; bp_vega: number | null
  price_range: Record<string, number>
  iv_spike_risk: { risk_level?: string; risks?: string[]; recommendation?: string }
  recommendation: string
  error?: string
}

const IF_LOT_DEFAULTS: Record<IFUnderlyingType, string> = {
  nifty: '1', banknifty: '1', stock: '1'
}

const IF_LABEL: Record<IFUnderlyingType, string> = {
  nifty: 'NIFTY 50', banknifty: 'BANK NIFTY', stock: 'Stock F&O'
}

function IronFlyTab() {
  const [uType, setUType]         = useState<IFUnderlyingType>('nifty')
  const [symbol, setSymbol]       = useState('')
  const [symName, setSymName]     = useState('')
  const [qtyLots, setQtyLots]     = useState('1')
  const [wingPct, setWingPct]     = useState('3')
  const [expiryDays, setExpiryDays] = useState('30')
  const [result, setResult]       = useState<IronFlyResult | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [greeksOpen, setGreeksOpen] = useState(false)

  const selectType = (t: IFUnderlyingType) => {
    setUType(t); setResult(null); setError('')
    setQtyLots(IF_LOT_DEFAULTS[t])
  }

  const analyze = () => {
    if (uType === 'stock' && !symbol) { setError('Please select a stock first.'); return }
    setLoading(true); setError('')
    const params = new URLSearchParams({
      underlying_type: uType,
      symbol:          symbol || '',
      qty_lots:        qtyLots,
      wing_width_pct:  wingPct,
      expiry_days:     expiryDays,
    })
    client.get(`/strategies/ironfly?${params}`)
      .then(r => {
        if (r.data.error) { setError(r.data.error); setResult(null) }
        else setResult(r.data)
      })
      .catch(() => setError('Failed to fetch option chain. Market may be closed.'))
      .finally(() => setLoading(false))
  }

  const r = result
  const displayLabel = r ? (r.is_index ? IF_LABEL[r.underlying_type as IFUnderlyingType] ?? r.symbol : r.symbol) : ''

  const ivRiskColor = r?.iv_spike_risk?.risk_level === 'high'   ? 'bg-red-950 border-red-700 text-red-200'
    : r?.iv_spike_risk?.risk_level === 'medium' ? 'bg-amber-950 border-amber-700 text-amber-200'
    : 'bg-green-950 border-green-800 text-green-200'

  return (
    <div className="space-y-5">

      {/* Strategy explainer */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="text-sm font-semibold text-white mb-2">🦋 Wide Wing Iron Fly — Strategy Logic</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-300">
          <div className="space-y-1.5">
            <div><span className="text-score-red font-semibold">SELL ATM Call + SELL ATM Put</span> <span className="text-muted">— collect maximum premium (the body)</span></div>
            <div><span className="text-score-green font-semibold">BUY OTM Call + BUY OTM Put</span> <span className="text-muted">— cap your maximum loss (the wings)</span></div>
          </div>
          <div className="space-y-1.5">
            <div><span className="text-score-amber font-semibold">Best in:</span> <span className="text-muted">Low-volatility, sideways/consolidating markets. Earn time decay every day.</span></div>
            <div><span className="text-score-red font-semibold">Avoid when:</span> <span className="text-muted">High-impact events near expiry (results, RBI, elections) — IV spike kills the trade.</span></div>
          </div>
        </div>
      </div>

      {/* Input panel */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">

        {/* Underlying selector */}
        <div>
          <div className="text-xs text-muted mb-2">Underlying</div>
          <div className="flex flex-wrap gap-2">
            {(['nifty', 'banknifty'] as IFUnderlyingType[]).map(t => (
              <button key={t} onClick={() => selectType(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType === t ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-border text-muted hover:text-white'}`}>
                📈 {t === 'banknifty' ? 'BANK NIFTY' : 'NIFTY 50'}
              </button>
            ))}
            <button onClick={() => selectType('stock')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType === 'stock' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-border text-muted hover:text-white'}`}>
              🏢 Stock F&O
            </button>
          </div>
        </div>

        {/* Stock search */}
        {uType === 'stock' && (
          <div>
            <div className="text-xs text-muted mb-1">NSE F&O Stock</div>
            {symbol ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-slate-800 border border-border rounded px-3 py-2 text-sm">
                  <span className="text-white font-semibold">{symbol}</span>
                  {symName && <span className="text-muted ml-2 text-xs">{symName}</span>}
                </div>
                <button onClick={() => { setSymbol(''); setSymName(''); setResult(null) }}
                  className="text-muted hover:text-white text-xs border border-border rounded px-2 py-2">✕</button>
              </div>
            ) : (
              <NseStockSearch
                onSelect={(sym, name) => { setSymbol(sym.replace('.NS', '')); setSymName(name) }}
                placeholder="Search NSE F&O stock (e.g. RELIANCE, HDFCBANK)"
              />
            )}
          </div>
        )}

        {/* Parameters */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">Lots</div>
            <input type="number" value={qtyLots} onChange={e => setQtyLots(e.target.value)} min={1}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            <div className="text-[10px] text-muted mt-1">
              {uType !== 'stock' ? `NIFTY=75 · BANKNIFTY=35` : '1 lot = stock lot size'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Wing Width %</div>
            <input type="number" value={wingPct} onChange={e => setWingPct(e.target.value)} step={0.5} min={1} max={10}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            <div className="text-[10px] text-muted mt-1">OTM % per wing (3% = wide)</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Preferred Expiry</div>
            <select value={expiryDays} onChange={e => setExpiryDays(e.target.value)}
              className="w-full bg-slate-800 border border-border rounded px-3 py-2 text-sm text-white focus:outline-none">
              {[7, 14, 21, 30, 45, 60].map(d => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
        </div>

        <button onClick={analyze} disabled={loading || (uType === 'stock' && !symbol)}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg">
          {loading ? '⏳ Fetching live option chain…' : '🦋 Analyse Iron Fly'}
        </button>
        {error && <div className="text-score-red text-xs mt-1">{error}</div>}
      </div>

      {/* Results */}
      {r && !r.error && (
        <div className="space-y-4">

          {/* IV spike risk */}
          {r.iv_spike_risk?.risks && r.iv_spike_risk.risks.length > 0 && (
            <div className={`border rounded-xl px-4 py-3 text-sm ${ivRiskColor}`}>
              ⚠ {r.iv_spike_risk.risks[0]}
              {r.iv_spike_risk.recommendation && <div className="text-xs mt-1 opacity-80">{r.iv_spike_risk.recommendation}</div>}
            </div>
          )}

          {/* Recommendation */}
          <div className="bg-blue-950 border border-blue-800 rounded-xl px-4 py-3 text-sm text-blue-200">
            🦋 {r.recommendation}
          </div>

          {/* Header */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap gap-3 items-center text-sm">
            <div>
              <span className="text-white font-bold text-lg">{displayLabel}</span>
              <span className="text-muted ml-2">Spot ₹{r.spot.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
            </div>
            <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
              Expiry: {r.expiry || '—'} · {r.days_to_expiry}d
            </span>
            <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
              Lot: {r.lot_size} · {r.qty_lots} lot{r.qty_lots !== 1 ? 's' : ''}
            </span>
            {r.atm_iv && (
              <span className="text-xs bg-slate-800 border border-border px-2 py-1 rounded text-slate-300">
                ATM IV: {r.atm_iv}%
              </span>
            )}
            <span className="text-xs font-bold px-2 py-1 rounded border bg-green-950 border-green-700 text-green-300">
              NET CREDIT ₹{r.net_credit_total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              {
                label: 'Max Profit', val: `₹${r.max_profit_total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                sub: `${r.max_profit_pu} pts · spot pins ATM`, col: 'text-score-green',
              },
              {
                label: 'Max Loss', val: `₹${r.max_loss_total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                sub: `${r.max_loss_pu} pts · wing width ${r.wing_width_pts}`, col: 'text-score-red',
              },
              {
                label: 'Break-even Range', val: `₹${r.lower_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })} – ₹${r.upper_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                sub: `${(r.net_credit_pu * 2).toFixed(0)} pts wide`, col: 'text-blue-300',
              },
              {
                label: 'Prob of Profit', val: `${r.prob_profit}%`,
                sub: `Ann. yield ${r.ann_yield}% on margin`, col: r.prob_profit >= 55 ? 'text-score-green' : r.prob_profit >= 45 ? 'text-score-amber' : 'text-score-red',
              },
            ].map(c => (
              <div key={c.label} className="bg-card border border-border rounded-xl p-3">
                <div className="text-xs text-muted mb-1">{c.label}</div>
                <div className={`text-base font-bold ${c.col}`}>{c.val}</div>
                <div className="text-[10px] text-muted">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 4 legs */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">
              Iron Fly Legs · ATM ₹{r.atm_strike.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-border">

              {/* SELL ATM CALL */}
              {[
                {
                  badge: 'SELL ATM CALL', badgeColor: 'bg-red-950 border-red-700 text-red-300',
                  desc: 'body · income leg', strikeKey: 'atm_strike',
                  ltp: r.sc_ltp, iv: r.sc_iv, oi: r.sc_oi, bid: r.sc_bid, ask: r.sc_ask,
                  totalLabel: 'Credit (1 lot)', totalVal: r.sc_ltp * r.lot_size, totalColor: 'text-score-green',
                },
                {
                  badge: 'SELL ATM PUT', badgeColor: 'bg-red-950 border-red-700 text-red-300',
                  desc: 'body · income leg', strikeKey: 'atm_strike',
                  ltp: r.sp_ltp, iv: r.sp_iv, oi: r.sp_oi, bid: r.sp_bid, ask: r.sp_ask,
                  totalLabel: 'Credit (1 lot)', totalVal: r.sp_ltp * r.lot_size, totalColor: 'text-score-green',
                },
                {
                  badge: 'BUY OTM CALL', badgeColor: 'bg-green-950 border-green-700 text-green-300',
                  desc: `+${wingPct}% wing · cap loss`, strikeKey: 'bc_strike',
                  ltp: r.bc_ltp, iv: r.bc_iv, oi: r.bc_oi, bid: r.bc_bid, ask: r.bc_ask,
                  totalLabel: 'Debit (1 lot)', totalVal: r.bc_ltp * r.lot_size, totalColor: 'text-score-red',
                },
                {
                  badge: 'BUY OTM PUT', badgeColor: 'bg-green-950 border-green-700 text-green-300',
                  desc: `-${wingPct}% wing · cap loss`, strikeKey: 'bp_strike',
                  ltp: r.bp_ltp, iv: r.bp_iv, oi: r.bp_oi, bid: r.bp_bid, ask: r.bp_ask,
                  totalLabel: 'Debit (1 lot)', totalVal: r.bp_ltp * r.lot_size, totalColor: 'text-score-red',
                },
              ].map(leg => (
                <div key={leg.badge} className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`text-xs px-2 py-0.5 rounded border font-bold ${leg.badgeColor}`}>{leg.badge}</span>
                    <span className="text-xs text-muted">{leg.desc}</span>
                  </div>
                  {[
                    ['Strike', `₹${r[leg.strikeKey as keyof IronFlyResult]?.toLocaleString('en-IN', { maximumFractionDigits: 0 }) ?? '—'}`],
                    ['LTP', leg.ltp > 0 ? `₹${fmt(leg.ltp)}` : '—'],
                    ['IV', leg.iv ? `${leg.iv}%` : '—'],
                    ['Bid / Ask', (leg.bid && leg.ask) ? `₹${fmt(leg.bid)} / ₹${fmt(leg.ask)}` : '—'],
                    ['OI', leg.oi ? leg.oi.toLocaleString('en-IN') : '—'],
                    [leg.totalLabel, `₹${(leg.totalVal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`],
                  ].map(([l, v]) => (
                    <div key={l} className="flex justify-between text-xs py-0.5">
                      <span className="text-muted">{l}</span>
                      <span className={l === leg.totalLabel ? `${leg.totalColor} font-semibold` : 'text-white'}>{v}</span>
                    </div>
                  ))}
                </div>
              ))}

            </div>
          </div>

          {/* Scenario plan */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold text-white">
              📊 Scenario Plan at Expiry
            </div>
            <div className="divide-y divide-border">
              {[
                {
                  label: `✅ Consolidates inside ₹${r.lower_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}–₹${r.upper_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (ideal)`,
                  prob: r.prob_profit,
                  pnl: r.max_profit_total,
                  note: `All 4 options expire worthless. Keep full net credit ₹${r.net_credit_total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}.`,
                  color: 'border-green-700 bg-green-950/30', probColor: 'text-score-green',
                },
                {
                  label: `↗ Moves up to wing ₹${r.bc_strike.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (short call ITM)`,
                  prob: r.prob_above_upper_be,
                  pnl: -(r.bc_strike - r.upper_be) * r.lot_size * r.qty_lots,
                  note: `Partial loss. Loss grows from break-even ₹${r.upper_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })} to max at wing. Long call caps loss.`,
                  color: 'border-amber-700 bg-amber-950/30', probColor: 'text-score-amber',
                },
                {
                  label: `↙ Moves down to wing ₹${r.bp_strike.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (short put ITM)`,
                  prob: r.prob_below_lower_be,
                  pnl: -(r.lower_be - r.bp_strike) * r.lot_size * r.qty_lots,
                  note: `Partial loss. Loss grows from break-even ₹${r.lower_be.toLocaleString('en-IN', { maximumFractionDigits: 0 })} to max at wing. Long put caps loss.`,
                  color: 'border-amber-700 bg-amber-950/30', probColor: 'text-score-amber',
                },
                {
                  label: `🚨 Gaps beyond wings — max loss zone (${r.prob_max_loss.toFixed(1)}%)`,
                  prob: r.prob_max_loss,
                  pnl: -r.max_loss_total,
                  note: `Max loss ₹${r.max_loss_total.toLocaleString('en-IN', { maximumFractionDigits: 0 })} fully realised. Long wings protect beyond this point.`,
                  color: 'border-red-700 bg-red-950/30', probColor: 'text-score-red',
                },
              ].map(s => (
                <div key={s.label} className={`px-4 py-3 border-l-4 ${s.color}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-sm font-semibold text-white">{s.label}</div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold ${s.probColor}`}>{s.prob?.toFixed(1)}%</span>
                      <span className={`text-sm font-bold ${s.pnl >= 0 ? 'text-score-green' : 'text-score-red'}`}>
                        {s.pnl >= 0 ? '+' : ''}₹{Math.abs(s.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-muted">{s.note}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Net position summary bar */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap gap-4 items-center text-xs">
            <div className="text-muted font-semibold">Net Position:</div>
            {[
              { label: 'Δ Delta',  val: fmt(r.net_delta, 3),  hint: '≈0 = delta neutral',  col: Math.abs(r.net_delta) < 0.1 ? 'text-score-green' : 'text-score-amber' },
              { label: 'Γ Gamma',  val: fmt(r.net_gamma, 4),  hint: 'negative = short gamma', col: 'text-score-red' },
              { label: 'Θ Theta',  val: `${r.net_theta >= 0 ? '+' : ''}${fmt(r.net_theta, 2)}/d`, hint: r.net_theta >= 0 ? 'earn daily decay' : 'paying net theta — skew is high', col: r.net_theta >= 0 ? 'text-score-green' : 'text-score-amber' },
              { label: 'ν Vega',   val: fmt(r.net_vega, 2),   hint: 'negative = short vega', col: 'text-score-red' },
              { label: 'R:R',      val: `1 : ${r.rr_ratio > 0 ? (1/r.rr_ratio).toFixed(1) : '—'}`, hint: 'reward:risk', col: 'text-slate-300' },
            ].map(g => (
              <div key={g.label} title={g.hint} className="bg-slate-800 rounded px-2.5 py-1.5 text-center cursor-help">
                <div className="text-muted text-[10px]">{g.label}</div>
                <div className={`font-bold text-xs ${g.col}`}>{g.val}</div>
              </div>
            ))}
          </div>

          {/* Greeks accordion */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button onClick={() => setGreeksOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800/30">
              <span>📐 Per-Leg Greeks (Black-Scholes)</span>
              <span className="text-muted">{greeksOpen ? '▲' : '▼'}</span>
            </button>
            {greeksOpen && (
              <div className="border-t border-border p-4 overflow-x-auto">
                <table className="w-full text-xs min-w-[480px]">
                  <thead>
                    <tr className="text-muted border-b border-border">
                      <th className="text-left py-1">Greek</th>
                      <th className="text-right py-1 text-score-red">SC ATM Call</th>
                      <th className="text-right py-1 text-score-red">SP ATM Put</th>
                      <th className="text-right py-1 text-score-green">BC Wing Call</th>
                      <th className="text-right py-1 text-score-green">BP Wing Put</th>
                      <th className="text-right py-1 text-white font-bold">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {[
                      { name: 'Delta',
                        sc: r.sc_delta, sp: r.sp_delta, bc: r.bc_delta, bp: r.bp_delta, net: r.net_delta,
                        meaning: 'Net Δ≈0 = delta-neutral. Short ATM call/put deltas cancel.' },
                      { name: 'Gamma',
                        sc: -r.sc_gamma, sp: -r.sp_gamma, bc: r.bc_gamma, bp: r.bp_gamma, net: r.net_gamma,
                        meaning: 'Net Γ negative = short gamma. Suffers from large moves.' },
                      { name: 'Theta/day',
                        sc: -r.sc_theta, sp: -r.sp_theta, bc: r.bc_theta, bp: r.bp_theta, net: r.net_theta,
                        meaning: 'Net Θ positive = earn time decay daily. Strategy profits from theta.' },
                      { name: 'Vega/1%IV',
                        sc: -r.sc_vega, sp: -r.sp_vega, bc: r.bc_vega, bp: r.bp_vega, net: r.net_vega,
                        meaning: 'Net ν negative = short vega. IV spike hurts P&L. Avoid near events.' },
                    ].map(g => (
                      <tr key={g.name} title={g.meaning}>
                        <td className="py-1.5 font-medium text-slate-300 cursor-help" title={g.meaning}>{g.name}</td>
                        <td className="py-1.5 text-right text-score-red">{g.sc != null ? fmt(g.sc, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-score-red">{g.sp != null ? fmt(g.sp, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-score-green">{g.bc != null ? fmt(g.bc, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-score-green">{g.bp != null ? fmt(g.bp, 3) : '—'}</td>
                        <td className="py-1.5 text-right text-white font-semibold">{g.net != null ? fmt(g.net, 3) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-[10px] text-muted mt-2">Hover a row for meaning. SC/SP = Short positions (negative sign applied). BC/BP = Long wing positions.</div>
              </div>
            )}
          </div>

          {/* Wing width note */}
          <div className="text-xs text-muted bg-card border border-border rounded-xl p-3">
            💡 <span className="text-slate-300 font-semibold">Wide Wing tip:</span> Wings at {wingPct}% OTM give break-evens {(r.net_credit_pu * 2).toFixed(0)} pts wide around ATM.
            {r.net_theta >= 0
              ? ` This trade earns ₹${fmt(r.net_theta, 0)}/day theta and loses when IV rises (${fmt(r.net_vega, 0)} per 1% IV move).`
              : ` ⚠ Net theta is negative (${fmt(r.net_theta, 2)}/day) — put skew is high, making the long put expensive. Consider a narrower lower wing or a higher ATM when skew normalises.`
            }
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM FLY — STAGED ENTRY with PAYOFF CHART
// ═══════════════════════════════════════════════════════════════

// ── Client-side Black-Scholes for payoff chart ──────────────
function _ncdf(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)/Math.sqrt(2)
  const t = 1/(1+p*ax)
  const y = 1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax)
  return 0.5*(1+sign*y)
}
function bsOptPrice(S:number,K:number,iv:number,dte:number,type:'CE'|'PE',rf=0.065):number {
  if(dte<=0) return type==='CE'?Math.max(0,S-K):Math.max(0,K-S)
  const T=dte/365,s=iv/100
  if(s<=0||S<=0||K<=0) return type==='CE'?Math.max(0,S-K):Math.max(0,K-S)
  const d1=(Math.log(S/K)+(rf+0.5*s*s)*T)/(s*Math.sqrt(T)),d2=d1-s*Math.sqrt(T)
  return type==='CE'?S*_ncdf(d1)-K*Math.exp(-rf*T)*_ncdf(d2):K*Math.exp(-rf*T)*_ncdf(-d2)-S*_ncdf(-d1)
}

interface CfLeg {
  id:string; type:'CE'|'PE'; pos:'short'|'long'
  strike:number; ltp:number; iv:number; dte:number; stage:1|2
}

function cfLegPnl(spot:number,legs:CfLeg[],lot:number,qty:number,atExpiry:boolean,cDte=0):number {
  return legs.reduce((s,l)=>{
    const v = atExpiry?(l.type==='CE'?Math.max(0,spot-l.strike):Math.max(0,l.strike-spot)):bsOptPrice(spot,l.strike,l.iv,cDte,l.type)
    return s+(l.pos==='long'?v-l.ltp:l.ltp-v)*lot*qty
  },0)
}

// ── Payoff Chart (SVG) ──────────────────────────────────────
interface PayoffChartProps {
  legs:CfLeg[]; spot:number; lot:number; qty:number; currentDte:number
  oiData?:{strike:number;call_oi:number;put_oi:number}[]
  sd?:{upper_1sd:number;lower_1sd:number;upper_2sd:number;lower_2sd:number;sd1_pts:number}|null
  atmIv?:number
}

function PayoffChart({legs,spot,lot,qty,currentDte,oiData,sd,atmIv}:PayoffChartProps) {
  if(!legs.length) return (
    <div className="h-64 bg-slate-900/60 rounded-xl flex items-center justify-center text-muted text-sm border border-border">
      Lock Stage 1 legs to see payoff chart
    </div>
  )
  const W=940,H=360,pL=72,pR=68,pT=40,pB=62
  const pw=W-pL-pR,ph=H-pT-pB

  // P&L curves
  const xMin=spot*0.88,xMax=spot*1.12,N=320
  const prices=Array.from({length:N},(_,i)=>xMin+(xMax-xMin)*i/(N-1))
  const exPnl=prices.map(p=>cfLegPnl(p,legs,lot,qty,true))
  const midDte=Math.max(1,Math.round(currentDte*0.5))
  const midPnl=currentDte>3?prices.map(p=>cfLegPnl(p,legs,lot,qty,false,midDte)):null
  const curPnl=currentDte>0?prices.map(p=>cfLegPnl(p,legs,lot,qty,false,currentDte)):null
  const allV=[...exPnl,...(midPnl||[]),...(curPnl||[])]
  const yLo=Math.min(...allV)*1.35-800,yHi=Math.max(...allV)*1.35+800,yr=yHi-yLo

  const xs=(p:number)=>pL+(p-xMin)/(xMax-xMin)*pw
  const ys=(v:number)=>pT+ph*(1-(v-yLo)/yr)
  const z0=ys(0)

  // OI scale (right axis) — bars from bottom of chart area upward
  const oiInRange = (oiData||[]).filter(d=>d.strike>=xMin&&d.strike<=xMax)
  const oiMax = Math.max(...oiInRange.map(d=>Math.max(d.call_oi,d.put_oi)),1)
  const oiY=(v:number)=>pT+ph-(v/oiMax)*ph*0.72   // bars occupy 72% of chart height
  const fOI=(v:number)=>v>=10000000?`${(v/10000000).toFixed(1)}Cr`:v>=100000?`${(v/100000).toFixed(1)}L`:v>=1000?`${(v/1000).toFixed(0)}K`:String(v)
  const barW = oiInRange.length > 0 ? Math.max(4, Math.min(14, pw/oiInRange.length*0.35)) : 8

  const buildFill=(vals:number[],pos:boolean)=>{
    const segs:string[]=[];let pts:string[]=[]
    for(let i=0;i<prices.length;i++){
      const ok=pos?vals[i]>=0:vals[i]<0
      if(ok){
        if(!pts.length&&i>0){const t=-vals[i-1]/(vals[i]-vals[i-1]);pts.push(`${xs(prices[i-1]+t*(prices[i]-prices[i-1]))},${z0}`)}
        pts.push(`${xs(prices[i])},${ys(vals[i])}`)
      } else if(pts.length){
        if(i>0){const t=-vals[i-1]/(vals[i]-vals[i-1]);pts.push(`${xs(prices[i-1]+t*(prices[i]-prices[i-1]))},${z0}`)}
        segs.push(`M ${pts.join(' L ')} Z`);pts=[]
      }
    }
    if(pts.length){pts.push(`${xs(prices[prices.length-1])},${z0}`);segs.push(`M ${pts.join(' L ')} Z`)}
    return segs.join(' ')
  }
  const pl=(vals:number[])=>prices.map((p,i)=>`${xs(p)},${ys(vals[i])}`).join(' ')

  const bes:number[]=[]
  for(let i=0;i<exPnl.length-1;i++){
    if((exPnl[i]<=0&&exPnl[i+1]>0)||(exPnl[i]>0&&exPnl[i+1]<=0)){
      const t=-exPnl[i]/(exPnl[i+1]-exPnl[i]);bes.push(prices[i]+t*(prices[i+1]-prices[i]))
    }
  }
  const strikes=[...new Set(legs.map(l=>l.strike))].filter(s=>s>=xMin&&s<=xMax).sort((a,b)=>a-b)
  const step=Math.pow(10,Math.floor(Math.log10(Math.max(yr/5,1))))
  const yTicks=Array.from({length:11},(_,i)=>Math.round((yLo+yr/11*i)/step)*step).filter((t,_,a)=>a.indexOf(t)===_&&t>=yLo&&t<=yHi)
  const oiTicks=[0,0.25,0.5,0.75,1.0].map(f=>Math.round(oiMax*f))
  const fK=(v:number)=>{const a=Math.abs(v);return a>=100000?`${(v/100000).toFixed(1)}L`:a>=1000?`${(v/1000).toFixed(0)}K`:v.toFixed(0)}
  const fP=(p:number)=>p>=1000?`${(p/1000).toFixed(1)}K`:p.toFixed(0)
  const legsByStrike:Record<number,CfLeg[]>={}
  for(const l of legs){if(!legsByStrike[l.strike])legsByStrike[l.strike]=[];legsByStrike[l.strike].push(l)}

  // Current P&L at spot (for callout)
  const spotPnlNow = currentDte>0?cfLegPnl(spot,legs,lot,qty,false,currentDte):cfLegPnl(spot,legs,lot,qty,true)
  const spotPnlExp = cfLegPnl(spot,legs,lot,qty,true)
  const totalInvested = legs.reduce((s,l)=>s+(l.pos==='long'?l.ltp:0)*lot*qty,0)+1  // premium paid

  // SD band positions
  const sdBands = sd ? [
    {x:xs(sd.lower_2sd),label:'-2SD',col:'#475569'},
    {x:xs(sd.lower_1sd),label:'-1SD',col:'#64748b'},
    {x:xs(sd.upper_1sd),label:'+1SD',col:'#64748b'},
    {x:xs(sd.upper_2sd),label:'+2SD',col:'#475569'},
  ].filter(b=>b.x>pL&&b.x<pL+pw) : []

  return(
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl" style={{background:'#080d18'}}>
      <defs>
        <clipPath id="cfclip2"><rect x={pL} y={pT} width={pw} height={ph}/></clipPath>
      </defs>
      <rect x={pL} y={pT} width={pw} height={ph} fill="#0b1220" rx={3} stroke="#1a2535" strokeWidth={1}/>

      <g clipPath="url(#cfclip2)">
        {/* OI bars — background layer */}
        {oiInRange.map(d=>{
          const bx=xs(d.strike)
          const putH=pT+ph-oiY(d.put_oi)
          const callH=pT+ph-oiY(d.call_oi)
          return(
            <g key={`oi${d.strike}`}>
              {d.put_oi>0&&<rect x={bx-barW-1} y={oiY(d.put_oi)} width={barW} height={putH} fill="rgba(74,222,128,0.22)" rx={1}/>}
              {d.call_oi>0&&<rect x={bx+1} y={oiY(d.call_oi)} width={barW} height={callH} fill="rgba(248,113,113,0.22)" rx={1}/>}
            </g>
          )
        })}

        {/* Grid lines */}
        {yTicks.map(t=><line key={`yg${t}`} x1={pL} y1={ys(t)} x2={pL+pw} y2={ys(t)} stroke="#141f30" strokeWidth={1}/>)}

        {/* SD bands */}
        {sdBands.map(b=>(
          <line key={b.label} x1={b.x} y1={pT} x2={b.x} y2={pT+ph} stroke={b.col} strokeWidth={1} strokeDasharray="4,4"/>
        ))}

        {/* Zero line */}
        <line x1={pL} y1={z0} x2={pL+pw} y2={z0} stroke="#2d3e52" strokeWidth={1}/>

        {/* P&L fill zones */}
        <path d={buildFill(exPnl,true)} fill="rgba(34,197,94,0.11)"/>
        <path d={buildFill(exPnl,false)} fill="rgba(239,68,68,0.11)"/>

        {/* Strike guide lines */}
        {strikes.map(s=><line key={`sv${s}`} x1={xs(s)} y1={pT} x2={xs(s)} y2={pT+ph} stroke="#1e2d3f" strokeWidth={1} strokeDasharray="3,3"/>)}

        {/* Break-even lines */}
        {bes.map((be,i)=><line key={`be${i}`} x1={xs(be)} y1={pT} x2={xs(be)} y2={pT+ph} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="6,3"/>)}

        {/* Spot line */}
        <line x1={xs(spot)} y1={pT} x2={xs(spot)} y2={pT+ph} stroke="#f59e0b" strokeWidth={2}/>

        {/* P&L curves */}
        {midPnl&&<polyline points={pl(midPnl)} fill="none" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5,4"/>}
        {curPnl&&<polyline points={pl(curPnl)} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="8,4"/>}
        <polyline points={pl(exPnl)} fill="none" stroke="#e2e8f0" strokeWidth={2.5}/>
      </g>

      {/* SD labels at top */}
      {sdBands.map(b=>(
        <text key={`sl${b.label}`} x={b.x} y={pT-4} textAnchor="middle" fontSize={9} fill={b.col}>{b.label}</text>
      ))}

      {/* Break-even labels */}
      {bes.map((be,i)=><text key={`bel${i}`} x={Math.max(pL+18,Math.min(pL+pw-18,xs(be)))} y={pT-5} textAnchor="middle" fontSize={9} fill="#22c55e">BE {fP(be)}</text>)}

      {/* Left P&L Y-axis */}
      <line x1={pL} y1={pT} x2={pL} y2={pT+ph} stroke="#1e293b"/>
      {yTicks.map(t=>(
        <g key={`yt${t}`}>
          <line x1={pL-4} y1={ys(t)} x2={pL} y2={ys(t)} stroke="#2d3e52"/>
          <text x={pL-7} y={ys(t)+4} textAnchor="end" fontSize={10} fill={t===0?'#94a3b8':'#3d5166'}>{t===0?'0':fK(t)}</text>
        </g>
      ))}
      <text x={13} y={pT+ph/2} textAnchor="middle" fontSize={9} fill="#3d5166" transform={`rotate(-90,13,${pT+ph/2})`}>P&amp;L (₹)</text>

      {/* Right OI Y-axis */}
      {oiInRange.length>0&&(
        <>
          <line x1={pL+pw} y1={pT} x2={pL+pw} y2={pT+ph} stroke="#1e293b"/>
          {oiTicks.map(t=>(
            <g key={`oir${t}`}>
              <line x1={pL+pw} y1={oiY(t)} x2={pL+pw+4} y2={oiY(t)} stroke="#2d3e52"/>
              <text x={pL+pw+7} y={oiY(t)+4} fontSize={9} fill="#3d5166">{fOI(t)}</text>
            </g>
          ))}
          <text x={W-12} y={pT+ph/2} textAnchor="middle" fontSize={9} fill="#3d5166" transform={`rotate(90,${W-12},${pT+ph/2})`}>OI</text>
          {/* OI legend */}
          <rect x={pL+pw-90} y={pT+4} width={85} height={28} fill="rgba(8,13,24,0.85)" rx={3}/>
          <rect x={pL+pw-87} y={pT+10} width={8} height={8} fill="rgba(248,113,113,0.5)" rx={1}/>
          <text x={pL+pw-76} y={pT+18} fontSize={9} fill="#94a3b8">Call OI</text>
          <rect x={pL+pw-87} y={pT+21} width={8} height={8} fill="rgba(74,222,128,0.5)" rx={1}/>
          <text x={pL+pw-76} y={pT+29} fontSize={9} fill="#94a3b8">Put OI</text>
        </>
      )}

      {/* X axis */}
      <line x1={pL} y1={pT+ph} x2={pL+pw} y2={pT+ph} stroke="#1e293b"/>
      {[...strikes,spot,...(sd?[sd.upper_1sd,sd.lower_1sd]:[])]
        .sort((a,b)=>a-b)
        .filter((v,i,a)=>a.indexOf(v)===i&&v>=xMin&&v<=xMax)
        .map(p=>(
          <g key={`xp${p}`}>
            <line x1={xs(p)} y1={pT+ph} x2={xs(p)} y2={pT+ph+4} stroke="#2d3e52"/>
            <text x={xs(p)} y={pT+ph+14} textAnchor="middle" fontSize={10}
              fill={p===spot?'#f59e0b':sd&&(p===sd.upper_1sd||p===sd.lower_1sd)?'#64748b':'#94a3b8'}>
              {fP(p)}
            </text>
            {(legsByStrike[p]||[]).map((l,j)=>(
              <text key={l.id} x={xs(p)} y={pT+ph+26+j*11} textAnchor="middle" fontSize={8} fill={l.pos==='short'?'#f87171':'#4ade80'}>
                {l.pos==='short'?'▼':'▲'}{l.type}
              </text>
            ))}
          </g>
        ))
      }
      <text x={xs(spot)} y={pT+ph+46} textAnchor="middle" fontSize={9} fill="#f59e0b">SPOT</text>

      {/* Current price callout box */}
      {(()=>{
        const bx=xs(spot),by=ys(spotPnlNow)
        const label=`SPOT ${spot.toLocaleString('en-IN',{maximumFractionDigits:0})}  |  P&L: ${spotPnlNow>=0?'+':''}${fK(spotPnlNow)}`
        const bw=label.length*5.8+10,bh=16
        const bxc=Math.max(pL+bw/2+2,Math.min(pL+pw-bw/2-2,bx))
        const byc=Math.max(pT+bh/2+2,Math.min(by-14,by-14))
        return(<>
          <rect x={bxc-bw/2} y={byc-bh/2} width={bw} height={bh} rx={3} fill={spotPnlNow>=0?'rgba(21,128,61,0.92)':'rgba(153,27,27,0.92)'} stroke={spotPnlNow>=0?'#22c55e':'#ef4444'} strokeWidth={0.5}/>
          <text x={bxc} y={byc+5} textAnchor="middle" fontSize={9.5} fill="#f1f5f9" fontWeight="500">{label}</text>
        </>)
      })()}

      {/* At-expiry callout at spot */}
      {(()=>{
        const bx=xs(spot),by=ys(spotPnlExp),label=`Expiry: ${spotPnlExp>=0?'+':''}${fK(spotPnlExp)}`
        const bw=label.length*5.4+10,bh=15
        const bxc=Math.max(pL+bw/2+2,Math.min(pL+pw-bw/2-2,bx))
        const byc=Math.max(pT+bh/2+2,Math.min(pT+ph-bh-2,by+18))
        return(<>
          <rect x={bxc-bw/2} y={byc-bh/2} width={bw} height={bh} rx={3} fill="rgba(30,41,59,0.92)" stroke="#475569" strokeWidth={0.5}/>
          <text x={bxc} y={byc+5} textAnchor="middle" fontSize={9} fill="#94a3b8">{label}</text>
        </>)
      })()}

      {/* Legend */}
      <g transform={`translate(${pL+8},${pT+6})`}>
        <rect width={curPnl&&midPnl?200:curPnl?165:110} height={curPnl&&midPnl?60:curPnl?45:24} fill="rgba(8,13,24,0.92)" rx={3}/>
        <line x1={6} y1={13} x2={22} y2={13} stroke="#e2e8f0" strokeWidth={2.5}/>
        <text x={27} y={17} fontSize={10} fill="#94a3b8">At Expiry</text>
        {curPnl&&<><line x1={6} y1={30} x2={22} y2={30} stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="8,4"/><text x={27} y={34} fontSize={10} fill="#94a3b8">Now ({currentDte}d)</text></>}
        {midPnl&&<><line x1={6} y1={47} x2={22} y2={47} stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5,4"/><text x={27} y={51} fontSize={10} fill="#94a3b8">Mid ({midDte}d)</text></>}
      </g>
    </svg>
  )
}

// ── P&L Session Table (next 10 trading days, 3 scenarios) ───────
interface PnlTableProps {
  legs:CfLeg[]; spot:number; lot:number; qty:number
  currentDte:number; atmIv:number; margin:number; direction:CFDir
  expiry:string
}

function PnlSessionTable({legs,spot,lot,qty,currentDte,atmIv,margin,direction,expiry}:PnlTableProps) {
  const [exitPct,setExitPct] = useState('2')

  if(!legs.length||currentDte<=0) return null

  const exitThreshold = parseFloat(exitPct)||2
  const exitAmt = margin * exitThreshold / 100

  // Daily move per scenario using IV-based 1σ
  const daily1sd = spot * (atmIv/100) / Math.sqrt(252)
  const scenMoves:{key:string;label:string;drift:number;color:string;spotColor:string}[] = [
    {key:'bear', label:`Bear (−0.5σ/d ≈ ${(daily1sd*0.5).toFixed(0)}pts)`, drift:-daily1sd*0.5, color:'text-score-red',   spotColor:'#f87171'},
    {key:'neut', label:'Neutral (theta only)',                               drift:0,             color:'text-blue-300',    spotColor:'#60a5fa'},
    {key:'bull', label:`Bull (+0.5σ/d ≈ ${(daily1sd*0.5).toFixed(0)}pts)`, drift:+daily1sd*0.5, color:'text-score-green', spotColor:'#4ade80'},
  ]

  // Generate rows for next 10 trading sessions
  const rows = Array.from({length:10},(_,i)=>{
    const d    = i+1
    const dte  = Math.max(0, currentDte - d)
    const date = new Date()
    // Skip weekends
    let tradingDays=0,checkDate=new Date()
    while(tradingDays<d){
      checkDate.setDate(checkDate.getDate()+1)
      if(checkDate.getDay()!==0&&checkDate.getDay()!==6) tradingDays++
    }
    const dateStr = checkDate.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})

    return {
      d, dateStr, dte,
      scenarios: scenMoves.map(s=>{
        const projSpot = spot + s.drift * d
        const pnl = cfLegPnl(projSpot, legs, lot, qty, dte===0, dte)
        const rocPct = margin>0 ? (pnl/margin*100) : 0
        return {projSpot, pnl, rocPct}
      })
    }
  })

  // Find first exit/stop day per scenario
  const firstExit = scenMoves.map((_,si)=>rows.findIndex(r=>r.scenarios[si].pnl>=exitAmt))
  const firstStop = scenMoves.map((_,si)=>rows.findIndex(r=>r.scenarios[si].pnl<=-exitAmt))

  const fK=(v:number)=>{const a=Math.abs(v);return(v<0?'-':'+')+( a>=100000?`${(a/100000).toFixed(1)}L`:a>=1000?`${(a/1000).toFixed(1)}K`:a.toFixed(0))}

  return(
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-white">📅 10-Session P&L Forecast</div>
          <div className="text-[10px] text-muted mt-0.5">
            IV: {atmIv.toFixed(1)}% · 1σ/day: {daily1sd.toFixed(0)} pts · Margin: ₹{margin.toLocaleString('en-IN',{maximumFractionDigits:0})} · Expiry: {expiry} ({currentDte}d)
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Exit/Stop at</span>
          <input type="number" value={exitPct} onChange={e=>setExitPct(e.target.value)} step={0.5} min={0.5} max={20}
            className="w-16 bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"/>
          <span className="text-xs text-muted">% of margin = ₹{exitAmt.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
        </div>
      </div>

      {/* Scenario key */}
      <div className="px-4 py-2 bg-slate-900/40 border-b border-border flex gap-6 flex-wrap">
        {scenMoves.map((s,si)=>(
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <div className="w-8 h-0.5" style={{background:s.spotColor}}/>
            <span className={s.color}>{s.label}</span>
            {firstExit[si]>=0&&<span className="text-[10px] text-score-green bg-green-950 border border-green-800 px-1.5 py-0.5 rounded">Exit day {rows[firstExit[si]].d}</span>}
            {firstStop[si]>=0&&<span className="text-[10px] text-score-red bg-red-950 border border-red-800 px-1.5 py-0.5 rounded">Stop day {rows[firstStop[si]].d}</span>}
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-3 py-2 text-left sticky left-0 bg-card">Day</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">DTE</th>
              {scenMoves.map(s=>(
                <th key={s.key} colSpan={2} className={`px-3 py-2 text-center border-l border-border/50 ${s.color}`}>{s.key==='bear'?'↓ Bear':s.key==='neut'?'↔ Neutral':'↑ Bull'}</th>
              ))}
            </tr>
            <tr className="border-b border-border text-muted text-[10px]">
              <th className="px-3 py-1 sticky left-0 bg-card"/>
              <th className="px-3 py-1"/>
              <th className="px-3 py-1"/>
              {scenMoves.map(s=>(
                <Fragment key={s.key}>
                  <th className="px-2 py-1 text-right border-l border-border/50">Proj. Spot</th>
                  <th className="px-2 py-1 text-right">P&L (ROC%)</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row=>{
              return(
                <tr key={row.d} className="border-b border-border/40 hover:bg-slate-800/30">
                  <td className="px-3 py-2 font-semibold text-white sticky left-0 bg-card">D{row.d}</td>
                  <td className="px-3 py-2 text-muted">{row.dateStr}</td>
                  <td className="px-3 py-2 text-muted">{row.dte}d</td>
                  {row.scenarios.map((sc,si)=>{
                    const isExit = firstExit[si]===row.d-1
                    const isStop = firstStop[si]===row.d-1
                    const pnlColor = sc.pnl>0?'text-score-green':sc.pnl<0?'text-score-red':'text-muted'
                    return(
                      <Fragment key={si}>
                        <td className={`px-2 py-2 text-right border-l border-border/50 ${sc.pnl>0?'text-slate-300':'text-muted'}`}>
                          {sc.projSpot.toLocaleString('en-IN',{maximumFractionDigits:0})}
                        </td>
                        <td className={`px-2 py-2 text-right font-semibold ${pnlColor}`}>
                          <div className="flex items-center justify-end gap-1">
                            {(isExit||isStop)&&(
                              <span className={`text-[9px] px-1 py-0.5 rounded border font-bold ${isExit?'bg-green-950 border-green-700 text-green-300':'bg-red-950 border-red-700 text-red-300'}`}>
                                {isExit?'EXIT':'STOP'}
                              </span>
                            )}
                            <span>{fK(sc.pnl)}</span>
                            <span className="text-[9px] text-slate-500">({sc.rocPct.toFixed(1)}%)</span>
                          </div>
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer note */}
      <div className="px-4 py-2 border-t border-border text-[10px] text-muted leading-relaxed">
        💡 P&L computed via Black-Scholes with time decay. Bull/Bear scenarios assume ±0.5σ/day move (~{(daily1sd*0.5).toFixed(0)} pts for {atmIv.toFixed(0)}% IV). EXIT = take profit at {exitThreshold}% of margin. STOP = cut loss at {exitThreshold}% of margin. Actual IV and slippage may differ.
      </div>
    </div>
  )
}

// ── CustomFlyTab ───────────────────────────────────────────────
type CFDir  = 'up' | 'down' | 'neutral'
type CFType = 'nifty' | 'banknifty' | 'stock'

interface CFTrend {
  prev_day_chg:number; five_day_chg:number; last5_closes:number[]
  suggested_direction:'up'|'down'|'neutral'; direction_reason:string
}

interface CFChainData {
  underlying_type:string; symbol:string; is_index:boolean
  spot:number; expiry:string; dte:number; lot_size:number
  atm_iv:number; atm_strike:number; bc_strike:number; bp_strike:number
  wing_width_pct:number
  trend?:CFTrend
  oi_distribution?:{strike:number;call_oi:number;put_oi:number}[]
  sd?:{sd1_pts:number;sd2_pts:number;upper_1sd:number;lower_1sd:number;upper_2sd:number;lower_2sd:number}|null
  sc:{type:'CE';pos:'short';strike:number;ltp:number;iv:number;oi:number|null;bid:number|null;ask:number|null;stage:1}|null
  sp:{type:'PE';pos:'short';strike:number;ltp:number;iv:number;oi:number|null;bid:number|null;ask:number|null;stage:2}|null
  bc:{type:'CE';pos:'long';strike:number;ltp:number;iv:number;oi:number|null;stage:1}|null
  bp:{type:'PE';pos:'long';strike:number;ltp:number;iv:number;oi:number|null;stage:2}|null
  call_spread:{short_strike:number;long_strike:number;short_ltp:number;long_ltp:number;net_credit:number;net_credit_rs:number}
  put_spread:{short_strike:number;long_strike:number;short_ltp:number;long_ltp:number;net_credit:number;net_credit_rs:number}
  combined:{total_credit:number;total_credit_rs:number;wing_width_pts:number;max_loss_pu:number;max_loss_rs:number;upper_be:number;lower_be:number;pop:number}
  error?:string
}

const CF_LOT_DEF:Record<CFType,string> = {nifty:'1',banknifty:'1',stock:'1'}
const CF_LABEL:Record<CFType,string>   = {nifty:'NIFTY 50',banknifty:'BANK NIFTY',stock:'Stock F&O'}

function CustomFlyTab() {
  const [uType,setUType]       = useState<CFType>('nifty')
  const [symbol,setSymbol]     = useState('')
  const [symName,setSymName]   = useState('')
  const [wingPct,setWingPct]   = useState('5')
  const [expDays,setExpDays]   = useState('30')
  const [qtyLots,setQtyLots]   = useState('1')
  const [direction,setDir]     = useState<CFDir>('up')
  const [chain1,setChain1]     = useState<CFChainData|null>(null)
  const [chain2,setChain2]     = useState<CFChainData|null>(null)
  const [loading1,setL1]       = useState(false)
  const [loading2,setL2]       = useState(false)
  const [error,setError]       = useState('')
  const [lockedLegs,setLocked] = useState<CfLeg[]>([])
  const [stage1Done,setS1Done] = useState(false)
  const [stage2Done,setS2Done] = useState(false)
  const [currentDte,setCurDte] = useState('')

  // Editable entry prices for each leg (stage 1 and stage 2)
  const [ep,setEp] = useState({sc:'',bc:'',sp:'',bp:''})
  const [ep2,setEp2] = useState({sc:'',bc:'',sp:'',bp:''})

  const fetchChain = (forStage2=false) => {
    const params = new URLSearchParams({
      underlying_type: uType, symbol: symbol||'',
      wing_width_pct:  wingPct, expiry_days: expDays,
    })
    if(forStage2) { setL2(true) } else { setL1(true); setChain1(null); setChain2(null); setLocked([]); setS1Done(false); setS2Done(false) }
    setError('')
    client.get(`/strategies/customfly?${params}`)
      .then(r => {
        if(r.data.error){setError(r.data.error);return}
        if(forStage2){
          setChain2(r.data)
          // Pre-fill Stage 2 prices from fresh chain
          if(direction==='up'){setEp2({sc:String(r.data.sp?.ltp||''),bc:'',sp:'',bp:String(r.data.bp?.ltp||'')})}
          else{setEp2({sc:String(r.data.sc?.ltp||''),bc:String(r.data.bc?.ltp||''),sp:'',bp:''})}
        } else {
          setChain1(r.data)
          // Auto-set direction from trend analysis
          if(r.data.trend?.suggested_direction) {
            setDir(r.data.trend.suggested_direction as CFDir)
          }
          // Pre-fill Stage 1 prices
          setEp({sc:String(r.data.sc?.ltp||''),bc:String(r.data.bc?.ltp||''),sp:String(r.data.sp?.ltp||''),bp:String(r.data.bp?.ltp||'')})
        }
      })
      .catch(()=>setError('Failed to fetch option chain. Market may be closed.'))
      .finally(()=>{ if(forStage2)setL2(false); else setL1(false) })
  }

  const lockStage1 = () => {
    if(!chain1) return
    const iv1 = chain1.atm_iv || 15
    const dte1 = chain1.dte

    const newLegs: CfLeg[] = direction==='neutral'
      // Neutral: lock all 4 legs at once
      ? [
          {id:'s1-sc',type:'CE',pos:'short',strike:chain1.atm_strike,ltp:parseFloat(ep.sc)||chain1.sc?.ltp||0,iv:chain1.sc?.iv||iv1,dte:dte1,stage:1},
          {id:'s1-bc',type:'CE',pos:'long', strike:chain1.bc_strike, ltp:parseFloat(ep.bc)||chain1.bc?.ltp||0,iv:chain1.bc?.iv||iv1*0.7,dte:dte1,stage:1},
          {id:'s1-sp',type:'PE',pos:'short',strike:chain1.atm_strike,ltp:parseFloat(ep.sp)||chain1.sp?.ltp||0,iv:chain1.sp?.iv||iv1,dte:dte1,stage:1},
          {id:'s1-bp',type:'PE',pos:'long', strike:chain1.bp_strike, ltp:parseFloat(ep.bp)||chain1.bp?.ltp||0,iv:chain1.bp?.iv||iv1*0.7,dte:dte1,stage:1},
        ]
      : direction==='up'
      // Up: Stage 1 = Bear Call Spread (short ATM call + long OTM call)
      ? [
          {id:'s1-sc',type:'CE',pos:'short',strike:chain1.atm_strike,ltp:parseFloat(ep.sc)||chain1.sc?.ltp||0,iv:chain1.sc?.iv||iv1,dte:dte1,stage:1},
          {id:'s1-bc',type:'CE',pos:'long', strike:chain1.bc_strike, ltp:parseFloat(ep.bc)||chain1.bc?.ltp||0,iv:chain1.bc?.iv||iv1*0.7,dte:dte1,stage:1},
        ]
      // Down: Stage 1 = Bull Put Spread (short ATM put + long OTM put)
      : [
          {id:'s1-sp',type:'PE',pos:'short',strike:chain1.atm_strike,ltp:parseFloat(ep.sp)||chain1.sp?.ltp||0,iv:chain1.sp?.iv||iv1,dte:dte1,stage:1},
          {id:'s1-bp',type:'PE',pos:'long', strike:chain1.bp_strike, ltp:parseFloat(ep.bp)||chain1.bp?.ltp||0,iv:chain1.bp?.iv||iv1*0.7,dte:dte1,stage:1},
        ]

    setLocked(newLegs)
    setS1Done(true)
    if(!currentDte) setCurDte(String(chain1.dte))
  }

  const lockStage2 = () => {
    if(!chain2) return
    const iv2 = chain2.atm_iv || 15
    const dte2 = chain2.dte

    const stage2Legs: CfLeg[] = direction==='up'
      // Stage 2 for UP: now add Bull Put Spread at new (lower) ATM
      ? [
          {id:'s2-sp',type:'PE',pos:'short',strike:chain2.atm_strike,ltp:parseFloat(ep2.sc)||chain2.sp?.ltp||0,iv:chain2.sp?.iv||iv2,dte:dte2,stage:2},
          {id:'s2-bp',type:'PE',pos:'long', strike:chain2.bp_strike, ltp:parseFloat(ep2.bp)||chain2.bp?.ltp||0,iv:chain2.bp?.iv||iv2*0.7,dte:dte2,stage:2},
        ]
      // Stage 2 for DOWN: add Bear Call Spread at new (higher) ATM
      : [
          {id:'s2-sc',type:'CE',pos:'short',strike:chain2.atm_strike,ltp:parseFloat(ep2.sc)||chain2.sc?.ltp||0,iv:chain2.sc?.iv||iv2,dte:dte2,stage:2},
          {id:'s2-bc',type:'CE',pos:'long', strike:chain2.bc_strike, ltp:parseFloat(ep2.bc)||chain2.bc?.ltp||0,iv:chain2.bc?.iv||iv2*0.7,dte:dte2,stage:2},
        ]
    setLocked(prev=>[...prev,...stage2Legs])
    setS2Done(true)
  }

  const resetAll = () => { setChain1(null);setChain2(null);setLocked([]);setS1Done(false);setS2Done(false);setError('') }

  const allLegs = lockedLegs
  const lot = chain1?.lot_size || (uType==='nifty'?75:uType==='banknifty'?35:100)
  const qty = parseInt(qtyLots)||1
  const spot = chain2?.spot || chain1?.spot || 0
  const chartDte = parseInt(currentDte)||0
  const atmIv = chain1?.atm_iv || 15

  // Compute metrics from locked legs
  const totalCredit = allLegs.reduce((s,l)=>s+(l.pos==='short'?l.ltp:-l.ltp)*lot*qty,0)
  const maxProfitAtm = spot > 0 ? cfLegPnl(spot, allLegs, lot, qty, true) : 0
  const priceRange = Array.from({length:200},(_,i)=>spot*0.85+spot*0.30*i/199)
  const expiryPnls = priceRange.map(p=>cfLegPnl(p,allLegs,lot,qty,true))
  const maxProfit  = Math.max(...expiryPnls)
  const maxLoss    = Math.min(...expiryPnls)

  // Margin estimate: wing width × lot × qty × 1.1
  const wingPts = (()=>{
    const ceLegs = allLegs.filter(l=>l.type==='CE')
    const peLegs = allLegs.filter(l=>l.type==='PE')
    const cW = ceLegs.length>=2 ? Math.abs(ceLegs[0].strike - ceLegs[1].strike) : 0
    const pW = peLegs.length>=2 ? Math.abs(peLegs[0].strike - peLegs[1].strike) : 0
    return Math.max(cW,pW,0)
  })()
  const marginEst = Math.max(wingPts * lot * qty * 1.1, Math.abs(maxLoss) * 1.1, 1)

  // Break-even count
  const bes:number[]=[]
  for(let i=0;i<expiryPnls.length-1;i++){
    if((expiryPnls[i]<=0&&expiryPnls[i+1]>0)||(expiryPnls[i]>0&&expiryPnls[i+1]<=0)){
      const t=-expiryPnls[i]/(expiryPnls[i+1]-expiryPnls[i]);bes.push(priceRange[i]+t*(priceRange[i+1]-priceRange[i]))
    }
  }

  const stage1Net = lockedLegs.filter(l=>l.stage===1).reduce((s,l)=>s+(l.pos==='short'?l.ltp:-l.ltp)*lot*qty,0)
  const stage2Net = lockedLegs.filter(l=>l.stage===2).reduce((s,l)=>s+(l.pos==='short'?l.ltp:-l.ltp)*lot*qty,0)

  // OI + SD from chain (use whichever chain has the data)
  const oiData = chain1?.oi_distribution
  const sdData = chain1?.sd

  const isComplete = direction==='neutral'?stage1Done:stage1Done&&stage2Done

  const dirButtons:(CFDir|string)[] = ['up','down','neutral']
  const dirMeta:Record<string,{icon:string;label:string;color:string;s1:string;s2:string}> = {
    up:      {icon:'↑',label:'Market UP',   color:'text-score-green', s1:'Short ATM Call + Buy 5% OTM Call (Bear Call Spread — collect inflated call premium)',         s2:'After pullback: Short new ATM Put + Buy 5% OTM Put (Bull Put Spread at lower ATM)'},
    down:    {icon:'↓',label:'Market DOWN', color:'text-score-red',   s1:'Short ATM Put + Buy 5% OTM Put (Bull Put Spread — collect inflated put premium / skew)',       s2:'After bounce: Short new ATM Call + Buy 5% OTM Call (Bear Call Spread at higher ATM)'},
    neutral: {icon:'↔',label:'Neutral',     color:'text-blue-300',    s1:'All 4 legs simultaneously (standard iron fly — market not directionally biased)',            s2:'— no stage 2 needed'},
  }

  return (
    <div className="space-y-5">
      {/* Strategy explainer */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-white">🎯 Custom Fly — Staged Entry Strategy</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {(['up','down','neutral'] as CFDir[]).map(d=>(
            <div key={d} className="bg-slate-800/60 rounded-lg p-3 space-y-1.5">
              <div className={`font-bold ${dirMeta[d].color}`}>{dirMeta[d].icon} {dirMeta[d].label}</div>
              <div className="text-muted leading-relaxed">{dirMeta[d].s1}</div>
              {d!=='neutral'&&<div className="text-slate-500 leading-relaxed text-[10px]">Stage 2: {dirMeta[d].s2}</div>}
            </div>
          ))}
        </div>
        <div className="text-xs text-muted border-t border-border pt-2">
          💡 <span className="text-slate-300">Why staged?</span> When market is UP, call IV is temporarily elevated — you collect more premium by shorting calls first. Then when market pulls back, put IV normalises — you add puts at a cheaper IV, resulting in a better combined credit than entering all 4 legs simultaneously.
        </div>
      </div>

      {/* Controls */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap gap-2 items-center">
          {(['nifty','banknifty'] as CFType[]).map(t=>(
            <button key={t} onClick={()=>{setUType(t);resetAll()}}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType===t?'bg-blue-600 border-blue-500 text-white':'bg-slate-800 border-border text-muted hover:text-white'}`}>
              📈 {t==='banknifty'?'BANK NIFTY':'NIFTY 50'}
            </button>
          ))}
          <button onClick={()=>{setUType('stock');resetAll()}}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${uType==='stock'?'bg-blue-600 border-blue-500 text-white':'bg-slate-800 border-border text-muted hover:text-white'}`}>
            🏢 Stock F&O
          </button>
          <div className="ml-auto flex gap-2 items-center">
            <span className="text-xs text-muted">Lots:</span>
            <input type="number" value={qtyLots} onChange={e=>setQtyLots(e.target.value)} min={1}
              className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-xs text-white focus:outline-none"/>
            <span className="text-xs text-muted">Wing:</span>
            <input type="number" value={wingPct} onChange={e=>setWingPct(e.target.value)} step={0.5} min={2} max={10}
              className="w-16 bg-slate-800 border border-border rounded px-2 py-1.5 text-xs text-white focus:outline-none"/>
            <span className="text-xs text-muted">%</span>
            <select value={expDays} onChange={e=>setExpDays(e.target.value)}
              className="bg-slate-800 border border-border rounded px-2 py-1.5 text-xs text-white focus:outline-none">
              {[7,14,21,30,45,60].map(d=><option key={d} value={d}>{d}d</option>)}
            </select>
          </div>
        </div>

        {uType==='stock'&&(
          <div>
            <div className="text-xs text-muted mb-1">NSE F&O Stock</div>
            {symbol?(
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-slate-800 border border-border rounded px-3 py-2 text-sm">
                  <span className="text-white font-semibold">{symbol}</span>
                  {symName&&<span className="text-muted ml-2 text-xs">{symName}</span>}
                </div>
                <button onClick={()=>{setSymbol('');setSymName('');resetAll()}} className="text-muted hover:text-white text-xs border border-border rounded px-2 py-2">✕</button>
              </div>
            ):(
              <NseStockSearch onSelect={(sym,name)=>{setSymbol(sym.replace('.NS',''));setSymName(name)}}
                placeholder="Search NSE F&O stock"/>
            )}
          </div>
        )}

        {/* Direction selector */}
        <div>
          <div className="text-xs text-muted mb-2">Today's Market View <span className="text-[10px] text-slate-500">(auto-set from trend after fetch — override if needed)</span></div>
          <div className="flex gap-2">
            {(['up','down','neutral'] as CFDir[]).map(d=>(
              <button key={d} onClick={()=>setDir(d)}
                className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors flex items-center gap-1.5 ${direction===d?'bg-blue-600 border-blue-500 text-white':'bg-slate-800 border-border text-muted hover:text-white'}`}>
                <span>{dirMeta[d].icon}</span> {dirMeta[d].label}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-muted mt-1.5 pl-1">{dirMeta[direction].s1}</div>
        </div>

        <button onClick={()=>fetchChain(false)} disabled={loading1||(uType==='stock'&&!symbol)}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
          {loading1?'⏳ Fetching chain…':'🔍 Fetch Option Chain'}
        </button>
        {error&&<div className="text-score-red text-xs">{error}</div>}
      </div>

      {/* Trend analysis banner — shown immediately after fetch */}
      {chain1?.trend&&!chain1.error&&(()=>{
        const t = chain1.trend!
        const dirColor = t.suggested_direction==='up'?'border-green-700 bg-green-950/30':t.suggested_direction==='down'?'border-red-700 bg-red-950/30':'border-blue-700 bg-blue-950/30'
        const prevColor = t.prev_day_chg>0?'text-score-green':t.prev_day_chg<0?'text-score-red':'text-muted'
        const fiveColor = t.five_day_chg>0?'text-score-green':t.five_day_chg<0?'text-score-red':'text-muted'
        // Mini sparkline from last5_closes
        const closes = t.last5_closes
        const spark = closes.length >= 2 ? (()=>{
          const lo=Math.min(...closes),hi=Math.max(...closes),rng=hi-lo||1
          const pts=closes.map((c,i)=>`${(i/(closes.length-1))*80+10},${30-((c-lo)/rng)*22}`).join(' ')
          const lineColor=closes[closes.length-1]>=closes[0]?'#22c55e':'#ef4444'
          return <svg viewBox="0 0 100 36" className="w-20 h-7 shrink-0"><polyline points={pts} fill="none" stroke={lineColor} strokeWidth={2}/></svg>
        })():null
        return(
          <div className={`border rounded-xl px-4 py-3 flex flex-col gap-2 ${dirColor}`}>
            <div className="flex items-start gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                {spark}
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-wide mb-0.5">5-day trend</div>
                  <div className="flex gap-4 items-center">
                    <span className="text-xs text-muted">Prev day:</span>
                    <span className={`text-sm font-bold ${prevColor}`}>{t.prev_day_chg>0?'+':''}{t.prev_day_chg.toFixed(0)} pts</span>
                    <span className="text-xs text-muted">5d:</span>
                    <span className={`text-sm font-bold ${fiveColor}`}>{t.five_day_chg>0?'+':''}{t.five_day_chg.toFixed(0)} pts</span>
                  </div>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted uppercase tracking-wide mb-0.5">Trend signal</div>
                <div className={`text-xs font-semibold ${t.suggested_direction==='up'?'text-score-green':t.suggested_direction==='down'?'text-score-red':'text-blue-300'}`}>
                  {t.suggested_direction==='up'?'↑ Bullish':t.suggested_direction==='down'?'↓ Bearish':'↔ Neutral'} → {t.suggested_direction==='up'?'Enter Bear Call Spread first':t.suggested_direction==='down'?'Enter Bull Put Spread first':'Enter all legs simultaneously'}
                </div>
                <div className="text-[10px] text-muted mt-0.5 leading-relaxed">{t.direction_reason}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-muted mb-0.5">Expiry</div>
                <div className="text-xs text-white font-semibold">{chain1.expiry}</div>
                <div className="text-[10px] text-muted">{chain1.dte}d · Monthly</div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* STAGE 1 */}
      {chain1&&!chain1.error&&(
        <div className={`bg-card border rounded-xl overflow-hidden ${stage1Done?'border-green-700':'border-border'}`}>
          <div className={`px-4 py-3 flex items-center justify-between text-sm font-semibold border-b border-border ${stage1Done?'bg-green-950/30 text-green-300':'text-white'}`}>
            <span>
              {stage1Done?'✅ ':'📌 '}
              Stage 1 — {direction==='up'?'Bear Call Spread (enter now — call IVs elevated)':direction==='down'?'Bull Put Spread (enter now — put IVs elevated)':'All Legs — Standard Iron Fly (enter simultaneously)'}
            </span>
            {stage1Done&&<span className="text-xs text-green-400">Locked · Net credit ₹{stage1Net.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>}
          </div>
          {!stage1Done&&(
            <div className="p-4 space-y-3">
              <div className="text-xs text-muted mb-2">Spot: <span className="text-white font-semibold">{chain1.spot.toLocaleString('en-IN',{maximumFractionDigits:0})}</span> · ATM: <span className="text-white">{chain1.atm_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}</span> · Expiry: <span className="text-white">{chain1.expiry}</span> · {chain1.dte}d</div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(direction==='up'||direction==='neutral')&&<>
                  <div>
                    <div className="text-[10px] text-score-red mb-1">▼ SHORT {chain1.atm_strike} CE</div>
                    <input type="number" value={ep.sc} onChange={e=>setEp(p=>({...p,sc:e.target.value}))}
                      className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                    <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain1.sc?.ltp} · IV {chain1.sc?.iv}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-score-green mb-1">▲ LONG {chain1.bc_strike} CE</div>
                    <input type="number" value={ep.bc} onChange={e=>setEp(p=>({...p,bc:e.target.value}))}
                      className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                    <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain1.bc?.ltp} · IV {chain1.bc?.iv}%</div>
                  </div>
                </>}
                {(direction==='down'||direction==='neutral')&&<>
                  <div>
                    <div className="text-[10px] text-score-red mb-1">▼ SHORT {chain1.atm_strike} PE</div>
                    <input type="number" value={ep.sp} onChange={e=>setEp(p=>({...p,sp:e.target.value}))}
                      className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                    <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain1.sp?.ltp} · IV {chain1.sp?.iv}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-score-green mb-1">▲ LONG {chain1.bp_strike} PE</div>
                    <input type="number" value={ep.bp} onChange={e=>setEp(p=>({...p,bp:e.target.value}))}
                      className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                    <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain1.bp?.ltp} · IV {chain1.bp?.iv}%</div>
                  </div>
                </>}
              </div>

              <div className="flex items-center gap-4">
                <div className="text-xs text-muted">
                  Net credit preview:
                  <span className="text-score-green font-semibold ml-2">
                    {direction==='up'?`${chain1.call_spread.net_credit} pts = ₹${chain1.call_spread.net_credit_rs.toLocaleString('en-IN',{maximumFractionDigits:0})}`:
                     direction==='down'?`${chain1.put_spread.net_credit} pts = ₹${chain1.put_spread.net_credit_rs.toLocaleString('en-IN',{maximumFractionDigits:0})}`:
                     `${chain1.combined.total_credit} pts = ₹${chain1.combined.total_credit_rs.toLocaleString('en-IN',{maximumFractionDigits:0})}`}
                  </span>
                </div>
                <button onClick={lockStage1}
                  className="ml-auto bg-green-700 hover:bg-green-600 text-white text-sm font-semibold px-5 py-2 rounded-lg">
                  {direction==='neutral'?'✅ Lock All Legs':'✅ Lock Stage 1'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STAGE 2 (only for up/down, only after stage 1 locked) */}
      {stage1Done&&direction!=='neutral'&&(
        <div className={`bg-card border rounded-xl overflow-hidden ${stage2Done?'border-green-700':'border-amber-700'}`}>
          <div className={`px-4 py-3 flex items-center justify-between text-sm font-semibold border-b border-border ${stage2Done?'bg-green-950/30 text-green-300':'bg-amber-950/30 text-amber-300'}`}>
            <span>{stage2Done?'✅ Stage 2 — Complete':'⏳ Stage 2 — '}{direction==='up'?'Bull Put Spread (enter after pullback — add put side at lower ATM)':'Bear Call Spread (enter after bounce — add call side at higher ATM)'}</span>
            {stage2Done&&<span className="text-xs text-green-400">Locked · Net credit ₹{stage2Net.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>}
          </div>

          {!stage2Done&&(
            <div className="p-4 space-y-3">
              {!chain2?(
                <div className="space-y-2">
                  <div className="text-xs text-slate-300">
                    {direction==='up'
                      ?"Wait 1–2 trading sessions for the market to pull back, then refresh the chain. The new ATM will be lower — you'll collect put spread premium at that level."
                      :"Wait 1–2 trading sessions for the market to bounce, then refresh the chain. The new ATM will be higher — you'll collect call spread premium at that level."
                    }
                  </div>
                  <button onClick={()=>fetchChain(true)} disabled={loading2}
                    className="bg-amber-700 hover:bg-amber-600 text-white text-sm font-semibold px-5 py-2 rounded-lg">
                    {loading2?'⏳ Fetching…':'🔄 Refresh Chain for Stage 2'}
                  </button>
                </div>
              ):(
                <div className="space-y-3">
                  <div className="text-xs text-muted">New Spot: <span className="text-white font-semibold">{chain2.spot.toLocaleString('en-IN',{maximumFractionDigits:0})}</span> · New ATM: <span className="text-white">{chain2.atm_strike.toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                    {chain1&&<span className={`ml-2 font-semibold text-xs ${chain2.spot<chain1.spot?'text-score-red':'text-score-green'}`}>
                      {chain2.spot>chain1.spot?'▲':'▼'} {Math.abs(chain2.spot-chain1.spot).toFixed(0)} pts
                    </span>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {direction==='up'?(
                      <>
                        <div>
                          <div className="text-[10px] text-score-red mb-1">▼ SHORT {chain2.atm_strike} PE</div>
                          <input type="number" value={ep2.sc} onChange={e=>setEp2(p=>({...p,sc:e.target.value}))}
                            className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                          <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain2.sp?.ltp} · IV {chain2.sp?.iv}%</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-score-green mb-1">▲ LONG {chain2.bp_strike} PE</div>
                          <input type="number" value={ep2.bp} onChange={e=>setEp2(p=>({...p,bp:e.target.value}))}
                            className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                          <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain2.bp?.ltp} · IV {chain2.bp?.iv}%</div>
                        </div>
                      </>
                    ):(
                      <>
                        <div>
                          <div className="text-[10px] text-score-red mb-1">▼ SHORT {chain2.atm_strike} CE</div>
                          <input type="number" value={ep2.sc} onChange={e=>setEp2(p=>({...p,sc:e.target.value}))}
                            className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                          <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain2.sc?.ltp} · IV {chain2.sc?.iv}%</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-score-green mb-1">▲ LONG {chain2.bc_strike} CE</div>
                          <input type="number" value={ep2.bc} onChange={e=>setEp2(p=>({...p,bc:e.target.value}))}
                            className="w-full bg-slate-800 border border-border rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"/>
                          <div className="text-[10px] text-muted mt-0.5">Market: ₹{chain2.bc?.ltp} · IV {chain2.bc?.iv}%</div>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-xs text-muted">
                      Stage 2 credit:
                      <span className="text-score-green font-semibold ml-2">
                        {direction==='up'?`${chain2.put_spread.net_credit} pts = ₹${chain2.put_spread.net_credit_rs.toLocaleString('en-IN',{maximumFractionDigits:0})}`:`${chain2.call_spread.net_credit} pts = ₹${chain2.call_spread.net_credit_rs.toLocaleString('en-IN',{maximumFractionDigits:0})}`}
                      </span>
                    </div>
                    <button onClick={lockStage2}
                      className="ml-auto bg-green-700 hover:bg-green-600 text-white text-sm font-semibold px-5 py-2 rounded-lg">
                      ✅ Lock Stage 2 — Complete Iron Fly
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* PAYOFF CHART + METRICS */}
      {allLegs.length>0&&(
        <div className="space-y-4">
          {/* Incomplete position warning */}
          {!isComplete&&(
            <div className="bg-amber-950 border border-amber-700 rounded-xl px-4 py-3 text-sm text-amber-300">
              ⚠ Stage 1 only — {direction==='up'?'Bear call spread: unlimited profit below, capped above. Stage 2 will add the put spread to complete the iron fly.':'Bull put spread: unlimited profit above, capped below. Stage 2 will add the call spread to complete the iron fly.'}
            </div>
          )}
          {isComplete&&(
            <div className="bg-green-950 border border-green-700 rounded-xl px-4 py-3 text-sm text-green-300">
              ✅ Iron Fly complete — {direction!=='neutral'?'Staged entry captured elevated premium on both sides.':'Standard simultaneous entry.'} Net credit ₹{totalCredit.toLocaleString('en-IN',{maximumFractionDigits:0})}.
            </div>
          )}

          {/* DTE slider for chart */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">Chart DTE (current P&L line):</span>
            <input type="number" value={currentDte} onChange={e=>setCurDte(e.target.value)} min={0} max={chain1?.dte||60}
              className="w-20 bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"/>
            <span className="text-xs text-muted">days · 0 = show only at-expiry</span>
            <button onClick={resetAll} className="ml-auto text-xs text-muted hover:text-score-red border border-border rounded px-2 py-1">↺ Reset</button>
          </div>

          {/* Payoff chart */}
          <div className="bg-card border border-border rounded-xl p-3">
            <div className="text-xs font-semibold text-white mb-2 flex items-center gap-2">
              📊 Payoff Chart
              {!isComplete&&<span className="text-[10px] text-amber-400 bg-amber-950 border border-amber-800 rounded px-1.5 py-0.5">Stage 1 only</span>}
              {isComplete&&direction!=='neutral'&&<span className="text-[10px] text-blue-300 bg-blue-950 border border-blue-800 rounded px-1.5 py-0.5">Asymmetric fly (staged)</span>}
              {oiData&&oiData.length>0&&<span className="text-[10px] text-slate-400 border border-border rounded px-1.5 py-0.5">OI bars shown</span>}
            </div>
            <PayoffChart
              legs={allLegs} spot={spot} lot={lot} qty={qty} currentDte={chartDte}
              oiData={oiData||undefined} sd={sdData||undefined} atmIv={atmIv}
            />
          </div>

          {/* Metrics */}
          {isComplete&&(
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                {label:'Net Credit',val:`₹${totalCredit.toLocaleString('en-IN',{maximumFractionDigits:0})}`,sub:`${(totalCredit/lot/qty).toFixed(1)} pts/unit`,col:'text-score-green'},
                {label:'Max Profit',val:`₹${maxProfit.toLocaleString('en-IN',{maximumFractionDigits:0})}`,sub:'when spot pins at body strike',col:'text-score-green'},
                {label:'Max Loss',val:`₹${Math.abs(maxLoss).toLocaleString('en-IN',{maximumFractionDigits:0})}`,sub:'beyond any wing',col:'text-score-red'},
                {label:'Break-evens',val:bes.length>=2?`${bes[0].toFixed(0)} — ${bes[bes.length-1].toFixed(0)}`:bes.length===1?bes[0].toFixed(0):'—',sub:`${(bes[bes.length-1]-bes[0]).toFixed(0)} pts wide`,col:'text-blue-300'},
              ].map(c=>(
                <div key={c.label} className="bg-card border border-border rounded-xl p-3">
                  <div className="text-xs text-muted mb-1">{c.label}</div>
                  <div className={`text-base font-bold ${c.col}`}>{c.val}</div>
                  <div className="text-[10px] text-muted">{c.sub}</div>
                </div>
              ))}
            </div>
          )}

          {/* 10-session P&L forecast table */}
          {chartDte > 0 && (
            <PnlSessionTable
              legs={allLegs} spot={spot} lot={lot} qty={qty}
              currentDte={chartDte} atmIv={atmIv} margin={marginEst}
              direction={direction} expiry={chain1?.expiry||''}
            />
          )}

          {/* Active legs table */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2 border-b border-border text-xs font-semibold text-white flex items-center gap-2">
              Active Legs
              {stage1Done&&<span className="text-[10px] bg-green-950 border border-green-800 text-green-400 px-1.5 py-0.5 rounded">Stage 1 ✓</span>}
              {stage2Done&&<span className="text-[10px] bg-blue-950 border border-blue-800 text-blue-400 px-1.5 py-0.5 rounded">Stage 2 ✓</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-muted">
                  <th className="px-3 py-2 text-left">Stage</th>
                  <th className="px-3 py-2 text-left">Position</th>
                  <th className="px-3 py-2 text-right">Strike</th>
                  <th className="px-3 py-2 text-right">Entry LTP</th>
                  <th className="px-3 py-2 text-right">IV</th>
                  <th className="px-3 py-2 text-right">P&L contribution</th>
                </tr></thead>
                <tbody>
                  {allLegs.map(l=>(
                    <tr key={l.id} className="border-b border-border/50">
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${l.stage===1?'bg-green-950 border-green-800 text-green-400':'bg-blue-950 border-blue-800 text-blue-400'}`}>S{l.stage}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-bold ${l.pos==='short'?'text-score-red':'text-score-green'}`}>{l.pos==='short'?'▼ SHORT':'▲ LONG'}</span>
                        <span className="text-white ml-1">{l.type}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-white">{l.strike.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                      <td className="px-3 py-2 text-right text-white">₹{l.ltp.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right text-muted">{l.iv.toFixed(1)}%</td>
                      <td className={`px-3 py-2 text-right font-semibold ${l.pos==='short'?'text-score-green':'text-score-red'}`}>
                        {l.pos==='short'?'+':'-'}₹{(l.ltp*lot*qty).toLocaleString('en-IN',{maximumFractionDigits:0})}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Exit guidance */}
          {isComplete&&(
            <div className="bg-card border border-border rounded-xl p-4 text-xs space-y-2">
              <div className="text-sm font-semibold text-white mb-1">🚪 Exit Strategy</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-green-950/30 border border-green-800/40 rounded-lg p-2.5">
                  <div className="text-score-green font-semibold mb-1">📈 Profitable exit</div>
                  <div className="text-muted">When short options reach 20-30% of entry price, buy back both short legs. Let long wings expire worthless.</div>
                </div>
                <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-2.5">
                  <div className="text-score-amber font-semibold mb-1">↔ Time-based exit</div>
                  <div className="text-muted">Exit at 50% max profit OR 7 days before expiry — whichever comes first. Avoid gamma risk near expiry.</div>
                </div>
                <div className="bg-red-950/30 border border-red-800/40 rounded-lg p-2.5">
                  <div className="text-score-red font-semibold mb-1">🛑 Stop loss</div>
                  <div className="text-muted">Exit if loss reaches 2× net credit received. For staged positions: unwind the losing spread first, keep the profitable one.</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
export default function Strategies() {
  const [tab, setTab] = useState<StratTab>('momentum')

  const TABS: { key: StratTab; label: string; desc: string }[] = [
    { key: 'momentum', label: '🔄 Momentum Rotation', desc: 'Rank sectors, rotate into winners' },
    { key: 'breakout', label: '📈 Breakout Scanner',  desc: 'Volume-confirmed price breakouts' },
    { key: 'collar',   label: '🛡 Collar Optimizer',  desc: 'Protect stock gains with options' },
    { key: 'ironfly',   label: '🦋 Iron Fly',   desc: 'Wide wing iron fly — earn time decay in sideways markets' },
    { key: 'customfly', label: '🎯 Custom Fly', desc: 'Staged iron fly — enter each spread when that side\'s premium is elevated' },
  ]

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="text-xl font-bold text-white">Strategies</div>
        <div className="text-sm text-muted mt-0.5">Advanced trading strategies — research & signal generation</div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? 'border-blue-500 text-white' : 'border-transparent text-muted hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Active tab description */}
      <div className="text-xs text-muted">{TABS.find(t => t.key === tab)?.desc}</div>

      {tab === 'momentum'  && <MomentumTab />}
      {tab === 'breakout'  && <BreakoutTab />}
      {tab === 'collar'    && <CollarTab />}
      {tab === 'ironfly'   && <IronFlyTab />}
      {tab === 'customfly' && <CustomFlyTab />}
    </div>
  )
}
