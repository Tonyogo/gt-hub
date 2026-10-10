#!/usr/bin/env bash
set -e

# Load user environment variables (e.g. NVM, Node, PM2 paths)
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
[ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

echo "=========================================="
echo "Deployment Directory : $(pwd)"
echo "Node Version         : $(node -v 2>/dev/null || echo 'not found')"
echo "NPM Version          : $(npm -v 2>/dev/null || echo 'not found')"
echo "PM2 Version          : $(pm2 -v 2>/dev/null || echo 'not found')"
echo "=========================================="

echo "===> [1/5] Pulling latest code from origin/main..."
git fetch origin main
git reset --hard origin/main

# Inspect current git commit and package version
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
COMMIT_TITLE=$(git log -1 --pretty=%B 2>/dev/null | head -n 1 || echo "")
BASE_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")

echo "------------------------------------------"
echo "Deploying Target Version : v${BASE_VERSION}+${GIT_COMMIT}"
echo "Current Git Commit       : ${GIT_COMMIT} - \"${COMMIT_TITLE}\""
echo "------------------------------------------"

echo "===> [2/5] Installing dependencies..."
npm install

echo "===> [3/5] Building frontend, backend, and CLI..."
npm run build

echo "===> [4/5] Reloading PM2 process..."
pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js

echo "===> Process Status:"
pm2 status gt-hub || true

echo "===> [5/5] Performing Health Check & Version Verification..."
# Wait brief moment for server to bind port
sleep 2

# Probe local health check endpoint
HEALTH_URL="http://127.0.0.1:8000/health"
HEALTH_STATUS="failed"
for i in 1 2 3 4 5; do
  HEALTH_RESP=$(curl -fsSL "$HEALTH_URL" 2>/dev/null || echo "")
  if [ -n "$HEALTH_RESP" ] && echo "$HEALTH_RESP" | grep -q '"status":"ok"'; then
    HEALTH_STATUS="ok"
    REPORTED_VERSION=$(echo "$HEALTH_RESP" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "")
    echo "✓ Health check passed! Server is active (status: ok, version: ${REPORTED_VERSION})"
    break
  fi
  sleep 1
done

if [ "$HEALTH_STATUS" != "ok" ]; then
  echo "⚠️ Warning: Health check did not respond with 200 OK within 5s at $HEALTH_URL."
  echo "Please verify PM2 logs with: pm2 logs gt-hub"
fi

echo "=========================================="
echo "Deployment completed successfully! (Version: v${BASE_VERSION}+${GIT_COMMIT})"
echo "=========================================="
