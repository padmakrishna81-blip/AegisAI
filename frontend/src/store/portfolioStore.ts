import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Holding } from '../types'

interface PortfolioState {
  holdings: Holding[]
  monthlyTarget: number
  monthlyAchieved: number
  cashAvailable: number
  setHoldings: (h: Holding[]) => void
  setMonthlyTarget: (v: number) => void
  setMonthlyAchieved: (v: number) => void
  setCash: (v: number) => void
}

export const usePortfolioStore = create<PortfolioState>()(
  persist(
    (set) => ({
      holdings: [],
      monthlyTarget: 30000,
      monthlyAchieved: 0,
      cashAvailable: 500000,
      setHoldings: (holdings) => set({ holdings }),
      setMonthlyTarget: (monthlyTarget) => set({ monthlyTarget }),
      setMonthlyAchieved: (monthlyAchieved) => set({ monthlyAchieved }),
      setCash: (cashAvailable) => set({ cashAvailable }),
    }),
    { name: 'aegisai-portfolio' }
  )
)
