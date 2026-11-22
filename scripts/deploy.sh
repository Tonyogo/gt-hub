#!/usr/bin/env bash

# Load user environment variables and ensure PM2 is present
ensure_pm2() {
  [ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
  [ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
  [ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

  if [ -d "./node_modules/.bin" ]; then
    export PATH="./node_modules/.bin:$PATH"
  fi

  if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2 not found in PATH. Attempting installation..."
    npm install -g pm2 2>/dev/null || sudo -n npm install -g pm2 2>/dev/null || npm install pm2 --save-dev 2>/dev/null || true
  fi

  echo "=========================================="
  echo "Deployment Directory : $(pwd)"
  echo "Node Version         : $(node -v 2>/dev/null || echo 'not found')"
  echo "NPM Version          : $(npm -v 2>/dev/null || echo 'not found')"
  echo "PM2 Version          : $(pm2 -v 2>/dev/null || echo 'not found')"
  echo "=========================================="
}

# Resolve PORT from .env (stripping comments, surrounding whitespace, and quotes)
resolve_env_port() {
  local env_file="${1:-.env}"
  local port="8000"
  if [ -f "$env_file" ]; then
    local raw_port
    raw_port=$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$env_file" 2>/dev/null | tail -n 1 | cut -d '=' -f2- || true)
    if [ -n "$raw_port" ]; then
      raw_port=$(echo "$raw_port" | sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//')
      if [ -n "$raw_port" ]; then
        port="$raw_port"
      fi
    fi
  fi
  echo "$port"
}

# Compute incremental deployment plan
compute_deploy_plan() {
  local prev_commit="${1:-}"
  local new_commit="${2:-}"
  local force_install="${3:-${FORCE_INSTALL:-0}}"
  local force_build="${4:-${FORCE_BUILD:-0}}"

  DIFF_AVAILABLE=0
  CHANGED_FILES=""
  ROOT_INSTALL_NEEDED=0
  FRONTEND_INSTALL_NEEDED=0
  FRONTEND_BUILD_NEEDED=0

  if [ -n "$prev_commit" ] && [ -n "$new_commit" ]; then
    if git cat-file -e "${prev_commit}^{commit}" 2>/dev/null; then
      DIFF_AVAILABLE=1
      if [ "$prev_commit" != "$new_commit" ]; then
        if ! CHANGED_FILES=$(git diff --name-only "$prev_commit" "$new_commit" 2>/dev/null); then
          DIFF_AVAILABLE=0
          CHANGED_FILES=""
        fi
      fi
    fi
  fi

  # 1. Root dependency install check
  if [ "$force_install" = "1" ] || \
     [ "$DIFF_AVAILABLE" -eq 0 ] || \
     [ ! -d "node_modules" ] || \
     [ ! -f "node_modules/.bin/tsc" ] || \
     [ ! -f "node_modules/.bin/esbuild" ] || \
     [ ! -d "node_modules/node-pty" ] || \
     echo "$CHANGED_FILES" | grep -qE '^package(-lock)?\.json$'; then
    ROOT_INSTALL_NEEDED=1
  fi

  # 2. Frontend dependency install check
  if [ "$force_install" = "1" ] || \
     [ "$DIFF_AVAILABLE" -eq 0 ] || \
     [ ! -d "frontend/node_modules" ] || \
     [ ! -f "frontend/node_modules/.bin/vite" ] || \
     echo "$CHANGED_FILES" | grep -qE '^frontend/package(-lock)?\.json$'; then
    FRONTEND_INSTALL_NEEDED=1
  fi

  # 3. Frontend build check
  if [ "$force_build" = "1" ] || \
     [ "$DIFF_AVAILABLE" -eq 0 ] || \
     [ "$FRONTEND_INSTALL_NEEDED" -eq 1 ] || \
     [ ! -f "dist/frontend/index.html" ] || \
     echo "$CHANGED_FILES" | grep -qE '^frontend/'; then
    FRONTEND_BUILD_NEEDED=1
  fi

  export DIFF_AVAILABLE CHANGED_FILES ROOT_INSTALL_NEEDED FRONTEND_INSTALL_NEEDED FRONTEND_BUILD_NEEDED
}

main() {
  ensure_pm2

  echo "===> [1/5] Pulling latest code and tags from origin/main..."
  PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
  git fetch origin main --tags -f
  git reset --hard origin/main
  NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")

  GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  COMMIT_TITLE=$(git log -1 --pretty=%B 2>/dev/null | head -n 1 || echo "")
  GIT_DESCRIBE=$(git describe --tags --always 2>/dev/null || echo "${GIT_COMMIT}")

  # Generate deployment version unified with build-gt.js (Single Source of Truth)
  TARGET_VERSION=$(node scripts/build-gt.js --version-only --silent 2>/dev/null && node -p "require('./src/shared/version.json').version" 2>/dev/null || true)
  if [ -z "$TARGET_VERSION" ]; then
    BASE_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")
    if [[ "$GIT_DESCRIBE" =~ ^v?[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
      TARGET_VERSION="${GIT_DESCRIBE#v}"
    else
      TARGET_VERSION="${BASE_VERSION}+${GIT_COMMIT}"
    fi
  fi

  echo "------------------------------------------"
  echo "Deploying Target Version : ${TARGET_VERSION}"
  echo "Current Git Commit       : ${GIT_COMMIT} - \"${COMMIT_TITLE}\""
  echo "Git Describe Output      : ${GIT_DESCRIBE}"
  echo "------------------------------------------"

  compute_deploy_plan "$PREV_COMMIT" "$NEW_COMMIT"

  echo "===> [2/5] Smart Dependency Installation..."
  NPM_FLAGS="--no-audit --no-fund --prefer-offline --include=dev"
  if [ "$ROOT_INSTALL_NEEDED" -eq 1 ]; then
    echo "-> Installing root dependencies..."
    NODE_ENV=development npm install $NPM_FLAGS
  else
    echo "-> Root dependencies up to date. Skipping install."
  fi

  if [ "$FRONTEND_INSTALL_NEEDED" -eq 1 ]; then
    echo "-> Installing frontend dependencies..."
    (cd frontend && NODE_ENV=development npm install $NPM_FLAGS)
  else
    echo "-> Frontend dependencies up to date. Skipping install."
  fi

  echo "===> [3/5] Building frontend, backend, and CLI..."
  if [ "$FRONTEND_BUILD_NEEDED" -eq 1 ]; then
    echo "-> Building frontend..."
    npm run build:frontend
  else
    echo "-> Frontend up to date. Skipping build."
  fi

  echo "-> Running typecheck..."
  npm run typecheck

  echo "-> Building backend..."
  npm run build:backend

  echo "-> Building gt CLI..."
  npm run build:gt

  echo "===> [4/5] Reloading PM2 process..."
  PM2_BIN="pm2"
  if ! command -v pm2 >/dev/null 2>&1; then
    if [ -x "./node_modules/.bin/pm2" ]; then
      PM2_BIN="./node_modules/.bin/pm2"
    else
      PM2_BIN="npx pm2"
    fi
  fi

  $PM2_BIN reload ecosystem.config.js --update-env || $PM2_BIN start ecosystem.config.js --update-env

  echo "===> Process Status:"
  $PM2_BIN status gt-hub || true

  echo "===> [5/5] Performing Health Check & Version Verification..."
  sleep 2

  PORT=$(resolve_env_port ".env")
  HEALTH_URL="http://127.0.0.1:${PORT}/health"
  HEALTH_STATUS="failed"
  for i in 1 2 3 4 5; do
    HEALTH_RESP=$(curl -fsSL -m 5 "$HEALTH_URL" 2>/dev/null || echo "")
    if [ -n "$HEALTH_RESP" ] && echo "$HEALTH_RESP" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      HEALTH_STATUS="ok"
      REPORTED_VERSION=$(echo "$HEALTH_RESP" | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
      echo "✓ Health check passed! Server is active (status: ok, version: ${REPORTED_VERSION})"
      break
    fi
    sleep 1
  done

  if [ "$HEALTH_STATUS" != "ok" ]; then
    echo "⚠️ Warning: Health check did not respond with 200 OK within 5s at $HEALTH_URL."
    echo "Please verify PM2 logs with: $PM2_BIN logs gt-hub"
  fi

  echo "=========================================="
  echo "Deployment completed successfully! (Version: ${TARGET_VERSION})"
  echo "=========================================="
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -e
  main "$@"
fi
