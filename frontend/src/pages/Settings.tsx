import React, { useState, useEffect } from 'react'
import client from '../api/client'
import type { AppSettings, BrokerStatus } from '../types'
import { useThemeStore } from '../store/themeStore'

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [provider, setProvider] = useState('claude')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [groqKey, setGroqKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState<'anthropic' | 'openai' | 'groq' | null>(null)
  const [testingLlm, setTestingLlm] = useState(false)
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const { theme, setTheme } = useThemeStore()

  // Broker state
  const [brokerStatus, setBrokerStatus]     = useState<BrokerStatus>({})
  const [aoApiKey, setAoApiKey]             = useState('')
  const [aoClientId, setAoClientId]         = useState('')
  const [aoPassword, setAoPassword]         = useState('')
  const [aoTotpSecret, setAoTotpSecret]     = useState('')
  const [kotakConsKey, setKotakConsKey]     = useState('')
  const [kotakConsSec, setKotakConsSec]     = useState('')
  const [kotakMobile, setKotakMobile]       = useState('')
  const [kotakPassword, setKotakPassword]   = useState('')
  const [kotakMpin, setKotakMpin]           = useState('')
  const [brokerSaving, setBrokerSaving]     = useState<'angelone' | 'kotak' | null>(null)
  const [brokerConnecting, setBrokerConnecting] = useState<'angelone' | 'kotak' | null>(null)
  const [brokerMsg, setBrokerMsg]           = useState<Record<string, { ok: boolean; text: string }>>({})

  // Password change state
  const [currentPw, setCurrentPw]   = useState('')
  const [newPw, setNewPw]           = useState('')
  const [confirmPw, setConfirmPw]   = useState('')
  const [pwSaving, setPwSaving]     = useState(false)
  const [pwMsg, setPwMsg]           = useState<{ ok: boolean; text: string } | null>(null)

  const saveBrokerCreds = async (broker: 'angelone' | 'kotak') => {
    setBrokerSaving(broker)
    setBrokerMsg(m => ({ ...m, [broker]: { ok: false, text: '' } }))
    const creds = broker === 'angelone'
      ? { api_key: aoApiKey, client_id: aoClientId, password: aoPassword, totp_secret: aoTotpSecret }
      : { consumer_key: kotakConsKey, consumer_secret: kotakConsSec, mobile_number: kotakMobile, password: kotakPassword, mpin: kotakMpin }
    // strip empty strings so we don't overwrite existing values with blank
    const filtered = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim()))
    try {
      await client.post('/broker/save-credentials', { broker, creds: filtered })
      setBrokerMsg(m => ({ ...m, [broker]: { ok: true, text: 'Credentials saved' } }))
      // refresh status so badge updates and Connect Now becomes active
      client.get('/broker/status').then(r => setBrokerStatus(r.data)).catch(() => {})
      // clear input fields
      if (broker === 'angelone') { setAoApiKey(''); setAoClientId(''); setAoPassword(''); setAoTotpSecret('') }
      else { setKotakConsKey(''); setKotakConsSec(''); setKotakMobile(''); setKotakPassword(''); setKotakMpin('') }
    } catch {
      setBrokerMsg(m => ({ ...m, [broker]: { ok: false, text: 'Save failed' } }))
    } finally { setBrokerSaving(null) }
  }

  const connectBroker = async (broker: 'angelone' | 'kotak') => {
    setBrokerConnecting(broker)
    setBrokerMsg(m => ({ ...m, [broker]: { ok: false, text: '' } }))
    try {
      const r = await client.post('/broker/connect', { broker })
      setBrokerMsg(m => ({ ...m, [broker]: { ok: true, text: r.data.message || 'Connected' } }))
      const s = await client.get('/broker/status')
      setBrokerStatus(s.data)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Connection failed'
      setBrokerMsg(m => ({ ...m, [broker]: { ok: false, text: msg } }))
    } finally { setBrokerConnecting(null) }
  }

  const disconnectBroker = async (broker: 'angelone' | 'kotak') => {
    try {
      await client.delete(`/broker/disconnect/${broker}`)
      const s = await client.get('/broker/status')
      setBrokerStatus(s.data)
    } catch { /* ignore */ }
  }

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
    client.get('/broker/status').then(r => setBrokerStatus(r.data)).catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    setLlmTestResult(null)
    try {
      const res = await client.post('/settings', {
        llm_provider: provider,
        anthropic_api_key: anthropicKey,
        openai_api_key: openaiKey,
        groq_api_key: groqKey,
      })
      setSettings(res.data)
      setSaved(true)
      setAnthropicKey('')
      setOpenaiKey('')
      setGroqKey('')
      // Auto-test the key so the user gets immediate feedback
      if (res.data.llm_ready) {
        try {
          setTestingLlm(true)
          const tr = await client.post('/settings/test-llm', {})
          if (tr.data.ok) {
            setLlmTestResult({ ok: true, text: `Connected — ${(tr.data.provider as string)?.toUpperCase()} responded` })
          } else {
            setLlmTestResult({ ok: false, text: tr.data.error || 'LLM test failed — check your API key' })
          }
        } catch {
          setLlmTestResult({ ok: false, text: 'Could not reach backend — check logs' })
        } finally {
          setTestingLlm(false)
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  const testLlm = async () => {
    setTestingLlm(true)
    setLlmTestResult(null)
    try {
      const res = await client.post('/settings/test-llm', {})
      if (res.data.ok) {
        setLlmTestResult({ ok: true, text: `Connected — ${res.data.provider?.toUpperCase()} responded` })
      } else {
        setLlmTestResult({ ok: false, text: res.data.error || 'LLM test failed' })
      }
    } catch {
      setLlmTestResult({ ok: false, text: 'Request failed — check backend logs' })
    } finally {
      setTestingLlm(false)
    }
  }

  // Clear a specific API key — sends empty string with overwrite flag
  const clearKey = async (which: 'anthropic' | 'openai' | 'groq') => {
    const label = which === 'anthropic' ? 'Anthropic' : which === 'openai' ? 'OpenAI' : 'Groq'
    if (!window.confirm(`Clear the ${label} API key? AI features will fall back to rule-based.`)) return
    setClearing(which)
    try {
      const body: Record<string, string> = {
        llm_provider: provider,
        anthropic_api_key: '',
        openai_api_key: '',
        groq_api_key: '',
      }
      if (which === 'anthropic') body.anthropic_api_key = '__CLEAR__'
      else if (which === 'openai') body.openai_api_key = '__CLEAR__'
      else body.groq_api_key = '__CLEAR__'
      const res = await client.post('/settings', body)
      setSettings(res.data)
      setSaved(false)
    } catch (e) { console.error(e) }
    finally { setClearing(null) }
  }

  return (
    <div className="p-6 flex gap-6 items-start min-h-full">
    {/* ── Left column: all settings forms ── */}
    <div className="flex-1 min-w-0 max-w-xl space-y-6">

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
          <div className="flex gap-2 flex-wrap">
            {(['none', 'claude', 'openai', 'groq'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  provider === p
                    ? p === 'none'
                      ? 'bg-slate-600 border-slate-500 text-white'
                      : 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-border text-muted hover:text-white'
                }`}
              >
                {p === 'none' ? '⊘ Rule-based' : p === 'claude' ? '◆ Claude' : p === 'openai' ? '⬡ OpenAI' : '⚡ Groq'}
              </button>
            ))}
          </div>
          {provider === 'none' && (
            <div className="mt-2 text-xs text-slate-400 bg-slate-800 rounded-lg px-3 py-2">
              Rule-based mode: AI Insights uses scoring algorithms only. No API key needed. Save to apply.
            </div>
          )}
          {provider === 'groq' && (
            <div className="mt-2 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-800/40 rounded-lg px-3 py-2">
              ⚡ Groq runs <strong>llama-3.3-70b-versatile</strong> — 3–10× faster than GPT-4o, generous free tier.
              Get a key at <span className="font-mono">console.groq.com</span>.
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

            {/* Groq */}
            <div className={`rounded-lg p-3 border flex items-center justify-between ${settings.groq_configured ? 'border-green-800 bg-green-950' : 'border-border bg-slate-800'}`}>
              <div>
                <div className="text-xs text-muted">Groq (Llama 3.3 70B)</div>
                <div className={`text-sm font-medium mt-0.5 ${settings.groq_configured ? 'text-score-green' : 'text-muted'}`}>
                  {settings.groq_configured ? '✓ Configured' : '✗ Not set'}
                </div>
              </div>
              {settings.groq_configured && (
                <button onClick={() => clearKey('groq')} disabled={clearing === 'groq'}
                  className="px-3 py-1.5 bg-red-950 border border-red-800 text-score-red hover:bg-red-900 rounded-lg text-xs font-medium disabled:opacity-50">
                  {clearing === 'groq' ? '…' : '✕ Clear Key'}
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
          <div>
            <label className="text-xs text-muted block mb-1.5">Set New Groq API Key</label>
            <input
              type="password" value={groqKey}
              onChange={(e) => setGroqKey(e.target.value)}
              placeholder="gsk_... (leave blank to keep current)"
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
          <div className="space-y-2">
            <div className="text-center text-xs text-score-green">✓ Settings saved successfully</div>
            <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800/40 rounded-lg px-3 py-2">
              After changing the LLM key, click <strong>Test Connection</strong> to verify it works, then go to <strong>AI Trader → Reports</strong> and click <strong>+ Generate</strong> to regenerate any reports that showed an error.
            </div>
          </div>
        )}

        {settings?.llm_ready && (
          <button
            onClick={testLlm} disabled={testingLlm}
            className="w-full py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors border border-border"
          >
            {testingLlm ? 'Testing…' : '⚡ Test Connection'}
          </button>
        )}

        {llmTestResult && (
          <div className={`text-xs rounded-lg px-3 py-2 border ${llmTestResult.ok ? 'text-score-green bg-green-950 border-green-800' : 'text-score-red bg-red-950 border-red-800'}`}>
            {llmTestResult.ok ? '✓' : '✗'} {llmTestResult.text}
          </div>
        )}
      </div>

      {/* ── Broker Connections ── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-5">
        <div>
          <div className="text-sm font-semibold text-white mb-1">Broker Connections</div>
          <p className="text-xs text-muted">
            Connect your trading account to enable live portfolio, real-time funds, and automated order placement.
          </p>
        </div>

        {/* Angel One */}
        {(() => {
          const s = brokerStatus.angelone
          const msg = brokerMsg.angelone
          return (
            <div className="border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-white">Angel One SmartAPI</span>
                  {s?.connected
                    ? <span className="text-[10px] px-1.5 py-0.5 bg-green-950 border border-green-800 text-score-green rounded">● Connected</span>
                    : s?.configured
                      ? <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 border border-border text-muted rounded">○ Not connected</span>
                      : <span className="text-[10px] px-1.5 py-0.5 bg-amber-950/40 border border-amber-800/40 text-amber-400 rounded">○ Not configured</span>}
                </div>
                {s?.connected && (
                  <button onClick={() => disconnectBroker('angelone')}
                    className="text-[10px] px-2 py-1 bg-red-950/50 border border-red-800/50 text-score-red hover:bg-red-900/70 rounded">
                    Disconnect
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'API Key', val: aoApiKey, setter: setAoApiKey, placeholder: 'From Angel One app' },
                  { label: 'Client ID', val: aoClientId, setter: setAoClientId, placeholder: 'e.g. A123456' },
                  { label: 'Login Password', val: aoPassword, setter: setAoPassword, placeholder: '••••••••' },
                  { label: 'TOTP Secret (base32)', val: aoTotpSecret, setter: setAoTotpSecret, placeholder: 'From QR setup' },
                ].map(({ label, val, setter, placeholder }) => (
                  <div key={label}>
                    <label className="text-[10px] text-muted block mb-1">{label}</label>
                    <input type="password" value={val} onChange={e => setter(e.target.value)}
                      placeholder={placeholder}
                      className="w-full bg-slate-800 border border-border rounded-lg px-2.5 py-2 text-xs text-white placeholder-muted focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-slate-500">
                TOTP Secret is the base32 key from Angel One's 2FA QR code (not the 6-digit code). Required for automated trading.
              </div>
              <div className="flex gap-2">
                <button onClick={() => saveBrokerCreds('angelone')} disabled={brokerSaving === 'angelone'}
                  className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                  {brokerSaving === 'angelone' ? 'Saving…' : '💾 Save'}
                </button>
                <button onClick={() => connectBroker('angelone')} disabled={brokerConnecting === 'angelone' || !s?.configured}
                  className="px-4 py-1.5 bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                  {brokerConnecting === 'angelone' ? 'Connecting…' : '⚡ Connect Now'}
                </button>
              </div>
              {msg?.text && (
                <div className={`text-[10px] px-2 py-1 rounded ${msg.ok ? 'text-score-green' : 'text-score-red'}`}>
                  {msg.ok ? '✓' : '✗'} {msg.text}
                </div>
              )}
            </div>
          )
        })()}

        {/* Kotak Neo */}
        {(() => {
          const s = brokerStatus.kotak
          const msg = brokerMsg.kotak
          return (
            <div className="border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-white">Kotak Neo</span>
                  {s?.connected
                    ? <span className="text-[10px] px-1.5 py-0.5 bg-green-950 border border-green-800 text-score-green rounded">● Connected</span>
                    : s?.configured
                      ? <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 border border-border text-muted rounded">○ Not connected</span>
                      : <span className="text-[10px] px-1.5 py-0.5 bg-amber-950/40 border border-amber-800/40 text-amber-400 rounded">○ Not configured</span>}
                </div>
                {s?.connected && (
                  <button onClick={() => disconnectBroker('kotak')}
                    className="text-[10px] px-2 py-1 bg-red-950/50 border border-red-800/50 text-score-red hover:bg-red-900/70 rounded">
                    Disconnect
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Consumer Key', val: kotakConsKey, setter: setKotakConsKey, placeholder: 'From Kotak API portal' },
                  { label: 'Consumer Secret', val: kotakConsSec, setter: setKotakConsSec, placeholder: '••••••••' },
                  { label: 'Mobile Number', val: kotakMobile, setter: setKotakMobile, placeholder: '+91...' },
                  { label: 'Login Password', val: kotakPassword, setter: setKotakPassword, placeholder: '••••••••' },
                  { label: 'MPIN', val: kotakMpin, setter: setKotakMpin, placeholder: '6-digit MPIN' },
                ].map(({ label, val, setter, placeholder }) => (
                  <div key={label}>
                    <label className="text-[10px] text-muted block mb-1">{label}</label>
                    <input type="password" value={val} onChange={e => setter(e.target.value)}
                      placeholder={placeholder}
                      className="w-full bg-slate-800 border border-border rounded-lg px-2.5 py-2 text-xs text-white placeholder-muted focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-slate-500">
                MPIN (not OTP) is used for automated re-authentication — no mobile OTP dependency.
              </div>
              <div className="flex gap-2">
                <button onClick={() => saveBrokerCreds('kotak')} disabled={brokerSaving === 'kotak'}
                  className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                  {brokerSaving === 'kotak' ? 'Saving…' : '💾 Save'}
                </button>
                <button onClick={() => connectBroker('kotak')} disabled={brokerConnecting === 'kotak' || !s?.configured}
                  className="px-4 py-1.5 bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
                  {brokerConnecting === 'kotak' ? 'Connecting…' : '⚡ Connect Now'}
                </button>
              </div>
              {msg?.text && (
                <div className={`text-[10px] px-2 py-1 rounded ${msg.ok ? 'text-score-green' : 'text-score-red'}`}>
                  {msg.ok ? '✓' : '✗'} {msg.text}
                </div>
              )}
            </div>
          )
        })()}
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

    </div>{/* end left column */}

    {/* ── Right column: Broker Setup Guide ── */}
    <BrokerSetupGuide />

    </div>
  )
}

// ── Broker Setup Guide (right panel) ─────────────────────────────────────────

function Step({ n, text, sub }: { n: number; text: string; sub?: string }) {
  return (
    <div className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-blue-900 text-blue-300 text-[10px] font-bold flex items-center justify-center mt-0.5">{n}</span>
      <div>
        <div className="text-xs text-slate-300">{text}</div>
        {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

function Field({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="flex gap-2 items-start">
      <span className="shrink-0 mt-0.5 text-[9px] font-bold bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded font-mono">{name}</span>
      <span className="text-[10px] text-slate-400">{desc}</span>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2 text-[10px] text-amber-300 flex gap-2">
      <span>⚠</span><span>{children}</span>
    </div>
  )
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-950/30 border border-blue-800/40 rounded-lg px-3 py-2 text-[10px] text-blue-300 flex gap-2">
      <span>💡</span><span>{children}</span>
    </div>
  )
}

function BrokerSetupGuide() {
  const [tab, setTab] = useState<'ao' | 'kotak'>('ao')

  return (
    <div className="w-80 shrink-0 sticky top-6 self-start">
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="text-base">📋</span>
          <div>
            <div className="text-sm font-semibold text-white">Broker Setup Guide</div>
            <div className="text-[10px] text-muted">Step-by-step credential walkthrough</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border text-xs font-medium">
          <button onClick={() => setTab('ao')}
            className={`flex-1 py-2.5 transition-colors ${tab === 'ao' ? 'bg-orange-950/50 text-orange-300 border-b-2 border-orange-500' : 'text-slate-400 hover:text-white'}`}>
            Angel One
          </button>
          <button onClick={() => setTab('kotak')}
            className={`flex-1 py-2.5 transition-colors ${tab === 'kotak' ? 'bg-red-950/50 text-red-300 border-b-2 border-red-500' : 'text-slate-400 hover:text-white'}`}>
            Kotak Neo
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5 max-h-[calc(100vh-200px)] overflow-y-auto">
          {tab === 'ao' ? <AngelOneGuide /> : <KotakNeoGuide />}
        </div>
      </div>
    </div>
  )
}

function AngelOneGuide() {
  return (
    <>
      {/* What you need */}
      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Fields Required</div>
        <div className="space-y-1.5">
          <Field name="API Key"       desc="8-char key from the SmartAPI developer portal" />
          <Field name="Client ID"     desc="Your Angel One trading ID (e.g. A123456)" />
          <Field name="Password"      desc="Your Angel One trading account login password" />
          <Field name="TOTP Secret"   desc="Base32 seed from the 2FA QR code — not the 6-digit OTP" />
        </div>
      </div>

      {/* Steps */}
      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">How to Get the API Key</div>
        <div className="space-y-3">
          <Step n={1} text="Open smartapi.angelbroking.com in a browser and log in with your Angel One credentials." />
          <Step n={2} text='Click "My Apps" in the top navigation, then "Create App".' />
          <Step n={3} text='Enter any app name (e.g. "AegisAI"), select type "SmartAPI", set redirect URL to http://localhost.' />
          <Step n={4} text="Click Create. The app card shows your API Key — copy it." sub="Format: 8 alphanumeric characters, e.g. Xa1CMleE" />
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">How to Get the TOTP Secret</div>
        <div className="space-y-3">
          <Step n={1} text="In the Angel One mobile app, tap the profile icon (bottom-right)." />
          <Step n={2} text='Go to Settings → Security → Enable TOTP / Authenticator App.' />
          <Step n={3} text="A QR code appears. Below the QR code is the plain-text secret key (a long base32 string)." sub='It looks like: JBSWY3DPEHPK3PXP (20–32 uppercase letters A–Z and 2–7)' />
          <Step n={4} text="Copy that secret key — paste it as the TOTP Secret here. Don't paste the 6-digit code." />
          <Step n={5} text="Also scan the QR with Google Authenticator / Authy to complete the 2FA setup on your phone." />
        </div>
        <div className="mt-3 space-y-2">
          <Note>The TOTP Secret is a one-time setup. Once saved here AegisAI generates the 6-digit code automatically — no manual entry needed.</Note>
          <Tip>If the QR code does not show a text secret, use a QR decoder app (e.g. Google Lens) to read the URL — the secret= parameter is the base32 key.</Tip>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">Connect Flow</div>
        <div className="space-y-3">
          <Step n={1} text="Fill all four fields above and click Save — credentials are stored encrypted locally." />
          <Step n={2} text='Click "Connect Now". AegisAI performs a headless login with TOTP and stores the session token.' />
          <Step n={3} text='Status badge turns green: "● Connected". Session lasts until end of trading day.' />
          <Step n={4} text="Reconnect the next morning before trading. Save is needed only once; Connect Now is daily." />
        </div>
        <div className="mt-3">
          <Tip>Angel One SmartAPI data calls (option chain, portfolio, funds) are free. Brokerage (₹20/order) applies only when AegisAI places actual buy/sell orders.</Tip>
        </div>
      </div>

      {/* IP whitelist note */}
      <div className="bg-slate-800 rounded-lg px-3 py-2.5 space-y-1.5 text-[10px] text-slate-400">
        <div className="text-slate-300 font-medium text-xs">IP Whitelist</div>
        <div>Angel One requires whitelisting the machine's public IP in the SmartAPI app settings.</div>
        <div>In the developer portal: My Apps → your app → Edit → add your IP under "Allowed IPs".</div>
        <div>Find your IP at <span className="font-mono text-blue-400">whatismyip.com</span>. Update whenever your IP changes.</div>
      </div>
    </>
  )
}

function KotakNeoGuide() {
  return (
    <>
      {/* What you need */}
      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Fields Required</div>
        <div className="space-y-1.5">
          <Field name="Consumer Key"    desc="App key from the Kotak Neo developer portal" />
          <Field name="Consumer Secret" desc="App secret paired with the Consumer Key" />
          <Field name="Mobile Number"   desc="Your registered Kotak mobile number (+91…)" />
          <Field name="Password"        desc="Your Kotak Neo trading account password" />
          <Field name="MPIN"            desc="6-digit MPIN set in the Kotak Neo mobile app" />
        </div>
      </div>

      {/* Steps */}
      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">How to Get Consumer Key & Secret</div>
        <div className="space-y-3">
          <Step n={1} text="Open developer.kotaksecurities.com and sign in with your Kotak Net Banking credentials." />
          <Step n={2} text='Click "My Apps" → "Create New App".' />
          <Step n={3} text='Enter an app name, set type to "Neo API", set redirect URL to http://localhost.' />
          <Step n={4} text="Click Submit. The app detail page shows Consumer Key and Consumer Secret — copy both." sub="Keep the secret private; it cannot be retrieved again after closing the page." />
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">How to Set / Find Your MPIN</div>
        <div className="space-y-3">
          <Step n={1} text="Open the Kotak Neo app on your phone." />
          <Step n={2} text="Go to Profile → Security → MPIN. Set a 6-digit MPIN if you have not already." />
          <Step n={3} text="This MPIN is what AegisAI uses for automated session authentication — no OTP required." />
        </div>
        <div className="mt-3">
          <Note>MPIN is different from your net-banking PIN. It is set inside the Kotak Neo trading app, not the banking website.</Note>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">Connect Flow</div>
        <div className="space-y-3">
          <Step n={1} text="Fill all five fields and click Save." />
          <Step n={2} text='Click "Connect Now". AegisAI calls the OAuth2 endpoint and authenticates with MPIN (no SMS OTP).' />
          <Step n={3} text='Status badge turns green: "● Connected". The session token is valid for the trading day.' />
          <Step n={4} text="Reconnect each morning. Save is a one-time step; Connect Now is daily." />
        </div>
        <div className="mt-3 space-y-2">
          <Tip>If connection fails with "401 Unauthorized", your Consumer Key may be for a different environment (UAT vs Production). Ensure you created a Production app.</Tip>
          <Tip>Kotak Neo API rate limits: 10 req/sec. AegisAI batches calls automatically to stay within limits.</Tip>
        </div>
      </div>

      <div className="bg-slate-800 rounded-lg px-3 py-2.5 space-y-1.5 text-[10px] text-slate-400">
        <div className="text-slate-300 font-medium text-xs">Important Notes</div>
        <div>The Kotak Neo developer portal is separate from the Kotak Net Banking portal — use developer.kotaksecurities.com.</div>
        <div>API access requires your account to have F&O trading enabled. Contact your Kotak RM if the option is not visible.</div>
      </div>
    </>
  )
}
