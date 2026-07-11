import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

function applyTheme(t: Theme) {
  if (t === 'light') {
    document.documentElement.classList.add('light')
  } else {
    document.documentElement.classList.remove('light')
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      setTheme: (t) => { applyTheme(t); set({ theme: t }) },
      toggle: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
        applyTheme(next)
        set({ theme: next })
      },
    }),
    { name: 'aegisai-theme', onRehydrateStorage: () => (state) => { if (state) applyTheme(state.theme) } }
  )
)
