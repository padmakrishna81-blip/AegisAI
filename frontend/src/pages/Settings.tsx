import { useState, useEffect } from 'react'
import client from '../api/client'
import type { AppSettings } from '../types'
import { useThemeStore } from '../store/themeStore'

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [provider, setProvider] = useState('claude')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { theme, setTheme } = useThemeStore()

  useEffect(() => {
    client.get('/settings').then((r) => {
      setSettings(r.data)
      setProvider(r.data.llm_provider || 'claude')
    }).catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await client.post('/settings', {
        llm_provider: provider,
        anthropic_api_key: anthropicKey,
        openai_api_key: openaiKey,
      })
      setSettings(res.data)
      setSaved(true)
      setAnthropicKey('')
      setOpenaiKey('')
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-xl">

      {/* ── Appearance ── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="text-sm font-semibold text-white">Appearance</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-300">Theme</div>
            <div className="text-xs text-muted mt-0.5">Choose between dark (default) and light mode</div>
          </div>
          <div className="flex gap-2 bg-slate-800 rounded-xl p-1">
            {(['dark', 'light'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                  theme === t
                    ? t === 'dark'
                      ? 'bg-slate-700 text-white shadow'
                      : 'bg-white text-slate-900 shadow'
                    : 'text-muted hover:text-white'
                }`}
              >
                {t === 'dark' ? '🌙 Dark' : '☀ Light'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── AI Provider ── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div>
          <div className="text-sm font-semibold text-white mb-1">AI Provider</div>
          <p className="text-xs text-muted mb-3">
            Configure which LLM powers the AI advisor, sentiment analysis, and explanations.
          </p>
          <div className="flex gap-3">
            {['claude', 'openai'].map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  provider === p
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-border text-muted hover:text-white'
                }`}
              >
                {p === 'claude' ? '◆ Claude (Anthropic)' : '⬡ GPT-4 (OpenAI)'}
              </button>
            ))}
          </div>
        </div>

        {settings && (
          <div className="grid grid-cols-2 gap-3">
            <div className={`rounded-lg p-3 border ${settings.anthropic_configured ? 'border-green-800 bg-green-950' : 'border-border bg-slate-800'}`}>
              <div className="text-xs text-muted">Anthropic API</div>
              <div className={`text-sm font-medium mt-0.5 ${settings.anthropic_configured ? 'text-score-green' : 'text-muted'}`}>
                {settings.anthropic_configured ? '✓ Configured' : '✗ Not set'}
              </div>
            </div>
            <div className={`rounded-lg p-3 border ${settings.openai_configured ? 'border-green-800 bg-green-950' : 'border-border bg-slate-800'}`}>
              <div className="text-xs text-muted">OpenAI API</div>
              <div className={`text-sm font-medium mt-0.5 ${settings.openai_configured ? 'text-score-green' : 'text-muted'}`}>
                {settings.openai_configured ? '✓ Configured' : '✗ Not set'}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted block mb-1.5">Anthropic API Key</label>
            <input
              type="password" value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={settings?.anthropic_configured ? '••••••• (leave blank to keep current)' : 'sk-ant-...'}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1.5">OpenAI API Key</label>
            <input
              type="password" value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={settings?.openai_configured ? '••••••• (leave blank to keep current)' : 'sk-...'}
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <button
          onClick={save} disabled={saving}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

        {saved && (
          <div className="text-center text-xs text-score-green">✓ Settings saved successfully</div>
        )}
      </div>

      {/* ── About ── */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="text-sm font-semibold text-white mb-3">About Aegis AI</div>
        <div className="space-y-2 text-xs text-muted">
          <div>Platform: AI-Powered Investment Intelligence for Indian Markets</div>
          <div>Data: Yahoo Finance (live NSE/BSE data)</div>
          <div>Analysis: 6 scoring engines covering 60+ metrics</div>
          <div>Version: 1.0.0</div>
        </div>
      </div>
    </div>
  )
}
