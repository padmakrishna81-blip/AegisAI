import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries,
  LineStyle, CrosshairMode,
} from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import client from '../api/client'
import NseStockSearch from '../components/NseStockSearch'

// ── Channel fill primitive ────────────────────────────────────────────────────

class ChannelFillPrimitive {
  private _chart: any = null
  private _series: any = null
  private _upper: Array<{ time: number; value: number }>
  private _lower: Array<{ time: number; value: number }>
  private _color: string
  private _view: any

  constructor(
    upper: Array<{ time: number; value: number }>,
    lower: Array<{ time: number; value: number }>,
    color: string,
  ) {
    this._upper = upper
    this._lower = lower
    this._color = color

    this._view = {
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: (target: any) => {
          if (!this._chart || !this._series) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio, verticalPixelRatio }: any) => {
            const toXY = (pt: { time: number; value: number }) => {
              const x = ts.timeToCoordinate(pt.time as Time)
              const y = this._series.priceToCoordinate(pt.value)
              if (x === null || y === null) return null
              return { x: x * horizontalPixelRatio, y: y * verticalPixelRatio }
            }
            ctx.save()
            ctx.beginPath()
            let started = false
            for (const pt of this._upper) {
              const p = toXY(pt)
              if (!p) continue
              if (!started) { ctx.moveTo(p.x, p.y); started = true }
              else ctx.lineTo(p.x, p.y)
            }
            for (const pt of [...this._lower].reverse()) {
              const p = toXY(pt)
              if (!p) continue
              if (!started) { ctx.moveTo(p.x, p.y); started = true }
              else ctx.lineTo(p.x, p.y)
            }
            if (started) { ctx.closePath(); ctx.fillStyle = this._color; ctx.fill() }
            ctx.restore()
          })
        },
      }),
    }
  }

  attached({ chart, series, requestUpdate }: { chart: any; series: any; requestUpdate: () => void }) {
    this._chart = chart; this._series = series; requestUpdate()
  }
  detached() { this._chart = null; this._series = null }
  paneViews() { return [this._view] }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface EMAPoint { time: number; value: number }
interface TrendlineCoords {
  id: string; type: 'support' | 'resistance'; touches: number; score: number
  start: { time: number; value: number }
  end:   { time: number; value: number }
  projection: { time: number; value: number }
}
interface ChannelLinePoint { time: number; price: number }
interface ChannelLine {
  points?: ChannelLinePoint[]
  start: ChannelLinePoint; end: ChannelLinePoint
  slope?: number; intercept?: number
}
interface Channel {
  id: string; type: 'ascending' | 'descending' | 'horizontal'
  status?: 'active' | 'broken_downward' | 'broken_upward' | 'unconfirmed' | 'provisional'
  validation_status?: 'validated' | 'provisional' | 'unconfirmed'
  containment: number; is_regression?: boolean; is_structural?: boolean
  support_line: ChannelLine; resistance_line: ChannelLine
  channel_width?: number
  diagnostics?: {
    slope: number; sup_touches: number; res_touches: number
    body_violations: number; wick_overshoots: number
    containment_pct: number; quality_score: number; avg_error_atr: number
    span_bars: number; start_time: number; end_time: number
    sup_anchor_price: number | null; sup_anchor_time: number | null
    res_anchor_price: number | null; res_anchor_time: number | null
  }
}
interface SRLine { id: string; type: 'support' | 'resistance'; price: number; touches: number; pct: number; zone_status?: 'active' | 'zone_under_test' }
interface Convergence {
  id: string; time: number; price: number; is_future: boolean
  line1: string; line2: string; quality: string
}
interface Rule {
  id: string; name: string; status: 'triggered' | 'not_triggered' | 'n/a'
  level: 'bullish' | 'bearish' | 'neutral'; evidence: string; explanation: string
  category?: string
}
interface Analysis {
  symbol: string; market: string; timeframe: string; lookback: string; bars: number
  warning?: string; channel_method?: string
  candles: Candle[]
  overlays: {
    trendlines: TrendlineCoords[]
    channels: Channel[]
    sr_lines: SRLine[]
    convergences: Convergence[]
  }
  indicators: {
    current_price: number; ema20: number; ema50: number; ema200: number
    rsi: number; macd: number; macd_signal: number; macd_hist: number
    macd_rising: boolean; atr: number; atr_pct: number; vol_ratio: number
  }
  ema20_series: EMAPoint[]; ema50_series: EMAPoint[]; ema200_series: EMAPoint[]
  trend: {
    primary: string; strength: number; short_term: string
    ema_trend: string; swing_structure: string; ema_positions: string[]
  }
  rules: Rule[]
  assessment: {
    bias: string; primary_trend: string; short_term: string
    bullish_rules: number; bearish_rules: number; neutral_rules: number
    weighted_bull?: number; weighted_bear?: number
    rsi: number; rsi_zone: string; vol_ratio: number
    scenarios: {
      bullish: { trigger: string; target: number; invalidation: number; method?: string }
      bearish: { trigger: string; target: number; invalidation: number; method?: string }
    }
  }
  generated_at: string
}

// ── Default preferences ───────────────────────────────────────────────────────

const DEFAULTS = {
  showChannels:     true,
  showTrendlines:   true,
  showSR:           true,
  showConvergences: true,
  showProjections:  true,
  showEma20:        false,
  showEma50:        false,
  showEma200:       false,
  showVolume:       false,
  channelOpacity:   30,   // 0–100
}

type Prefs = typeof DEFAULTS

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem('aegis_chart_prefs')
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULTS }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEFRAMES = [
  { value: 'daily',   label: 'Daily'   },
  { value: 'weekly',  label: 'Weekly'  },
  { value: 'monthly', label: 'Monthly' },
  { value: '4h',      label: '4 Hour'  },
  { value: '1h',      label: '1 Hour'  },
  { value: '15m',     label: '15 Min'  },
]
const LOOKBACKS = [
  { value: '3mo', label: '3 Months' },
  { value: '6mo', label: '6 Months' },
  { value: '1y',  label: '1 Year'   },
  { value: '2y',  label: '2 Years'  },
  { value: '3y',  label: '3 Years'  },
  { value: '5y',  label: '5 Years'  },
]
const DEFAULT_US = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN']

// ── Quick Interpretation Engine ───────────────────────────────────────────────

interface InterpretationBullet {
  id: string
  category: 'trend' | 'channel' | 'support' | 'resistance' | 'confirmation' | 'overall'
  title: string
  explanation: string
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'caution'
  highlightIds: string[]
}

