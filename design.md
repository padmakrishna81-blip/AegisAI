# AegisAI — Architecture & Design Reference

> **Last verified:** 2026-10-02. Written by inspecting the actual codebase — not generated from chat history alone.
>
> **Status legend used throughout this document:**
> - **IMPLEMENTED** — code exists and is wired up end-to-end
> - **PARTIALLY IMPLEMENTED** — backend or frontend exists but not both; or schema exists without data migration
> - **PLANNED** — design decision made, no code yet
> - **DEPRECATED** — superseded; code may still exist but should not be called
> - **UNKNOWN** — unclear from codebase; needs investigation

---

## 1. Project Overview

AegisAI is an AI-powered personal investment-intelligence platform for Indian equity markets (NSE/BSE). It provides:

- AI-curated stock and ETF picks with allocation recommendations
- Paper-trading simulations for F&O strategies (Wheel, Covered Calls, Custom Strangles)
- Smart Wheel V2 — a structured short-strangle + equity participation strategy
- Live broker integration (Angel One, Kotak Neo) for live_trader-role users
- Market dashboards (macro regime, sector heatmap, AI insights, predictions)
- Multi-user SaaS with role-based access (viewer / paper_trader / live_trader / admin)

**Target markets:** NSE-listed equities and ETFs only. No crypto, no international exchanges (global_stocks module exists for reference data but does not support live trading).

---

## 2. Technology Stack

### Backend
| Component | Choice | Notes |
|---|---|---|
| Runtime | Python 3.11+ | Tested on 3.13 in production |
| Web framework | FastAPI 0.115+ | Async endpoints; sync CPU work run in ThreadPoolExecutor |
| Auth | python-jose (JWT HS256) + passlib (pbkdf2_sha256) | |
| LLM | Anthropic Claude / OpenAI GPT-4o / Groq (runtime-switchable) | |
| Broker SDK (Angel One) | smartapi-python + pyotp | TOTP auto-generated from stored secret |
| Broker (Kotak Neo) | Raw HTTP (`requests`), no SDK | |
| ORM | SQLAlchemy 2.x | Schema defined; data not yet migrated |
| DB (default) | SQLite (`backend/aegisai.db`) | Zero-infra; switchable to PostgreSQL |
| Market data | yfinance | Supplemented by jugaad_data for live IV/option-chain |
| Config | python-dotenv (`backend/.env`) | |
| Server | uvicorn[standard] | |

### Frontend
| Component | Choice |
|---|---|
| Framework | React 18 |
| Build | Vite 6 + TypeScript 5.7 |
| Routing | react-router-dom v6 |
| State | Zustand 5 |
| Charts | Recharts |
| HTTP client | axios |
| Spreadsheet export | xlsx |
| Styles | Tailwind CSS 3 |

---

## 3. Repository Structure

```
AegisAI/
├── backend/
│   ├── main.py               # FastAPI app, CORS, router registration, daemon threads
│   ├── config.py             # Settings class (env vars, constants)
│   ├── requirements.txt      # Python deps (see §36 for missing items)
│   ├── .env                  # NOT committed — API keys, DB URL
│   ├── .jwt_secret           # NOT committed — auto-generated JWT signing key
│   ├── users.json            # NOT committed — user store (currently the auth DB)
│   ├── broker_creds.json     # NOT committed — raw broker credentials per user
│   ├── aegisai.db            # NOT committed — SQLite DB (schema only, no data yet)
│   │
│   ├── auth/
│   │   └── auth_utils.py     # JWT helpers, user CRUD, role enforcement
│   │
│   ├── api/routes/           # One file per feature domain
│   │   ├── auth.py           # /auth/login, /auth/register, /auth/refresh, /admin/…
│   │   ├── stock_trader.py   # /stock-trader/… campaigns, AI picks, ETF picks
│   │   ├── wheel_v2.py       # /wheel-v2/… Smart Wheel V2 CRUD + assess + enter
│   │   ├── wheel_agent.py    # /wheel/… Wheel V1 (put selling strategy)
│   │   ├── broker.py         # /broker/connect, /broker/status, /broker/balance
│   │   ├── market_brain.py   # /market-brain/… macro analysis + option chain
│   │   └── … (18 more route files)
│   │
│   ├── ai/
│   │   ├── llm_client.py     # Unified LLM gateway (Claude/OpenAI/Groq)
│   │   ├── stock_picker.py   # AI stock picks, UNIVERSE definition, candidate screening
│   │   ├── etf_screener.py   # ETF universe + AI ETF picks
│   │   ├── trade_agent.py    # Campaign execution engine (place orders, chunk logic)
│   │   ├── wheel_agent.py    # Wheel V1 strategy AI (put selection, exit signals)
│   │   ├── wheel_v2_agent.py # Smart Wheel V2 strategy engine
│   │   ├── market_brain.py   # Macro regime detection + option chain analysis
│   │   └── explainer.py      # LLM-powered explanations for holdings
│   │
│   ├── data/
│   │   ├── db.py             # SQLAlchemy engine + SessionLocal + init_db()
│   │   ├── models.py         # ORM models (User, Campaign, WheelPosition, …)
│   │   ├── broker_creds.py   # JSON-based credential store (CRUD + session cache)
│   │   ├── wheel_positions.py# JSON-based Smart Wheel V2 position + config store
│   │   └── market_data.py    # yfinance wrapper with in-memory cache
│   │
│   ├── brokers/
│   │   ├── angel_one.py      # AngelOneClient (SDK wrapper + auto-reconnect)
│   │   └── kotak_neo.py      # KotakNeoClient (raw REST)
│   │
│   ├── services/
│   │   └── notify.py         # Telegram notification sender + in-memory alert ring
│   │
│   └── engines/              # Six scoring engines + orchestrator for stock recommendation
│       ├── recommendation.py # Runs all 6 engines concurrently → final verdict
│       ├── company_health.py
│       ├── technical_strength.py
│       ├── growth_trend.py
│       ├── sector_strength.py
│       ├── business_events.py
│       ├── macro_environment.py
│       └── paper_trade.py
│
└── frontend/
    ├── index.html            # PWA meta tags
    ├── vite.config.ts        # Vite build config
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx           # Router, layout, MobileBottomNav, UpgradeWall, guards
    │   ├── api/client.ts     # Axios instance with base URL + JWT interceptor
    │   ├── store/authStore.ts# Zustand auth store, role helpers, token persistence
    │   ├── pages/
    │   │   ├── Login.tsx
    │   │   ├── Register.tsx
    │   │   ├── Dashboard.tsx
    │   │   ├── StockTrader.tsx   # AI Stock Trader (2400+ lines — largest file)
    │   │   ├── Wheel.tsx         # Wheel V1 strategy page
    │   │   ├── WheelV2.tsx       # Smart Wheel V2 page
    │   │   ├── Market.tsx
    │   │   ├── MarketBrain.tsx
    │   │   ├── AIInsights.tsx
    │   │   ├── BrokerPortfolio.tsx
    │   │   ├── Settings.tsx
    │   │   ├── Users.tsx         # Admin-only user management
    │   │   └── … (10 more pages)
    │   └── components/
    │       ├── layout/
    │       │   ├── Sidebar.tsx   # Collapsible desktop nav with role badges
    │       │   └── Header.tsx
    │       ├── NseStockSearch.tsx# Async NSE stock/ETF search with dropdown
    │       ├── WheelStatus.tsx   # Smart Wheel V2 status card
    │       └── … (other shared components)
```

