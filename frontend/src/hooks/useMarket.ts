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
      // Fetch independently so one failure doesn't blank the whole page
      const [macroRes, sectorRes] = await Promise.allSettled([
        client.get('/market/macro'),
        client.get('/market/sectors'),
      ])
      if (macroRes.status === 'fulfilled') setMacro(macroRes.value.data)
      if (sectorRes.status === 'fulfilled') setSectors(sectorRes.value.data.sectors || [])
      setLoading(false)
    }
    fetchAll()
  }, [])

  return { macro, sectors, loading }
}
