#!/bin/bash

# AegisAI — Stop both servers

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
NC="\033[0m"

echo -e "${YELLOW}→ Stopping AegisAI servers...${NC}"

# Kill by PID file if available
for svc in backend frontend; do
  PID_FILE="$LOG_DIR/$svc.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null && echo -e "${GREEN}  ✓ $svc stopped (pid $PID)${NC}"
    rm -f "$PID_FILE"
  fi
done

# Fallback: kill by process name
pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true

echo -e "${GREEN}  ✓ Done${NC}"
