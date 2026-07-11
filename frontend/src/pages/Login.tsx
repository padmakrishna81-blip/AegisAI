import { useState, FormEvent } from 'react'
import { useAuthStore } from '../store/authStore'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'

export default function Login() {
  const { login } = useAuthStore()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username || !password) { setError('Enter username and password'); return }
    setLoading(true)
    setError('')
    try {
      // OAuth2 form encoding required
      const params = new URLSearchParams()
      params.append('username', username)
      params.append('password', password)
      const res = await axios.post('http://localhost:8001/api/auth/login', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      login(res.data.access_token, {
        username: res.data.username,
        full_name: res.data.full_name,
        role: res.data.role,
        permissions: res.data.permissions || [],
      })
      navigate('/')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Login failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🛡</div>
          <h1 className="text-2xl font-bold text-white tracking-wide">AEGIS AI</h1>
          <p className="text-sm text-muted mt-1">Investment Intelligence Platform</p>
        </div>

        {/* Login card */}
        <div className="bg-card border border-border rounded-2xl p-6 space-y-5">
          <div className="text-sm font-semibold text-white text-center">Sign in to your account</div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-muted block mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                autoFocus
                className="w-full bg-slate-800 border border-border rounded-lg px-4 py-3 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-800 border border-border rounded-lg px-4 py-3 text-sm text-white placeholder-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {error && (
              <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-2.5 text-xs text-score-red">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-muted mt-4">
          Default: <span className="text-slate-400">admin</span> / <span className="text-slate-400">AegisAI@2024</span>
        </p>
      </div>
    </div>
  )
}
