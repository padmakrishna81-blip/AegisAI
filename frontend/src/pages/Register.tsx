import { useState, FormEvent } from 'react'
import { useAuthStore } from '../store/authStore'
import { useNavigate, Link } from 'react-router-dom'
import axios from 'axios'

export default function Register() {
  const { login } = useAuthStore()
  const navigate   = useNavigate()

  const [fullName,  setFullName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [username,  setUsername]  = useState('')
  const [password,  setPassword]  = useState('')
  const [confirm,   setConfirm]   = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!fullName || !email || !username || !password) {
      setError('All fields are required'); return
    }
    if (password !== confirm) {
      setError('Passwords do not match'); return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters'); return
    }
    setLoading(true)
    setError('')
    try {
      const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8001/api'
      const res = await axios.post(`${apiBase}/auth/register`, {
        full_name: fullName.trim(),
        email:     email.trim().toLowerCase(),
        username:  username.trim().toLowerCase(),
        password,
      })
      login(
        res.data.access_token,
        {
          username:    res.data.username,
          email:       res.data.email || '',
          full_name:   res.data.full_name,
          role:        res.data.role,
          permissions: res.data.permissions || [],
        },
        res.data.refresh_token,
      )
      navigate('/')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Registration failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🛡</div>
          <h1 className="text-2xl font-bold text-white tracking-wide">AEGIS AI</h1>
          <p className="text-sm text-muted mt-1">AI-Powered Trading Intelligence</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 space-y-5">
          <div className="space-y-1 text-center">
            <div className="text-sm font-semibold text-white">Create your account</div>
            <div className="text-xs text-muted">Start as Paper Trader — free, no credit card required</div>
          </div>

          {/* Role info */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-blue-950/40 border border-blue-700/30 rounded-lg p-2.5 text-center">
              <div className="text-blue-300 font-semibold mb-0.5">Paper Trader</div>
              <div className="text-slate-400">AI picks + paper trading. No real money risk.</div>
            </div>
            <div className="bg-emerald-950/40 border border-emerald-700/30 rounded-lg p-2.5 text-center">
              <div className="text-emerald-300 font-semibold mb-0.5">Live Trader</div>
              <div className="text-slate-400">Automated live orders. Admin upgrade required.</div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs text-muted block mb-1.5">Full Name</label>
              <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
                placeholder="Rajesh Kumar"
                autoFocus autoComplete="name"
                className="w-full bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1.5">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@email.com"
                autoComplete="email"
                className="w-full bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors" />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1.5">Username</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="rajesh_k"
                autoComplete="username"
                className="w-full bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted block mb-1.5">Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Min 8 chars"
                  autoComplete="new-password"
                  className="w-full bg-slate-800 border border-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="text-xs text-muted block mb-1.5">Confirm</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder="Repeat"
                  autoComplete="new-password"
                  className={`w-full bg-slate-800 border rounded-lg px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none transition-colors ${
                    confirm && confirm !== password ? 'border-red-500' : 'border-border focus:border-blue-500'
                  }`} />
              </div>
            </div>

            {error && (
              <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-2.5 text-xs text-red-400">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors">
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
          </form>

          <div className="text-center text-xs text-muted">
            Already have an account?{' '}
            <Link to="/login" className="text-blue-400 hover:text-blue-300 font-medium transition">
              Sign in
            </Link>
          </div>
        </div>

        <p className="text-center text-[10px] text-muted mt-4 px-4">
          By registering you agree to use this platform for personal investment decisions only.
          AegisAI is not a SEBI-registered investment advisor.
        </p>
      </div>
    </div>
  )
}