---

## 4. Authentication & Authorization — IMPLEMENTED

### Token model
- **Access token**: JWT HS256, 8-hour expiry, payload: `{sub: username, type: "access"}`
- **Refresh token**: JWT HS256, 30-day expiry, payload: `{sub: username, type: "refresh"}`
- **Secret**: loaded from `JWT_SECRET` env var → `backend/.jwt_secret` file → auto-generated at startup
- **Password hashing**: passlib pbkdf2_sha256 (not bcrypt — change this for higher user volumes)

### Role hierarchy
```
viewer (0) < paper_trader (1) < live_trader (2) < admin (99)
```

### Role permissions
```python
"viewer":       ["market"]
"paper_trader": ["market", "ai_insights", "covered_calls", "wheel", "paper_trade"]
"live_trader":  [all paper_trader + "broker_connect", "live_trade"]
"admin":        [same as live_trader]
```
Permissions are **always recomputed from the role** (`_safe_user()` in `auth_utils.py`) — never stored in the DB. The `permissions` list in the JWT payload is informational only.

### Backend enforcement
```python
# Protect an endpoint:
@router.post("/some-endpoint")
async def endpoint(user=Depends(require_role('live_trader'))):
    ...

# require_role() is a FastAPI Depends factory in auth/auth_utils.py
# It accepts multiple roles: require_role('live_trader', 'admin')
# Admins are always allowed (their role level = 99)
```

### Frontend enforcement
```typescript
// In store/authStore.ts:
hasMinRole(user, 'paper_trader')  // checks role level
hasRole(user, 'admin', 'live_trader')  // checks exact roles
hasPermission(user, 'broker_connect')  // legacy — prefers hasMinRole

// In App.tsx routes:
element={isPaper ? <StockTrader /> : <UpgradeWall minRole="paper_trader" />}
```

### Self-registration
- `POST /api/auth/register` — always creates `paper_trader` role regardless of body
- Admin upgrades roles via `POST /api/admin/users/{username}/set-role`
- Default admin: username=`admin`, password=`AegisAI@2024` — **must be changed on first deploy**

### Current storage — PARTIALLY IMPLEMENTED
Users are stored in `backend/users.json` (JSON file). The SQLAlchemy `User` model exists but is not used by any auth code. Migration to DB is the next planned step.

---

## 5. Data Storage Strategy — CRITICAL

### Reality as of 2026-10-02

**ALL feature data is stored in JSON files.** The SQLAlchemy ORM was added this session to establish the schema, but no feature code has been migrated to use it.

| Data type | Current storage | ORM model | Status |
|---|---|---|---|
| Users | `users.json` | `User` | PARTIALLY IMPLEMENTED (schema only) |
| Campaigns + stocks | `stock_trader.json` | `Campaign`, `CampaignStock` | PARTIALLY IMPLEMENTED (schema only) |
| Smart Wheel V2 positions | `wheel_v2_positions.json` | `WheelPosition` | PARTIALLY IMPLEMENTED (schema only) |
| Smart Wheel V2 config | `wheel_v2_config.json` | `WheelConfig` | PARTIALLY IMPLEMENTED (schema only) |
| Broker credentials | `broker_creds.json` | `BrokerSession` | PARTIALLY IMPLEMENTED (schema only) |
| Paper trades | `paper_trades.json` | `PaperTrade` | PARTIALLY IMPLEMENTED (schema only) |
| Holdings | `holdings_data.json` | — (no model yet) | IMPLEMENTED (JSON only) |
| Portfolio | `portfolio_data.json` | — | IMPLEMENTED (JSON only) |
| Predictions | `predictions.json` | — | IMPLEMENTED (JSON only) |
| Strategy monitor | `strategy_monitor.json` | — | IMPLEMENTED (JSON only) |
| Global stocks | `global_stocks.json` | — | IMPLEMENTED (JSON only) |