function buildInterpretation(analysis: Analysis): InterpretationBullet[] {
  const bullets: InterpretationBullet[] = []
  const { trend, assessment, indicators, overlays, rules } = analysis
  const price = indicators.current_price
  const f2 = (n: number) => n?.toFixed(2) ?? '?'

  // 1. Current Trend
  const pSen = trend.primary.includes('Bullish') || trend.primary === 'Uptrend' ? 'bullish'
             : trend.primary.includes('Bearish') || trend.primary === 'Downtrend' ? 'bearish' : 'neutral'
  // Fix: "Uptrend"/"Downtrend" labels from backend must map correctly (not via includes('Bearish'))
  const sSen = trend.short_term === 'Uptrend'   ? 'bullish'
             : trend.short_term === 'Downtrend' ? 'bearish'
             : trend.short_term.includes('Bullish') ? 'bullish'
             : trend.short_term.includes('Bearish') ? 'bearish' : 'neutral'
  const trendSen: InterpretationBullet['sentiment'] =
    pSen !== sSen ? 'caution' : pSen === 'bullish' ? 'bullish' : pSen === 'bearish' ? 'bearish' : 'neutral'

  let trendExpl: string
  if (pSen === sSen) {
    if (pSen === 'bullish') {
      trendExpl = `Both the long-term trend (${trend.primary}) and short-term (${trend.short_term}) are aligned bullish, suggesting sustained upward momentum.`
    } else if (pSen === 'bearish') {
      trendExpl = `Both the long-term trend (${trend.primary}) and short-term (${trend.short_term}) are aligned bearish, indicating continued selling pressure on both timeframes.`
    } else {
      trendExpl = `Both the long-term trend (${trend.primary}) and short-term (${trend.short_term}) show sideways price action — no directional bias.`
    }
  } else {
    // Genuine divergence: one bullish, one bearish or neutral
    const longBias  = pSen === 'bullish' ? 'bullish' : pSen === 'bearish' ? 'bearish' : 'neutral'
    const shortBias = sSen === 'bullish' ? 'bullish' : sSen === 'bearish' ? 'bearish' : 'neutral'
    trendExpl = `Long-term trend is ${trend.primary.toLowerCase()} (${longBias}) while short-term is ${trend.short_term.toLowerCase()} (${shortBias}). This divergence may precede a directional resolution.`
  }

  bullets.push({
    id: 'trend', category: 'trend', title: `Trend: ${trend.primary}`,
    explanation: trendExpl, sentiment: trendSen,
    highlightIds: overlays.trendlines.map(t => t.id),
  })

  // 2. Channel / Pattern Status
  const ch = overlays.channels[0]
  if (ch) {
    const broken = ch.status === 'broken_downward' || ch.status === 'broken_upward'
    const chSen: InterpretationBullet['sentiment'] =
      ch.status === 'broken_downward' ? 'bearish' :
      ch.status === 'broken_upward'   ? 'bullish' :
      ch.type === 'ascending'         ? 'bullish' :
      ch.type === 'descending'        ? 'bearish' : 'neutral'

    let chTitle = '', chExpl = ''
    if (ch.status === 'broken_downward') {
      chTitle = 'Channel Breakdown'
      chExpl  = `Price has fallen below the ${ch.type} channel's lower boundary, suggesting the previous upward structure is no longer intact. This is a bearish structural signal — the channel may now act as resistance.`
    } else if (ch.status === 'broken_upward') {
      chTitle = 'Channel Breakout'
      chExpl  = `Price has broken above the ${ch.type} channel's upper boundary, indicating a potential acceleration of the move. Confirmation on higher volume strengthens this signal.`
    } else {
      const infix = ch.is_regression ? 'regression' : 'structural'
      chTitle = `${ch.type.charAt(0).toUpperCase() + ch.type.slice(1)} Channel (${infix})`
      chExpl  = `Price is within a ${ch.type} channel (${ch.containment}% containment). ${
        ch.type === 'ascending'  ? 'The structure remains bullish as long as the lower boundary holds.' :
        ch.type === 'descending' ? 'The downtrend continues unless price breaks above the upper boundary.' :
                                   'Price is range-bound — a breakout in either direction sets the next trend.'
      }`
    }
    bullets.push({ id: 'channel', category: 'channel', title: chTitle, explanation: chExpl, sentiment: chSen, highlightIds: [ch.id] })
  } else {
    bullets.push({
      id: 'channel', category: 'channel', title: 'No Clear Channel Pattern',
      explanation: 'No reliable parallel channel was detected. Analysis relies on trendlines and support/resistance levels.',
      sentiment: 'neutral', highlightIds: [],
    })
  }

  // 3. Support
  const sups = overlays.sr_lines.filter(sr => sr.type === 'support')
  if (sups.length > 0) {
    const s = sups[0]
    const below = s.price < price
    const dist  = Math.abs(s.pct)
    const supSen: InterpretationBullet['sentiment'] = !below ? 'bearish' : dist < 3 ? 'caution' : 'bullish'
    let supExpl = !below
      ? `Price is below $${f2(s.price)}, which previously acted as support and may now act as overhead resistance. Recovering above it would improve the technical outlook.`
      : dist < 3
      ? `Price is testing support at $${f2(s.price)} (${dist.toFixed(1)}% below). This level has been validated ${s.touches} time${s.touches !== 1 ? 's' : ''}. A breakdown here could accelerate selling.`
      : `The nearest support at $${f2(s.price)} is ${dist.toFixed(1)}% below current price and has been tested ${s.touches} time${s.touches !== 1 ? 's' : ''}. This is a key level for buyers to defend.`
    bullets.push({ id: 'support', category: 'support', title: `Support at $${f2(s.price)}`, explanation: supExpl, sentiment: supSen, highlightIds: [s.id] })
  }

  // 4. Resistance
  const ress = overlays.sr_lines.filter(sr => sr.type === 'resistance')
  if (ress.length > 0) {
    const r = ress[0]
    const above = r.price > price
    const dist  = Math.abs(r.pct)
    const resSen: InterpretationBullet['sentiment'] = !above ? 'bullish' : dist < 3 ? 'caution' : 'neutral'
    let resExpl = !above
      ? `Price has moved above $${f2(r.price)}, converting former resistance into potential support. Holding above this level is a positive sign.`
      : dist < 3
      ? `Price is approaching resistance at $${f2(r.price)} (${dist.toFixed(1)}% away). Sellers may react here. A confirmed close above it with volume would be a bullish breakout signal.`
      : `The nearest resistance is at $${f2(r.price)} (${dist.toFixed(1)}% above), tested ${r.touches} time${r.touches !== 1 ? 's' : ''}. This is where the stock may face selling pressure.`
    bullets.push({ id: 'resistance', category: 'resistance', title: `Resistance at $${f2(r.price)}`, explanation: resExpl, sentiment: resSen, highlightIds: [r.id] })
  }

  // 5. Confirmation signal — use weighted counts if available, raw counts otherwise
  const wBull = assessment.weighted_bull ?? assessment.bullish_rules
  const wBear = assessment.weighted_bear ?? assessment.bearish_rules
  const bull = assessment.bullish_rules
  const bear = assessment.bearish_rules
  const confSen: InterpretationBullet['sentiment'] =
    wBull > wBear + 1 ? 'bullish' : wBear > wBull + 1 ? 'bearish' :
    wBull > 0 && wBear > 0 ? 'caution' : 'neutral'
  const { bullish: bs, bearish: bes } = assessment.scenarios
  let confTitle = '', confExpl = ''
  const rawNote = bull !== wBull || bear !== wBear
    ? ` (${bull} raw bullish / ${bear} raw bearish signals; correlated EMA rules grouped)`
    : ''
  if (confSen === 'bullish') {
    confTitle = 'Bullish Confirmation Setup'
    confExpl  = `${wBull} independent bullish signal category${wBull !== 1 ? 's' : ''} vs ${wBear} bearish${rawNote}. Trigger: ${bs.trigger}. Invalidation below $${f2(bs.invalidation)}.`
  } else if (confSen === 'bearish') {
    confTitle = 'Bearish Signal Active'
    confExpl  = `${wBear} independent bearish signal category${wBear !== 1 ? 's' : ''} vs ${wBull} bullish${rawNote}. Trigger: ${bes.trigger}. Recovery above $${f2(bes.invalidation)} invalidates.`
  } else if (confSen === 'caution') {
    confTitle = 'Conflicting Signals — Wait for Clarity'
    confExpl  = `${wBull} bullish and ${wBear} bearish signal categories present simultaneously${rawNote}. A decisive close ${bs.trigger.toLowerCase()} favours bulls; ${bes.trigger.toLowerCase()} favours bears.`
  } else {
    confTitle = 'No Strong Directional Signal'
    confExpl  = `Technical signals are neutral. Watch: ${bs.trigger} as upside trigger, ${bes.trigger} as downside trigger.`
  }
  bullets.push({ id: 'confirmation', category: 'confirmation', title: confTitle, explanation: confExpl, sentiment: confSen, highlightIds: [] })

  // 6. Overall
  const bias = assessment.bias
  const ovSen: InterpretationBullet['sentiment'] =
    bias.includes('Bullish') ? 'bullish' : bias.includes('Bearish') ? 'bearish' :
    bias === 'Neutral' ? 'neutral' : 'caution'
  const ovExpl =
    ovSen === 'bullish' ? 'Uptrend intact with supportive structure. Stay alert for any breakdown of key support.' :
    ovSen === 'bearish' ? 'Downtrend confirmed with no clear recovery. Caution warranted on long positions.' :
    ovSen === 'caution' ? 'Mixed signals — awaiting clearer directional confirmation before establishing a firm view.' :
                          'Sideways price action between support and resistance. A breakout will set the next trend.'
  bullets.push({ id: 'overall', category: 'overall', title: `Overall: ${bias}`, explanation: ovExpl, sentiment: ovSen, highlightIds: [] })

  return bullets
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trendColor(t: string) {
  return t.includes('Bullish') || t === 'Uptrend'   ? 'text-emerald-400' :
         t.includes('Bearish') || t === 'Downtrend' ? 'text-red-400'     : 'text-slate-400'
}

function statusBadge(status?: string) {
  if (!status || status === 'active') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 border border-emerald-700/30">Active</span>
  if (status === 'broken_downward')   return <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700/30">Broken ↓</span>
  if (status === 'broken_upward')     return <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 border border-amber-700/30">Broken ↑</span>
  if (status === 'provisional')       return <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 border border-blue-700/30">Provisional</span>
  return <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-400 border border-slate-600/30">Unconfirmed</span>
}

function validationBadge(vs?: string) {
  if (!vs || vs === 'validated')    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800/30">Validated</span>
  if (vs === 'provisional')         return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 border border-blue-800/30">Provisional</span>
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 border border-slate-600/30">Unconfirmed</span>
}

function Pill({ label, color }: { label: string; color: string }) {
  const map: Record<string, string> = {
    bullish: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
    bearish: 'bg-red-900/40 text-red-300 border-red-700/40',
    neutral: 'bg-slate-700/40 text-slate-300 border-slate-600/40',
    mixed:   'bg-amber-900/40 text-amber-300 border-amber-700/40',
  }
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${map[color.toLowerCase()] ?? map.neutral}`}>{label}</span>
}

function SectionCard({
  title, badge, letter, defaultOpen = true, children, onHeaderClick,
}: {
  title: string; badge?: React.ReactNode; letter?: string; defaultOpen?: boolean
  children: React.ReactNode; onHeaderClick?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
        onClick={() => { setOpen(v => !v); onHeaderClick?.() }}>
        <div className="flex items-center gap-2 font-medium text-white text-sm">
          {letter && <span className="text-[10px] font-bold text-muted/60 tracking-widest uppercase w-4">{letter}</span>}
          {title}{badge}
        </div>
        <span className="text-muted text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

function RuleRow({ rule, expanded, onToggle }: { rule: Rule; expanded: boolean; onToggle: () => void }) {
  const dot = rule.status === 'triggered'
    ? rule.level === 'bullish' ? '🟢' : rule.level === 'bearish' ? '🔴' : '⚪'
    : rule.status === 'n/a' ? '—' : '⚪'
  return (
    <div className="border-b border-border/40 last:border-0">
      <button className="w-full flex items-start gap-3 py-2.5 px-1 text-left hover:bg-white/[0.02] transition-colors" onClick={onToggle}>
        <span className="text-base mt-0.5 shrink-0">{dot}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted">{rule.id}</span>
            <span className="text-sm text-white">{rule.name}</span>
            {rule.status === 'triggered' && <Pill label={rule.level} color={rule.level} />}
          </div>
          <p className="text-xs text-muted mt-0.5 truncate">{rule.evidence}</p>
        </div>
        <span className="text-muted text-xs shrink-0 mt-1">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && <div className="px-8 pb-2.5 text-xs text-slate-300 leading-relaxed">{rule.explanation}</div>}
    </div>
  )
}

// ── Overlay Toolbar ───────────────────────────────────────────────────────────

function OverlayToolbar({
  prefs, onPrefChange, onReset,
}: {
  prefs: Prefs
  onPrefChange: (key: keyof Prefs, value: boolean | number) => void
  onReset: () => void
}) {
  const [showIndicators, setShowIndicators] = useState(false)
  const [showSettings,   setShowSettings]   = useState(false)
  const indRef = useRef<HTMLDivElement>(null)
  const setRef = useRef<HTMLDivElement>(null)

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (indRef.current && !indRef.current.contains(e.target as Node)) setShowIndicators(false)
      if (setRef.current && !setRef.current.contains(e.target as Node)) setShowSettings(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const structBtn = (key: keyof Prefs, label: string) => (
    <button
      key={key}
      onClick={() => onPrefChange(key, !prefs[key])}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
        prefs[key]
          ? 'bg-blue-900/40 text-blue-300 border-blue-700/50'
          : 'bg-transparent text-slate-500 border-slate-700/40 hover:border-slate-600'
      }`}>
      {prefs[key] ? '✓ ' : ''}{label}
    </button>
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Structure controls */}
      {structBtn('showChannels',     'Channels')}
      {structBtn('showTrendlines',   'Trendlines')}
      {structBtn('showSR',           'S/R Levels')}
      {structBtn('showConvergences', 'Convergences')}

      <div className="w-px h-5 bg-border/50 mx-1" />

      {/* Indicators dropdown */}
      <div ref={indRef} className="relative">
        <button
          onClick={() => { setShowIndicators(v => !v); setShowSettings(false) }}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1 ${
            (prefs.showEma20 || prefs.showEma50 || prefs.showEma200 || prefs.showVolume)
              ? 'bg-purple-900/40 text-purple-300 border-purple-700/50'
              : 'bg-transparent text-slate-500 border-slate-700/40 hover:border-slate-600'
          }`}>
          Indicators {showIndicators ? '▲' : '▼'}
        </button>
        {showIndicators && (
          <div className="absolute top-full mt-1 left-0 z-50 bg-slate-900 border border-border rounded-xl shadow-xl p-2 min-w-[160px]">
            {([
              ['showEma20',  'EMA 20',    '#60a5fa'],
              ['showEma50',  'EMA 50',    '#fbbf24'],
              ['showEma200', 'EMA 200',   '#c084fc'],
              ['showVolume', 'Volume',    '#64748b'],
            ] as [keyof Prefs, string, string][]).map(([key, label, color]) => (
              <button key={key} onClick={() => onPrefChange(key, !prefs[key])}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left hover:bg-white/5 transition-colors">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color, opacity: prefs[key] ? 1 : 0.3 }} />
                <span className={prefs[key] ? 'text-white' : 'text-slate-500'}>{label}</span>
                {prefs[key] && <span className="ml-auto text-emerald-400 text-[10px]">ON</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Settings popover */}
      <div ref={setRef} className="relative">
        <button
          onClick={() => { setShowSettings(v => !v); setShowIndicators(false) }}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1 ${
            showSettings
              ? 'bg-slate-700/60 text-white border-slate-600'
              : 'bg-transparent text-slate-500 border-slate-700/40 hover:border-slate-600'
          }`}>
          ⚙ Settings
        </button>
        {showSettings && (
          <div className="absolute top-full mt-1 right-0 z-50 bg-slate-900 border border-border rounded-xl shadow-xl p-4 w-64">
            <div className="text-xs font-semibold text-muted mb-3">Chart Settings</div>
            {/* Channel opacity */}
            <div className="mb-3">
              <div className="flex justify-between text-xs text-muted mb-1.5">
                <span>Channel fill opacity</span>
                <span className="text-white">{prefs.channelOpacity}%</span>
              </div>
              <input type="range" min={10} max={80} step={5}
                value={prefs.channelOpacity}
                onChange={e => onPrefChange('channelOpacity', +e.target.value)}
                className="w-full h-1.5 accent-blue-500 cursor-pointer" />
            </div>
            {/* Future projections */}
            <button onClick={() => onPrefChange('showProjections', !prefs.showProjections)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs hover:bg-white/5 transition-colors mb-2">
              <span className="text-muted">Future projections</span>
              <span className={prefs.showProjections ? 'text-emerald-400' : 'text-slate-600'}>{prefs.showProjections ? 'ON' : 'OFF'}</span>
            </button>
            {/* Reset */}
            <button onClick={onReset}
              className="w-full text-center px-3 py-2 rounded-lg text-xs text-red-400 hover:bg-red-900/20 border border-red-800/30 transition-colors">
              Reset to Defaults
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ChartIntelligence() {
  const [market,      setMarket]      = useState<'NSE' | 'US'>('NSE')
  const [symbol,      setSymbol]      = useState('^NSEI')
  const [symbolName,  setSymbolName]  = useState('NIFTY 50')
  const [usInput,     setUsInput]     = useState('NVDA')
  const [timeframe,   setTimeframe]   = useState('daily')
  const [lookback,    setLookback]    = useState('3y')
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [analysis,      setAnalysis]      = useState<Analysis | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [channelMethod, setChannelMethod] = useState<'structural' | 'regression'>('structural')

  // Overlay preferences — loaded from localStorage
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)

  // Persist prefs on change
  useEffect(() => {
    try { localStorage.setItem('aegis_chart_prefs', JSON.stringify(prefs)) } catch {}
  }, [prefs])

  const updatePref = useCallback((key: keyof Prefs, value: boolean | number) => {
    setPrefs(p => ({ ...p, [key]: value }))
  }, [])

  const resetPrefs = useCallback(() => {
    setPrefs({ ...DEFAULTS })
  }, [])

  // Refs
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef          = useRef<IChartApi | null>(null)
  const allSeriesRef      = useRef<ISeriesApi<any>[]>([])
  const obsRef            = useRef<ResizeObserver | null>(null)
  // Map from technical ID to series (for highlighting)
  const seriesMapRef      = useRef<Map<string, ISeriesApi<any>[]>>(new Map())

  // ── Chart build / rebuild effect ─────────────────────────────────────────

  useEffect(() => {
    const container = chartContainerRef.current
    if (!container || !analysis) return

    if (!chartRef.current) {
      const chart = createChart(container, {
        layout: { background: { color: '#0d1117' }, textColor: '#94a3b8', fontSize: 11 },
        grid: { vertLines: { color: '#1a2230' }, horzLines: { color: '#1a2230' } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1e2736', minimumWidth: 60 },
        timeScale: { borderColor: '#1e2736', timeVisible: true, secondsVisible: false, rightOffset: 30 },
        width: container.clientWidth,
        height: 480,
      })
      chartRef.current = chart
      obsRef.current?.disconnect()
      const obs = new ResizeObserver(entries => {
        if (chartRef.current && entries[0])
          chartRef.current.applyOptions({ width: entries[0].contentRect.width })
      })
      obs.observe(container)
      obsRef.current = obs
    }

    const chart = chartRef.current
    seriesMapRef.current.clear()

    // Remove all previous series
    for (const s of allSeriesRef.current) { try { chart.removeSeries(s) } catch {} }
    allSeriesRef.current = []

    const opacity = prefs.channelOpacity / 100

    // 1. Candlesticks
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350',
      borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    })
    candleSeries.setData(analysis.candles.map(c => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    })))
    allSeriesRef.current.push(candleSeries)

    // 2. S/R price lines — deduplicate levels within ATR/2 of each other
    if (prefs.showSR) {
      const renderedPrices: number[] = []
      const atr = analysis.indicators.atr || analysis.indicators.current_price * 0.02
      for (const sr of analysis.overlays.sr_lines) {
        // Skip if too close to an already-rendered level
        if (renderedPrices.some(p => Math.abs(p - sr.price) < atr * 0.5)) continue
        renderedPrices.push(sr.price)
        const isHighlighted = highlightedId === sr.id
        candleSeries.createPriceLine({
          price: sr.price,
          color: sr.type === 'support'
            ? (isHighlighted ? '#4ade80' : '#22c55e80')
            : (isHighlighted ? '#f87171' : '#ef444480'),
          lineWidth: isHighlighted ? 2 : 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${sr.type === 'support' ? 'S' : 'R'} (${sr.touches}t)`,
        })
      }
    }

    // 3. Volume histogram
    if (prefs.showVolume) {
      const volSeries = chart.addSeries(HistogramSeries, {
        color: '#3b82f640', priceFormat: { type: 'volume' }, priceScaleId: 'vol',
      } as any)
      try { chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, autoScale: true }) } catch {}
      volSeries.setData(analysis.candles.map(c => ({
        time: c.time as Time, value: c.volume,
        color: c.close >= c.open ? '#26a69a30' : '#ef535030',
      })))
      allSeriesRef.current.push(volSeries)
    }

    // 4. EMA lines
    const emaConfig: [keyof Prefs, EMAPoint[], string][] = [
      ['showEma20',  analysis.ema20_series,  '#60a5fa'],
      ['showEma50',  analysis.ema50_series,  '#fbbf24'],
      ['showEma200', analysis.ema200_series, '#c084fc'],
    ]
    for (const [key, data, color] of emaConfig) {
      if (!prefs[key] || !data.length) continue
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      })
      s.setData(data.map(p => ({ time: p.time as Time, value: p.value })))
      allSeriesRef.current.push(s)
    }

    // 5. Channels
    if (prefs.showChannels) {
      for (const ch of analysis.overlays.channels) {
        const isBroken = ch.status === 'broken_downward' || ch.status === 'broken_upward'
        const isProvisional = ch.status === 'provisional' || ch.validation_status === 'provisional' || ch.validation_status === 'unconfirmed'
        const isHighlighted = highlightedId === ch.id

        const baseAlpha = isBroken ? opacity * 0.4 : isProvisional ? opacity * 0.6 : opacity
        const fillColor = ch.type === 'ascending'
          ? `rgba(41,98,255,${baseAlpha})`
          : ch.type === 'descending'
          ? `rgba(255,82,82,${baseAlpha})`
          : `rgba(41,98,255,${baseAlpha * 0.65})`

        const lineColor  = isBroken ? '#64748b' : isProvisional ? '#94a3b8' : isHighlighted ? '#ffffff' : '#ffffffcc'
        const lineWidth: 1 | 2 | 3 | 4 = isHighlighted ? 3 : (isBroken || isProvisional) ? 1 : 2
        const lineStyle  = isBroken ? LineStyle.Dashed : isProvisional ? LineStyle.Dashed : LineStyle.Solid

        const toVal = (arr: ChannelLinePoint[]) =>
          arr.map(p => ({ time: p.time, value: p.price }))

        const upperPts = toVal(ch.resistance_line.points ?? [ch.resistance_line.start, ch.resistance_line.end])
        const lowerPts = toVal(ch.support_line.points    ?? [ch.support_line.start,    ch.support_line.end])

        // Filled primitive
        const prim = new ChannelFillPrimitive(upperPts, lowerPts, fillColor)
        candleSeries.attachPrimitive(prim as any)

        // Boundary lines
        const chSeries: ISeriesApi<any>[] = []
        for (const pts of [upperPts, lowerPts]) {
          const s = chart.addSeries(LineSeries, {
            color: lineColor, lineWidth, lineStyle,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          s.setData(pts.map(p => ({ time: p.time as Time, value: p.value })))
          allSeriesRef.current.push(s)
          chSeries.push(s)
        }
        seriesMapRef.current.set(ch.id, chSeries)
      }
    }

    // 6. Trendlines (individual)
    if (prefs.showTrendlines) {
      for (const tl of analysis.overlays.trendlines) {
        const isHighlighted = highlightedId === tl.id
        const histColor  = tl.type === 'support'
          ? (isHighlighted ? '#4ade80' : '#4ade8099')
          : (isHighlighted ? '#fb923c' : '#fb923c99')
        const projColor  = tl.type === 'support' ? '#4ade8050' : '#fb923c50'
        const lw: 1 | 2 | 3 | 4 = isHighlighted ? 2 : 1

        // Historical portion (solid)
        const histPts: { time: Time; value: number }[] = [
          { time: tl.start.time as Time, value: tl.start.value },
          { time: tl.end.time   as Time, value: tl.end.value   },
        ].sort((a, b) => (a.time as number) - (b.time as number))

        const hs = chart.addSeries(LineSeries, {
          color: histColor, lineWidth: lw, lineStyle: LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        hs.setData(histPts)
        allSeriesRef.current.push(hs)
        seriesMapRef.current.set(tl.id, [hs])

        // Future projection (dashed, lighter)
        if (prefs.showProjections && tl.projection.time !== tl.end.time) {
          const projPts: { time: Time; value: number }[] = [
            { time: tl.end.time        as Time, value: tl.end.value        },
            { time: tl.projection.time as Time, value: tl.projection.value },
          ].sort((a, b) => (a.time as number) - (b.time as number))

          const ps = chart.addSeries(LineSeries, {
            color: projColor, lineWidth: 1, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          ps.setData(projPts)
          allSeriesRef.current.push(ps)
        }
      }
    }

    // 7. Convergence markers — shown as faint dotted price lines, no axis label to avoid clutter
    if (prefs.showConvergences) {
      const renderedConvPrices: number[] = []
      const convAtr = analysis.indicators.atr || analysis.indicators.current_price * 0.02
      for (const conv of analysis.overlays.convergences ?? []) {
        if (renderedConvPrices.some(p => Math.abs(p - conv.price) < convAtr * 0.3)) continue
        renderedConvPrices.push(conv.price)
        const isHighlighted = highlightedId === conv.id
        candleSeries.createPriceLine({
          price: conv.price,
          color: conv.is_future
            ? (isHighlighted ? '#c084fc' : '#c084fc50')
            : (isHighlighted ? '#f59e0b' : '#f59e0b60'),
          lineWidth: isHighlighted ? 2 : 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: '',
        })
      }
    }

    chart.timeScale().fitContent()
  }, [analysis, prefs, highlightedId])

  // Cleanup
  useEffect(() => {
    return () => {
      obsRef.current?.disconnect()
      chartRef.current?.remove()
      chartRef.current = null
      allSeriesRef.current = []
    }
  }, [])

  // ── API call ────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    const sym = market === 'US' ? usInput.trim().toUpperCase() : symbol
    if (!sym) return
    setLoading(true); setError(null); setHighlightedId(null)
    try {
      const { data } = await client.post('/chart/analyze', { symbol: sym, market, timeframe, lookback, channel_method: channelMethod })
      if (data.error) { setError(data.error); return }
      setAnalysis(data)
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Analysis failed')
    } finally { setLoading(false) }
  }

  const fmt = (n: number, d = 2) => n?.toFixed(d) ?? '—'

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 pb-16 md:pb-0">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold text-white">Technical Chart Intelligence</h1>
          <p className="text-xs text-muted mt-0.5">Automatic trendline · channel · S/R · convergence detection</p>
        </div>
        {analysis && <span className="text-xs text-muted">Generated {new Date(analysis.generated_at).toLocaleTimeString()}</span>}
      </div>

      {/* Control panel */}
      <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-end gap-4">
        {/* Market */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Market</label>
          <select value={market} onChange={e => setMarket(e.target.value as 'NSE' | 'US')}
            className="bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 min-w-[140px]">
            <option value="NSE">NSE / Indices</option>
            <option value="US">US Markets</option>
          </select>
        </div>

        {/* Symbol */}
        {market === 'NSE' ? (
          <div className="flex flex-col gap-1 min-w-[240px]">
            <label className="text-xs text-muted">Symbol</label>
            <NseStockSearch
              placeholder="Search NSE / Index (e.g. NIFTY, HDFC)"
              includeEtfIndex
              onSelect={(sym, name) => { setSymbol(sym); setSymbolName(name) }}
            />
            {symbol && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-muted">Selected:</span>
                <span className="text-xs font-mono text-blue-300 bg-blue-900/30 border border-blue-700/30 px-2 py-0.5 rounded-full">
                  {symbolName || symbol}
                </span>
                {symbol !== symbolName && <span className="text-[10px] text-muted font-mono">{symbol}</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">Symbol</label>
            <input value={usInput} onChange={e => setUsInput(e.target.value.toUpperCase())}
              placeholder="NVDA, AAPL, SPY…"
              className="bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 w-44"
              onKeyDown={e => e.key === 'Enter' && handleGenerate()} />
            <div className="flex gap-1 mt-1">
              {DEFAULT_US.map(s => (
                <button key={s} onClick={() => setUsInput(s)}
                  className="text-[10px] px-2 py-0.5 rounded bg-slate-700/60 text-slate-300 hover:bg-slate-600/60 transition">{s}</button>
              ))}
            </div>
          </div>
        )}

        {/* Timeframe */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Timeframe</label>
          <select value={timeframe} onChange={e => setTimeframe(e.target.value)}
            className="bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
            {TIMEFRAMES.map(tf => <option key={tf.value} value={tf.value}>{tf.label}</option>)}
          </select>
        </div>

        {/* Lookback */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Lookback</label>
          <select value={lookback} onChange={e => setLookback(e.target.value)}
            className="bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
            {LOOKBACKS.map(lb => <option key={lb.value} value={lb.value}>{lb.label}</option>)}
          </select>
        </div>

        {/* Generate */}
        <button onClick={handleGenerate} disabled={loading}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition">
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Analyzing…
            </span>
          ) : 'Generate Chart'}
        </button>
      </div>

      {error && <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{error}</div>}
      {analysis?.warning && <div className="bg-amber-900/20 border border-amber-700/30 rounded-lg p-3 text-amber-300 text-sm">⚠ {analysis.warning}</div>}

      {/* ── Chart + analysis ── */}
      {analysis && (
        <>
          {/* Overlay toolbar */}
          <OverlayToolbar prefs={prefs} onPrefChange={updatePref} onReset={resetPrefs} />

          {/* EMA legend (only when any EMA is on) */}
          {(prefs.showEma20 || prefs.showEma50 || prefs.showEma200) && (
            <div className="flex gap-4 text-xs text-slate-400">
              {prefs.showEma20  && <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#60a5fa] inline-block rounded" />EMA20</span>}
              {prefs.showEma50  && <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#fbbf24] inline-block rounded" />EMA50</span>}
              {prefs.showEma200 && <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-[#c084fc] inline-block rounded" />EMA200</span>}
            </div>
          )}

          {/* Chart */}
          <div className="rounded-xl overflow-hidden border border-border">
            <div ref={chartContainerRef} style={{ height: '480px', width: '100%' }} />
          </div>

          {/* ── Quick Chart Interpretation ── */}
          {(() => {
            const interp = buildInterpretation(analysis)
            const sentimentStyle = (s: InterpretationBullet['sentiment']) =>
              s === 'bullish' ? { dot: 'bg-emerald-500', text: 'text-emerald-300', border: 'border-emerald-700/30' } :
              s === 'bearish' ? { dot: 'bg-red-500',     text: 'text-red-300',     border: 'border-red-700/30'     } :
              s === 'caution' ? { dot: 'bg-amber-500',   text: 'text-amber-300',   border: 'border-amber-700/30'   } :
                                { dot: 'bg-slate-500',   text: 'text-slate-400',   border: 'border-slate-600/30'   }

            const overall = interp.find(b => b.id === 'overall')
            const overallStyle = overall ? sentimentStyle(overall.sentiment) : sentimentStyle('neutral')

            return (
              <div className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">Quick Chart Interpretation</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${overallStyle.text} ${overallStyle.border} bg-opacity-20`}>
                      {overall?.sentiment.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span className="font-mono">{analysis.symbol}</span>
                    <span>·</span>
                    <span className="font-mono">${analysis.indicators.current_price.toFixed(2)}</span>
                    <span>·</span>
                    <span>{new Date(analysis.generated_at).toLocaleTimeString()}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  {interp.map((bullet, i) => {
                    const st = sentimentStyle(bullet.sentiment)
                    return (
                      <button
                        key={bullet.id}
                        onClick={() => {
                          if (bullet.highlightIds.length > 0) {
                            const first = bullet.highlightIds[0]
                            setHighlightedId(h => h === first ? null : first)
                          }
                        }}
                        className={`w-full text-left flex items-start gap-3 p-3 rounded-lg transition-all ${
                          bullet.highlightIds.length > 0 ? 'hover:bg-white/[0.03] cursor-pointer' : 'cursor-default'
                        } ${bullet.highlightIds.some(id => id === highlightedId) ? 'bg-white/[0.05] ring-1 ring-white/10' : ''}`}>
                        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                          <span className="text-xs text-muted/60 w-4 text-right">{i + 1}.</span>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium ${st.text}`}>{bullet.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{bullet.explanation}</div>
                        </div>
                        {bullet.highlightIds.length > 0 && (
                          <span className="text-[9px] text-muted/40 mt-1 shrink-0">⟲</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Summary strip */}
          <div className="bg-card border border-border rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-muted mb-1">Bias</div>
              <Pill label={analysis.assessment.bias} color={analysis.assessment.bias.toLowerCase()} />
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Primary Trend</div>
              <div className={`font-semibold text-sm ${trendColor(analysis.assessment.primary_trend)}`}>{analysis.assessment.primary_trend}</div>
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Short-Term</div>
              <div className={`font-semibold text-sm ${trendColor(analysis.assessment.short_term)}`}>{analysis.assessment.short_term}</div>
            </div>
            <div>
              <div className="text-xs text-muted mb-1">Rules</div>
              <div className="flex gap-2 text-xs">
                <span className="text-emerald-400">{analysis.assessment.bullish_rules}↑</span>
                <span className="text-red-400">{analysis.assessment.bearish_rules}↓</span>
                <span className="text-slate-400">{analysis.assessment.neutral_rules}—</span>
              </div>
            </div>
          </div>

          {/* ── Analysis Sections A–G ── */}

          {/* A — Overall Trend */}
          <SectionCard title="Overall Trend" letter="A">
            <div className="grid grid-cols-2 gap-3 text-sm mb-3">
              <div><div className="text-xs text-muted mb-1">Primary Trend</div>
                <div className={`font-bold ${trendColor(analysis.trend.primary)}`}>{analysis.trend.primary}</div></div>
              <div><div className="text-xs text-muted mb-1">Short-Term</div>
                <div className={`font-semibold ${trendColor(analysis.trend.short_term)}`}>{analysis.trend.short_term}</div></div>
              <div><div className="text-xs text-muted mb-1">Strength</div>
                <div className="flex gap-0.5">
                  {[1,2,3,4,5].map(i => <span key={i} className={`w-4 h-4 rounded-sm ${i <= analysis.trend.strength ? 'bg-blue-500' : 'bg-slate-800'}`} />)}
                </div></div>
              <div><div className="text-xs text-muted mb-1">Channel</div>
                <div className="flex items-center gap-2">
                  {analysis.overlays.channels[0] && (
                    <>
                      <span className="text-xs text-white capitalize">{analysis.overlays.channels[0].type}</span>
                      {statusBadge(analysis.overlays.channels[0].status)}
                    </>
                  )}
                </div>
              </div>
            </div>
            {analysis.trend.ema_positions.length > 0 && (
              <div className="pt-2 border-t border-border/40 space-y-1">
                {analysis.trend.ema_positions.map((p, i) => <div key={i} className="text-xs text-slate-400">{p}</div>)}
              </div>
            )}
          </SectionCard>

          {/* B — Support Levels */}
          <SectionCard title="Support Levels" letter="B">
            {analysis.overlays.sr_lines.filter(sr => sr.type === 'support').length === 0 ? (
              <p className="text-sm text-muted">No support levels detected. Try a longer lookback.</p>
            ) : (
              <div className="space-y-2">
                {analysis.overlays.sr_lines.filter(sr => sr.type === 'support').map((sr, i) => {
                  const isBroken = analysis.indicators.current_price > sr.price * 1.01
                  const isZoneTest = sr.zone_status === 'zone_under_test'
                  return (
                    <button key={sr.id}
                      onClick={() => setHighlightedId(h => h === sr.id ? null : sr.id)}
                      className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-all ${
                        highlightedId === sr.id
                          ? 'bg-emerald-900/40 border-2 border-emerald-500/60'
                          : 'bg-emerald-900/20 border border-emerald-700/30 hover:bg-emerald-900/30'
                      }`}>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-emerald-400">S{i + 1}</span>
                          <span className="text-white font-mono text-sm">{fmt(sr.price)}</span>
                          {isZoneTest && <span className="text-[10px] px-1.5 py-0.5 bg-amber-900/40 text-amber-300 rounded border border-amber-700/30">Testing Zone</span>}
                          {!isZoneTest && isBroken && <span className="text-[10px] px-1.5 py-0.5 bg-slate-700/40 text-slate-400 rounded border border-slate-600/30">Was Support</span>}
                        </div>
                        <div className="text-xs text-muted mt-0.5">Identified from {sr.touches} swing low cluster{sr.touches !== 1 ? 's' : ''}</div>
                      </div>
                      <div className="text-right text-xs">
                        <div className={sr.pct < 0 ? 'text-emerald-400' : isZoneTest ? 'text-amber-400' : 'text-red-400'}>{sr.pct > 0 ? '+' : ''}{fmt(sr.pct)}%</div>
                        <div className="text-muted">{sr.touches}t</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* C — Resistance Levels */}
          <SectionCard title="Resistance Levels" letter="C">
            {analysis.overlays.sr_lines.filter(sr => sr.type === 'resistance').length === 0 ? (
              <p className="text-sm text-muted">No resistance levels detected. Try a longer lookback.</p>
            ) : (
              <div className="space-y-2">
                {analysis.overlays.sr_lines.filter(sr => sr.type === 'resistance').map((sr, i) => {
                  const resTL = analysis.overlays.trendlines.find(tl =>
                    tl.type === 'resistance' && Math.abs(tl.end.value - sr.price) / sr.price < 0.03)
                  return (
                    <button key={sr.id}
                      onClick={() => setHighlightedId(h => h === sr.id ? null : sr.id)}
                      className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-all ${
                        highlightedId === sr.id
                          ? 'bg-red-900/40 border-2 border-red-500/60'
                          : 'bg-red-900/20 border border-red-700/30 hover:bg-red-900/30'
                      }`}>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-red-400">R{i + 1}</span>
                          <span className="text-white font-mono text-sm">{fmt(sr.price)}</span>
                          {resTL && <span className="text-[10px] px-1.5 py-0.5 bg-orange-900/40 text-orange-300 rounded border border-orange-700/30">+ TL</span>}
                        </div>
                        <div className="text-xs text-muted mt-0.5">
                          {resTL
                            ? `Structural resistance reinforced by descending trendline`
                            : `Identified from ${sr.touches} swing high cluster${sr.touches !== 1 ? 's' : ''}`}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">Breakout: close above {fmt(sr.price * 1.005)} on volume surge</div>
                      </div>
                      <div className="text-right text-xs">
                        <div className={sr.pct > 0 ? 'text-red-400' : 'text-emerald-400'}>{sr.pct > 0 ? '+' : ''}{fmt(sr.pct)}%</div>
                        <div className="text-muted">{sr.touches}t</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* D — Chart Patterns */}
          <SectionCard title="Chart Patterns" letter="D">
            <div className="space-y-3">
              {analysis.overlays.channels.map((ch: any, i) => (
                <button key={ch.id}
                  onClick={() => setHighlightedId(h => h === ch.id ? null : ch.id)}
                  className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-all text-sm ${
                    highlightedId === ch.id
                      ? 'bg-blue-900/40 border-2 border-blue-500/60'
                      : 'bg-slate-800/40 border border-border hover:bg-slate-800/60'
                  }`}>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-semibold capitalize ${
                        ch.type === 'ascending' ? 'text-emerald-400' :
                        ch.type === 'descending' ? 'text-red-400' : 'text-slate-400'
                      }`}>{ch.type} {ch.is_regression ? 'Regression' : ''} Channel</span>
                      {statusBadge(ch.status)}
                      {ch.validation_status && validationBadge(ch.validation_status)}
                    </div>
                    <div className="text-xs text-muted mt-1">
                      {ch.containment}% containment · {ch.is_regression ? 'Linear regression fit' : `${ch.channel_width?.toFixed(2) ?? '?'} width`}
                      {ch.diagnostics && ` · ${ch.diagnostics.sup_touches}↓ ${ch.diagnostics.res_touches}↑ touches`}
                    </div>
                    {ch.status === 'broken_downward' && <div className="text-xs text-red-400 mt-1">⚠ Price has broken below the support boundary — bearish signal</div>}
                    {ch.status === 'broken_upward' && <div className="text-xs text-emerald-400 mt-1">⚡ Price has broken above resistance — potential acceleration</div>}
                    {ch.status === 'provisional' && <div className="text-xs text-blue-400 mt-1">Provisional: limited boundary evidence — treat as candidate, not confirmed channel</div>}
                  </div>
                </button>
              ))}

              {analysis.overlays.trendlines.length > 0 && (
                <div className="pt-2 border-t border-border/40">
                  <div className="text-xs text-muted mb-2">Significant trendlines</div>
                  {analysis.overlays.trendlines.map(tl => (
                    <button key={tl.id}
                      onClick={() => setHighlightedId(h => h === tl.id ? null : tl.id)}
                      className={`w-full flex items-center justify-between rounded-lg px-3 py-2 mb-1 text-sm text-left transition-all ${
                        highlightedId === tl.id
                          ? 'bg-slate-700/60 border-2 border-slate-500'
                          : 'bg-slate-800/40 border border-border hover:bg-slate-800/60'
                      }`}>
                      <span className={`capitalize text-xs ${tl.type === 'support' ? 'text-emerald-400' : 'text-orange-400'}`}>
                        {tl.type} trendline
                      </span>
                      <span className="text-xs text-muted">{tl.touches} touches</span>
                    </button>
                  ))}
                </div>
              )}

              {(analysis.overlays.convergences ?? []).length > 0 && (
                <div className="pt-2 border-t border-border/40">
                  <div className="text-xs text-muted mb-2">Convergence zones</div>
                  {(analysis.overlays.convergences ?? []).map(conv => (
                    <button key={conv.id}
                      onClick={() => setHighlightedId(h => h === conv.id ? null : conv.id)}
                      className={`w-full flex items-center justify-between rounded-lg px-3 py-2 mb-1 text-xs text-left transition-all ${
                        highlightedId === conv.id
                          ? 'bg-purple-900/40 border-2 border-purple-500/60'
                          : 'bg-slate-800/40 border border-border hover:bg-slate-800/60'
                      }`}>
                      <div>
                        <div className="text-white font-mono">{fmt(conv.price)}</div>
                        <div className="text-muted">{conv.line1} × {conv.line2}</div>
                      </div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        conv.is_future
                          ? 'text-purple-300 border-purple-700/30 bg-purple-900/30'
                          : 'text-amber-300 border-amber-700/30 bg-amber-900/30'
                      }`}>{conv.is_future ? 'Projected' : 'Confirmed'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          {/* E — Bullish Scenario */}
          <SectionCard title="Bullish Scenario" letter="E" defaultOpen={false}>
            {(() => {
              const s = analysis.assessment.scenarios.bullish
              return (
                <div className="rounded-xl p-4 bg-emerald-900/20 border border-emerald-700/30 space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-muted w-24 shrink-0 pt-0.5">Trigger</span>
                    <span className="text-sm text-white">{s.trigger}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-24 shrink-0">Target</span>
                    <span className="font-mono text-emerald-400 font-bold">{fmt(s.target)}</span>
                    <span className="text-xs text-muted">(+{fmt((s.target / analysis.indicators.current_price - 1) * 100)}%)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-24 shrink-0">Invalidation</span>
                    <span className="font-mono text-red-400">{fmt(s.invalidation)}</span>
                  </div>
                </div>
              )
            })()}
          </SectionCard>

          {/* F — Bearish Scenario */}
          <SectionCard title="Bearish Scenario" letter="F" defaultOpen={false}>
            {(() => {
              const s = analysis.assessment.scenarios.bearish
              return (
                <div className="rounded-xl p-4 bg-red-900/20 border border-red-700/30 space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-muted w-24 shrink-0 pt-0.5">Trigger</span>
                    <span className="text-sm text-white">{s.trigger}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-24 shrink-0">Target</span>
                    <span className="font-mono text-red-400 font-bold">{fmt(s.target)}</span>
                    <span className="text-xs text-muted">({fmt((s.target / analysis.indicators.current_price - 1) * 100)}%)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-24 shrink-0">Invalidation</span>
                    <span className="font-mono text-emerald-400">{fmt(s.invalidation)}</span>
                  </div>
                </div>
              )
            })()}
          </SectionCard>

          {/* G — Risk + Rule Engine */}
          <SectionCard title="Risk & Rule Engine" letter="G" defaultOpen={false}
            badge={<span className="ml-2 text-xs text-muted">({analysis.rules.length} rules)</span>}>
            {/* Key levels */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-sm">
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="text-xs text-muted mb-1">ATR (14)</div>
                <div className="font-bold text-white">{fmt(analysis.indicators.atr_pct)}%</div>
                <div className="text-xs text-muted">{analysis.indicators.atr_pct > 4 ? 'High vol' : analysis.indicators.atr_pct < 1 ? 'Squeeze' : 'Normal'}</div>
              </div>
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="text-xs text-muted mb-1">RSI (14)</div>
                <div className={`font-bold ${analysis.indicators.rsi >= 70 ? 'text-red-400' : analysis.indicators.rsi <= 30 ? 'text-emerald-400' : 'text-white'}`}>
                  {fmt(analysis.indicators.rsi, 1)}
                </div>
                <div className="text-xs text-muted capitalize">{analysis.assessment.rsi_zone}</div>
              </div>
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="text-xs text-muted mb-1">Vol Ratio</div>
                <div className={`font-bold ${analysis.indicators.vol_ratio > 1.5 ? 'text-emerald-400' : analysis.indicators.vol_ratio < 0.5 ? 'text-amber-400' : 'text-white'}`}>
                  {fmt(analysis.indicators.vol_ratio, 2)}×
                </div>
                <div className="text-xs text-muted">vs 20d avg</div>
              </div>
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="text-xs text-muted mb-1">Signals</div>
                <div className="text-xs mt-1 space-y-0.5">
                  <div><span className="text-emerald-400">{analysis.assessment.bullish_rules}</span> bullish</div>
                  <div><span className="text-red-400">{analysis.assessment.bearish_rules}</span> bearish</div>
                </div>
              </div>
            </div>
            {/* Rules */}
            <div>
              {analysis.rules.map(rule => (
                <RuleRow key={rule.id} rule={rule}
                  expanded={expandedRules.has(rule.id)}
                  onToggle={() => setExpandedRules(prev => {
                    const n = new Set(prev); n.has(rule.id) ? n.delete(rule.id) : n.add(rule.id); return n
                  })} />
              ))}
            </div>
          </SectionCard>

          {/* H — Channel Diagnostics */}
          <SectionCard title="Channel Diagnostics" letter="H" defaultOpen={false}
            badge={
              analysis.channel_method === 'regression'
                ? <span className="ml-2 text-[10px] text-slate-500">regression</span>
                : <span className="ml-2 text-[10px] text-blue-500">structural</span>
            }>
            <div className="space-y-3">
              {analysis.overlays.channels.map((ch, idx) => {
                const d = ch.diagnostics
                if (!d) return null
                const fmtDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '?'
                return (
                  <button key={ch.id}
                    onClick={() => setHighlightedId(h => h === ch.id ? null : ch.id)}
                    className={`w-full text-left rounded-xl p-3 border transition-all ${
                      highlightedId === ch.id
                        ? 'bg-blue-900/30 border-blue-500/60'
                        : 'bg-slate-800/40 border-border hover:bg-slate-800/60'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white capitalize">{ch.type} channel</span>
                        {statusBadge(ch.status)}
                        {ch.is_regression && <span className="text-[10px] text-slate-500">regression</span>}
                      </div>
                      <span className="text-xs font-mono text-blue-400">Q: {d.quality_score.toFixed(2)}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <div><div className="text-muted">Span</div><div className="text-white">{d.span_bars} bars</div></div>
                      <div><div className="text-muted">Slope</div><div className="font-mono text-white">{d.slope.toFixed(4)}</div></div>
                      <div><div className="text-muted">Sup touches</div><div className="text-emerald-400">{d.sup_touches}</div></div>
                      <div><div className="text-muted">Res touches</div><div className="text-orange-400">{d.res_touches}</div></div>
                      <div><div className="text-muted">Containment</div><div className="text-white">{d.containment_pct}%</div></div>
                      <div><div className="text-muted">Body violations</div><div className={d.body_violations > 10 ? 'text-red-400' : 'text-white'}>{d.body_violations}</div></div>
                      <div><div className="text-muted">Wick overshoots</div><div className="text-white">{d.wick_overshoots}</div></div>
                      <div><div className="text-muted">Avg error (ATR)</div><div className="text-white">{d.avg_error_atr.toFixed(3)}</div></div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-muted">Support anchor</div>
                        <div className="text-emerald-300 font-mono">{d.sup_anchor_price ?? '—'} {d.sup_anchor_time ? `(${fmtDate(d.sup_anchor_time)})` : ''}</div>
                      </div>
                      <div>
                        <div className="text-muted">Resistance anchor</div>
                        <div className="text-orange-300 font-mono">{d.res_anchor_price ?? '—'} {d.res_anchor_time ? `(${fmtDate(d.res_anchor_time)})` : ''}</div>
                      </div>
                      <div>
                        <div className="text-muted">Channel start</div>
                        <div className="text-white">{fmtDate(d.start_time)}</div>
                      </div>
                      <div>
                        <div className="text-muted">Channel end</div>
                        <div className="text-white">{fmtDate(d.end_time)}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Channel method toggle */}
            <div className="pt-3 border-t border-border/40 mt-3">
              <div className="text-xs text-muted mb-2">Channel detection method</div>
              <div className="flex gap-2">
                {(['structural', 'regression'] as const).map(m => (
                  <button key={m} onClick={() => setChannelMethod(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-all capitalize ${
                      channelMethod === m
                        ? 'bg-blue-900/40 text-blue-300 border-blue-700/50'
                        : 'bg-transparent text-slate-500 border-slate-700/40 hover:border-slate-600'
                    }`}>
                    {m}
                  </button>
                ))}
                <span className="text-xs text-muted self-center ml-1">(click Generate to apply)</span>
              </div>
            </div>
          </SectionCard>
        </>
      )}

      {/* Empty state */}
      {!analysis && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="text-5xl mb-4">📊</div>
          <div className="text-white font-semibold mb-2">Select a symbol and click Generate Chart</div>
          <div className="text-sm text-muted max-w-sm">Automatic trendline · channel · S/R · convergence detection with rule-based analysis</div>
        </div>
      )}
    </div>
  )
}
