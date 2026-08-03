import { NavLink } from 'react-router-dom'
import type { AuthUser } from '../../store/authStore'
import { hasPermission } from '../../store/authStore'

const BASE_NAV = [
  { path: '/',          label: 'Dashboard',     icon: '⬡' },
  { path: '/discover',  label: 'Discover',       icon: '⬢' },
  { path: '/portfolio', label: 'Portfolio',      icon: '⬣' },
  { path: '/settings',  label: 'Settings',       icon: '⚙' },
]

const GATED_NAV = [
  { path: '/trade',         label: 'Paper Trade',    icon: '◈', perm: 'paper_trade' },
  { path: '/covered-calls', label: 'Covered Calls',  icon: '◉', perm: 'covered_calls' },
  { path: '/wheel',         label: 'Wheel Strategy', icon: '🎡', perm: 'wheel' },
  { path: '/strategies',    label: 'Strategies',     icon: '⚡', perm: 'market' },
  { path: '/market',        label: 'Market',         icon: '◊', perm: 'market' },
  { path: '/ai-insights',   label: 'AI Insights',    icon: '◇', perm: 'ai_insights' },
]

interface SidebarProps {
  user: AuthUser | null
  onLogout: () => void
}

export default function Sidebar({ user, onLogout }: SidebarProps) {
  return (
    <aside className="w-56 min-h-screen bg-card border-r border-border flex flex-col py-6 px-3 shrink-0">
      {/* Logo */}
      <div className="px-3 mb-8">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🛡</span>
          <div>
            <div className="font-bold text-white tracking-wide text-sm">AEGIS AI</div>
            <div className="text-[10px] text-muted leading-tight">Investment Intelligence</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 flex-1">
        {BASE_NAV.map(({ path, label, icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-blue-950 text-score-blue font-medium'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`
            }
          >
            <span className="text-base">{icon}</span>
            {label}
          </NavLink>
        ))}

        {/* Gated nav items */}
        <div className="my-1 border-t border-border/50" />
        {GATED_NAV.map(({ path, label, icon, perm }) => {
          const allowed = hasPermission(user, perm)
          if (!allowed) return (
            <div key={path}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-600 cursor-not-allowed select-none"
              title={`Requires '${perm.replace('_', ' ')}' permission`}
            >
              <span className="text-base opacity-40">{icon}</span>
              <span className="opacity-40">{label}</span>
              <span className="ml-auto text-[9px] text-slate-600">🔒</span>
            </div>
          )
          return (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-950 text-score-blue font-medium'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <span className="text-base">{icon}</span>
              {label}
            </NavLink>
          )
        })}

        {/* Admin-only: Users */}
        {user?.role === 'admin' && (
          <>
            <div className="my-1 border-t border-border/50" />
            <NavLink
              to="/users"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-amber-950 text-amber-400 font-medium'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <span className="text-base">👥</span>
              Users
            </NavLink>
          </>
        )}
      </nav>

      {/* User info + logout */}
      <div className="px-3 mt-4 border-t border-border pt-4">
        {user && (
          <div className="mb-3">
            <div className="text-xs text-white font-medium truncate">{user.full_name}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] text-muted">{user.username}</span>
              {user.role === 'admin' ? (
                <span className="text-[9px] bg-amber-950 text-amber-400 px-1.5 py-0.5 rounded">admin</span>
              ) : user.permissions?.length > 0 ? (
                <span className="text-[9px] bg-blue-950 text-blue-400 px-1.5 py-0.5 rounded">{user.permissions.length} access</span>
              ) : null}
            </div>
          </div>
        )}
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted hover:bg-slate-800 hover:text-score-red transition-colors"
        >
          <span>⎋</span> Sign Out
        </button>
        <div className="text-[10px] text-muted mt-3">Protect • Analyze • Grow</div>
      </div>
    </aside>
  )
}