### SQLAlchemy DB

- File: `backend/aegisai.db` (SQLite, default)
- Tables are created at startup via `init_db()` called in FastAPI `startup` event
- Switch to PostgreSQL: set `DATABASE_URL=postgresql+psycopg2://user:pass@host/aegisai`
- `get_db()` is a FastAPI dependency but is not used by any route yet
- The ORM migration is the most important near-term engineering work (see §34)

---

## 6. Backend Architecture

### Request flow
```
Client HTTP → FastAPI router → Depends(get_current_user) [JWT decode]
  → Route handler
    → sync work offloaded via ThreadPoolExecutor / asyncio.run_in_executor
    → JSON file read/write (current) or SQLAlchemy session (future)
    → LLM call via ai/llm_client.py (cached 1hr in-memory)
    → yfinance / jugaad_data (cached 15min in-memory)
  → JSONResponse (numpy cleaned via convert_numpy())
```

### Key conventions
- All float/numpy values cleaned via `convert_numpy()` in `main.py` before returning
- NaN and Inf are converted to `None`
- CPU-bound or blocking operations must use `run_in_executor` — never `await blocking_call()`
- Each feature has its own route file; routes are registered with `prefix="/api"` in `main.py`
- Route file import order matters: `cc_strategy` must be registered before `covered_calls` (more specific routes first)

### Daemon threads
Three background threads start at app launch (all `daemon=True`, raw `time.sleep(60)` loops):

| Thread | Trigger | Purpose |
|---|---|---|
| `_auto_fill_loop` | 15:45–16:00 IST weekdays | Fill prediction actuals from closing prices |
| `_monitor_loop` | Every 30 min, 9:15–15:30 IST weekdays | Check saved strategies for alert conditions |
| `_wheel_v2_monitor_loop` | Every 15 min, 9:15–15:30 IST weekdays | Check Smart Wheel V2 positions per user |

---

## 7. API Structure

All routes are prefixed `/api/`. Authentication routes at `/api/auth/`. Admin at `/api/admin/`.

### Authentication endpoints
```
POST /api/auth/login          body: form-urlencoded username+password → access_token + refresh_token
POST /api/auth/register       body: JSON {full_name, email, username, password} → tokens
POST /api/auth/refresh        body: JSON {refresh_token} → new access_token
GET  /api/auth/me             → current user info
PUT  /api/auth/me             → update own profile
POST /api/admin/users         → admin create user
GET  /api/admin/users         → admin list all users
POST /api/admin/users/{u}/set-role  → admin role change
DELETE /api/admin/users/{u}   → admin delete user
```

### Stock Trader endpoints
```
GET  /api/stock-trader/picks          AI stock picks for date
GET  /api/stock-trader/etf-picks      AI ETF picks
GET  /api/stock-trader/campaigns      List all campaigns (current user)
POST /api/stock-trader/campaigns      Create campaign
GET  /api/stock-trader/campaigns/{id} Get campaign detail
DELETE /api/stock-trader/campaigns/{id} Delete campaign
POST /api/stock-trader/campaigns/{id}/run  Execute campaign (requires live_trader)
GET  /api/stock-trader/broker-balance  Get available funds (requires live_trader)
```

### Smart Wheel V2 endpoints
```
GET  /api/wheel-v2/config      Get user watchlist + thresholds
POST /api/wheel-v2/config      Save config
POST /api/wheel-v2/assess      Assess watchlist stocks, return best pick
POST /api/wheel-v2/capital     Calculate capital requirement
POST /api/wheel-v2/enter       Paper-enter a position
GET  /api/wheel-v2/positions   List positions
POST /api/wheel-v2/positions/{id}/update  Update MTM manually
DELETE /api/wheel-v2/positions/{id}        Close/delete position
POST /api/wheel-v2/monitor     Manual trigger of position monitor
```

### Broker endpoints
```
POST /api/broker/connect       Connect Angel One or Kotak
GET  /api/broker/status        Connection status
GET  /api/broker/balance       Account balance
POST /api/broker/disconnect    Clear session
```

### Other key endpoints
```
GET  /api/market/macro         Market regime (bull/bear/neutral)
GET  /api/market/sectors       Sector performance
POST /api/market-brain/analyze Option chain + macro analysis
GET  /api/wheel/agent/plan     Wheel V1 put selection plan
POST /api/wheel/agent/enter    Enter put position (paper)
GET  /api/wheel/agent/monitor/alerts  Strategy alert count
GET  /api/nse/search           NSE stock/ETF search
GET  /health                   Health check (no auth required)
POST /api/admin/flush-cache    Flush yfinance cache
POST /api/admin/fill-actuals   Manual trigger prediction actuals fill
```

---

## 8. Frontend Architecture

### Routing & guards
```
/login    → <AuthPageGuard>   (redirects to / if already authenticated)
/register → <AuthPageGuard>
/*        → <RequireAuth>     (redirects to /login if not authenticated)
  → <ProtectedLayout>
    → <Sidebar> (hidden on mobile: `hidden md:block`)
    → <Header>
    → <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
        <Routes> ... </Routes>
    → <MobileBottomNav> (visible only on mobile: `md:hidden`)
```

### Role-gated routes in App.tsx
Routes for paper_trader+ features render `<UpgradeWall>` for lower-role users rather than redirecting. This lets users see what they'd get if they upgrade.

### `UpgradeWall` component
Shown for routes the user's role can't access. Contains upgrade CTA that links to `/settings`.

---

## 9. State Management — IMPLEMENTED

