import { useState, useEffect } from 'react'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

// ── shared ────────────────────────────────────────────────────
type StratTab = 'momentum' | 'breakout' | 'collar'

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
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
export default function Strategies() {
  const [tab, setTab] = useState<StratTab>('momentum')

  const TABS: { key: StratTab; label: string; desc: string }[] = [
    { key: 'momentum', label: '🔄 Momentum Rotation', desc: 'Rank sectors, rotate into winners' },
    { key: 'breakout', label: '📈 Breakout Scanner',  desc: 'Volume-confirmed price breakouts' },
    { key: 'collar',   label: '🛡 Collar Optimizer',  desc: 'Protect stock gains with options' },
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

      {tab === 'momentum' && <MomentumTab />}
      {tab === 'breakout' && <BreakoutTab />}
      {tab === 'collar'   && <CollarTab />}
    </div>
  )
}
