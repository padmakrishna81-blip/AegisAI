/**
 * SmartRangeBar — reusable prediction range bar.
 *
 * Visual rules:
 *   CMP inside range:  red fill (low→CMP) + green fill (CMP→high)
 *   CMP below range:   full green bar + dotted CMP line to the left
 *   CMP above range:   full red bar + dotted CMP line to the right
 */

interface SmartRangeBarProps {
  low: number
  base: number
  high: number
  cmp: number
  label: string
  sublabel?: string          // e.g. "±100 pts range"
  biasNote?: string          // e.g. "Expected gap: -82 pts (GIFT Nifty + US + global cues)"
  biasColor?: string
}

export default function SmartRangeBar({
  low, base, high, cmp, label, sublabel, biasNote, biasColor,
}: SmartRangeBarProps) {
  const fmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 1 })

  const rangeSpan = high - low
  const basePos   = rangeSpan > 0 ? Math.max(1, Math.min(99, ((base - low) / rangeSpan) * 100)) : 50

  // Determine CMP position relative to range
  const cmpInsideLow  = cmp >= low
  const cmpInsideHigh = cmp <= high
  const cmpInside     = cmpInsideLow && cmpInsideHigh
  const cmpAbove      = cmp > high   // above range → bar red, dotted right
  const cmpBelow      = cmp < low    // below range → bar green, dotted left

  // Position of CMP clipped to bar (0–100), plus overflow percentage
  const cmpBarPos    = rangeSpan > 0 ? ((cmp - low) / rangeSpan) * 100 : 50
  const cmpClipped   = Math.max(0, Math.min(100, cmpBarPos))
  const overflowPct  = Math.abs(cmpBarPos - cmpClipped)  // how far outside (in range units %)

  // How much extra space to show the dotted extension (as % of bar width)
  // Cap extension at ~25% visual overflow so it doesn't go too far
  const extensionPx  = Math.min(overflowPct * 1.5, 28)   // visual %

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-semibold text-white">{label}</span>
        {sublabel && <span className="text-muted">{sublabel}</span>}
      </div>

      {/* Low / Base / High labels */}
      <div className="flex justify-between text-[10px] text-muted">
        <span>₹{fmt(low)}</span>
        <span className="text-white font-semibold">Base ₹{fmt(base)}</span>
        <span>₹{fmt(high)}</span>
      </div>

      {/* Bar container with overflow space for CMP outside */}
      <div className="relative"
           style={{
             paddingLeft:  cmpBelow ? `${extensionPx}%` : '0',
             paddingRight: cmpAbove ? `${extensionPx}%` : '0',
             paddingTop: '20px',  // space for CMP label above
           }}>

        {/* CMP floating label + arrow */}
        {cmpInside && (
          <div className="absolute top-0 flex flex-col items-center z-10"
               style={{
                 left: `${cmpClipped}%`,
                 transform: 'translateX(-50%)',
                 ...(cmpBelow ? { paddingLeft: `${extensionPx}%` } : {}),
               }}>
            <span className="text-[10px] font-bold text-blue-400 whitespace-nowrap bg-slate-900 px-1 rounded border border-blue-900/60">
              CMP ₹{fmt(cmp)}
            </span>
            <span className="text-blue-400 text-[9px] leading-none">▼</span>
          </div>
        )}

        {cmpBelow && (
          <div className="absolute top-0 left-0 flex flex-col items-center z-10">
            <span className="text-[10px] font-bold text-blue-400 whitespace-nowrap bg-slate-900 px-1 rounded border border-blue-900/60">
              CMP ₹{fmt(cmp)}
            </span>
            <span className="text-blue-400 text-[9px] leading-none">▼</span>
          </div>
        )}

        {cmpAbove && (
          <div className="absolute top-0 right-0 flex flex-col items-center z-10">
            <span className="text-[10px] font-bold text-blue-400 whitespace-nowrap bg-slate-900 px-1 rounded border border-blue-900/60">
              CMP ₹{fmt(cmp)}
            </span>
            <span className="text-blue-400 text-[9px] leading-none">▼</span>
          </div>
        )}

        {/* The bar row (dotted extension + main bar) */}
        <div className="flex items-center gap-0" style={{ height: '16px' }}>

          {/* Left dotted extension when CMP is below range */}
          {cmpBelow && (
            <div className="flex-shrink-0 h-full flex items-center" style={{ width: `${extensionPx}%` }}>
              <div className="w-full h-2 border-t-2 border-dashed border-blue-400/60 rounded-l-full" />
              <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0 -ml-1" />
            </div>
          )}

          {/* Main bar */}
          <div className="relative flex-1 h-full bg-slate-700 rounded-full overflow-hidden">
            {/* Base marker */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white/80 z-10"
                 style={{ left: `${basePos}%` }} />

            {cmpInside ? (
              <>
                {/* Red: low → CMP (already fallen below this, or started above) */}
                <div className="absolute top-0 bottom-0 bg-red-700/70"
                     style={{ left: 0, width: `${cmpClipped}%` }} />
                {/* Green: CMP → high (upside remaining) */}
                <div className="absolute top-0 bottom-0 bg-green-800/70"
                     style={{ left: `${cmpClipped}%`, right: 0 }} />
                {/* CMP marker on bar */}
                <div className="absolute top-0 bottom-0 w-1.5 bg-blue-400 rounded z-20"
                     style={{ left: `${cmpClipped}%`, transform: 'translateX(-50%)' }} />
              </>
            ) : cmpBelow ? (
              /* CMP below range → full bar green (market expected to rise) */
              <div className="absolute inset-0 bg-green-800/70" />
            ) : (
              /* CMP above range → full bar red (market may pull back) */
              <div className="absolute inset-0 bg-red-700/70" />
            )}
          </div>

          {/* Right dotted extension when CMP is above range */}
          {cmpAbove && (
            <div className="flex-shrink-0 h-full flex items-center" style={{ width: `${extensionPx}%` }}>
              <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0 -mr-1" />
              <div className="w-full h-2 border-t-2 border-dashed border-blue-400/60 rounded-r-full" />
            </div>
          )}
        </div>
      </div>

      {/* Footer: Bear / bias / Bull */}
      <div className="flex justify-between text-[9px] mt-0.5">
        <span className="text-muted">Bear</span>
        {biasNote && (
          <span className={biasColor || 'text-muted'}>{biasNote}</span>
        )}
        <span className="text-muted">Bull</span>
      </div>
    </div>
  )
}