State is managed via **Zustand** (`frontend/src/store/authStore.ts`). Persisted to `localStorage` (key: `aegisai-auth`).

### Store shape
```typescript
{
  token: string | null
  refreshToken: string | null
  user: AuthUser | null   // { username, email, full_name, role, permissions }
  isAuthenticated: boolean
  _hasHydrated: boolean   // false until localStorage is read — gates route guards
}
```

### Exported helpers
```typescript
hasMinRole(user, minRole)        // role level comparison
hasRole(user, ...roles)          // exact role match (admin always passes)
hasPermission(user, permission)  // legacy string-based check
roleLabel(role)                  // "Paper Trader" etc.
roleBadgeClass(role)             // Tailwind class string for badge color
```

### Token refresh
The `refreshToken` is stored in Zustand (persisted under key `aegisai-auth`) and also in `localStorage` (`aegis_refresh`). The API client (`api/client.ts`) does **NOT** have a refresh interceptor — on 401 it clears all stored tokens and redirects to `/login`. The refresh token is available in storage but is not automatically used. To implement automatic refresh: add a response interceptor that, on 401, calls `POST /api/auth/refresh` with the stored refresh token, updates the stored access token, and retries the request.

---

## 10. Mobile Responsiveness — IMPLEMENTED

- Sidebar: `hidden md:block` — invisible on screens narrower than 768px
- Main content: `pb-16 md:pb-0` — bottom padding prevents content being obscured by mobile nav
- `<MobileBottomNav>`: 5-tab fixed bottom bar, `md:hidden`
  - Tabs: Home, Market, Picks (paper_trader+), Wheel (paper_trader+), More
  - Tabs not available to the user's role render as dimmed but still tappable
- `index.html` PWA meta: `viewport user-scalable=no`, `apple-mobile-web-app-capable`, `theme-color`
- No PWA service worker or manifest yet — just the meta tags

---

## 11. LLM Layer — IMPLEMENTED

### Provider abstraction (`backend/ai/llm_client.py`)
```python
call_llm(prompt, system="", max_tokens=1024) → str
```
Provider selected by `LLM_PROVIDER` env var (default: `"claude"`). Options: `claude`, `openai`, `groq`.

### Providers
| Provider | Model used | Notes |
|---|---|---|
| Claude | `claude-sonnet-4-5` | `anthropic` SDK — **NOT in requirements.txt** |
| OpenAI | `gpt-4o` | `openai` SDK — in requirements.txt |
| Groq | `qwen/qwen3.8-27b` (configurable via `GROQ_MODEL`) | `groq` SDK — in requirements.txt; reasoning model, strips `<think>` blocks |

### Caching
- 1-hour in-memory cache keyed by MD5 of `provider:prompt+system`
- Error responses (strings starting `[LLM`) are never cached
- Cache is process-global (shared across users)

### Rule-based fallbacks
Every AI module that calls `call_llm()` has a fallback that returns deterministic rule-based results when the LLM is unavailable or returns an error string. Always check `result.startswith('[LLM')` before trusting the response.

### Missing from requirements.txt
`anthropic` is **not** in `backend/requirements.txt`. Install with:
```bash
pip install anthropic>=0.25.0
```

---

## 12. Broker Integration — IMPLEMENTED

### Angel One
- SDK: `smartapi-python` + `pyotp`
- Auto-reconnect: `data/broker_creds.py::auto_reconnect()` regenerates TOTP and re-calls `connect()`
- Symbol format: stocks use `SYMBOL-EQ`, ETFs use bare symbol (no `-EQ`)
- Session cached in `broker_creds.json` under `session` sub-key
### Kotak Neo
- No SDK — raw HTTP (`requests`)
- OAuth2 + 2FA via MPIN
- **No token caching** — a new HTTP call is made for every request. Fix: implement session caching in `brokers/kotak_neo.py`

### Credential storage
Per-user credentials stored in `backend/broker_creds.json`:
```json
{
  "username": {
    "angelone": { "api_key": "...", "client_id": "...", "password": "...", "totp_secret": "..." },
    "kotak":    { "consumer_key": "...", "consumer_secret": "...", "mobile": "...", "mpin": "...", "totp_secret": "..." }
  }
}
```
**Credentials are stored in plaintext.** The comment "encrypted at rest in prod" in `models.py` is aspirational, not actual. Encrypt before production scaling.

---

## 13. NSE Data Sources — IMPLEMENTED (with caveats)

### yfinance
- Used everywhere for price history, option chains, fundamentals
- Symbols: `SYMBOL.NS` for stocks, bare symbol for some ETFs
- In-memory cache in `data/market_data.py` (TTL: 15 min, configurable via `CACHE_TTL_SECONDS`)
- Flush cache: `POST /api/admin/flush-cache`

### jugaad_data
- Third-party NSE scraper library
- Used in `ai/wheel_agent.py` and `ai/market_brain.py` for **live IV** and **option chain** data
- **NOT in `requirements.txt`** — must install separately:
  ```bash
  pip install jugaad-data
  ```
- If not installed, `ImportError` will crash those modules at runtime

### nse_catalog.json
- Static file at `backend/nse_catalog.json` — list of NSE stocks/ETFs with symbol, name, sector
- Used by `api/routes/nse_search.py` for the autocomplete search
- Updated manually; not fetched from NSE at runtime

---

## 14. Strategy Modules

### Wheel V1 (Put Selling) — IMPLEMENTED
- Route: `/api/wheel/…`
- AI module: `ai/wheel_agent.py`
- Data: JSON files for positions and config
- Strategy: sell OTM puts at 1-2 SD below spot, collect premium
- Paper entry supported; live entry depends on broker connection

