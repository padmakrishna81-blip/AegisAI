import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useAuthStore, hasPermission } from './store/authStore'
import Sidebar from './components/layout/Sidebar'
import Header from './components/layout/Header'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Discover from './pages/Discover'
import Portfolio from './pages/Portfolio'
import Trade from './pages/Trade'
import CoveredCalls from './pages/CoveredCalls'
import Wheel from './pages/Wheel'
import Market from './pages/Market'
import AIInsights from './pages/AIInsights'
import Settings from './pages/Settings'
import Users from './pages/Users'
import client from './api/client'

function ProtectedLayout() {
  const [marketMode, setMarketMode] = useState('NEUTRAL')
  const { user, logout } = useAuthStore()

  useEffect(() => {
    client.get('/market/macro').then((r) => {
      setMarketMode(r.data.market_mode || 'NEUTRAL')
    }).catch(() => {})
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar user={user} onLogout={logout} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header marketMode={marketMode} user={user} onLogout={logout} />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/trade" element={
              hasPermission(user, 'paper_trade') ? <Trade /> : <AccessDenied />
            } />
            <Route path="/covered-calls" element={
              hasPermission(user, 'covered_calls') ? <CoveredCalls /> : <AccessDenied />
            } />
            <Route path="/wheel" element={
              hasPermission(user, 'wheel') ? <Wheel /> : <AccessDenied />
            } />
            <Route path="/market" element={
              hasPermission(user, 'market') ? <Market /> : <AccessDenied />
            } />
            <Route path="/ai-insights" element={
              hasPermission(user, 'ai_insights') ? <AIInsights /> : <AccessDenied />
            } />
            <Route path="/settings" element={<Settings />} />
            <Route path="/users" element={
              user?.role === 'admin' ? <Users /> : <Navigate to="/" replace />
            } />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginGuard />} />
        <Route path="/*" element={
          <RequireAuth>
            <ProtectedLayout />
          </RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  )
}

function LoginGuard() {
  const { isAuthenticated } = useAuthStore()
  if (isAuthenticated) return <Navigate to="/" replace />
  return <Login />
}

function AccessDenied() {
  return (
    <div className="flex items-center justify-center h-full p-10">
      <div className="text-center">
        <div className="text-5xl mb-4">🔒</div>
        <div className="text-lg font-semibold text-white mb-2">Access Restricted</div>
        <div className="text-sm text-muted">You don't have permission to view this page.<br />Ask your admin to grant access.</div>
      </div>
    </div>
  )
}
