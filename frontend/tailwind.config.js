/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--color-background)',
        card: 'var(--color-card)',
        border: 'var(--color-border)',
        muted: 'var(--color-muted)',
        'score-green': '#22c55e',
        'score-blue': '#3b82f6',
        'score-amber': '#f59e0b',
        'score-red': '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