### Smart Wheel V2 (Short Strangle + Equity) — IMPLEMENTED
- Route: `/api/wheel-v2/…`
- AI module: `ai/wheel_v2_agent.py`
- Data: `wheel_v2_positions.json`, `wheel_v2_config.json`
- Strategy:
  1. Sell CE at 2 SD above spot (DTE 30–50)
  2. Sell PE at 1 SD below spot
  3. Buy 25% lot worth of shares at CMP
  4. Monitor: if CMP crosses PE-BE → exit PE, buy 25% more shares → Phase 2 (Covered Call)
  5. Phase 2: short CE only + 50% lot shares
  6. Close all when CMP crosses CE-BE
- MTM guardrails: amber at -6000, red at -10000 (user-configurable in /api/wheel-v2/config)
- Telegram alerts via `services/notify.py`
- **Paper entry only** — live broker order placement not implemented

### Covered Calls — IMPLEMENTED
- Route: `/api/covered-calls/…`
- Standard covered call strategy; separate from Wheel

### Custom Strangle Builder — IMPLEMENTED
- Route: `/api/cushion-strangle/…`, `/api/strategies/…`
- Manual strike/premium input, P&L calculator

### Strategy Monitor — IMPLEMENTED
- Route: `/api/monitor/…`
- Stores monitored strategy positions in `strategy_monitor.json`
- Background `_monitor_loop` checks conditions every 30 min during market hours
- Alerts delivered via `services/notify.py`

---

## 15. AI Stock Trader & Campaign System — IMPLEMENTED

### Overview
Users build campaigns: a named set of stocks/ETFs with allocation percentages and an entry strategy. Campaigns support paper simulation and (for live_trader) automated broker order execution.

### Campaign creation flow
1. User navigates to AI Stock Trader → "AI Picks" or "ETF Picks" tab
2. LLM analyzes `UNIVERSE` stocks; returns ranked picks with justifications
3. User selects picks from AI recommendations, adjusts allocations
4. User can manually add stocks/ETFs via NseStockSearch (outside overflow container to avoid dropdown clipping)
5. Allocation validation: stock allocations must sum to 100%; ETF allocations must sum to 100% (independently)
6. `POST /api/stock-trader/campaigns` creates campaign in `stock_trader.json`
7. For live_trader: `POST /api/stock-trader/campaigns/{id}/run` triggers `trade_agent.py`

### Allocation rules
- Stocks (AI picks + manually added stocks) sum to 100%
- ETFs (AI ETF picks + manually added ETFs) sum to 100%
- Mixed campaigns have both; each type is validated independently
- `split_config` stores the stock/ETF capital split: `{"stocks_pct": 60, "etfs_pct": 40}`

### Campaign statuses
```
watching → chunk1_placed → chunk2_placed → trailing_sl → exited
```

### The `UNIVERSE` constant
Defined in `ai/stock_picker.py` — a curated list of NSE large/mid-cap stocks to scan. The screener fetches metrics for all UNIVERSE stocks via yfinance. `MAX_SCAN_STOCKS=50` is set in `config.py` but **ignored** — `stock_picker.py` uses a hardcoded cap of 15 to prevent Groq TPM exhaustion.

---

## 16. ETF Support — IMPLEMENTED

- ETF picks provided by `ai/etf_screener.py`
- ETFs added to campaigns via the "ETF" tab in NseStockSearch
- `asset_type: "etf"` field distinguishes ETF rows in campaign stocks
- Angel One: ETFs use bare symbol (not `-EQ` suffix)
- ETF allocation pool is separate from stock allocation pool (each must sum independently to 100%)

---

## 17. Background Schedulers — IMPLEMENTED

All three schedulers run as daemon threads using raw `time.sleep(60)` polling. No APScheduler, Celery, or cron dependency.

```python
# Thread 1: predict actuals filler
# Fires: 15:45–16:00 IST, weekdays only, once per calendar day
# Calls: api.routes.predict.fill_actuals(date)

# Thread 2: strategy monitor
# Fires: every 30 min (on the :00 or :30 minute), 9:15–15:30 IST weekdays
# Calls: data.strategy_monitor.run_monitor_checks()

# Thread 3: Smart Wheel V2 position monitor
# Fires: every 15 min during 9:15–15:30 IST weekdays
# Calls: ai.wheel_v2_agent.monitor_all(username) for each user with active positions
```

**Limitation**: Schedulers are process-local. If running multiple uvicorn workers, each worker runs its own copy of all threads. This causes duplicate alerts and potentially duplicate order placement. Use a single worker (`--workers 1`) in production until this is fixed.

---

## 18. Notification System — PARTIALLY IMPLEMENTED

### Telegram notifications
- Module: `backend/services/notify.py`
- Each user configures their own `telegram_bot_token` and `telegram_chat_id` in wheel config
- Sends via stdlib `urllib.request` POST to Telegram Bot API
- Used by Smart Wheel V2 monitor for amber/red MTM alerts

### In-memory alert ring buffer
- `services/notify.py` maintains a process-global list of recent alerts (not per-user)
- Alerts from all users are mixed together — a privacy concern at scale
- `GET /api/wheel/agent/monitor/alerts` returns the count from this global buffer
- Sidebar polls this endpoint every 5 minutes to show the alert badge

---

## 19. Deployment — EC2

### Infrastructure
- **Instance**: AWS EC2 (Ubuntu 22.04)
- **SSH**: `ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178`
- **App path**: `/home/ubuntu/aegisai/`
- **Frontend static files**: `/var/www/aegisai/`
- **Web server**: nginx (reverse proxy; serves frontend static files)
- **Backend service**: systemd unit `aegisai` (runs uvicorn)

