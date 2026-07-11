import { useState, useCallback } from 'react'
import client from '../api/client'
import type { StockAnalysis } from '../types'

export function useStock() {
  const [data, setData] = useState<StockAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const analyze = useCallback(async (symbol: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get(`/analyze/${symbol}`)
      setData(res.data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }, [])

  const quickAnalyze = useCallback(async (symbol: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get(`/analyze/${symbol}/quick`)
      setData(res.data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Quick analysis failed')
    } finally {
      setLoading(false)
    }
  }, [])

  return { data, loading, error, analyze, quickAnalyze }
}
