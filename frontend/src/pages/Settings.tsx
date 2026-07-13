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
  const [clearing, setClearing] = useState<'anthropic' | 'openai' | null>(null)
  const { theme, setTheme } = useThemeStore()

  // Password change state
  const [currentPw, setCurrentPw]   = useState('')
  const [newPw, setNewPw]           = useState('')
  const [confirmPw, setConfirmPw]   = useState('')
  const [pwSaving, setPwSaving]     = useState(false)
  const [pwMsg, setPwMsg]           = useState<{ ok: boolean; text: string } | null>(null)

  const changePw = async () => {
    if (!currentPw || !newPw) { setPwMsg({ ok: false, text: 'Enter current and new password' }); return }
    if (newPw.length < 6)     { setPwMsg({ ok: false, text: 'New password must be at least 6 characters' }); return }
    if (newPw !== confirmPw)  { setPwMsg({ ok: false, text: 'Passwords do not match' }); return }
    setPwSaving(true); setPwMsg(null)
    try {
      await client.post('/auth/change-password', { current_password: currentPw, new_password: newPw })
      setPwMsg({ ok: true, text: 'Password changed successfully' })
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setPwMsg({ ok: false, text: msg || 'Failed to change password' })
    } finally { setPwSaving(false) }
  }

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

  // Clear a specific API key — sends empty string with overwrite flag
  const clearKey = async (which: 'anthropic' | 'openai') => {
    if (!window.confirm(`Clear the ${which === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key? AI features will fall back to rule-based.`)) return
    setClearing(which)
    try {
      const body: Record<string, string> = {
        llm_provider: provider,
        anthropic_api_key: '',
        openai_api_key: '',
      }
      // Send a special sentinel to indicate explicit clear
      if (which === 'anthropic') body.anthropic_api_key = '__CLEAR__'
      else body.openai_api_key = '__CLEAR__'
      const res = await client.post('/settings', body)
      setSettings(res.data)
      setSaved(false)
    } catch (e) { console.error(e) }
    finally { setClearing(null) }
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
            {(['none', 'claude', 'openai'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  provider === p
                    ? p === 'none'
                      ? 'bg-slate-600 border-slate-500 text-white'
                      : 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-border text-muted hover:text-white'
                }`}
              >
                {p === 'none' ? '⊘ Rule-based' : p === 'claude' ? '◆ Claude' : '⬡ OpenAI'}
              </button>
            ))}
          </div>
          {provider === 'none' && (
            <div className="mt-2 text-xs text-slate-400 bg-slate-800 rounded-lg px-3 py-2">
              Rule-based mode: AI Insights uses scoring algorithms only. No API key needed. Save to apply.
            </div>
          )}
        </div>

        {/* API key status with Clear buttons */}
        {settings && (
          <div className="space-y-3">
            {/* Anthropic */}
            <div className={`rounded-lg p-3 border flex items-center justify-between ${settings.anthropic_configured ? 'border-green-800 bg-green-950' : 'border-border bg-slate-800'}`}>
              <div>
                <div className="text-xs text-muted">Anthropic (Claude)</div>
                <div className={`text-sm font-medium mt-0.5 ${settings.anthropic_configured ? 'text-score-green' : 'text-muted'}`}>
                  {settings.anthropic_configured ? '✓ Configured' : '✗ Not set'}
                </div>
              </div>
              {settings.anthropic_configured && (
                <button onClick={() => clearKey('anthropic')} disabled={clearing === 'anthropic'}
                  className="px-3 py-1.5 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded-lg text-xs font-medium disabled:opacity-50">
                  {clearing === 'anthropic' ? '…' : '✕ Clear Key'}
                </button>
              )}
            </div>

            {/* OpenAI */}
            <div className={`rounded-lg p-3 border flex items-center justify-between ${settings.openai_configured ? 'border-green-800 bg-green-950' : 'border-border bg-slate-800'}`}>
              <div>
                <div className="text-xs text-muted">OpenAI (GPT-4)</div>
                <div className={`text-sm font-medium mt-0.5 ${settings.openai_configured ? 'text-score-green' : 'text-muted'}`}>
                  {settings.openai_configured ? '✓ Configured' : '✗ Not set'}
                </div>
              </div>
              {settings.openai_configured && (
                <button onClick={() => clearKey('openai')} disabled={clearing === 'openai'}
                  className="px-3 py-1.5 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded-lg text-xs font-medium disabled:opacity-50">
                  {clearing === 'openai' ? '…' : '✕ Clear Key'}
                </button>
              )}
            </div>
          </div>
        )}

        {settings?.openai_configured && provider === 'openai' && (
          <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2 text-xs text-amber-300">
            ⚠ If AI Insights shows "Rule-based", your OpenAI quota may be exceeded.
            Click <strong>✕ Clear Key</strong> above to remove it and switch to Rule-based, or add credits at platform.openai.com.
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted block mb-1.5">Set New Anthropic API Key</label>
            <input
              type="password" value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-... (leave blank to keep current)"
              className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1.5">Set New OpenAI API Key</label>
            <input
              type="password" value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-... (leave blank to keep current)"
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

      {/* ── Change Password ── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="text-sm font-semibold text-white">Change Password</div>
        <div className="space-y-3">
          {[
            { label: 'Current Password', val: currentPw, setter: setCurrentPw },
            { label: 'New Password (min 6 chars)', val: newPw, setter: setNewPw },
            { label: 'Confirm New Password', val: confirmPw, setter: setConfirmPw },
          ].map(({ label, val, setter }) => (
            <div key={label}>
              <label className="text-xs text-muted block mb-1.5">{label}</label>
              <input type="password" value={val} onChange={e => setter(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          ))}
        </div>
        {pwMsg && (
          <div className={`text-xs px-3 py-2 rounded-lg ${pwMsg.ok ? 'bg-green-950 border border-green-800 text-score-green' : 'bg-red-950 border border-red-800 text-score-red'}`}>
            {pwMsg.ok ? '✓' : '✗'} {pwMsg.text}
          </div>
        )}
        <button onClick={changePw} disabled={pwSaving}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
          {pwSaving ? 'Changing…' : 'Change Password'}
        </button>
      </div>
    </div>
  )
}
