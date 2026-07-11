#!/bin/bash

# AegisAI — Start both backend and frontend servers
# Usage: ./start.sh
# Stop:  ./stop.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
LOG_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOG_DIR"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m"

echo ""
echo -e "${BLUE}  🛡  AEGIS AI — Investment Intelligence Platform${NC}"
echo -e "${BLUE}  ──────────────────────────────────────────────${NC}"
echo ""

# ── Kill any existing instances ───────────────────────────────────────────────
pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

# ── Check Python ──────────────────────────────────────────────────────────────
PYTHON=$(command -v python3 || command -v python)
if [ -z "$PYTHON" ]; then
  echo -e "${RED}✗ Python not found. Please install Python 3.9+${NC}"
  exit 1
fi

# ── Install backend dependencies if needed ────────────────────────────────────
echo -e "${YELLOW}→ Checking backend dependencies...${NC}"
cd "$BACKEND_DIR"
$PYTHON -c "import fastapi, uvicorn, yfinance, anthropic, pandas, jugaad_data" 2>/dev/null || {
  echo -e "${YELLOW}  Installing missing packages...${NC}"
  pip3 install fastapi openai jugaad-data python-dotenv 2>/dev/null | tail -2
}

# ── Check .env file ───────────────────────────────────────────────────────────
if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo -e "${YELLOW}  Creating default .env file...${NC}"
  echo "LLM_PROVIDER=claude" > "$BACKEND_DIR/.env"
  echo "ANTHROPIC_API_KEY=" >> "$BACKEND_DIR/.env"
  echo "OPENAI_API_KEY=" >> "$BACKEND_DIR/.env"
fi

# ── Start backend ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}→ Starting backend (FastAPI) on port 8001...${NC}"
cd "$BACKEND_DIR"
nohup $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8001 --log-level warning \
  > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo $BACKEND_PID > "$LOG_DIR/backend.pid"

# Wait for backend to be ready
for i in $(seq 1 15); do
  sleep 1
  if curl -s http://localhost:8001/health > /dev/null 2>&1; then
    echo -e "${GREEN}  ✓ Backend ready  →  http://localhost:8001${NC}"
    break
  fi
  if [ $i -eq 15 ]; then
    echo -e "${RED}  ✗ Backend failed to start. Check logs/backend.log${NC}"
    cat "$LOG_DIR/backend.log" | tail -10
    exit 1
  fi
done

# ── Check Node / install frontend deps ───────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Please install Node.js 18+${NC}"
  exit 1
fi

echo -e "${YELLOW}→ Checking frontend dependencies...${NC}"
cd "$FRONTEND_DIR"
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}  Running npm install...${NC}"
  npm install --silent
fi

# ── Start frontend ────────────────────────────────────────────────────────────
echo -e "${YELLOW}→ Starting frontend (Vite) on port 5173...${NC}"
nohup npm run dev -- --host 0.0.0.0 \
  > "$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo $FRONTEND_PID > "$LOG_DIR/frontend.pid"

# Wait for frontend to be ready
for i in $(seq 1 20); do
  sleep 1
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ 2>/dev/null | grep -q "200"; then
    echo -e "${GREEN}  ✓ Frontend ready  →  http://localhost:5173${NC}"
    break
  fi
  if [ $i -eq 20 ]; then
    echo -e "${RED}  ✗ Frontend failed to start. Check logs/frontend.log${NC}"
    cat "$LOG_DIR/frontend.log" | tail -10
    exit 1
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ✅  AegisAI is running!${NC}"
echo ""
echo -e "  Dashboard  →  ${BLUE}http://localhost:5173${NC}"
echo -e "  API Docs   →  ${BLUE}http://localhost:8001/docs${NC}"
echo ""
echo -e "  Logs:  ${YELLOW}./logs/backend.log${NC}  |  ${YELLOW}./logs/frontend.log${NC}"
echo -e "  Stop:  ${YELLOW}./stop.sh${NC}"
echo ""
