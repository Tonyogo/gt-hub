# GitHub Actions CI/CD Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure GitHub Actions automation workflows for continuous integration (testing and building on push and pull requests) and continuous deployment (remote deployment via Gemini Terminal on push to `main`).

**Architecture:**
- **CI Workflow (`.github/workflows/ci.yml`)**: Triggered on `push` and `pull_request` (as well as `workflow_dispatch`). Sets up Node.js 20, caches dependencies, runs `npm test` across all 89 test suites, and executes `npm run build` to verify frontend Vite bundles and backend TypeScript transpilation.
- **Remote Deploy Script (`scripts/deploy.sh`)**: Standardizes server-side deployment operations: environment variable sourcing (NVM, Node, PM2), git reset to `origin/main`, dependency installation, project build, and zero-downtime PM2 reload.
- **CD Workflow (`.github/workflows/deploy.yml`)**: Modeled after `gemini_proxy`. Triggered on push to `main` (and `workflow_dispatch`). Validates required secrets, downloads the `gt` CLI from `TERMINAL_SERVER`, and executes `npm run deploy` on the target remote host (`GT_HOST`).

**Tech Stack:** GitHub Actions, Node.js 20, Bash, PM2, Gemini Terminal (`gt` CLI).

**Spec:** In-chat approved bounded design following `gemini-proxy/.github/workflows/deploy.yml` pattern.

## Global Constraints

- Use Node.js version 20 LTS for GitHub Actions runners.
- GitHub Actions workflows must use latest stable actions (`actions/checkout@v4`, `actions/setup-node@v4`).
- Ensure deploy script handles shell environments gracefully (`NVM`, `.bashrc`, `.profile`).
- Maintain concurrency control on the deployment job (`concurrency: { group: 'deploy', cancel-in-progress: false }`).
- Do not commit secrets into repository files; all sensitive values must come from GitHub Secrets or fallback defaults.

## Review Focus

1. **Missing GitHub Secrets during CD execution**: CD workflow must exit with a clear error listing which secrets are missing before attempting any network requests.
2. **Missing shell environment paths on remote host**: `deploy.sh` must defensively source `.nvm/nvm.sh`, `.bashrc`, and `.profile` so that `node`, `npm`, and `pm2` are found in non-interactive shells.
3. **PM2 reload vs start fallback**: If the PM2 process `gt-hub` is not yet running on the target machine, `pm2 reload` might return an error; it must fall back to `pm2 start ecosystem.config.js`.
4. **CI node_modules caching**: `setup-node@v4` with `cache: 'npm'` should be used to accelerate CI runs without breaking native addons like `node-pty`.
5. **Executable permissions**: `scripts/deploy.sh` must have executable permissions (`chmod +x`).

---

### Task 1: Add Local & Remote Deployment Script `scripts/deploy.sh` and Update `package.json`

**Files:**
- Create: `scripts/deploy.sh`
- Modify: `package.json:9-21`

**Interfaces:**
- Produces: `scripts/deploy.sh` executable script and `npm run deploy` command.
- Consumes: `ecosystem.config.js` (`apps[0].name = 'gt-hub'`), git repository remote `origin/main`.

- [x] **Step 1: Create `scripts/deploy.sh`**

Create `scripts/deploy.sh` with robust environment loading, git pull, build, and PM2 reload logic:

```bash
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
```

- [x] **Step 2: Grant executable permission to `scripts/deploy.sh`**

Run:
```bash
chmod +x scripts/deploy.sh
```

- [x] **Step 3: Update `package.json` to include `"deploy"` script**

In `package.json`, add `"deploy": "bash scripts/deploy.sh"` under `"scripts"`:

```json
    "build:frontend": "cd frontend && ( [ -d node_modules ] || npm install ) && npm run build",
    "build:backend": "tsc",
    "build": "npm run build:frontend && npm run build:backend",
    "deploy": "bash scripts/deploy.sh",
    "prestart": "([ -d dist/frontend ] || npm run build:frontend) && npm run build:backend",
```

- [x] **Step 4: Verify script syntax and package.json validity**

Run:
```bash
bash -n scripts/deploy.sh
node -e "const p = require('./package.json'); if (!p.scripts.deploy) process.exit(1); console.log('deploy script registered:', p.scripts.deploy);"
```
Expected: No syntax errors, output confirms `deploy script registered: bash scripts/deploy.sh`.

- [x] **Step 5: Commit changes**

```bash
git add scripts/deploy.sh package.json
git commit -m "feat(deploy): add deployment script and npm deploy command"
```

---

### Task 2: Create CI Workflow `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: GitHub Actions CI workflow triggered on push/PR.
- Consumes: `package.json` scripts (`npm test`, `npm run build`).

- [x] **Step 1: Create `.github/workflows/ci.yml`**

Create directory and workflow file:
```bash
mkdir -p .github/workflows
```

Content for `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches:
      - main
      - 'feature/**'
      - 'fix/**'
  pull_request:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test-and-build:
    name: Test and Build
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: |
          npm install

      - name: Run test suite
        run: |
          npm test

      - name: Build frontend and backend
        run: |
          npm run build
```

- [x] **Step 2: Validate YAML format and structure**

Run:
```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('.github/workflows/ci.yml', 'utf-8');
if (!content.includes('npm test') || !content.includes('npm run build')) {
  throw new Error('Missing test or build commands in ci.yml');
}
console.log('ci.yml validated successfully.');
"
```
Expected: `ci.yml validated successfully.`

