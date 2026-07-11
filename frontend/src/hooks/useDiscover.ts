import { useState, useCallback } from 'react'
import client from '../api/client'
import type { ScanResult, CompareResult } from '../types'

export function useDiscover() {
  const [scanResults, setScanResults] = useState<ScanResult[]>([])
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback(async (index: string, topN: number, minScore: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get('/discover/scan', { params: { index, top_n: topN, min_score: minScore } })
      setScanResults(res.data.results || [])
    } catch (e: unknown) {
      setError('Scan failed')
    } finally {
      setLoading(false)
    }
  }, [])

  const compare = useCallback(async (symbols: string[]) => {
    setLoading(true)
    setError(null)
    try {
      const res = await client.get('/discover/compare', { params: { symbols: symbols.join(',') } })
      setCompareResult(res.data)
    } catch (e: unknown) {
      setError('Compare failed')
    } finally {
      setLoading(false)
    }
  }, [])

  return { scanResults, compareResult, loading, error, scan, compare }
}
