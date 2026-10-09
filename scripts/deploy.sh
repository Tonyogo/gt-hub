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

echo "===> [1/4] Pulling latest code from origin/main..."
git fetch origin main
git reset --hard origin/main

echo "===> [2/4] Installing dependencies..."
npm install

echo "===> [3/4] Building frontend and backend..."
npm run build

echo "===> [4/4] Reloading PM2 process..."
pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js

echo "===> Process Status:"
pm2 status gt-hub || true

echo "=========================================="
echo "Deployment completed successfully!"
echo "=========================================="