### Start/stop
```bash
# From repo root:
./start.sh    # starts frontend build + uvicorn
./stop.sh     # stops the service

# Or via systemd on EC2:
sudo systemctl start aegisai
sudo systemctl stop aegisai
sudo systemctl status aegisai
```

### Frontend build
```bash
cd frontend
npm run build      # outputs to frontend/dist/
# deploy: rsync dist/ to /var/www/aegisai/ on EC2
```

### Backend start
```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8001
```

### Environment variables (backend/.env)
```
LLM_PROVIDER=groq           # or claude, openai
GROQ_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GROQ_MODEL=qwen/qwen3.8-27b
JWT_SECRET=...              # optional; auto-generated if absent
DATABASE_URL=...            # optional; defaults to SQLite
```

### CORS — NOT PRODUCTION READY
`main.py` hardcodes:
```python
allow_origins=["http://localhost:5173", "http://localhost:3000"]
```
This must be updated for the deployed domain before going live:
```python
allow_origins=os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
```

---

## 20. Environment Variables Reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_PROVIDER` | No | `claude` | LLM backend (`claude`/`openai`/`groq`) |
| `ANTHROPIC_API_KEY` | If Claude | — | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | — | OpenAI API key |
| `GROQ_API_KEY` | If Groq | — | Groq API key |
| `GROQ_MODEL` | No | `qwen/qwen3.8-27b` | Groq model ID |
| `JWT_SECRET` | No | auto-generated | JWT signing secret |
| `DATABASE_URL` | No | `sqlite:///…/aegisai.db` | SQLAlchemy DB URL |
| `ALLOWED_ORIGINS` | **Yes for prod** | *(not implemented)* | CORS origins — must be added |

---

## 21. Known Bugs & Technical Debt

### High priority
1. **Kotak Neo has no token caching** — re-authenticates on every request. Fix: implement session cache in `brokers/kotak_neo.py`.
3. **CORS hardcoded to localhost** — see §19. Blocks all production traffic.
4. **Single-worker requirement** — schedulers run per-process; must use `--workers 1` to avoid duplicate alerts/orders.
5. **jugaad_data not in requirements.txt** — missing import will crash `wheel_agent.py` and `market_brain.py` at first call.

### Medium priority
6. **anthropic not in requirements.txt** — crashes on first LLM call if `LLM_PROVIDER=claude`.
7. **Default admin password** `AegisAI@2024` in auth_utils.py — must be changed on deploy.
8. **Process-global alert buffer** in `services/notify.py` — leaks alert counts across users.
9. **`market_brain._is_monthly()`** — potential loop variable shadowing bug in last-Thursday detection logic.
10. **`config.py::MAX_SCAN_STOCKS=50` is ignored** — `stock_picker.py` uses hardcoded `15`.

### Low priority
11. **Token refresh interceptor** in `api/client.ts` — **confirmed absent**: on 401 the client clears localStorage tokens and redirects to `/login`. The refresh token is stored but unused by the interceptor. Must be implemented before long-running sessions are supported.
12. **Holdings/portfolio pages** use JSON files with no per-user isolation — all users see the same holdings data.
13. **`broker_creds.json` plaintext** — credentials stored unencrypted.
14. **No rate limiting** on auth endpoints — brute-force vulnerable.
15. **Sidebar alert polling** — `GET /api/wheel/agent/monitor/alerts` polled every 5 min by all sidebar instances; not per-user.

---

## 22. Security Considerations

### Critical for production
- **Rotate all credentials**: admin password, JWT secret, all API keys
- **Never commit** the files listed in §23
- **CORS** must be restricted to actual domain (see §19)
- **Broker credentials** must be encrypted at rest (currently plaintext JSON)
- **Rate limiting** on `/api/auth/login` and `/api/auth/register`
- **HTTPS only** in production — enforce via nginx

### Files that MUST NOT be committed (also in .gitignore)
See §23 below.

---

## 23. Files That Must Never Be Committed

The following files contain sensitive data and are in `.gitignore`:

```
backend/.env                    # API keys
backend/.jwt_secret             # JWT signing secret
backend/users.json              # Password hashes + user data
backend/broker_creds.json       # Raw broker API keys, passwords, TOTP secrets
backend/holdings_data.json      # Personal financial positions
backend/portfolio_data.json     # Personal portfolio
backend/strategy_monitor.json   # Personal strategy data
backend/ai_trades.json          # Trade history
backend/stock_trader.json       # Campaign data
backend/wheel_v2_positions.json # Smart Wheel V2 positions
backend/wheel_v2_config.json    # Smart Wheel V2 config (Telegram tokens)
backend/predictions.json        # Prediction data
backend/aegisai.db              # SQLite DB
```

---

## 24. Missing from requirements.txt

Two libraries are used in production code but absent from `requirements.txt`:

```bash
pip install anthropic>=0.25.0    # required if LLM_PROVIDER=claude
pip install jugaad-data          # required by wheel_agent.py + market_brain.py
```

Add to `requirements.txt` before any new deployment.

---

