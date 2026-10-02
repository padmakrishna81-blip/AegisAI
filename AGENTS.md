# AGENTS.md — AegisAI Coding Agent Instructions

> Provider-neutral instructions for any AI coding agent working on this repository.
> Read `design.md` first for full architecture context.

---

## 1. Repository at a Glance

AegisAI is an AI-powered investment-intelligence platform for Indian equity markets. It has a Python/FastAPI backend and a React/TypeScript/Vite frontend.

```
backend/   Python 3.11+, FastAPI, SQLAlchemy (SQLite/PostgreSQL), JWT auth
frontend/  React 18, TypeScript 5.7, Vite 6, Zustand, Tailwind CSS, Recharts
```

---

## 2. Before Your First Edit

**Read these files in order:**
1. `design.md` — full architecture, feature status, known bugs
2. `backend/main.py` — app entry point, router registration, daemon threads
3. `backend/auth/auth_utils.py` — role system
4. `backend/data/models.py` — ORM schema
5. `frontend/src/App.tsx` — routing, layout, guards

**Critical facts to know before touching anything:**

- **All data is in JSON files**, not the database. The SQLAlchemy ORM (7 models) was created to establish schema; no feature code uses it yet. Do not assume data is in `aegisai.db`.
- **Never commit** the files listed in `design.md §23`. Check `.gitignore` before every commit.
- **CORS is hardcoded to localhost** (`main.py`). Do not deploy without fixing this.
- **Two packages are missing from requirements.txt**: `anthropic` and `jugaad-data`. Install them manually if testing those features.
- **Do not run uvicorn with `--workers > 1`**. Background scheduler threads are not multi-process safe.

---

## 3. Project Structure

```
backend/
  main.py              FastAPI app + daemon thread launchers
  config.py            Settings (env vars)
  requirements.txt     Dependencies (missing: anthropic, jugaad-data)
  auth/
    auth_utils.py      JWT, user CRUD, role enforcement
  api/routes/          One file per feature domain
    auth.py            /auth/* and /admin/* endpoints
    stock_trader.py    AI Stock Trader campaigns
    wheel_v2.py        Smart Wheel V2
    wheel_agent.py     Wheel V1
    broker.py          Broker connect/disconnect
    market_brain.py    Macro + option chain
    … (18 more)
  ai/
    llm_client.py      Claude/OpenAI/Groq unified gateway
    stock_picker.py    Stock universe + AI picks
    etf_screener.py    ETF picks
    trade_agent.py     Campaign order execution
    wheel_v2_agent.py  Smart Wheel V2 strategy engine
    wheel_agent.py     Wheel V1 strategy
    market_brain.py    Macro analysis
  data/
    db.py              SQLAlchemy engine + init_db()
    models.py          ORM models (schema only — not in use)
    broker_creds.py    JSON-backed broker credential store
    wheel_positions.py JSON-backed Wheel V2 position store
    market_data.py     yfinance wrapper with in-memory cache
  brokers/
    angel_one.py       Angel One SDK wrapper
    kotak_neo.py       Kotak Neo raw HTTP client
  services/
    notify.py          Telegram notifications + alert ring buffer
  engines/             Six scoring sub-engines + recommendation orchestrator
    recommendation.py  Runs all 6 engines concurrently via ThreadPoolExecutor
    company_health.py / technical_strength.py / growth_trend.py
    sector_strength.py / business_events.py / macro_environment.py

frontend/src/
  App.tsx              Router, guards, layout, MobileBottomNav
  store/authStore.ts   Zustand auth store + role helpers
  api/client.ts        Axios instance + auth interceptor
  pages/
    StockTrader.tsx    AI Stock Trader (largest file — 2400+ lines)
    Wheel.tsx          Wheel V1
    WheelV2.tsx        Smart Wheel V2
    Login.tsx / Register.tsx
    … (12 more)
  components/
    NseStockSearch.tsx Async stock/ETF autocomplete
    layout/Sidebar.tsx Collapsible desktop sidebar
    layout/Header.tsx
```

---

## 4. Architecture Rules

