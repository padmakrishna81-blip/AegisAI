import { NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import type { AuthUser } from '../../store/authStore'
import { hasMinRole, roleBadgeClass, roleLabel } from '../../store/authStore'
import client from '../../api/client'

// min_role: minimum role needed to access the route
const NAV_ITEMS = [
  // Always accessible
  { path: '/',        label: 'Dashboard',  icon: '⬡',  min_role: null },
  { path: '/market',  label: 'Market',     icon: '◊',  min_role: null },
  { path: '/discover',label: 'Discover',   icon: '⬢',  min_role: null },

  { divider: true, label: 'Paper Trading' },

  { path: '/portfolio',       label: 'Portfolio',        icon: '⬣',  min_role: 'paper_trader' },
  { path: '/holdings',        label: 'Holdings',         icon: '💼', min_role: 'paper_trader' },
  { path: '/trade',           label: 'Paper Trade',      icon: '◈',  min_role: 'paper_trader' },
  { path: '/wheel',           label: 'Wheel Strategy',   icon: '🎡', min_role: 'paper_trader' },
  { path: '/smart-wheel',     label: 'Smart Wheel V2',   icon: '⚙️', min_role: 'paper_trader' },
  { path: '/stock-trader',    label: 'AI Stock Trader',  icon: '📈', min_role: 'paper_trader' },
  { path: '/ai-insights',     label: 'AI Insights',      icon: '◇',  min_role: 'paper_trader' },
  { path: '/market-brain',    label: 'Market Brain',     icon: '🧠', min_role: 'paper_trader' },
  { path: '/covered-calls',   label: 'Covered Calls',    icon: '◉',  min_role: 'paper_trader' },

  { divider: true, label: 'Strategy Tools' },

  { path: '/strategies',       label: 'Strategies',       icon: '⚡', min_role: 'paper_trader' },
  { path: '/cushion-strangle', label: 'Cushion Strangle', icon: '🛡️', min_role: 'paper_trader' },
  { path: '/custom-strangle',  label: 'Custom Builder',   icon: '🔧', min_role: 'paper_trader' },
  { path: '/multi-builder',    label: 'Multi-Asset',      icon: '🧩', min_role: 'paper_trader' },
  { path: '/strategy-monitor', label: 'Strategy Monitor', icon: '📡', min_role: 'paper_trader' },

  { divider: true, label: 'Live Trading' },

  { path: '/broker-portfolio', label: 'Broker Portfolio', icon: '🏦', min_role: 'live_trader' },

  { path: '/settings', label: 'Settings', icon: '⚙', min_role: null },
] as const

type NavItem = {
  path: string
  label: string
  icon: string
  min_role: 'paper_trader' | 'live_trader' | null
} | { divider: true; label: string }

interface SidebarProps {
  user: AuthUser | null
  onLogout: () => void
}

export default function Sidebar({ user, onLogout }: SidebarProps) {
  const [alertCount, setAlertCount] = useState(0)
  const [collapsed, setCollapsed]   = useState(false)

  useEffect(() => {
    const fetch = () => {
      client.get('/wheel/agent/monitor/alerts')
        .then(r => setAlertCount(r.data.count ?? 0))
        .catch(() => {})
    }
    fetch()
    const id = setInterval(fetch, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <aside className={`h-screen bg-card border-r border-border flex flex-col py-4 shrink-0 transition-all duration-200
      ${collapsed ? 'w-14 px-1' : 'w-56 px-3'}`}>

      {/* Logo + collapse toggle */}
      <div className={`mb-6 flex items-center ${collapsed ? 'justify-center' : 'px-2 justify-between'}`}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <span className="text-2xl">🛡</span>
            <div>
              <div className="font-bold text-white tracking-wide text-sm">AEGIS AI</div>
              <div className="text-[10px] text-muted">Trading Intelligence</div>
            </div>
          </div>
        )}
        {collapsed && <span className="text-2xl">🛡</span>}
        {!collapsed && (
          <button onClick={() => setCollapsed(true)}
            className="text-slate-600 hover:text-white text-xs p-1 rounded hover:bg-slate-800 transition ml-1"
            title="Collapse sidebar">
            ◀
          </button>
        )}
      </div>

      {collapsed && (
        <button onClick={() => setCollapsed(false)}
          className="mx-auto text-slate-600 hover:text-white text-xs p-1 rounded hover:bg-slate-800 transition mb-2"
          title="Expand sidebar">
          ▶
        </button>
      )}

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 flex-1 overflow-y-auto min-h-0">
        {(NAV_ITEMS as unknown as NavItem[]).map((item, idx) => {
          if ('divider' in item) {
            if (collapsed) return <div key={idx} className="my-1 border-t border-border/40" />
            return (
              <div key={idx} className="mt-3 mb-1 px-2">
                <div className="text-[9px] uppercase tracking-widest text-muted/60 font-semibold">{item.label}</div>
              </div>
            )
          }

          const allowed = item.min_role === null || hasMinRole(user, item.min_role)
          const isLocked = !allowed

          if (isLocked) {
            return (
              <NavLink key={item.path} to={item.path}
                title={collapsed ? item.label : undefined}
                className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-800/40 transition-colors group">
                <span className="text-base opacity-40 shrink-0">{item.icon}</span>
                {!collapsed && (
                  <>
                    <span className="opacity-40 text-xs truncate flex-1">{item.label}</span>
                    <span className="text-[10px] opacity-60">🔒</span>
                  </>
                )}
              </NavLink>
            )
          }

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-950 text-blue-400 font-medium'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <span className="text-base shrink-0">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="truncate flex-1 text-xs">{item.label}</span>
                  {item.path === '/strategy-monitor' && alertCount > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 bg-amber-600 text-white rounded-full font-bold shrink-0">
                      {alertCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          )
        })}

        {/* Admin-only */}
        {user?.role === 'admin' && (
          <>
            <div className={`${collapsed ? 'my-1 border-t border-border/40' : 'mt-2 mb-1 px-2'}`}>
              {!collapsed && <div className="text-[9px] uppercase tracking-widest text-amber-600/60 font-semibold">Admin</div>}
            </div>
            <NavLink to="/users" title={collapsed ? 'Users' : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-amber-950 text-amber-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`
              }>
              <span className="text-base shrink-0">👥</span>
              {!collapsed && <span className="text-xs">Users</span>}
            </NavLink>
          </>
        )}
      </nav>

      {/* User info + logout */}
      {!collapsed && (
        <div className="px-2 mt-3 pt-3 border-t border-border">
          {user && (
            <div className="mb-3">
              <div className="text-xs text-white font-medium truncate">{user.full_name}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-[10px] text-muted">{user.username}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${roleBadgeClass(user.role)}`}>
                  {roleLabel(user.role)}
                </span>
              </div>
            </div>
          )}
          <button onClick={onLogout}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted hover:bg-slate-800 hover:text-red-400 transition-colors">
            <span>⎋</span> Sign Out
          </button>
        </div>
      )}
      {collapsed && user && (
        <button onClick={onLogout} title="Sign Out"
          className="mx-auto p-2 rounded-lg text-muted hover:text-red-400 hover:bg-slate-800 transition-colors text-sm mt-2">
          ⎋
        </button>
      )}
    </aside>
  )
}
