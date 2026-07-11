import { scoreToColor, formatINR, starsArray, recommendationColor } from '../../utils/formatters'
import type { Verdict } from '../../types'

interface AIVerdictProps {
  verdict: Verdict
  symbol: string
  companyName: string
  currentPrice: number
  overallScore: number
}

export default function AIVerdict({ verdict, symbol, companyName, currentPrice, overallScore }: AIVerdictProps) {
  const scoreColor = scoreToColor(overallScore)
  const stars = starsArray(verdict.stars)

  return (
    <div className="bg-card rounded-xl border border-border p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xs text-muted mb-0.5">AI Investment Verdict</div>
          <div className="text-lg font-bold text-white">{companyName}</div>
          <div className="text-sm text-muted">{symbol} · ₹{currentPrice.toLocaleString('en-IN')}</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${recommendationColor(verdict.action)}`}>
            {verdict.action}
          </span>
          <div className="flex gap-0.5">
            {stars.map((filled, i) => (
              <span key={i} className={filled ? 'text-yellow-400' : 'text-slate-600'}>★</span>
            ))}
          </div>
        </div>
      </div>

      {/* Score bar */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl font-bold" style={{ color: scoreColor }}>{overallScore}</span>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted">Overall Score</span>
            <span className="text-xs text-muted">Confidence {verdict.confidence}%</span>
          </div>
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${overallScore}%`, backgroundColor: scoreColor }}
            />
          </div>
        </div>
      </div>

      {/* Entry / Target / Stop */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-slate-800 rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-muted mb-0.5">Entry Zone</div>
          <div className="text-xs font-semibold text-white">
            ₹{verdict.entry_range.low}–{verdict.entry_range.high}
          </div>
        </div>
        <div className="bg-slate-800 rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-muted mb-0.5">Target</div>
          <div className="text-xs font-semibold text-score-green">₹{verdict.target_price}</div>
        </div>
        <div className="bg-slate-800 rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-muted mb-0.5">Stop Loss</div>
          <div className="text-xs font-semibold text-score-red">₹{verdict.stop_loss}</div>
        </div>
      </div>

      {/* Reasons */}
      {verdict.reasons.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-muted mb-2">Why?</div>
          <ul className="space-y-1">
            {verdict.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                <span className="text-score-green mt-0.5">✓</span> {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Risks */}
      {verdict.risks.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2">Risks</div>
          <ul className="space-y-1">
            {verdict.risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                <span className="text-score-amber mt-0.5">⚠</span> {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {verdict.summary && (
        <p className="mt-3 text-xs text-muted italic border-t border-border pt-3">{verdict.summary}</p>
      )}

      {verdict.ai_powered && (
        <div className="mt-2 text-right">
          <span className="text-[10px] text-blue-400">◆ AI Powered</span>
        </div>
      )}
    </div>
  )
}