### Backend
1. **All new endpoints** go in a route file under `api/routes/`, included in `main.py` with `prefix="/api"`.
2. **Auth on all user-facing endpoints**: use `Depends(get_current_user)` from `api/routes/auth.py`. For role-restricted endpoints: `Depends(require_role('live_trader'))` from `auth/auth_utils.py`.
3. **All blocking/CPU-bound work** must be run via `asyncio.run_in_executor` (ThreadPoolExecutor). Never `await` a blocking call directly.
4. **Clean numpy/float before returning**: either use `convert_numpy()` from `main.py` or the `_clean_nan()` pattern from `stock_trader.py`.
5. **No new JSON state files** — if persisting new data, add an ORM model to `data/models.py` and use SQLAlchemy sessions. This advances the DB migration.
6. **Existing JSON stores** — do not move them to the DB mid-feature without migrating all callers. Partial migration causes split-brain.
7. **LLM calls** — always check if the response starts with `[LLM` before trusting it (indicates an error string). Provide rule-based fallback.
8. **yfinance symbols** — stocks use `SYMBOL.NS`, ETFs use bare symbol. Angel One broker uses `SYMBOL-EQ` for stocks, bare for ETFs.

### Frontend
1. **State lives in Zustand** (`authStore`). Do not use React Context for auth or cross-page state.
2. **Role checks** — use `hasMinRole(user, 'paper_trader')` or `hasRole(user, 'admin')` from `authStore.ts`. Never check `user.role === 'paper_trader'` directly (ignores hierarchy).
3. **New routes** — add to `App.tsx` inside `ProtectedLayout`. Wrap in role gate: `{isPaper ? <NewPage /> : <UpgradeWall minRole="paper_trader" />}`.
4. **New nav items** — add to `NAV_ITEMS` in `Sidebar.tsx` with a `min_role` field.
5. **NseStockSearch must not be inside an overflow container** — place it outside any `overflow-y-auto` parent. This is a hard CSS constraint. See `design.md §30`.
6. **No inline styles** — use Tailwind classes. Use `className` composition, not `style={{}}` except when Tailwind cannot express the value.
7. **Mobile padding** — any new full-page layout must include `pb-16 md:pb-0` on the main scrollable container to clear the mobile bottom nav.

---

## 5. Coding Conventions

### Python
- Type hints on all function signatures
- Module docstrings explain the strategy or domain
- Exceptions in route handlers: catch broadly, return `JSONResponse({"error": str(e)}, status_code=500)`
- Secrets: never hardcode. Use `os.getenv()` or `config.py` Settings class
- Threading: use `threading.Lock()` for any JSON file read-write pair

### TypeScript / React
- Functional components only. No class components
- `useState` + `useEffect` for local state; Zustand for shared state
- Prefer explicit type annotations over `any`; use `unknown` + type narrowing for error catches
- Tailwind class strings: keep long className values on a single line or use template literals with clear grouping
- File-scoped constants (like tab definitions) go above the component

### General
- No test files in source directories — keep tests in a `tests/` directory when they are added
- No `console.log` left in committed frontend code
- No `print()` left in committed backend code (use `logging.getLogger("aegisai")`)

---

## 6. Key Commands

### Backend
```bash
# Install deps
cd backend
pip install -r requirements.txt
pip install anthropic jugaad-data   # until added to requirements.txt

# Run dev server
uvicorn main:app --reload --port 8001

# Test a specific Python module directly
python3 -c "from ai.stock_picker import get_ai_picks; import json; print(json.dumps(get_ai_picks(), indent=2))"

# Flush yfinance cache (dev)
curl -X POST http://localhost:8001/api/admin/flush-cache
```

### Frontend
```bash
cd frontend
npm install
npm run dev          # Vite dev server on :5173
npm run build        # TypeScript check + Vite build → dist/
```

### Git
```bash
# Check what would be committed
git status
git diff --staged

# Never commit these:
backend/.env  backend/.jwt_secret  backend/users.json  backend/broker_creds.json
backend/holdings_data.json  backend/portfolio_data.json  backend/stock_trader.json
backend/wheel_v2_positions.json  backend/wheel_v2_config.json
backend/strategy_monitor.json  backend/predictions.json
backend/aegisai.db
```

---

## 7. Adding a New Feature — Checklist

### Backend endpoint
- [ ] Create or edit a route file in `backend/api/routes/`
- [ ] Register the router in `backend/main.py` if it's a new file
- [ ] Add `Depends(get_current_user)` to all endpoints
- [ ] Add `Depends(require_role('live_trader'))` for live-trader-only operations
- [ ] Run blocking operations via `run_in_executor`
- [ ] Return `JSONResponse` with cleaned data (no numpy types, no NaN/Inf)
- [ ] Add an ORM model to `data/models.py` if persisting new data

