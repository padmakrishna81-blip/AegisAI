import { useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import type { Portfolio, Holding } from '../types'
import { usePortfolioStore } from '../store/portfolioStore'

export function usePortfolio() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(false)
  const { setHoldings } = usePortfolioStore()

  const fetchPortfolio = useCallback(async () => {
    setLoading(true)
    try {
      const res = await client.get('/portfolio')
      setPortfolio(res.data)
      setHoldings(res.data.holdings)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [setHoldings])

  const addHolding = useCallback(async (symbol: string, quantity: number, avg_price: number) => {
    await client.post('/portfolio/holding', { symbol, quantity, avg_price })
    fetchPortfolio()
  }, [fetchPortfolio])

  const removeHolding = useCallback(async (id: string) => {
    await client.delete(`/portfolio/holding/${id}`)
    fetchPortfolio()
  }, [fetchPortfolio])

  useEffect(() => { fetchPortfolio() }, [fetchPortfolio])

  return { portfolio, loading, fetchPortfolio, addHolding, removeHolding }
}