- [x] **Step 3: Commit changes**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for test and build"
```

---

### Task 3: Create CD Deployment Workflow `.github/workflows/deploy.yml`

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: GitHub Actions CD workflow triggered on push to `main` and manual dispatch.
- Consumes: Target hub endpoint, target host alias (`GT_HOST`), and secrets (`ADMIN_SECRET_KEY`, `TERMINAL_SERVER`, `DEPLOY_PATH`).

- [x] **Step 1: Create `.github/workflows/deploy.yml`**

Write `.github/workflows/deploy.yml` referencing the proven architecture in `gemini_proxy`:

```yaml
name: Deploy to Server

on:
  push:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy via Gemini Terminal (gt)
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Validate configuration & Deploy via gt
        env:
          TERMINAL_SERVER: ${{ secrets.TERMINAL_SERVER || 'https://www.yatao.cc.cd' }}
          ADMIN_SECRET_KEY: ${{ secrets.ADMIN_SECRET_KEY }}
          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH || '~/gt-hub' }}
          TARGET_HOST: ${{ secrets.GT_HOST || 'gt-hub' }}
        run: |
          # 1. Validate required GitHub Secrets
          MISSING=""
          [ -z "$TERMINAL_SERVER" ] && MISSING="$MISSING TERMINAL_SERVER"
          [ -z "$ADMIN_SECRET_KEY" ] && MISSING="$MISSING ADMIN_SECRET_KEY"
          [ -z "$DEPLOY_PATH" ] && MISSING="$MISSING DEPLOY_PATH"

          if [ -n "$MISSING" ]; then
            echo "::error::Missing required GitHub Secrets:${MISSING}"
            echo "Please configure the required secrets in Repository Settings -> Secrets and variables -> Actions."
            exit 1
          fi

          echo "=========================================="
          echo "Gemini Terminal (gt) Remote Deployment"
          echo "Target Hub  : $TERMINAL_SERVER"
          echo "Target Host : $TARGET_HOST"
          echo "Deploy Path : $DEPLOY_PATH"
          echo "=========================================="

          # 2. Dynamically download gt CLI from TERMINAL_SERVER
          echo "Downloading gt CLI from $TERMINAL_SERVER/gt..."
          curl -fsSL "$TERMINAL_SERVER/gt" -o ./gt.js

          # 3. Trigger deployment command via gt exec with repository auto-discovery fallback
          node ./gt.js exec \
            --verbose \
            -e DEPLOY_PATH="$DEPLOY_PATH" \
            "$TARGET_HOST" \
            bash -c '
              set -e

              # Load shell profiles to ensure node, npm, and PM2 are in PATH
              [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
              [ -s "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
              [ -s "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true

              DEPLOY_DIR="${DEPLOY_PATH:-}"

              # Expand leading tilde
              if [ "$DEPLOY_DIR" = "~" ]; then
                DEPLOY_DIR="$HOME"
              elif [[ "$DEPLOY_DIR" == "~/"* ]]; then
                DEPLOY_DIR="$HOME/${DEPLOY_DIR#\~/}"
              fi

              # Validate directory; if not found, probe common candidate directories
              if [ -z "$DEPLOY_DIR" ] || [ ! -d "$DEPLOY_DIR" ] || [ ! -f "$DEPLOY_DIR/scripts/deploy.sh" ]; then
                echo "Notice: Specified DEPLOY_PATH not found, probing repository location..."
                for CANDIDATE in "$HOME/gt-hub" "/root/gt-hub" "/home/ubuntu/gt-hub" "/home/yogo/gt-hub" "$(pwd)/gt-hub" "$(pwd)"; do
                  if [ -d "$CANDIDATE" ] && [ -f "$CANDIDATE/scripts/deploy.sh" ]; then
                    DEPLOY_DIR="$CANDIDATE"
                    echo "-> Auto-discovered repository at: $DEPLOY_DIR"
                    break
                  fi
                done
              fi

              if [ ! -d "$DEPLOY_DIR" ] || [ ! -f "$DEPLOY_DIR/scripts/deploy.sh" ]; then
                echo "::error::Could not locate gt-hub repository directory on remote host."
                exit 1
              fi

              if ! command -v npm >/dev/null 2>&1; then
                echo "::error::npm command not found in PATH on remote host."
                exit 1
              fi

              echo "===> Deploying repository at: $DEPLOY_DIR"
              cd "$DEPLOY_DIR"
              npm run deploy
            '
```

- [x] **Step 2: Validate YAML syntax and secret logic**

Run:
```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('.github/workflows/deploy.yml', 'utf-8');
if (!content.includes('TERMINAL_SERVER') || !content.includes('gt.js exec')) {
  throw new Error('deploy.yml content check failed');
}
console.log('deploy.yml validated successfully.');
"
```
Expected: `deploy.yml validated successfully.`

- [x] **Step 3: Commit changes**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): add GitHub Actions deployment workflow via gt exec"
```

---

### Task 4: Full Validation & Test Verification

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `.github/workflows/deploy.yml`
- Verify: `scripts/deploy.sh`
- Verify: `package.json`

- [x] **Step 1: Check git status and file permissions**

Run:
```bash
ls -la .github/workflows/
ls -l scripts/deploy.sh
```
Expected:
- `.github/workflows/ci.yml` and `.github/workflows/deploy.yml` exist.
- `scripts/deploy.sh` has executable bits (`-rwxrwxr-x` or `-rwxr-xr-x`).

- [x] **Step 2: Verify npm test passes cleanly**

Run:
```bash
npm test
```
Expected: 89 test suites pass, 533 tests pass.

- [x] **Step 3: Verify build completes cleanly**

Run:
```bash
npm run build
```
Expected: Frontend Vite build and backend `tsc` compilation complete with exit code 0.
