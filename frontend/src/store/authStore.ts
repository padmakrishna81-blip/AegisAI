import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UserRole = 'admin' | 'live_trader' | 'paper_trader' | 'viewer'

export interface AuthUser {
  username:   string
  email:      string
  full_name:  string
  role:       UserRole
  permissions: string[]
}

interface AuthState {
  user:            AuthUser | null
  token:           string | null
  refreshToken:    string | null
  isAuthenticated: boolean
  _hasHydrated:    boolean
  setHasHydrated:  (v: boolean) => void
  login:           (token: string, user: AuthUser, refreshToken?: string) => void
  logout:          () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user:            null,
      token:           null,
      refreshToken:    null,
      isAuthenticated: false,
      _hasHydrated:    false,
      setHasHydrated:  (v) => set({ _hasHydrated: v }),

      login: (token, user, refreshToken) => {
        localStorage.setItem('aegis_token', token)
        localStorage.setItem('aegis_user', JSON.stringify(user))
        if (refreshToken) localStorage.setItem('aegis_refresh', refreshToken)
        set({ token, user, refreshToken: refreshToken ?? null, isAuthenticated: true })
      },

      logout: () => {
        localStorage.removeItem('aegis_token')
        localStorage.removeItem('aegis_user')
        localStorage.removeItem('aegis_refresh')
        set({ token: null, user: null, refreshToken: null, isAuthenticated: false })
      },
    }),
    {
      name: 'aegisai-auth',
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true)
      },
    }
  )
)

// ── Role helpers ───────────────────────────────────────────────────────────────

const ROLE_LEVEL: Record<UserRole, number> = {
  viewer:       0,
  paper_trader: 1,
  live_trader:  2,
  admin:        99,
}

/** True if the user has at least `minRole` level of access. */
export function hasMinRole(user: AuthUser | null, minRole: UserRole): boolean {
  if (!user) return false
  return (ROLE_LEVEL[user.role] ?? 0) >= ROLE_LEVEL[minRole]
}

/** True if the user has exactly one of the given roles (or is admin). */
export function hasRole(user: AuthUser | null, ...roles: UserRole[]): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return roles.includes(user.role)
}

/** Legacy permission string check (kept for backward compatibility). */
export function hasPermission(user: AuthUser | null, perm: string): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions?.includes(perm) ?? false
}

/** Human-readable role label. */
export function roleLabel(role: UserRole | undefined): string {
  const labels: Record<UserRole, string> = {
    viewer:       'Viewer',
    paper_trader: 'Paper Trader',
    live_trader:  'Live Trader',
    admin:        'Administrator',
  }
  return labels[role ?? 'viewer'] ?? role ?? ''
}

/** Badge colour class for the role. */
export function roleBadgeClass(role: UserRole | undefined): string {
  const classes: Record<UserRole, string> = {
    viewer:       'bg-slate-700 text-slate-300',
    paper_trader: 'bg-blue-900/60 text-blue-300',
    live_trader:  'bg-emerald-900/60 text-emerald-300',
    admin:        'bg-amber-900/60 text-amber-300',
  }
  return classes[role ?? 'viewer'] ?? 'bg-slate-700 text-slate-300'
}
