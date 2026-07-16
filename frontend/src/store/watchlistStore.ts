import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface WatchlistItem {
  symbol: string
  company_name: string
  added_at: string
  last_score?: number
  last_recommendation?: string
  notes?: string
  prediction_enabled?: boolean  // opt-in to next-session prediction tracking
}

interface WatchlistState {
  items: WatchlistItem[]
  add: (item: Omit<WatchlistItem, 'added_at'>) => void
  remove: (symbol: string) => void
  update: (symbol: string, patch: Partial<WatchlistItem>) => void
  has: (symbol: string) => boolean
  clear: () => void
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => ({
      items: [],

      add: (item) => {
        if (get().has(item.symbol)) return
        set((s) => ({
          items: [
            ...s.items,
            { ...item, added_at: new Date().toISOString() },
          ],
        }))
      },

      remove: (symbol) =>
        set((s) => ({ items: s.items.filter((i) => i.symbol !== symbol) })),

      update: (symbol, patch) =>
        set((s) => ({
          items: s.items.map((i) =>
            i.symbol === symbol ? { ...i, ...patch } : i
          ),
        })),

      has: (symbol) => get().items.some((i) => i.symbol === symbol),

      clear: () => set({ items: [] }),
    }),
    { name: 'aegisai-watchlist' }
  )
)
