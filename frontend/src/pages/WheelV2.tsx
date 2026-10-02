import { useState, useEffect, useCallback } from 'react'
import WheelStatus from '../components/WheelStatus'
import NseStockSearch from '../components/NseStockSearch'
import Wheel from './Wheel'
import client from '../api/client'

const api = {
  get:  (url: string)              => client.get(url).then(r => r.data),
  post: (url: string, body?: any)  => client.post(url, body).then(r => r.data),
  del:  (url: string)              => client.delete(url).then(r => r.data),
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface WheelConfig {
  watchlist:            string[]
  auto_enter:           boolean
  mtm_amber:            number
  mtm_red:              number
  telegram_bot_token:   string
  telegram_chat_id:     string
}

interface WheelPosition {
  id:               string
  stock:            string
  status:           string
  phase:            string
  expiry:           string
  dte_at_entry:     number
  lot_size:         number
  ce_strike:        number
  ce_premium_sold:  number
  pe_strike:        number
  pe_premium_sold:  number
  net_premium:      number
  pe_be:            number
  ce_be:            number
  shares_phase1:    number
  shares_phase2:    number
  shares_avg_price: number
  current_cmp:      number
  current_mtm:      number
  mtm_status:       string
  entered_at:       string
  alerts:           any[]
}

interface AssessResult {
  symbol:          string
  eligible:        boolean
  score:           number
  reasons:         string[]
  cmp:             number
  dte:             number
  expiry:          string
  iv:              number
  rsi:             number | null
  lot_size:        number
  ce_strike_est:   number
  pe_strike_est:   number
  capital?:        { total_required: number }
  reason?:         string
}

interface Alert {
  id:             number
  level:          string
  title:          string
  message:        string
  recommendation: string
  time:           string
  read:           boolean
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const pnlColor = (v: number) =>
  v > 0 ? 'text-emerald-400' : v < -10000 ? 'text-red-400' : v < -6000 ? 'text-amber-400' : 'text-slate-300'

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 })

// ── Settings panel ─────────────────────────────────────────────────────────────

function SettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<WheelConfig>({
    watchlist: [], auto_enter: false, mtm_amber: -6000, mtm_red: -10000,
    telegram_bot_token: '', telegram_chat_id: '',
  })
  const [saving, setSaving]   = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg]         = useState('')

  useEffect(() => {
    api.get('/wheel-v2/config').then(r => setCfg(r)).catch(() => {})
  }, [])

  const addStock = (sym: string) => {
    const s = sym.replace('.NS', '').toUpperCase()
    if (!cfg.watchlist.includes(s))
      setCfg(c => ({ ...c, watchlist: [...c.watchlist, s] }))
  }
  const removeStock = (s: string) => setCfg(c => ({ ...c, watchlist: c.watchlist.filter(x => x !== s) }))

  const save = async () => {
    setSaving(true)
    try { await api.post('/wheel-v2/config', cfg); setMsg('Saved'); onSaved() }
    catch { setMsg('Save failed') }
    setSaving(false)
  }

  const testTelegram = async () => {
    setTesting(true)
    try {
      await api.post('/wheel-v2/config', cfg)
      const r = await api.post('/wheel-v2/test-telegram')
      setMsg(r.sent ? '✅ Telegram message sent! Check your bot chat.' : '❌ Send failed — verify Bot Token and Chat ID')
    } catch (e: any) { setMsg(e.message || 'Failed') }
    setTesting(false)
  }

  return (
    <div className="space-y-5">
      {/* Watchlist */}
      <div>
        <div className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Watchlist — Stocks to Consider</div>
        <NseStockSearch placeholder="Add stock (e.g. HCLTECH, INFY…)" onSelect={(sym) => addStock(sym)} />
        <div className="flex flex-wrap gap-2 mt-3">
          {cfg.watchlist.map(s => (
            <div key={s} className="flex items-center gap-1 bg-slate-700 border border-border rounded-full px-3 py-1 text-xs">
              <span className="text-white font-semibold">{s}</span>
              <button onClick={() => removeStock(s)} className="text-slate-500 hover:text-red-400 ml-1 text-[10px]">✕</button>
            </div>
          ))}
          {!cfg.watchlist.length && <span className="text-muted text-xs">No stocks yet</span>}
        </div>
      </div>

      {/* MTM thresholds */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-amber-400 font-medium">Amber alert (₹)</label>
          <input type="number" value={cfg.mtm_amber}
            onChange={e => setCfg(c => ({ ...c, mtm_amber: Number(e.target.value) }))}
            className="w-full mt-1 bg-slate-800 border border-amber-700/40 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
        <div>
          <label className="text-xs text-red-400 font-medium">Red alert (₹)</label>
          <input type="number" value={cfg.mtm_red}
            onChange={e => setCfg(c => ({ ...c, mtm_red: Number(e.target.value) }))}
            className="w-full mt-1 bg-slate-800 border border-red-700/40 rounded-lg px-3 py-2 text-sm text-white" />
        </div>
      </div>

      {/* Telegram */}
      <div className="border border-blue-700/30 bg-blue-950/20 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">✈️</span>
          <div>
            <div className="text-sm font-semibold text-blue-300">Telegram Alerts (Free, Instant)</div>
            <div className="text-[10px] text-muted mt-0.5">
              Setup (2 min): Open Telegram → search <span className="text-white">@BotFather</span> → /newbot → get token.
              Then message your bot once, open <span className="text-white">api.telegram.org/bot&#123;TOKEN&#125;/getUpdates</span> to find your Chat ID.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted">Bot Token</label>
            <input value={cfg.telegram_bot_token} placeholder="123456:ABC-DEF..."
              onChange={e => setCfg(c => ({ ...c, telegram_bot_token: e.target.value }))}
              className="w-full mt-1 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white font-mono" />
          </div>
          <div>
            <label className="text-[10px] text-muted">Chat ID</label>
            <input value={cfg.telegram_chat_id} placeholder="123456789"
              onChange={e => setCfg(c => ({ ...c, telegram_chat_id: e.target.value }))}
              className="w-full mt-1 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white font-mono" />
          </div>
        </div>
        <button onClick={testTelegram} disabled={testing}
          className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs rounded-lg transition">
          {testing ? 'Sending…' : '✈️ Send Test Message'}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition">
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {msg && <span className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-400' : msg.startsWith('❌') ? 'text-red-400' : 'text-slate-400'}`}>{msg}</span>}
      </div>
    </div>
  )
}

// ── Assessment panel ───────────────────────────────────────────────────────────

function AssessPanel({ onEnter }: { onEnter: (r: AssessResult) => void }) {
  const [loading,   setLoading]  = useState(false)
  const [best,      setBest]     = useState<AssessResult | null>(null)
  const [all,       setAll]      = useState<AssessResult[]>([])
  const [err,       setErr]      = useState('')
  const [watchlist, setWatchlist] = useState<string[]>([])

  useEffect(() => {
    api.get('/wheel-v2/config').then(r => setWatchlist(r.watchlist || [])).catch(() => {})
  }, [])

  const run = async () => {
    setLoading(true); setErr('')
    try {
      const r = await api.post('/wheel-v2/assess')
      setBest(r.best || null)
      setAll(r.all || [])
      if (!r.best) setErr('No eligible stock found — check DTE availability or add more stocks to watchlist')
    } catch (e: any) {
      setErr(e.response?.data?.error || e.message || 'Assessment failed')
    }
    setLoading(false)
  }

  return (
    <div className="space-y-4">
      {watchlist.length === 0 && (
        <div className="flex items-center gap-3 bg-amber-950/30 border border-amber-700/40 rounded-xl px-4 py-3 text-sm">
          <span className="text-amber-400 text-lg">⚠️</span>
          <div>
            <span className="text-amber-300 font-medium">Watchlist is empty.</span>
            <span className="text-slate-400 ml-1">Go to <strong className="text-white">Settings</strong> tab → add stocks (e.g. HCLTECH, INFY, RELIANCE) before assessing.</span>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">AI Stock Assessor</div>
          <div className="text-[10px] text-muted mt-0.5">Picks the best WHEEL candidate from your watchlist (DTE 30–50, oversold, high IV)</div>
        </div>
        <button onClick={run} disabled={loading || watchlist.length === 0}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition">
          {loading ? 'Assessing…' : '⚙️ Assess Watchlist'}
        </button>
      </div>
      {err && <div className="text-red-400 text-xs">{err}</div>}

      {best && (
        <div className="border border-emerald-700/40 bg-emerald-950/20 rounded-xl p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="text-emerald-300 text-xs font-bold uppercase tracking-wider mb-1">Best Pick</div>
              <div className="text-white text-xl font-bold">{best.symbol}</div>
              <div className="text-slate-400 text-xs mt-0.5">
                CMP ₹{best.cmp?.toFixed(0)} | DTE {best.dte} | IV {((best.iv || 0) * 100).toFixed(0)}%
                {best.rsi !== null && ` | RSI ${best.rsi?.toFixed(0)}`}
              </div>
            </div>
            <div className="text-right">
              <div className="text-emerald-400 text-2xl font-bold">{best.score}</div>
              <div className="text-[10px] text-muted">score</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 mb-3">
            {best.reasons?.map(r => (
              <span key={r} className="text-[10px] bg-emerald-900/40 border border-emerald-700/30 text-emerald-300 px-2 py-0.5 rounded-full">{r}</span>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center mb-3">
            {[
              ['CE Strike (2SD)', `₹${best.ce_strike_est}`],
              ['PE Strike (1SD)', `₹${best.pe_strike_est}`],
              ['Capital Needed', `₹${fmt(best.capital?.total_required || 0)}`],
            ].map(([l, v]) => (
              <div key={l} className="bg-slate-800/60 rounded-lg p-2">
                <div className="text-[9px] text-muted">{l}</div>
                <div className="text-white text-xs font-semibold mt-0.5">{v}</div>
              </div>
            ))}
          </div>
          <button onClick={() => onEnter(best)}
            className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition">
            Enter WHEEL → {best.symbol}
          </button>
        </div>
      )}

      {all.length > 0 && (
        <div className="bg-slate-800/40 rounded-xl overflow-hidden border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted text-left">
                <th className="px-3 py-2">Stock</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2 text-right">CMP</th>
                <th className="px-3 py-2 text-right">DTE</th>
                <th className="px-3 py-2 text-right">IV</th>
                <th className="px-3 py-2 text-right">RSI</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {all.map(r => (
                <tr key={r.symbol} className="border-b border-border/40 last:border-0 hover:bg-slate-700/20">
                  <td className="px-3 py-2 font-semibold text-white">{r.symbol}</td>
                  <td className={`px-3 py-2 text-right font-bold ${r.score >= 60 ? 'text-emerald-400' : r.score >= 40 ? 'text-amber-400' : 'text-slate-400'}`}>{r.score}</td>
                  <td className="px-3 py-2 text-right text-slate-300">₹{r.cmp?.toFixed(0) || '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{r.dte || '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{r.iv ? `${(r.iv * 100).toFixed(0)}%` : '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{r.rsi?.toFixed(0) || '—'}</td>
                  <td className="px-3 py-2">
                    {r.eligible
                      ? <span className="text-emerald-400 text-[10px]">Eligible</span>
                      : <span className="text-slate-500 text-[10px]">{r.reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Enter modal ────────────────────────────────────────────────────────────────

function EnterModal({ candidate, onClose, onEntered, activeCount }:
  { candidate: AssessResult; onClose: () => void; onEntered: () => void; activeCount: number }) {
  const [ceStrike,  setCeStrike]  = useState(String(candidate.ce_strike_est))
  const [cePrem,    setCePrem]    = useState('')
  const [peStrike,  setPeStrike]  = useState(String(candidate.pe_strike_est))
  const [pePrem,    setPePrem]    = useState('')
  const [expiry,    setExpiry]    = useState(candidate.expiry)
  const [lotSize,   setLotSize]   = useState(String(candidate.lot_size))
  const [entering,  setEntering]  = useState(false)
  const [err,       setErr]       = useState('')
  const [confirmed, setConfirmed] = useState(false)

  const netPrem  = (Number(cePrem) || 0) + (Number(pePrem) || 0)
  const peBe     = (Number(peStrike) || 0) - netPrem
  const ceBe     = (Number(ceStrike) || 0) + netPrem
  const shares1  = Math.floor((Number(lotSize) || 0) * 0.25)

  const needsConfirm = activeCount > 0 && !confirmed

  const enter = async () => {
    if (!cePrem || !pePrem) { setErr('Enter premiums for both CE and PE'); return }
    if (needsConfirm) { setConfirmed(true); return }
    setEntering(true); setErr('')
    try {
      await api.post('/wheel-v2/enter', {
        symbol:     candidate.symbol,
        expiry,
        ce_strike:  Number(ceStrike),
        ce_premium: Number(cePrem),
        pe_strike:  Number(peStrike),
        pe_premium: Number(pePrem),
        lot_size:   Number(lotSize),
        auto_trade: false,
      })
      onEntered()
    } catch (e: any) { setErr(e.message || 'Entry failed') }
    setEntering(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-border rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="p-5 border-b border-border flex items-center justify-between">
          <div className="text-white font-semibold">Enter WHEEL — {candidate.symbol}</div>
          <button onClick={onClose} className="text-muted hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {[
              ['Expiry',       expiry,    setExpiry,   'text'],
              ['Lot Size',     lotSize,   setLotSize,  'number'],
            ].map(([l, v, s, t]: any) => (
              <div key={l}>
                <label className="text-[10px] text-muted">{l}</label>
                <input type={t} value={v} onChange={e => s(e.target.value)}
                  className="w-full mt-1 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              ['CE Strike (2 SD)', ceStrike, setCeStrike],
              ['CE Premium sold', cePrem,    setCePrem],
              ['PE Strike (1 SD)', peStrike, setPeStrike],
              ['PE Premium sold', pePrem,    setPePrem],
            ].map(([l, v, s]: any) => (
              <div key={l}>
                <label className="text-[10px] text-muted">{l}</label>
                <input type="number" value={v} onChange={e => s(e.target.value)}
                  className="w-full mt-1 bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white" />
              </div>
            ))}
          </div>
          {/* Computed BEs */}
          {netPrem > 0 && (
            <div className="grid grid-cols-3 gap-2 bg-slate-800/60 rounded-xl p-3 text-center">
              <div><div className="text-[9px] text-muted">Net Premium</div><div className="text-white text-sm font-bold">₹{netPrem.toFixed(2)}</div></div>
              <div><div className="text-[9px] text-amber-400">PE Breakeven ↓</div><div className="text-amber-400 text-sm font-bold">₹{peBe.toFixed(0)}</div></div>
              <div><div className="text-[9px] text-emerald-400">CE Breakeven ↑</div><div className="text-emerald-400 text-sm font-bold">₹{ceBe.toFixed(0)}</div></div>
            </div>
          )}
          {netPrem > 0 && (
            <div className="text-[10px] text-slate-400 bg-slate-800/40 rounded-lg p-3">
              Buying <span className="text-white font-semibold">{shares1} shares</span> (25% of lot) at CMP as Phase 1.
              Phase 2: buy {shares1} more if CMP falls below PE-BE ₹{peBe.toFixed(0)}.
            </div>
          )}
          {err && <div className="text-red-400 text-xs">{err}</div>}
          {activeCount > 0 && !confirmed && (
            <div className="bg-amber-950/60 border border-amber-700/50 rounded-xl p-3 text-xs text-amber-300">
              <div className="font-semibold mb-1">⚠ {activeCount} active WHEEL{activeCount > 1 ? 's' : ''} already running</div>
              <div className="text-amber-400/80">Running multiple WHEELs simultaneously is supported but requires additional margin for each position. Click "Confirm & Start" to proceed.</div>
            </div>
          )}
          <button onClick={enter} disabled={entering}
            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded-lg transition">
            {entering ? 'Entering…' : needsConfirm ? '⚠ Confirm & Start WHEEL' : '⚙️ Start WHEEL'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Active position panel ──────────────────────────────────────────────────────

function ActivePosition({ pos, onRefresh }: { pos: WheelPosition; onRefresh: () => void }) {
  const [monitoring, setMonitoring] = useState(false)
  const [acting,     setActing]     = useState(false)
  const [msg,        setMsg]        = useState('')

  const dte = Math.max(0, Math.round(
    (new Date(pos.expiry).getTime() - Date.now()) / 86400000))

  const runMonitor = async () => {
    setMonitoring(true)
    try {
      const r = await api.post('/wheel-v2/monitor')
      const res = r.results?.find((x: any) => x.id === pos.id)
      setMsg(res ? `MTM ₹${fmt(res.mtm)} | ${res.reco}` : 'Checked')
      onRefresh()
    } catch { setMsg('Monitor failed') }
    setMonitoring(false)
  }

  const doAction = async (action: string) => {
    setActing(true); setMsg('')
    try {
      const r = await api.post(`/wheel-v2/action/${pos.id}`, { action })
      setMsg(action === 'exit_pe'
        ? `PE exited @ ₹${r.pe_bought_back_at} | P&L ₹${fmt(r.pe_pnl)} | Bought ${r.new_shares} shares`
        : `Closed | Final P&L ₹${fmt(r.final_pnl)}`)
      onRefresh()
    } catch (e: any) { setMsg(e.message || 'Action failed') }
    setActing(false)
  }

  const mtmStatus = (pos.mtm_status || 'green') as 'green' | 'amber' | 'red'

  return (
    <div className="space-y-4">
      {/* Gear + headline */}
      <div className="flex items-center gap-5 bg-slate-800/40 border border-border rounded-2xl p-5">
        <WheelStatus status={mtmStatus} size={80} mtm={pos.current_mtm} />
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white text-2xl font-bold">{pos.stock}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              pos.phase === 'covered_call'
                ? 'bg-purple-900/40 border-purple-700/40 text-purple-300'
                : 'bg-blue-900/40 border-blue-700/40 text-blue-300'
            }`}>
              {pos.phase === 'covered_call' ? 'Covered Call' : 'Strangle'}
            </span>
          </div>
          <div className="text-[11px] text-muted">
            Expiry {pos.expiry} · DTE {dte} · Lot {pos.lot_size}
          </div>
        </div>
        <button onClick={runMonitor} disabled={monitoring}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg border border-border transition">
          {monitoring ? '⟳' : '⟳ Refresh MTM'}
        </button>
      </div>

      {/* Legs */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Short CE', strike: pos.ce_strike, sold: pos.ce_premium_sold, be: pos.ce_be, color: 'emerald' },
          { label: 'Short PE', strike: pos.pe_strike, sold: pos.pe_premium_sold, be: pos.pe_be, color: 'amber' },
        ].map(leg => (
          <div key={leg.label} className="bg-slate-800/60 border border-border rounded-xl p-3">
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1">{leg.label}</div>
            <div className="text-white font-bold">₹{leg.strike}</div>
            <div className="text-[10px] text-slate-400">Sold @ ₹{leg.sold}</div>
            <div className={`text-[10px] text-${leg.color}-400 mt-1`}>BE: ₹{leg.be?.toFixed(0)}</div>
          </div>
        ))}
        <div className="bg-slate-800/60 border border-border rounded-xl p-3">
          <div className="text-[10px] text-muted uppercase tracking-wider mb-1">Shares</div>
          <div className="text-white font-bold">{pos.shares_phase1 + pos.shares_phase2}</div>
          <div className="text-[10px] text-slate-400">Avg ₹{pos.shares_avg_price?.toFixed(0)}</div>
          {pos.shares_phase2 > 0 && (
            <div className="text-[10px] text-purple-400 mt-1">Phase 2 added</div>
          )}
        </div>
      </div>

      {/* Net premium + P&L */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/60 border border-border rounded-xl p-3">
          <div className="text-[10px] text-muted mb-1">Net Premium Received</div>
          <div className="text-emerald-400 font-bold text-lg">
            ₹{fmt((pos.net_premium || 0) * pos.lot_size)}
          </div>
          <div className="text-[10px] text-slate-400">₹{pos.net_premium}/share × {pos.lot_size}</div>
        </div>
        <div className="bg-slate-800/60 border border-border rounded-xl p-3">
          <div className="text-[10px] text-muted mb-1">Current MTM</div>
          <div className={`font-bold text-lg ${pnlColor(pos.current_mtm || 0)}`}>
            {(pos.current_mtm || 0) >= 0 ? '+' : ''}₹{fmt(Math.abs(pos.current_mtm || 0))}
          </div>
          <div className="text-[10px] text-slate-400">CMP ₹{pos.current_cmp?.toFixed(0)}</div>
        </div>
      </div>

      {/* Action buttons */}
      {pos.status === 'active' && (
        <div className="flex gap-3">
          {pos.phase === 'strangle' && (
            <button onClick={() => doAction('exit_pe')} disabled={acting}
              className="flex-1 py-2 bg-amber-700/50 hover:bg-amber-600/60 border border-amber-700/40 text-amber-300 text-sm rounded-lg transition disabled:opacity-50">
              Exit PE + Add Shares
            </button>
          )}
          <button onClick={() => doAction('close_all')} disabled={acting}
            className="flex-1 py-2 bg-red-900/50 hover:bg-red-800/60 border border-red-700/40 text-red-300 text-sm rounded-lg transition disabled:opacity-50">
            Close All (Exit WHEEL)
          </button>
        </div>
      )}

      {msg && (
        <div className="text-xs text-slate-300 bg-slate-800/60 border border-border rounded-lg px-3 py-2">
          {msg}
        </div>
      )}

      {/* Recent alerts */}
      {pos.alerts && pos.alerts.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-muted uppercase tracking-wider">Recent Alerts</div>
          {[...pos.alerts].reverse().slice(0, 5).map((a, i) => (
            <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs border ${
              a.level === 'red' || a.level === 'action' ? 'bg-red-950/40 border-red-700/30 text-red-300' :
              a.level === 'amber' ? 'bg-amber-950/40 border-amber-700/30 text-amber-300' :
              'bg-slate-800/60 border-border text-slate-300'
            }`}>
              <span className="shrink-0 mt-0.5">
                {a.level === 'red' || a.level === 'action' ? '🔴' : a.level === 'amber' ? '🟡' : '🟢'}
              </span>
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

type Tab = 'position' | 'assess' | 'history' | 'settings'

export default function WheelV2() {
  const [tab,        setTab]        = useState<Tab>('position')
  const [positions,  setPositions]  = useState<WheelPosition[]>([])
  const [loading,    setLoading]    = useState(false)
  const [enterModal, setEnterModal] = useState<AssessResult | null>(null)
  const [alerts,     setAlerts]     = useState<Alert[]>([])
  const [unread,     setUnread]     = useState(0)
  const [addedSyms,  setAddedSyms]  = useState<Set<string>>(new Set())

  const activePositions = positions.filter(p => p.status === 'active' || p.status === 'covered_call')
  const activePos       = activePositions[0] ?? null
  const history         = positions.filter(p => !['active', 'covered_call'].includes(p.status))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pr, ar] = await Promise.all([
        api.get('/wheel-v2/positions'),
        api.get('/wheel-v2/alerts?unread_only=false'),
      ])
      setPositions(pr.positions || [])
      setAlerts(ar.alerts || [])
      setUnread(ar.unread || 0)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const addToWatchlist = useCallback(async (symbol: string) => {
    try {
      const cfg = await api.get('/wheel-v2/config')
      const wl: string[] = cfg.watchlist || []
      if (!wl.includes(symbol)) {
        await api.post('/wheel-v2/config', { ...cfg, watchlist: [...wl, symbol] })
      }
      setAddedSyms(prev => new Set([...prev, symbol]))
    } catch { /* silent */ }
  }, [])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'position', label: activePositions.length > 0 ? `⚙️ Active (${activePositions.length})` : 'Position' },
    { key: 'assess',   label: 'AI Assess' },
    { key: 'history',  label: 'History' },
    { key: 'settings', label: 'Settings' },
  ]

  const globalStatus = activePos
    ? (activePos.mtm_status as 'green' | 'amber' | 'red') || 'green'
    : 'green'

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Smart Wheel V2</h1>
          <p className="text-xs text-muted mt-1">Short Strangle + Equity · Delta-managed · BE-triggered exits</p>
        </div>
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <div className="relative">
              <div className="w-2 h-2 bg-red-500 rounded-full absolute -top-1 -right-1 animate-pulse" />
              <button onClick={() => setTab('position')}
                className="text-xs text-slate-400 hover:text-white bg-slate-800 border border-border rounded-lg px-2 py-1">
                {unread} alert{unread > 1 ? 's' : ''}
              </button>
            </div>
          )}
          {activePos && <WheelStatus status={globalStatus} size={48} showLabel={false} />}
        </div>
      </div>

      {/* Inline alert strip — only for unread red/amber */}
      {alerts.filter(a => !a.read && ['red', 'amber', 'action'].includes(a.level)).slice(0, 1).map(a => (
        <div key={a.id} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 mb-4 text-xs border ${
          a.level === 'red' || a.level === 'action'
            ? 'bg-red-950/50 border-red-700/40 text-red-300'
            : 'bg-amber-950/50 border-amber-700/40 text-amber-300'
        }`}>
          <span>{a.level === 'red' || a.level === 'action' ? '🔴' : '🟡'}</span>
          <span className="font-semibold">{a.title}</span>
          <span className="text-slate-400">·</span>
          <span>{a.message}</span>
          {a.recommendation && <><span className="text-slate-400">·</span><span className="font-medium">{a.recommendation}</span></>}
        </div>
      ))}

      {/* Tabs */}
      <div className="flex border-b border-border mb-6">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-muted hover:text-white'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && !positions.length && (
        <div className="text-center text-muted text-sm py-12">Loading…</div>
      )}

      {/* Position tab */}
      {tab === 'position' && (
        activePositions.length > 0
          ? (
            <div className="space-y-6">
              {activePositions.map(p => (
                <ActivePosition key={p.id} pos={p} onRefresh={load} />
              ))}
            </div>
          )
          : (
            <div className="text-center py-16">
              <WheelStatus status="green" size={96} mtm={0} />
              <div className="text-slate-400 text-sm mt-6">No active WHEEL position</div>
              <div className="text-muted text-xs mt-1">Go to AI Assess to find the best entry opportunity</div>
              <button onClick={() => setTab('assess')}
                className="mt-4 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition">
                Run AI Assessment →
              </button>
            </div>
          )
      )}

      {/* Assess tab — render existing Wheel scout page directly */}
      {tab === 'assess' && (
        <>
          {activePositions.length > 0 && (
            <div className="mb-4 px-4 py-2.5 bg-blue-950/50 border border-blue-700/40 rounded-xl text-xs text-blue-300">
              ⚙️ {activePositions.length} active WHEEL{activePositions.length > 1 ? 's' : ''} running.
              Adding another requires more margin — you'll be warned before entry.
            </div>
          )}
          {addedSyms.size > 0 && (
            <div className="mb-4 px-4 py-2.5 bg-emerald-950/50 border border-emerald-700/40 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
              ✓ Added to Smart Wheel watchlist: {[...addedSyms].join(', ')}
              <button onClick={() => setAddedSyms(new Set())} className="ml-auto text-emerald-500 hover:text-white">✕</button>
            </div>
          )}
          <Wheel onAddToWheelV2={addToWatchlist} />
        </>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <div>
          {!history.length
            ? <div className="text-center text-muted text-sm py-12">No closed positions yet</div>
            : (
              <div className="space-y-3">
                {history.map(p => (
                  <div key={p.id} className="bg-slate-800/40 border border-border rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-bold">{p.stock}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                          p.status === 'closed_profit' ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/30' :
                          'bg-red-900/40 text-red-400 border border-red-700/30'
                        }`}>
                          {p.status === 'closed_profit' ? 'Profit' : 'Loss'}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted mt-0.5">
                        {p.entered_at?.slice(0,10)} → {(p as any).closed_at?.slice(0,10) || '—'}
                        &nbsp;· DTE {p.dte_at_entry}
                      </div>
                    </div>
                    <div className={`text-lg font-bold ${pnlColor((p as any).final_pnl || 0)}`}>
                      {((p as any).final_pnl || 0) >= 0 ? '+' : ''}₹{fmt(Math.abs((p as any).final_pnl || 0))}
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* Settings tab */}
      {tab === 'settings' && <SettingsPanel onSaved={load} />}

      {/* Enter modal */}
      {enterModal && (
        <EnterModal
          candidate={enterModal}
          onClose={() => setEnterModal(null)}
          onEntered={() => { setEnterModal(null); load(); setTab('position') }}
          activeCount={activePositions.length}
        />
      )}
    </div>
  )
}
