import { useState, useEffect } from 'react'
import client from '../api/client'
import { useAuthStore } from '../store/authStore'

interface User {
  username: string
  full_name: string
  role: string
  permissions: string[]
  page_permissions: string[] | null
  created_at: string
  active: boolean
}

// ── Page catalogue (matches backend ROLE_DEFAULT_PAGES keys) ──────────────────

type PageGroup = { label: string; pages: { key: string; label: string }[] }

const PAGE_GROUPS: PageGroup[] = [
  {
    label: 'Always Accessible',
    pages: [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'market',    label: 'Market Intelligence' },
      { key: 'discover',  label: 'Discover' },
    ],
  },
  {
    label: 'Paper Trading',
    pages: [
      { key: 'portfolio',    label: 'Portfolio' },
      { key: 'holdings',     label: 'Holdings' },
      { key: 'paper_trade',  label: 'Paper Trade' },
      { key: 'wheel',        label: 'Wheel Strategy' },
      { key: 'smart_wheel',  label: 'Smart Wheel V2' },
      { key: 'nifty_wheel',  label: 'NIFTY Wheel' },
      { key: 'stock_trader', label: 'AI Stock Trader' },
      { key: 'ai_insights',  label: 'AI Insights' },
      { key: 'market_brain', label: 'Market Brain' },
      { key: 'covered_calls',label: 'Covered Calls' },
    ],
  },
  {
    label: 'Strategy Tools',
    pages: [
      { key: 'strategies',        label: 'Strategies' },
      { key: 'cushion_strangle',  label: 'Cushion Strangle' },
      { key: 'custom_strangle',   label: 'Custom Builder' },
      { key: 'multi_builder',     label: 'Multi-Asset' },
      { key: 'strategy_monitor',  label: 'Strategy Monitor' },
      { key: 'custom_fly',        label: 'Custom Fly' },
      { key: 'chart_intelligence',label: 'Chart Intelligence' },
    ],
  },
  {
    label: 'Live Trading',
    pages: [
      { key: 'broker_portfolio', label: 'Broker Portfolio' },
    ],
  },
]

const ALL_PAGE_KEYS = PAGE_GROUPS.flatMap(g => g.pages.map(p => p.key))

// Role-default page sets (mirror of backend ROLE_DEFAULT_PAGES)
const ROLE_DEFAULT_PAGES: Record<string, string[]> = {
  viewer: ['dashboard', 'market', 'discover'],
  paper_trader: [
    'dashboard', 'market', 'discover',
    'portfolio', 'holdings', 'paper_trade',
    'wheel', 'smart_wheel', 'nifty_wheel',
    'stock_trader', 'ai_insights', 'market_brain', 'covered_calls',
    'strategies', 'cushion_strangle', 'custom_strangle',
    'multi_builder', 'strategy_monitor', 'custom_fly', 'chart_intelligence',
  ],
  live_trader: [
    'dashboard', 'market', 'discover',
    'portfolio', 'holdings', 'paper_trade',
    'wheel', 'smart_wheel', 'nifty_wheel',
    'stock_trader', 'ai_insights', 'market_brain', 'covered_calls',
    'strategies', 'cushion_strangle', 'custom_strangle',
    'multi_builder', 'strategy_monitor', 'custom_fly', 'chart_intelligence',
    'broker_portfolio',
  ],
  admin: ALL_PAGE_KEYS,
}

// ── Role badge helpers ────────────────────────────────────────────────────────

const ROLE_BADGE: Record<string, string> = {
  admin:        'bg-amber-950 text-amber-400',
  live_trader:  'bg-emerald-950 text-emerald-300',
  paper_trader: 'bg-blue-950 text-blue-300',
  viewer:       'bg-slate-700 text-slate-300',
}
const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', live_trader: 'Live', paper_trader: 'Paper', viewer: 'Viewer',
}

// ── PagePermissionEditor ──────────────────────────────────────────────────────

interface PermEditorProps {
  user: User
  onSaved: () => void
  onCancel: () => void
}

