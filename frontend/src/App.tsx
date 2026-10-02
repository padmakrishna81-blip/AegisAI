import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useAuthStore, hasPermission, hasMinRole } from './store/authStore'
import type { AuthUser } from './store/authStore'
import Sidebar from './components/layout/Sidebar'
import Header from './components/layout/Header'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Discover from './pages/Discover'
import Portfolio from './pages/Portfolio'
import Holdings from './pages/Holdings'
import Trade from './pages/Trade'
import CoveredCalls from './pages/CoveredCalls'
import Wheel from './pages/Wheel'
import Market from './pages/Market'
import AIInsights from './pages/AIInsights'
import Settings from './pages/Settings'
import Users from './pages/Users'
import Strategies from './pages/Strategies'
import CushionStrangle from './pages/CushionStrangle'
import CustomStrangle from './pages/CustomStrangle'
import MultiBuilder from './pages/MultiBuilder'
import StrategyMonitor from './pages/StrategyMonitor'
import BrokerPortfolio from './pages/BrokerPortfolio'
import MarketBrain from './pages/MarketBrain'
import StockTrader from './pages/StockTrader'
import WheelV2 from './pages/WheelV2'
import client from './api/client'

function ProtectedLayout() {
  const [marketMode, setMarketMode] = useState('NEUTRAL')
  const { user, logout } = useAuthStore()

  useEffect(() => {
    client.get('/market/macro').then((r) => {
      setMarketMode(r.data.market_mode || 'NEUTRAL')
    }).catch(() => {})
  }, [])

  const isPaper = hasMinRole(user, 'paper_trader')
  const isLive  = hasMinRole(user, 'live_trader')

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar — hidden on mobile, shown on md+ */}
      <div className="hidden md:block">
        <Sidebar user={user} onLogout={logout} />
      </div>
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header marketMode={marketMode} user={user} onLogout={logout} />
        <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <Routes>
            {/* Always accessible */}
            <Route path="/"           element={<Dashboard />} />
            <Route path="/market"     element={<Market />} />
            <Route path="/discover"   element={<Discover />} />
            <Route path="/settings"   element={<Settings />} />

            {/* Paper Trader + above */}
            <Route path="/portfolio"        element={isPaper ? <Portfolio />       : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/holdings"         element={isPaper ? <Holdings />        : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/trade"            element={isPaper ? <Trade />           : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/covered-calls"    element={isPaper ? <CoveredCalls />    : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/wheel"            element={isPaper ? <Wheel />           : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/smart-wheel"      element={isPaper ? <WheelV2 />         : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/stock-trader"     element={isPaper ? <StockTrader />     : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/ai-insights"      element={isPaper ? <AIInsights />      : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/strategies"       element={isPaper ? <Strategies />      : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/market-brain"     element={isPaper ? <MarketBrain />     : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/cushion-strangle" element={isPaper ? <CushionStrangle /> : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/custom-strangle"  element={isPaper ? <CustomStrangle />  : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/multi-builder"    element={isPaper ? <MultiBuilder />    : <UpgradeWall minRole="paper_trader" />} />
            <Route path="/strategy-monitor" element={isPaper ? <StrategyMonitor /> : <UpgradeWall minRole="paper_trader" />} />

            {/* Live Trader only */}
            <Route path="/broker-portfolio" element={isLive ? <BrokerPortfolio /> : <UpgradeWall minRole="live_trader" />} />

            {/* Admin only */}
            <Route path="/users" element={
              user?.role === 'admin' ? <Users /> : <Navigate to="/" replace />
            } />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        {/* Mobile bottom nav — visible only on small screens */}
        <MobileBottomNav user={user} />
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, _hasHydrated } = useAuthStore()
  if (!_hasHydrated) return <div className="min-h-screen bg-background" />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"    element={<AuthPageGuard><Login /></AuthPageGuard>} />
        <Route path="/register" element={<AuthPageGuard><Register /></AuthPageGuard>} />
        <Route path="/*" element={
          <RequireAuth>
            <ProtectedLayout />
          </RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  )
}

function AuthPageGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, _hasHydrated } = useAuthStore()
  if (!_hasHydrated) return <div className="min-h-screen bg-background" />
  if (isAuthenticated) return <Navigate to="/" replace />
  return <>{children}</>
}

function UpgradeWall({ minRole }: { minRole: 'paper_trader' | 'live_trader' }) {
  const descriptions: Record<string, { title: string; body: string; badge: string; color: string }> = {
    paper_trader: {
      title: 'Paper Trader Access Required',
      body:  'This feature is available to Paper Trader subscribers. AI-guided paper trading with no real money risk.',
      badge: 'Paper Trader',
      color: 'blue',
    },
    live_trader: {
      title: 'Live Trader Access Required',
      body:  'This feature requires Live Trader access. Automated live orders, real broker integration, and AI-monitored execution.',
      badge: 'Live Trader',
      color: 'emerald',
    },
  }
  const d = descriptions[minRole]
  const c = d.color

  return (
    <div className="flex items-center justify-center h-full p-10">
      <div className="text-center max-w-sm">
        <div className="text-5xl mb-4">🔒</div>
        <div className={`inline-block mb-4 px-3 py-1 rounded-full text-xs font-semibold bg-${c}-900/60 text-${c}-300 border border-${c}-700/30`}>
          {d.badge}
        </div>
        <div className="text-lg font-semibold text-white mb-2">{d.title}</div>
        <div className="text-sm text-muted mb-6">{d.body}</div>
        <a href="/settings"
          className={`inline-block px-6 py-2.5 bg-${c}-600 hover:bg-${c}-700 text-white text-sm font-semibold rounded-lg transition`}>
          Upgrade Plan
        </a>
      </div>
    </div>
  )
}

// Legacy export — some files import this directly
export { hasPermission }

function MobileBottomNav({ user }: { user: AuthUser | null }) {
  const isPaper = hasMinRole(user, 'paper_trader')
  const tabs = [
    { path: '/',            icon: '⬡', label: 'Home',    always: true },
    { path: '/market',      icon: '◊', label: 'Market',  always: true },
    { path: '/stock-trader',icon: '📈', label: 'Picks',  always: isPaper },
    { path: '/wheel',       icon: '🎡', label: 'Wheel',  always: isPaper },
    { path: '/settings',    icon: '⚙', label: 'More',   always: true },
  ]
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border flex z-40">
      {tabs.map(({ path, icon, label, always }) => (
        <NavLink key={path} to={path} end={path === '/'}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center py-2 text-[10px] transition-colors ${
              isActive ? 'text-blue-400' : always ? 'text-slate-400' : 'text-slate-700'
            }`
          }>
          <span className="text-xl mb-0.5">{icon}</span>
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