## 25. Development Setup

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install anthropic jugaad-data  # until added to requirements.txt
cp .env.example .env               # create if it doesn't exist; fill in keys
uvicorn main:app --reload --port 8001
```

### Frontend
```bash
cd frontend
npm install
# Create frontend/.env.local:
# VITE_API_URL=http://localhost:8001/api
npm run dev   # starts Vite dev server on port 5173
```

### First run
The default admin account is created automatically if `users.json` doesn't exist:
- Username: `admin`
- Password: `AegisAI@2024`

Change this immediately in Settings or via the admin user management page.

---

## 26. Production Deployment Checklist

1. Set `JWT_SECRET` env var (don't rely on auto-generated file)
2. Set `ALLOWED_ORIGINS` in CORS config (currently hardcoded — must patch `main.py`)
3. Change default admin password
4. Install missing packages: `anthropic`, `jugaad-data`
5. Use `uvicorn --workers 1` (schedulers not safe with multiple workers)
6. Configure SSL/TLS via nginx
7. Set `DATABASE_URL` to PostgreSQL for multi-user production (SQLite has write-lock contention)
8. Never rsync or deploy: `users.json`, `broker_creds.json`, `*.json` state files, `.env`, `.jwt_secret`

---

## 27. Testing — NOT IMPLEMENTED

There are no automated tests in this repository. All testing has been done manually.

Before adding a test framework, the recommended approach:
- **Backend**: pytest + httpx for FastAPI endpoint testing; use a test SQLite DB
- **Frontend**: Vitest + React Testing Library
- **E2E**: Playwright

Critical paths to test first:
1. Auth flow (register → login → token refresh → logout)
2. Campaign creation with validation
3. Smart Wheel V2 enter/assess flow
4. Broker connect/disconnect

---

## 28. Smart Wheel V2 — Strategy Detail

```
Entry conditions (DTE 30–50):
  CE strike = spot + (spot × IV × √(DTE/365) × 2.0) → rounded to nearest step
  PE strike = spot - (spot × IV × √(DTE/365) × 1.0) → rounded to nearest step
  Buy 25% lot × shares at CMP

Phase 1 — Strangle active:
  MTM = net_premium × lot - (CE LTP + PE LTP) × lot + equity_PnL
  amber: MTM < -6000 (notify + recommend exit)
  red:   MTM < -10000 (strong exit recommendation)

  CMP crosses CE-BE upward → close all → profit
  CMP crosses PE-BE downward → exit PE at loss, buy 25% more shares → Phase 2

Phase 2 — Covered Call:
  Short CE only + 50% lot shares
  CMP crosses CE-BE → close all → profit

Strike step sizes:
  price < 500  → 10
  price < 1000 → 20
  price < 2000 → 50
  price < 5000 → 100
  else         → 200
```

**Live execution**: Paper entry only. Live broker order placement for Wheel V2 is not implemented.

---

## 29. Campaign JSON Schema (stock_trader.json)

```json
{
  "campaign_id": {
    "id": "uuid",
    "user": "username",
    "name": "My Campaign",
    "broker": "angelone",
    "reserved_fund": 100000,
    "auto_trade": false,
    "status": "active",
    "split_config": {"stocks_pct": 60, "etfs_pct": 40},
    "entry_condition": {"type": "market_open"},
    "chunk_config": {"chunks": [{"pct": 60}, {"pct": 40}]},
    "exit_config": {"profit_target_pct": 2.0, "sl_pct": 1.5},
    "stocks": [
      {
        "symbol": "RELIANCE",
        "display": "Reliance Industries",
        "sector": "Energy",
        "cap_type": "large",
        "allocation_pct": 30,
        "conviction": "HIGH",
        "justification": "Strong Q3 results...",
        "asset_type": "stock",
        "status": "watching",
        "chunk1_qty": 0, "chunk1_price": 0,
        "chunk2_qty": 0, "chunk2_price": 0,
        "avg_price": 0, "total_qty": 0,
        "sl_price": 0, "current_price": 0,
        "pnl": 0, "pnl_pct": 0
      }
    ]
  }
}
```

---

## 30. NseStockSearch Component

`frontend/src/components/NseStockSearch.tsx` — reusable async stock/ETF search with autocomplete dropdown.

### Props
```typescript
interface NseStockSearchProps {
  placeholder?: string
  onSelect: (symbol: string, name: string, sector?: string) => void
  includeEtfIndex?: boolean   // true to search ETFs/indices as well
}
```

### Overflow/clipping rule — IMPORTANT
This component renders an absolutely positioned dropdown. It MUST NOT be placed inside a container with `overflow-y-auto` or `overflow-hidden`, or the dropdown will be visually clipped regardless of z-index. Always place `<NseStockSearch>` outside scroll containers.

---

## 31. Frontend API Client

`frontend/src/api/client.ts` — Axios instance.

- Base URL: `import.meta.env.VITE_API_URL` (defaults to `http://localhost:8001/api`)
- Attaches `Authorization: Bearer <token>` from `authStore` on every request
- Handles 401 (may need refresh token interceptor — verify in code)

---

## 32. Admin Features — IMPLEMENTED

- `/admin` page in frontend (visible only to `admin` role in sidebar)
- List all users, view roles, change roles, deactivate/delete users
- `POST /api/admin/users/{username}/set-role` — role change API
- Only admin can elevate users to `live_trader` (self-registration always creates `paper_trader`)

---

## 33. Sidebar & Navigation

### Desktop (md+)
- `frontend/src/components/layout/Sidebar.tsx`
- Collapsible (`w-56` ↔ `w-14`) via toggle button
- Locked items shown with `🔒` icon (still navigable — shows UpgradeWall)
- Role badge in footer
- Polls `/api/wheel/agent/monitor/alerts` every 5 minutes (strategy alert count badge)
- Admin section shown only to `role === 'admin'`

### Mobile (< md)
- Sidebar is hidden (`hidden md:block`)
- `MobileBottomNav` in App.tsx: 5-tab fixed bottom bar
- Bottom padding on main content (`pb-16`) prevents content being hidden behind nav

---

## 34. ORM Migration Roadmap — PLANNED

The SQLAlchemy ORM schema is in place. The migration path:

1. `auth_utils.py` → replace `_load_users()` / `_save_users()` with ORM queries
2. `data/broker_creds.py` → replace JSON file with `BrokerSession` model
3. `api/routes/stock_trader.py` → replace `stock_trader.json` reads with `Campaign` + `CampaignStock` ORM
4. `data/wheel_positions.py` → replace JSON files with `WheelPosition` + `WheelConfig` ORM
5. Other JSON stores (portfolio, holdings, predictions) — add ORM models + migrate

Each step is independent. Recommended order: auth → broker_creds → campaigns → wheel.

---

## 35. Feature Status Matrix

| Feature | Backend | Frontend | Notes |
|---|---|---|---|
| Multi-user auth (JWT) | IMPLEMENTED | IMPLEMENTED | JSON file storage |
| Self-registration | IMPLEMENTED | IMPLEMENTED | |
| Role-based access control | IMPLEMENTED | IMPLEMENTED | |
| Token refresh | IMPLEMENTED | PARTIALLY | Interceptor may be missing in client.ts |
| Admin user management | IMPLEMENTED | IMPLEMENTED | |
| Market dashboard | IMPLEMENTED | IMPLEMENTED | |
| Discover stocks | IMPLEMENTED | IMPLEMENTED | |
| Holdings view | IMPLEMENTED | IMPLEMENTED | No per-user isolation |
| Portfolio view | IMPLEMENTED | IMPLEMENTED | No per-user isolation |
| AI Stock Picks | IMPLEMENTED | IMPLEMENTED | Rule-based fallback available |
| ETF Picks | IMPLEMENTED | IMPLEMENTED | |
| Campaign creation | IMPLEMENTED | IMPLEMENTED | |
| Campaign execution (live) | IMPLEMENTED | IMPLEMENTED | Broker key bug: see §21 |
| AI Insights | IMPLEMENTED | IMPLEMENTED | |
| Market Brain | IMPLEMENTED | IMPLEMENTED | Requires jugaad_data |
| Covered Calls | IMPLEMENTED | IMPLEMENTED | |
| Wheel V1 strategy | IMPLEMENTED | IMPLEMENTED | |
| Smart Wheel V2 | IMPLEMENTED | IMPLEMENTED | Paper entry only |
| Smart Wheel V2 live execution | NOT IMPLEMENTED | N/A | |
| Strategy Monitor | IMPLEMENTED | IMPLEMENTED | |
| Broker connect (Angel One) | IMPLEMENTED | IMPLEMENTED | TOTP auto |
| Broker connect (Kotak Neo) | IMPLEMENTED | IMPLEMENTED | No token cache |
| Telegram notifications | IMPLEMENTED | — | Per-user config in wheel settings |
| SQLAlchemy ORM | PARTIALLY | N/A | Schema only; no data migration |
| PostgreSQL support | PARTIALLY | N/A | URL config works; needs migration |
| Mobile responsive layout | IMPLEMENTED | IMPLEMENTED | |
| PWA | PARTIALLY | PARTIALLY | Meta tags only; no service worker |
| Stripe billing | PLANNED | PLANNED | stripe_customer column in User model |
| Email verification | PLANNED | PLANNED | email_verified column in User model |
| Password reset | NOT IMPLEMENTED | NOT IMPLEMENTED | |
| Screener tab (chip-based) | NOT IMPLEMENTED | NOT IMPLEMENTED | Plan exists |
| Automated tests | NOT IMPLEMENTED | NOT IMPLEMENTED | |

---

## 36. Python Dependencies

From `backend/requirements.txt` + known additions:

```
fastapi>=0.115.0
uvicorn[standard]>=0.29.0
openai>=1.0.0
python-dotenv>=1.2.2
smartapi-python>=1.5.5
pyotp>=2.8.0
python-jose[cryptography]>=3.3.0
passlib[bcrypt]>=1.7.4
websocket-client>=1.0
logzero>=1.7.0
yfinance>=0.2.0
groq>=0.4.0
sqlalchemy>=2.0.0
psycopg2-binary>=2.9.0

# MISSING — must add:
anthropic>=0.25.0      # required if LLM_PROVIDER=claude
jugaad-data            # required by wheel_agent + market_brain
```

---

## 37. Critical Warnings for the Next Developer

1. **The ORM schema exists but stores nothing** — all reads/writes still use JSON files. Do not assume data is in the SQLite DB.

2. **Do not run with `--workers > 1`** — the three background daemon threads are not safe for multi-worker deployment. Alerts and orders would be duplicated.

3. **CORS is broken for production** — `allow_origins` in `main.py` is hardcoded to localhost. Fix before deploying.

4. **jugaad_data and anthropic are not installed by default** — `pip install -r requirements.txt` will not install them. Wheel and Market Brain features will crash without jugaad_data.

5. **StockTrader.tsx is 2400+ lines** — the largest single file. Consider splitting into sub-components before adding more features.

6. **The NseStockSearch overflow rule** — never place this component inside an `overflow-y-auto` container (dropdown gets clipped). This has been a recurring bug.

7. **Scheduler threads poll in 60s loops** — they will not fire exactly on time. The Wheel V2 monitor fires "at the next 15-min slot after the current real time" with up to 60s lag.

8. **Campaign allocation validation is client-side only** — the backend validates that stock allocations sum to 100%, but the frontend performs this check first to give better UX. Both layers must agree.

9. **Admin password must be rotated** — `auth_utils.py` line 43: `DEFAULT_ADMIN` has password `AegisAI@2024`. This is the first thing to fix in any deployment.

10. **Broker credential encryption is aspirational** — the comment `"encrypted at rest in prod"` in `models.py` is not implemented. Credentials are plaintext in `broker_creds.json`.