function PagePermissionEditor({ user, onSaved, onCancel }: PermEditorProps) {
  // null = use role defaults
  const [useCustom, setUseCustom] = useState(user.page_permissions !== null)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(user.page_permissions ?? ROLE_DEFAULT_PAGES[user.role] ?? [])
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (user.role === 'admin') {
    return (
      <div className="px-5 pb-4 text-xs text-amber-400 bg-amber-950/20">
        Admin always has access to every page — permissions cannot be restricted.
      </div>
    )
  }

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })

  const toggleGroup = (group: PageGroup) => {
    const keys = group.pages.map(p => p.key)
    const allOn = keys.every(k => selected.has(k))
    setSelected(prev => {
      const next = new Set(prev)
      if (allOn) keys.forEach(k => next.delete(k)); else keys.forEach(k => next.add(k))
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true); setError('')
    try {
      const body = useCustom
        ? { page_permissions: Array.from(selected) }
        : { page_permissions: null }
      await client.put(`/admin/users/${user.username}/page-permissions`, body)
      onSaved()
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  const roleDefaults = ROLE_DEFAULT_PAGES[user.role] ?? []

  return (
    <div className="border-t border-border bg-slate-900/60 px-5 py-4 space-y-4">

      {/* Mode selector */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => {
            setUseCustom(false)
            setSelected(new Set(roleDefaults))
          }}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
            !useCustom
              ? 'bg-blue-950 border-blue-700 text-blue-300'
              : 'bg-slate-800 border-border text-muted hover:border-slate-500'
          }`}
        >
          <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${!useCustom ? 'border-blue-400 bg-blue-400' : 'border-slate-500'}`} />
          Use role defaults
          <span className="text-slate-500 ml-0.5">({ROLE_LABEL[user.role]})</span>
        </button>

        <button
          onClick={() => setUseCustom(true)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
            useCustom
              ? 'bg-blue-950 border-blue-700 text-blue-300'
              : 'bg-slate-800 border-border text-muted hover:border-slate-500'
          }`}
        >
          <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${useCustom ? 'border-blue-400 bg-blue-400' : 'border-slate-500'}`} />
          Custom permissions
        </button>

        {useCustom && (
          <span className="ml-auto text-[10px] text-muted">
            {selected.size} / {ALL_PAGE_KEYS.length} pages enabled
          </span>
        )}
      </div>

      {/* Page toggles */}
      <div className={`grid gap-5 transition-opacity ${!useCustom ? 'opacity-40 pointer-events-none' : ''}`}
           style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {PAGE_GROUPS.map(group => {
          const groupKeys = group.pages.map(p => p.key)
          const allOn = groupKeys.every(k => selected.has(k))
          const someOn = groupKeys.some(k => selected.has(k))

          return (
            <div key={group.label} className="space-y-1.5">
              {/* Group header with select-all toggle */}
              <button
                onClick={() => toggleGroup(group)}
                className="flex items-center gap-2 w-full text-left group"
              >
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  allOn ? 'bg-blue-500 border-blue-500' :
                  someOn ? 'bg-blue-500/30 border-blue-500' :
                  'border-slate-600 bg-transparent'
                }`}>
                  {allOn && <span className="text-white text-[9px] leading-none">✓</span>}
                  {!allOn && someOn && <span className="text-white text-[9px] leading-none">–</span>}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted group-hover:text-white transition-colors">
                  {group.label}
                </span>
              </button>

              {/* Individual page toggles */}
              {group.pages.map(page => (
                <label key={page.key} className="flex items-center gap-2 cursor-pointer pl-1 group/page">
                  <span
                    onClick={() => toggle(page.key)}
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                      selected.has(page.key)
                        ? 'bg-blue-500 border-blue-500'
                        : 'border-slate-600 bg-transparent hover:border-slate-400'
                    }`}
                  >
                    {selected.has(page.key) && <span className="text-white text-[9px] leading-none">✓</span>}
                  </span>
                  <span
                    onClick={() => toggle(page.key)}
                    className={`text-xs transition-colors cursor-pointer ${
                      selected.has(page.key)
                        ? 'text-slate-200'
                        : 'text-slate-500 group-hover/page:text-slate-400'
                    }`}
                  >
                    {page.label}
                  </span>
                </label>
              ))}
            </div>
          )
        })}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium">
          {saving ? 'Saving…' : 'Save Permissions'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 bg-slate-800 border border-border text-muted hover:text-white rounded-lg text-xs">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main Users page ────────────────────────────────────────────────────────────

export default function Users() {
  const { user: currentUser } = useAuthStore()
  const [users, setUsers]         = useState<User[]>([])
  const [loading, setLoading]     = useState(true)
  const [showAdd, setShowAdd]     = useState(false)
  const [form, setForm]           = useState({ username: '', full_name: '', email: '', password: '', role: 'paper_trader' })
  const [adding, setAdding]       = useState(false)
  const [error, setError]         = useState('')
  const [success, setSuccess]     = useState('')
  const [editingPages, setEditingPages] = useState<string | null>(null)  // username

  const fetchUsers = () => {
    setLoading(true)
    client.get('/admin/users').then(r => setUsers(r.data.users || [])).finally(() => setLoading(false))
  }

  useEffect(() => { fetchUsers() }, [])

  const addUser = async () => {
    setError('')
    if (!form.username || !form.full_name || !form.password) { setError('Username, full name and password are required'); return }
    setAdding(true)
    try {
      await client.post('/admin/users', form)
      setSuccess(`User '${form.username}' created`)
      setForm({ username: '', full_name: '', email: '', password: '', role: 'paper_trader' })
      setShowAdd(false)
      fetchUsers()
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to create user')
    } finally { setAdding(false) }
  }

  const toggleActive = async (username: string, active: boolean) => {
    await client.put(`/admin/users/${username}`, { active: !active })
    fetchUsers()
  }

  const setRole = async (username: string, role: string) => {
    await client.post(`/admin/users/${username}/set-role`, { role })
    setSuccess(`Role updated for '${username}'`)
    fetchUsers()
  }

  const resetPassword = async (username: string) => {
    const newPw = window.prompt(`New password for '${username}' (min 6 chars):`)
    if (!newPw || newPw.length < 6) return
    try {
      await client.post(`/admin/users/${username}/reset-password`, { new_password: newPw })
      setSuccess(`Password reset for '${username}'`)
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Reset failed')
    }
  }

  const deleteUser = async (username: string) => {
    if (!window.confirm(`Delete user '${username}'? This cannot be undone.`)) return
    await client.delete(`/admin/users/${username}`)
    fetchUsers()
  }

  return (
    <div className="p-6 space-y-5 pb-16 md:pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">User Management</h2>
          <p className="text-xs text-muted mt-0.5">Manage users and control per-page access</p>
        </div>
        <button
          onClick={() => { setShowAdd(!showAdd); setError('') }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
        >
          + Add User
        </button>
      </div>

      {success && (
        <div className="bg-green-950 border border-green-800 rounded-lg px-4 py-2.5 text-xs text-green-400 flex items-center justify-between">
          <span>✓ {success}</span>
          <button onClick={() => setSuccess('')} className="text-green-700 hover:text-green-400 ml-4">✕</button>
        </div>
      )}

      {/* Add user form */}
      {showAdd && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="text-sm font-semibold text-white">New User</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { field: 'username',  label: 'Username',   placeholder: 'john' },
              { field: 'full_name', label: 'Full Name',  placeholder: 'John Doe' },
              { field: 'email',     label: 'Email',      placeholder: 'john@company.com' },
              { field: 'password',  label: 'Password',   placeholder: 'min 6 chars' },
            ].map(({ field, label, placeholder }) => (
              <div key={field}>
                <label className="text-xs text-muted block mb-1">{label}</label>
                <input
                  type={field === 'password' ? 'password' : 'text'}
                  value={(form as Record<string, string>)[field]}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>

          <div>
            <label className="text-xs text-muted block mb-1">Role</label>
            <select
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
              className="bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
            >
              <option value="viewer">Viewer</option>
              <option value="paper_trader">Paper Trader</option>
              <option value="live_trader">Live Trader</option>
              <option value="admin">Admin</option>
            </select>
            <span className="text-xs text-muted ml-2">Page access can be customised after creation</span>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button onClick={addUser} disabled={adding}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {adding ? 'Creating…' : 'Create User'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 bg-card border border-border text-muted hover:text-white rounded-lg text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users list */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted text-sm">Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">No users found</div>
        ) : (
          <div className="divide-y divide-border/40">
            {users.map((u) => (
              <div key={u.username}>
                {/* User row */}
                <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-800/30 transition-colors">

                  {/* Name + username */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white text-sm">{u.full_name}</span>
                      {u.username === currentUser?.username && (
                        <span className="text-[9px] bg-blue-950 text-blue-400 px-1.5 py-0.5 rounded">you</span>
                      )}
                    </div>
                    <div className="text-xs text-muted mt-0.5">{u.username}</div>
                  </div>

                  {/* Role selector */}
                  <div className="shrink-0">
                    {u.username === 'admin' ? (
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${ROLE_BADGE.admin}`}>Admin</span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={e => setRole(u.username, e.target.value)}
                        className={`text-xs font-medium rounded px-2 py-0.5 border-0 focus:outline-none cursor-pointer ${ROLE_BADGE[u.role] ?? ROLE_BADGE.viewer} bg-transparent`}
                        title="Change role"
                      >
                        <option value="viewer"       className="bg-slate-800 text-white">Viewer</option>
                        <option value="paper_trader" className="bg-slate-800 text-white">Paper Trader</option>
                        <option value="live_trader"  className="bg-slate-800 text-white">Live Trader</option>
                        <option value="admin"        className="bg-slate-800 text-white">Admin</option>
                      </select>
                    )}
                  </div>

                  {/* Page access indicator */}
                  <div className="shrink-0 hidden sm:flex items-center gap-1.5">
                    {u.role === 'admin' ? (
                      <span className="text-[10px] text-amber-400">All pages</span>
                    ) : u.page_permissions !== null ? (
                      <span className="text-[10px] text-blue-400">
                        Custom ({u.page_permissions?.length ?? 0} pages)
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted">
                        Role defaults ({ROLE_DEFAULT_PAGES[u.role]?.length ?? 0} pages)
                      </span>
                    )}
                  </div>

                  {/* Status badge */}
                  <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-medium ${
                    u.active ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'
                  }`}>
                    {u.active ? 'Active' : 'Disabled'}
                  </span>

                  {/* Actions */}
                  <div className="shrink-0 flex gap-1">
                    <button
                      onClick={() => setEditingPages(editingPages === u.username ? null : u.username)}
                      className={`px-2.5 py-1 rounded text-xs transition-colors border ${
                        editingPages === u.username
                          ? 'bg-blue-950 border-blue-700 text-blue-300'
                          : 'bg-slate-800 border-border text-muted hover:text-white'
                      }`}
                      title="Edit page permissions"
                    >
                      Pages {editingPages === u.username ? '▲' : '▼'}
                    </button>

                    {u.username !== 'admin' && (
                      <button onClick={() => toggleActive(u.username, u.active)}
                        className="px-2.5 py-1 bg-slate-800 border border-border text-muted hover:text-white rounded text-xs">
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    )}

                    <button onClick={() => resetPassword(u.username)}
                      className="px-2.5 py-1 bg-slate-800 border border-border text-muted hover:text-white rounded text-xs">
                      Pwd
                    </button>

                    {u.username !== 'admin' && u.username !== currentUser?.username && (
                      <button onClick={() => deleteUser(u.username)}
                        className="px-2.5 py-1 bg-slate-800 border border-border text-muted hover:text-red-400 hover:border-red-800 rounded text-xs">
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline page permissions editor */}
                {editingPages === u.username && (
                  <PagePermissionEditor
                    user={u}
                    onSaved={() => { fetchUsers(); setSuccess(`Page permissions updated for '${u.username}'`) }}
                    onCancel={() => setEditingPages(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted">
        Click <strong className="text-slate-400">Pages ▼</strong> on any user to expand per-page access control.
        Role defaults apply when no custom permissions are set.
      </p>
    </div>
  )
}
