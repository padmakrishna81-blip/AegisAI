import { useState } from 'react'
import { scoreToColor, scoreToLabel } from '../../utils/formatters'
import type { ScoreBreakdown } from '../../types'

interface ScoreBreakdownPanelProps {
  title: string
  score: number
  breakdown: Record<string, ScoreBreakdown>
  defaultOpen?: boolean
}

const formatKey = (key: string) =>
  key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Sub-scores that are "higher = safer/better" but whose names sound like risk
// — show a plain label instead of a numeric percentage
const SAFETY_KEYS = new Set(['entry_timing', 'technical_risk', 'risk_outlook', 'sector_risk'])

// Detail fields we want to surface as a subtitle under the bar
const MEANING_FIELDS = ['meaning', 'entry_advice', 'condition', 'rsi_zone', 'trend']

function getSubtitle(key: string, details: Record<string, unknown>): string | null {
  for (const field of MEANING_FIELDS) {
    const v = details[field]
    if (v && typeof v === 'string') return v
  }
  return null
}

export default function ScoreBreakdownPanel({
  title,
  score,
  breakdown,
  defaultOpen = false,
}: ScoreBreakdownPanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const color = scoreToColor(score)

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-800/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className="font-semibold text-white text-sm">{title}</span>
        <div className="flex items-center gap-3">
          <span className="font-bold text-lg" style={{ color }}>{score}</span>
          <span className="text-muted text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-border">
          <div className="mt-3 space-y-4">
            {Object.entries(breakdown).map(([key, item]) => {
              const scaledScore = item.score * 10
              const isSafetyKey = SAFETY_KEYS.has(key)
              const subtitle = getSubtitle(key, item.details || {})
              const displayLabel = isSafetyKey
                ? scoreToLabel(scaledScore)           // "Strong", "Good", etc. — not a percentage
                : `${scaledScore}/100`

              return (
                <div key={key}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <div>
                          <span className="text-xs text-slate-300">{formatKey(key)}</span>
                          {isSafetyKey && (
                            <span className="ml-2 text-[10px] text-muted">(higher = better)</span>
                          )}
                        </div>
                        <span
                          className="text-xs font-semibold ml-2 shrink-0"
                          style={{ color: scoreToColor(scaledScore) }}
                        >
                          {displayLabel}
                        </span>
                      </div>
                      <div className="h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${scaledScore}%`,
                            backgroundColor: scoreToColor(scaledScore),
                          }}
                        />
                      </div>
                      {subtitle && (
                        <div className="mt-1 text-[10px] text-muted italic">{subtitle}</div>
                      )}
                    </div>
                    <span className="text-[10px] text-muted w-8 text-right shrink-0">
                      {item.weight}%
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
