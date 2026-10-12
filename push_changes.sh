#!/bin/bash
# AegisAI — Build frontend and deploy to EC2
# Usage: ./push_changes.sh
#        ./push_changes.sh --skip-build   (if dist/ is already fresh)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
EC2_HOST="ubuntu@13.202.218.119"
EC2_KEY="$HOME/.ssh/aegisai-key.pem"
EC2_APP_DIR="/home/ubuntu/aegisai"
EC2_WEB_ROOT="/var/www/aegisai"

GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m"

SKIP_BUILD=false
for arg in "$@"; do
  [ "$arg" = "--skip-build" ] && SKIP_BUILD=true
done

echo ""
echo -e "${BLUE}  🛡  AegisAI — Deploy to EC2${NC}"
echo -e "${BLUE}  ──────────────────────────${NC}"
echo ""

# ── Preflight checks ──────────────────────────────────────────────────────────
if [ ! -f "$EC2_KEY" ]; then
  echo -e "${RED}✗ SSH key not found: $EC2_KEY${NC}"
  exit 1
fi

# ── Git: commit check ─────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"
UNCOMMITTED=$(git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')
if [ "$UNCOMMITTED" -gt 0 ]; then
  echo -e "${YELLOW}⚠ You have $UNCOMMITTED uncommitted change(s):${NC}"
  git status --short | grep -v '^??'
  echo ""
  read -r -p "  Commit and push before deploying? [Y/n] " choice
  choice="${choice:-Y}"
  if [[ "$choice" =~ ^[Yy]$ ]]; then
    git add -A
    echo -e "${YELLOW}→ Enter commit message (or press Enter for default):${NC}"
    read -r msg
    msg="${msg:-chore: pre-deploy commit}"
    git commit -m "$msg"
    git push origin main
    echo -e "${GREEN}  ✓ Pushed to GitHub${NC}"
  else
    echo -e "${YELLOW}  Skipping git push — deploying local build only${NC}"
  fi
else
  # Push any unpushed commits
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  if [ "$AHEAD" -gt 0 ]; then
    echo -e "${YELLOW}→ Pushing $AHEAD unpushed commit(s) to GitHub...${NC}"
    git push origin main
    echo -e "${GREEN}  ✓ Pushed${NC}"
  fi
fi

# ── Build frontend ────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${YELLOW}→ Building frontend...${NC}"
  cd "$FRONTEND_DIR"
  npm run build 2>&1 | tail -5
  echo -e "${GREEN}  ✓ Build complete → dist/${NC}"
else
  echo -e "${YELLOW}→ Skipping build (--skip-build)${NC}"
fi

# ── Pull backend on EC2 ───────────────────────────────────────────────────────
echo -e "${YELLOW}→ Pulling latest code on EC2...${NC}"
ssh -i "$EC2_KEY" -o ConnectTimeout=15 "$EC2_HOST" \
  "cd $EC2_APP_DIR && git pull origin main && sudo systemctl restart aegisai && sudo systemctl is-active aegisai"
echo -e "${GREEN}  ✓ Backend updated and restarted${NC}"

# ── Rsync frontend dist ───────────────────────────────────────────────────────
echo -e "${YELLOW}→ Uploading frontend build...${NC}"
rsync -az --delete "$FRONTEND_DIR/dist/" \
  -e "ssh -i $EC2_KEY -o ConnectTimeout=15" \
  "$EC2_HOST:$EC2_WEB_ROOT/"
echo -e "${GREEN}  ✓ Frontend deployed${NC}"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ✅  Deploy complete!${NC}"
echo ""
echo -e "  Live app  →  ${BLUE}http://13.202.218.119${NC}"
echo ""
