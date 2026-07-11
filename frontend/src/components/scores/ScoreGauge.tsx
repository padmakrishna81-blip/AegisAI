import { scoreToColor, scoreToLabel } from '../../utils/formatters'

interface ScoreGaugeProps {
  score: number
  label: string
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
}

export default function ScoreGauge({ score, label, size = 'md', onClick }: ScoreGaugeProps) {
  const color = scoreToColor(score)
  const qualityLabel = scoreToLabel(score)

  const sizes = { sm: 64, md: 88, lg: 120 }
  const dim = sizes[size]
  const radius = dim / 2 - 8
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - score / 100)
  const fontSize = { sm: 'text-base', md: 'text-xl', lg: 'text-3xl' }

  return (
    <div
      className={`flex flex-col items-center gap-1 ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
      onClick={onClick}
    >
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="-rotate-90">
          <circle
            cx={dim / 2}
            cy={dim / 2}
            r={radius}
            fill="none"
            stroke="#334155"
            strokeWidth="6"
          />
          <circle
            cx={dim / 2}
            cy={dim / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`font-bold ${fontSize[size]}`} style={{ color }}>
            {score}
          </span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-xs text-white font-medium">{label}</div>
        <div className="text-[10px] text-muted">{qualityLabel}</div>
      </div>
    </div>
  )
}
