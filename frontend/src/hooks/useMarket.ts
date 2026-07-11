import { useState, useEffect } from 'react'
import client from '../api/client'
import type { MacroResult } from '../types'

export function useMarket() {
  const [macro, setMacro] = useState<MacroResult | null>(null)
  const [sectors, setSectors] = useState<{ sector: string; score: number }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true)
      try {
        const [macroRes, sectorRes] = await Promise.all([
          client.get('/market/macro'),
          client.get('/market/sectors'),
        ])
        setMacro(macroRes.data)
        setSectors(sectorRes.data.sectors || [])
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    fetchAll()
  }, [])

  return { macro, sectors, loading }
}
