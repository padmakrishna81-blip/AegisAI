import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthUser {
  username: string
  full_name: string
  role: 'admin' | 'user'
  permissions: string[]  // e.g. ['covered_calls', 'market', 'ai_insights']
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  isAuthenticated: boolean
  login: (token: string, user: AuthUser) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: (token, user) => {
        localStorage.setItem('aegis_token', token)
        localStorage.setItem('aegis_user', JSON.stringify(user))
        set({ token, user, isAuthenticated: true })
      },

      logout: () => {
        localStorage.removeItem('aegis_token')
        localStorage.removeItem('aegis_user')
        set({ token: null, user: null, isAuthenticated: false })
      },
    }),
    { name: 'aegisai-auth' }
  )
)

// Helper: check if the current user has a specific permission
export function hasPermission(user: AuthUser | null, perm: string): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions?.includes(perm) ?? false
}