### Frontend page
- [ ] Create `frontend/src/pages/NewPage.tsx`
- [ ] Add route in `App.tsx` under `ProtectedLayout`
- [ ] Add nav item in `Sidebar.tsx` `NAV_ITEMS` with appropriate `min_role`
- [ ] Gate with `UpgradeWall` if role-restricted
- [ ] Add `pb-16 md:pb-0` on the outermost scrollable div

### Role-gated feature
- [ ] Backend: `Depends(require_role('paper_trader'))` or `require_role('live_trader')`
- [ ] Frontend App.tsx: `isPaper ? <Feature /> : <UpgradeWall minRole="paper_trader" />`
- [ ] Frontend Sidebar: `min_role: 'paper_trader'` in NAV_ITEMS entry
- [ ] Frontend: any buttons/CTAs inside the page should also check `hasMinRole`

---

## 8. The Role System

### Levels (higher = more access)
```
viewer (0) < paper_trader (1) < live_trader (2) < admin (99)
```

### Backend usage
```python
# In a route file:
from api.routes.auth import get_current_user
from auth.auth_utils import require_role

# Any authenticated user:
async def endpoint(user=Depends(get_current_user)):

# Minimum role check:
async def endpoint(user=Depends(require_role('live_trader'))):

# Check in code:
from auth.auth_utils import has_min_role
if has_min_role(user, 'paper_trader'):
    ...
```

### Frontend usage
```typescript
import { useAuthStore, hasMinRole, hasRole } from '../store/authStore'
const { user } = useAuthStore()
const isPaper = hasMinRole(user, 'paper_trader')
const isLive  = hasMinRole(user, 'live_trader')
```

### Self-registration always creates `paper_trader`
Admin must manually upgrade to `live_trader` via Settings → Admin → Users.

---

## 9. LLM Integration

```python
from ai.llm_client import call_llm, is_configured

if not is_configured():
    # Return rule-based fallback immediately
    return rule_based_result()

response = call_llm(
    prompt="Analyze ...",
    system="You are an expert ...",
    max_tokens=1024
)

if response.startswith('[LLM'):
    # LLM returned an error string — use fallback
    return rule_based_result()

# Parse response (usually JSON in the text)
```

- Provider is set by `LLM_PROVIDER` env var: `claude`, `openai`, or `groq`
- Groq uses Qwen3 (reasoning model) — strips `<think>...</think>` blocks automatically
- Responses are cached 1 hour in-memory by (provider + prompt MD5)
- `anthropic` library must be installed manually if using Claude (see §6)

---

## 10. Broker Integration

### Connecting
```python
from data.broker_creds import get_raw_creds, get_session, auto_reconnect

creds   = get_raw_creds(username, 'angelone')
session = get_session(username, 'angelone')
if not session:
    session = auto_reconnect(username, 'angelone')
    if not session:
        raise HTTPException(400, "Not connected to broker")
```

### Placing orders (Angel One)
```python
from brokers.angel_one import AngelOneClient
client = AngelOneClient(session, cache_key=f"{username}:angelone")
order_id = client.place_order(
    symbol="RELIANCE-EQ",     # stocks: SYMBOL-EQ, ETFs: bare symbol
    qty=10,
    side="BUY",               # BUY or SELL
    order_type="MARKET"       # MARKET or LIMIT
)
```

### Known bugs
- `get_funds()` in `trade_agent.py` uses key `net_available` but Angel One returns `available_cash`
- Kotak Neo re-authenticates on every request (no session caching)

---

## 11. ORM / Database

### Current state
The ORM models exist (`data/models.py`). Tables are created at startup. **No feature code uses the ORM yet.** All reads/writes are JSON files.

### Using the ORM in new code
```python
from data.db import get_db
from data.models import Campaign

# In a FastAPI route:
@router.get("/campaigns")
async def get_campaigns(user=Depends(get_current_user), db=Depends(get_db)):
    campaigns = db.query(Campaign).filter(Campaign.user_id == user["id"]).all()
    return campaigns
```

### Adding a new model
1. Add class to `data/models.py` extending `Base`
2. Run `init_db()` (or the app restart will create the table)
3. Do NOT use `Base.metadata.drop_all()` in production — use Alembic migrations

### Switching to PostgreSQL
```bash
export DATABASE_URL="postgresql+psycopg2://user:pass@host/aegisai"
# psycopg2-binary is already in requirements.txt
```

---

## 12. Common Pitfalls

