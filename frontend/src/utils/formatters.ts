// Utility functions for formatting and score helpers

export const formatINR = (value: number): string => {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)} Cr`
  if (value >= 100000) return `₹${(value / 100000).toFixed(2)} L`
  if (value >= 1000) return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  return `₹${value.toFixed(2)}`
}

export const formatINRCompact = (value: number): string => {
  if (Math.abs(value) >= 10000000) return `₹${(value / 10000000).toFixed(1)}Cr`
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(1)}L`
  return `₹${Math.abs(value) >= 1000 ? value.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : value.toFixed(2)}`
}

export const formatPct = (value: number, decimals = 1): string => {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

export const scoreToColor = (score: number): string => {
  if (score >= 80) return '#22c55e'   // green
  if (score >= 65) return '#3b82f6'   // blue
  if (score >= 50) return '#f59e0b'   // amber
  return '#ef4444'                     // red
}

export const scoreToTailwindText = (score: number): string => {
  if (score >= 80) return 'text-score-green'
  if (score >= 65) return 'text-score-blue'
  if (score >= 50) return 'text-score-amber'
  return 'text-score-red'
}

export const scoreToLabel = (score: number): string => {
  if (score >= 90) return 'Exceptional'
  if (score >= 80) return 'Strong'
  if (score >= 70) return 'Good'
  if (score >= 60) return 'Positive'
  if (score >= 50) return 'Neutral'
  if (score >= 40) return 'Weak'
  return 'Avoid'
}

export const marketModeColor = (mode: string): string => {
  switch (mode) {
    case 'STRONG BULL': return 'text-score-green bg-green-950'
    case 'BULLISH': return 'text-emerald-400 bg-emerald-950'
    case 'NEUTRAL': return 'text-score-blue bg-blue-950'
    case 'DEFENSIVE': return 'text-score-amber bg-amber-950'
    case 'CAPITAL PRESERVATION': return 'text-score-red bg-red-950'
    default: return 'text-slate-400 bg-slate-800'
  }
}

export const recommendationColor = (rec: string): string => {
  switch (rec?.toUpperCase()) {
    case 'BUY': return 'text-score-green bg-green-950 border border-green-800'
    case 'SELL': return 'text-score-red bg-red-950 border border-red-800'
    default: return 'text-score-blue bg-blue-950 border border-blue-800'
  }
}

export const starsArray = (n: number): boolean[] =>
  Array.from({ length: 5 }, (_, i) => i < n)

export const normalizeSymbol = (s: string): string => {
  const upper = s.trim().toUpperCase()
  if (upper.startsWith('^') || upper.includes('.')) return upper
  return upper + '.NS'
}

export const shortSymbol = (s: string): string =>
  s.replace('.NS', '').replace('.BO', '')
