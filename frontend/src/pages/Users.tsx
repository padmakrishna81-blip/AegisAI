import { useState, useEffect } from 'react'
import client from '../api/client'
import { useAuthStore } from '../store/authStore'

interface User {
  username: string
  full_name: string
  role: string
  permissions: string[]
  created_at: string
  active: boolean
}

const PERM_LABELS: Record<string, string> = {
  paper_trade:   'Paper Trade',
  covered_calls: 'Covered Calls',
  wheel:         'Wheel Strategy',
  market:        'Market',
  ai_insights:   'AI Insights',
}
const ALL_PERMS = Object.keys(PERM_LABELS)

export default function Users() {
  const { user: currentUser } = useAuthStore()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ username: '', full_name: '', password: '', role: 'user', permissions: [] as string[] })
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Inline permission editing
  const [editingPerms, setEditingPerms] = useState<string | null>(null)
  const [editPerms, setEditPerms] = useState<string[]>([])

  const fetchUsers = () => {
    client.get('/admin/users').then(r => setUsers(r.data.users || [])).finally(() => setLoading(false))
  }

  useEffect(() => { fetchUsers() }, [])

  const toggleFormPerm = (p: string) =>
    setForm(f => ({
      ...f,
      permissions: f.permissions.includes(p) ? f.permissions.filter(x => x !== p) : [...f.permissions, p],
    }))

  const addUser = async () => {
    setError('')
    if (!form.username || !form.full_name || !form.password) { setError('All fields required'); return }
    setAdding(true)
    try {
      await client.post('/admin/users', form)
      setSuccess(`User '${form.username}' created`)
      setForm({ username: '', full_name: '', password: '', role: 'user', permissions: [] })
      setShowAdd(false)
      fetchUsers()
    } catch (e: unknown) {
      setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed')
    } finally { setAdding(false) }
  }

  const toggleActive = async (username: string, active: boolean) => {
    await client.put(`/admin/users/${username}`, { active: !active })
    fetchUsers()
  }

  const savePerms = async (username: string) => {
    await client.put(`/admin/users/${username}`, { permissions: editPerms })
    setEditingPerms(null)
    fetchUsers()
  }

  const resetPassword = async (username: string) => {
    const newPw = window.prompt(`New password for '${username}' (min 6 chars):`)
    if (!newPw || newPw.length < 6) return
    await client.post(`/admin/users/${username}/reset-password`, { new_password: newPw })
    setSuccess(`Password reset for '${username}'`)
  }

  const deleteUser = async (username: string) => {
    if (!window.confirm(`Delete user '${username}'?`)) return
    await client.delete(`/admin/users/${username}`)
    fetchUsers()
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">User Management</h2>
          <p className="text-xs text-muted mt-0.5">Admin only — manage access and permissions</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
        >
          + Add User
        </button>
      </div>

      {success && (
        <div className="bg-green-950 border border-green-800 rounded-lg px-4 py-2.5 text-xs text-score-green">
          ✓ {success}
        </div>
      )}

      {/* Add user form */}
      {showAdd && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="text-sm font-semibold text-white">New User</div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { field: 'username',  label: 'Username',  placeholder: 'john' },
              { field: 'full_name', label: 'Full Name', placeholder: 'John Doe' },
              { field: 'password',  label: 'Password',  placeholder: 'min 6 chars' },
            ].map(({ field, label, placeholder }) => (
              <div key={field}>
                <label className="text-xs text-muted block mb-1">{label}</label>
                <input
                  type={field === 'password' ? 'password' : 'text'}
                  value={(form as Record<string, unknown>)[field] as string}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
            <div>
              <label className="text-xs text-muted block mb-1">Role</label>
              <select
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>

          {/* Permissions */}
          {form.role !== 'admin' && (
            <div>
              <div className="text-xs text-muted mb-2">Page Permissions <span className="text-slate-500">(admin always gets all)</span></div>
              <div className="flex gap-3 flex-wrap">
                {ALL_PERMS.map(p => (
                  <label key={p} className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.permissions.includes(p)}
                      onChange={() => toggleFormPerm(p)}
                      className="w-4 h-4 rounded accent-blue-500"
                    />
                    <span className="text-sm text-slate-300">{PERM_LABELS[p]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-score-red">{error}</p>}
          <div className="flex gap-2">
            <button onClick={addUser} disabled={adding}
              className="px-4 py-2 bg-score-green hover:bg-green-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {adding ? 'Creating…' : 'Create User'}
            </button>
            <button onClick={() => { setShowAdd(false); setError('') }}
              className="px-4 py-2 bg-card border border-border text-muted hover:text-white rounded-lg text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted text-sm">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-border bg-slate-800/40">
                <th className="text-left px-5 py-3">Username</th>
                <th className="text-left px-3 py-3">Full Name</th>
                <th className="text-center px-3 py-3">Role</th>
                <th className="text-left px-3 py-3">Permissions</th>
                <th className="text-center px-3 py-3">Status</th>
                <th className="text-left px-3 py-3">Created</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <>
                  <tr key={u.username} className="border-b border-border/40">
                    <td className="px-5 py-3 font-medium text-white">
                      {u.username}
                      {u.username === currentUser?.username && (
                        <span className="ml-2 text-[10px] text-score-blue bg-blue-950 px-1.5 py-0.5 rounded">you</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-300">{u.full_name}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        u.role === 'admin' ? 'bg-amber-950 text-amber-400' : 'bg-slate-700 text-slate-300'
                      }`}>{u.role}</span>
                    </td>
                    <td className="px-3 py-3">
                      {u.role === 'admin' ? (
                        <span className="text-xs text-amber-400">All (admin)</span>
                      ) : editingPerms === u.username ? (
                        <div className="flex gap-2 items-center flex-wrap">
                          {ALL_PERMS.map(p => (
                            <label key={p} className="flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editPerms.includes(p)}
                                onChange={() => setEditPerms(prev =>
                                  prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
                                )}
                                className="w-3.5 h-3.5 accent-blue-500"
                              />
                              <span className="text-xs text-slate-300">{PERM_LABELS[p]}</span>
                            </label>
                          ))}
                          <button onClick={() => savePerms(u.username)}
                            className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">Save</button>
                          <button onClick={() => setEditingPerms(null)}
                            className="text-xs text-muted hover:text-white">✕</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {(u.permissions || []).length === 0 ? (
                            <span className="text-xs text-muted">None</span>
                          ) : (
                            (u.permissions || []).map(p => (
                              <span key={p} className="px-1.5 py-0.5 bg-blue-950 border border-blue-800 text-score-blue rounded text-[10px]">
                                {PERM_LABELS[p] || p}
                              </span>
                            ))
                          )}
                          <button
                            onClick={() => { setEditingPerms(u.username); setEditPerms(u.permissions || []) }}
                            className="text-[10px] text-muted hover:text-white ml-1"
                            title="Edit permissions"
                          >✏</button>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        u.active ? 'bg-green-950 text-score-green' : 'bg-red-950 text-score-red'
                      }`}>{u.active ? 'Active' : 'Disabled'}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted">
                      {new Date(u.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex gap-1.5">
                        {u.username !== 'admin' && (
                          <button onClick={() => toggleActive(u.username, u.active)}
                            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs">
                            {u.active ? 'Disable' : 'Enable'}
                          </button>
                        )}
                        <button onClick={() => resetPassword(u.username)}
                          className="px-2 py-1 bg-card border border-border text-muted hover:text-white rounded text-xs">
                          Reset Pwd
                        </button>
                        {u.username !== 'admin' && u.username !== currentUser?.username && (
                          <button onClick={() => deleteUser(u.username)}
                            className="px-2 py-1 bg-card border border-border text-muted hover:text-score-red hover:border-red-800 rounded text-xs">
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