### 1. NseStockSearch dropdown clipped
If `<NseStockSearch>` is inside an `overflow-y-auto` div, the dropdown is invisible. Always place it outside scroll containers.

```tsx
{/* WRONG — inside overflow container */}
<div className="overflow-y-auto">
  <NseStockSearch ... />
</div>

{/* CORRECT — outside overflow container */}
<div className="overflow-y-auto">...</div>
<NseStockSearch ... />   {/* placed after the scroll container */}
```

### 2. Numpy types in JSON responses
yfinance returns numpy int64/float64 which cannot be JSON-serialized directly. Always clean:
```python
from main import convert_numpy
return JSONResponse(convert_numpy(result))
```

### 3. LLM error strings vs real responses
```python
result = call_llm(prompt)
if result.startswith('[LLM'):
    # This is an error message — do not parse as JSON
    ...
```

### 4. Multi-user JSON files
Most JSON stores use `{username: {...}}` top-level keying. When reading/writing, always scope to `data.get(username, {})`.

### 5. Campaign allocation validation
Both frontend and backend validate independently. Stock allocations must sum to 100±1%; ETF allocations must sum to 100±1% (each independently). A campaign can have stocks only, ETFs only, or both.

### 6. Role check hierarchy
`admin` always passes `has_min_role()` and `has_role()` checks. Never special-case admin separately — the role level (99) handles it.

---

## 13. Security Rules

1. **Never log or print credentials** (API keys, passwords, TOTP secrets)
2. **Never echo user input into shell commands** (no subprocess with user data)
3. **Validate and sanitize** all user input at the API boundary
4. **Auth on every route** — `Depends(get_current_user)` is mandatory. `/health` and `/` are the only intentional exceptions
5. **Broker credentials** are currently plaintext in JSON — do not add new credential fields without noting this limitation
6. **JWT tokens** are signed but not encrypted — do not put sensitive data in JWT claims
7. **admin role** can access all endpoints that use `require_role` — do not bypass this with hardcoded username checks

---

## 14. Data Files — Access Patterns

| File | Who reads | Who writes | Thread-safe? |
|---|---|---|---|
| `users.json` | auth_utils.py | auth_utils.py | No explicit lock (single-process OK) |
| `broker_creds.json` | broker_creds.py | broker_creds.py | threading.Lock ✓ |
| `wheel_v2_positions.json` | wheel_positions.py | wheel_positions.py | threading.Lock ✓ |
| `wheel_v2_config.json` | wheel_positions.py | wheel_positions.py | threading.Lock ✓ |
| `stock_trader.json` | stock_trader route | stock_trader route | No lock (risk: concurrent writes) |
| `portfolio_data.json` | portfolio route | portfolio route | No lock |
| `holdings_data.json` | holdings route | holdings route | No lock |
| `predictions.json` | predict route | predict route | No lock |
| `strategy_monitor.json` | monitor data module | monitor data module | No lock |

---

## 15. Unresolved / Unknown Areas

1. **`frontend/src/api/client.ts` refresh interceptor** — confirmed absent. On 401 the client clears localStorage and redirects to `/login`. The refresh token is in `localStorage` (`aegis_refresh`) but the interceptor does not use it. This means users are logged out on token expiry even though a valid refresh token exists.
2. **Holdings/Portfolio JSON files** — appear to be single-user (no `username` keying). Multi-user isolation is not implemented for these pages.
3. **`paper_trades.json` vs `PaperTrade` ORM model** — unclear which is the source of truth for paper trade history on the Trade page.
4. **`services/notify.py` alert ring buffer** — alerts from all users mixed together. Unclear what the maximum buffer size is.
5. **`market_brain._is_monthly()`** — potential loop variable shadowing bug in last-Thursday detection. Needs a unit test before relying on monthly expiry detection logic.

---

## 16. Things the Next Agent Should Do First

In priority order:

1. **Add to requirements.txt**: `anthropic>=0.25.0` and `jugaad-data`
2. **Fix CORS**: replace hardcoded origins in `main.py` with an env var
3. **Fix `get_funds()` key**: `trade_agent.py` — change `net_available` → `available_cash`
4. **Implement refresh token interceptor** in `frontend/src/api/client.ts` (currently clears tokens and redirects on 401; should use stored `aegis_refresh` to get a new access token first)
5. **Add Alembic** for database migrations before any schema changes to `data/models.py`
6. **Migrate auth to ORM**: replace `users.json` CRUD in `auth_utils.py` with SQLAlchemy queries using the `User` model (first migration step — see `design.md §34`)
