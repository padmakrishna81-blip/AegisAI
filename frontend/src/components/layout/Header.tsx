import { useLocation } from 'react-router-dom'
import { marketModeColor } from '../../utils/formatters'
import type { AuthUser } from '../../store/authStore'

interface HeaderProps {
  marketMode?: string
  user?: AuthUser | null
  onLogout?: () => void
}

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/discover': 'Discover',
  '/portfolio': 'Portfolio',
  '/trade': 'Paper Trade',
  '/covered-calls': 'Covered Calls',
  '/market': 'Market Intelligence',
  '/ai-insights': 'AI Insights',
  '/settings': 'Settings',
  '/users': 'User Management',
}

export default function Header({ marketMode = 'NEUTRAL', user }: HeaderProps) {
  const location = useLocation()
  const title = pageTitles[location.pathname] || 'AegisAI'
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

  return (
    <header className="h-14 border-b border-border bg-card/50 backdrop-blur flex items-center justify-between px-6 shrink-0">
      <h1 className="text-base font-semibold text-white">{title}</h1>
      <div className="flex items-center gap-4">
        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide ${marketModeColor(marketMode)}`}>
          {marketMode}
        </span>
        <span className="text-xs text-muted">{dateStr} · {timeStr}</span>
        {user && (
          <span className="text-xs text-muted border-l border-border pl-4">
            {user.full_name}
          </span>
        )}
      </div>
    </header>
  )
}
