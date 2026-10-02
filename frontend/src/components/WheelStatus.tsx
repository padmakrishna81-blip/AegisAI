// Animated gear wheel with 3 states: green (smooth spin), amber (wobble), red (shake+pulse)

const GEAR_PATH = `
  M 50 18 L 53 10 L 47 10 Z
  M 50 82 L 47 90 L 53 90 Z
  M 18 50 L 10 47 L 10 53 Z
  M 82 50 L 90 53 L 90 47 Z
  M 26 26 L 20 20 L 24 24 Z
  M 74 26 L 80 20 L 76 24 Z
  M 26 74 L 20 80 L 24 76 Z
  M 74 74 L 80 80 L 76 76 Z
`

const COLORS = {
  green: { fill: '#22c55e', glow: '#16a34a', ring: '#bbf7d0' },
  amber: { fill: '#f59e0b', glow: '#d97706', ring: '#fef3c7' },
  red:   { fill: '#ef4444', glow: '#dc2626', ring: '#fee2e2' },
}

const STATUS_LABEL = {
  green: 'WHEEL rotating smoothly',
  amber: 'WHEEL shaking — monitor closely',
  red:   'WHEEL may collapse — take action!',
}

interface Props {
  status: 'green' | 'amber' | 'red'
  size?: number
  showLabel?: boolean
  mtm?: number
}

export default function WheelStatus({ status, size = 64, showLabel = true, mtm }: Props) {
  const c = COLORS[status]

  const animClass =
    status === 'green' ? 'animate-wheel-spin' :
    status === 'amber' ? 'animate-wheel-wobble' :
    'animate-wheel-shake'

  return (
    <div className="flex flex-col items-center gap-1.5">
      <style>{`
        @keyframes wheel-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes wheel-wobble {
          0%, 100% { transform: rotate(0deg); }
          20%      { transform: rotate(14deg); }
          40%      { transform: rotate(-10deg); }
          60%      { transform: rotate(8deg); }
          80%      { transform: rotate(-6deg); }
        }
        @keyframes wheel-shake {
          0%, 100% { transform: rotate(0deg) scale(1); }
          15%      { transform: rotate(22deg) scale(1.05); }
          30%      { transform: rotate(-18deg) scale(1.05); }
          45%      { transform: rotate(14deg) scale(1.03); }
          60%      { transform: rotate(-10deg) scale(1.03); }
          75%      { transform: rotate(6deg)  scale(1.01); }
        }
        @keyframes wheel-pulse-ring {
          0%, 100% { opacity: 0.15; r: 44; }
          50%      { opacity: 0.55; r: 48; }
        }
        .animate-wheel-spin   { animation: wheel-spin   3s linear infinite; transform-origin: 50% 50%; }
        .animate-wheel-wobble { animation: wheel-wobble 0.6s ease-in-out infinite; transform-origin: 50% 50%; }
        .animate-wheel-shake  { animation: wheel-shake  0.35s ease-in-out infinite; transform-origin: 50% 50%; }
        .wheel-pulse-ring     { animation: wheel-pulse-ring 0.8s ease-in-out infinite; }
      `}</style>

      <svg width={size} height={size} viewBox="0 0 100 100">
        {/* Glow ring — pulses on red */}
        {status === 'red' && (
          <circle cx="50" cy="50" r="44" fill="none"
            stroke={c.ring} strokeWidth="3" className="wheel-pulse-ring" />
        )}
        {/* Ambient ring */}
        <circle cx="50" cy="50" r="42" fill="none"
          stroke={c.ring} strokeWidth="1" opacity="0.2" />

        {/* Rotating gear group */}
        <g className={animClass}>
          {/* Outer gear teeth — 8 rectangles rotated */}
          {Array.from({ length: 8 }).map((_, i) => (
            <rect key={i}
              x="46" y="6" width="8" height="12" rx="2"
              fill={c.fill}
              transform={`rotate(${i * 45} 50 50)`}
            />
          ))}
          {/* Outer gear ring */}
          <circle cx="50" cy="50" r="34" fill={c.fill} opacity="0.15" />
          <circle cx="50" cy="50" r="34" fill="none" stroke={c.fill} strokeWidth="6" />
          {/* Inner spokes */}
          {Array.from({ length: 6 }).map((_, i) => (
            <line key={i}
              x1="50" y1="22" x2="50" y2="34"
              stroke={c.fill} strokeWidth="4" strokeLinecap="round"
              transform={`rotate(${i * 60} 50 50)`}
            />
          ))}
          {/* Centre hub */}
          <circle cx="50" cy="50" r="10" fill={c.glow} />
          <circle cx="50" cy="50" r="5"  fill="#0f172a" />
        </g>
      </svg>

      {showLabel && (
        <div className="text-center space-y-0.5">
          <div className={`text-xs font-semibold ${
            status === 'green' ? 'text-emerald-400' :
            status === 'amber' ? 'text-amber-400' :
            'text-red-400'
          }`}>
            {STATUS_LABEL[status]}
          </div>
          {mtm !== undefined && (
            <div className={`text-[11px] font-mono ${
              mtm >= 0 ? 'text-emerald-400' : mtm >= -6000 ? 'text-slate-300' :
              mtm >= -10000 ? 'text-amber-400' : 'text-red-400'
            }`}>
              MTM: {mtm >= 0 ? '+' : ''}₹{Math.abs(mtm).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
