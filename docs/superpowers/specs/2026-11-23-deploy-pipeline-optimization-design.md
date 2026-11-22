# `gt-hub` Deployment & CI/CD Pipeline Optimization Design Specification

- **Date**: 2026-11-23
- **Status**: Approved Design (Pending User Spec Review)
- **Target**: `gt-hub` GitHub Actions CI/CD, Build Tooling, and Local Server Deployment Pipeline

---

## 1. Background & Problem Statement

End-to-end deployment on `gt-hub` currently takes ~110–150 seconds compared to ~20–25 seconds on `app-hub` under identical infrastructure. Inspection of `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `package.json`, and `scripts/deploy.sh` identifies four structural bottlenecks:

1. **Redundant CI CLI Builds on Every Deploy**: `.github/workflows/deploy.yml` runs a full `npm install` + `npm run build:gt` on the GitHub Actions runner before invoking `gt exec`, instead of downloading the pre-built `gt` CLI directly from `$GT_SERVER/gt`.
2. **Duplicate & Unconditional `npm install` Loops**:
   - `package.json` defines `"postinstall": "cd frontend && npm install"`.
   - `package.json` defines `"build:frontend": "cd frontend && npm install && npm run build"`.
   - `scripts/deploy.sh` runs `npm install` unconditionally on every deployment.
   - As a result, every single deployment triggers root installation plus **two** redundant frontend dependency installations (and on the CI runner, another root + frontend installation).
3. **Slow Full Backend TypeScript Emission**: `build:backend` runs `tsc` to emit the entire `src/` and `config/` tree into `dist/src/` and `dist/config/`, whereas `esbuild` (already installed in `devDependencies`) can bundle `src/index.ts` to `dist/src/index.js` in ~0.2s alongside a ~1.9s `tsc --noEmit` type verification.
4. **Unconditional Frontend Rebuilds & Overlapping CI Triggers**: `scripts/deploy.sh` unconditionally re-bundles the React + Monaco Editor + Xterm.js frontend even when commits only touch backend, agent, CLI, or script files. Meanwhile, `.github/workflows/ci.yml` runs uncached on every push to `main`, competing with `deploy.yml`.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- **Fast Path `gt` CLI Acquisition in `deploy.yml`**: Download `./gt.cjs` directly from `${GT_SERVER%/}/gt` in <1s with `'gt (Gemini Terminal)'` signature validation, falling back to local root install + `npm run build:gt` only when `$GT_SERVER/gt` is unreachable or invalid.
- **Scoped & Cached CI (`.github/workflows/ci.yml`)**: Trigger CI on `pull_request` (`main`) and `workflow_dispatch` instead of competing with `push: main` deployments; enable `setup-node` `npm` cache across both lockfiles; install root and frontend dependencies once each.
- **Zero Redundant Installs (`package.json` + `scripts/deploy.sh`)**: Remove `postinstall` and remove unconditional `npm install` inside `build:frontend`. Use `git diff` across `PREV_COMMIT..NEW_COMMIT` (plus artifact/binary existence checks) in `scripts/deploy.sh` to skip unchanged `npm install` steps while preserving native build scripts for `node-pty`.
- **Incremental Frontend Build (`scripts/deploy.sh`)**: Rebuild `dist/frontend` only when `dist/frontend/index.html` is missing, `frontend/` files changed, `frontend/package*.json` changed, git history cannot be diffed, or `FORCE_BUILD=1` is set.
- **Fast `esbuild` Server Bundle + `tsc --noEmit` (`scripts/build-gt.js` + `package.json`)**: Bundle `src/index.ts` -> `dist/src/index.js` (~0.2s) using existing `esbuild` with `packages: 'external'`, inject compile-time version defines, and run `npm run typecheck` (`tsc --noEmit`, ~1.9s).
- **Backward Compatibility**: Preserve `dist/src/index.js`, `dist/gt.js`, `dist/frontend`, `ecosystem.config.js`, `npm start`, `/health` version reporting, `/gt` CLI download endpoint, and all existing test contracts.

### 2.2 Non-Goals
- Switching PM2 runtime to `tsx` (avoided to keep zero new dependencies and 100% compatibility with `node dist/src/index.js`).
- Committing `dist/` artifacts to Git (`dist/` remains gitignored).
- Altering runtime application logic inside `src/server/`, `src/terminal/`, `src/agent/`, or `frontend/src/`.

---

## 3. Architecture & End-to-End Flow

```text
[GitHub: push to main / workflow_dispatch]
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GitHub Actions: .github/workflows/deploy.yml                            │
│  1. Validate Secrets (GT_SERVER, GT_KEY, DEPLOY_PATH, TARGET_HOST)      │
│  2. Acquire gt CLI (./gt.cjs):                                          │
│     ├─ Fast Path (<1s): curl -fsSL $GT_SERVER/gt → ./gt.cjs + verify    │
│     └─ Fallback (Hub down/unreachable): root npm install + build:gt     │
│  3. Execute: node ./gt.cjs exec --poll --verbose "$TARGET_HOST" ...     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Target Host: scripts/deploy.sh                                          │
│  [Pre]  ensure_pm2 (source nvm/bashrc/profile; install pm2 if missing)  │
│  [1/5]  Git Sync: capture PREV_COMMIT → git fetch & reset → NEW_COMMIT  │
│         Compute CHANGED_FILES (with fallback if PREV_COMMIT unreachable)│
│  [2/5]  Smart Dependency Install (no --ignore-scripts for node-pty):    │
│         ├─ Root: skip unless missing bins/node-pty or package*.json diff│
│         └─ Frontend: skip unless missing vite or frontend/package*.json │
│  [3/5]  Incremental Build & Type Verification:                          │
│         ├─ Frontend: skip unless dist/frontend/index.html missing,      │
│         │            frontend/ diff, frontend install ran, or FORCE     │
│         ├─ Typecheck: npm run typecheck (tsc --noEmit)                  │
│         ├─ Backend:   npm run build:backend (esbuild → dist/src/index.js)│
│         └─ CLI:       npm run build:gt (esbuild → dist/gt.js)           │
│  [4/5]  PM2 Reload: pm2 reload ecosystem.config.js --update-env         │
│  [5/5]  Health Check: read PORT from .env (default 8000), poll /health  │
└─────────────────────────────────────────────────────────────────────────┘

[GitHub: pull_request to main / workflow_dispatch]
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GitHub Actions: .github/workflows/ci.yml                                │
│  - actions/setup-node@v4 with npm cache (root + frontend lockfiles)     │
│  - Single root npm install + single frontend npm install                │
│  - Run npm test + npm run typecheck + npm run build                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Specifications

### 4.1 Build Pipeline (`scripts/build-gt.js` & `package.json`)

#### `scripts/build-gt.js`
Extend `scripts/build-gt.js` with `buildServer(options = {})` alongside `buildGt(options = {})`, sharing `generateVersionData()` and the lazy `getEsbuild()` loader:
- **Entrypoint**: `path.join(rootDir, 'src/index.ts')`
- **Outfile**: `path.join(rootDir, 'dist/src/index.js')`
- **Esbuild Options**:
  - `bundle: true`
  - `platform: 'node'`
  - `target: 'node18'`
  - `format: 'cjs'`
  - `packages: 'external'` (all `node_modules` packages—including `express`, `ws`, `node-pty`, `dotenv`, `commander`—remain resolved at runtime)
  - `define`: `__GT_VERSION__`, `__GT_GIT_COMMIT__`, `__GT_BUILD_TIME__` derived from `generateVersionData({ rootDir })`
- **CLI Flag**: Support `node scripts/build-gt.js --server` (respecting `--silent` and `--root <path>`) and export `buildServer` in `module.exports`.
- **Path Compatibility**: Because `outfile` stays at `dist/src/index.js`, `__dirname` equals `<repo>/dist/src`, preserving all existing relative path candidates in `src/server/modules/download/downloadController.ts` (`../../dist`), `src/server/modules/static/staticMiddleware.ts` (`../../dist/frontend`), and `src/shared/version.ts`.

#### `package.json`
Update `"scripts"`:
- **Remove `"postinstall"`** (`"cd frontend && npm install"`).
- **Add `"install:all"`**: `"npm install --no-audit --no-fund && npm --prefix frontend install --no-audit --no-fund"` (explicit convenience command for clean local setup).
- **Add `"typecheck"`**: `"tsc --noEmit"`.
- **Update `"build:frontend"`**: `"([ -d frontend/node_modules ] || npm --prefix frontend install --no-audit --no-fund --prefer-offline) && npm --prefix frontend run build"`.
- **Update `"build:backend"`**: `"node scripts/build-gt.js --server"`.
- **Update `"build"`**: `"npm run build:frontend && npm run build:backend && npm run build:gt"`.
- **Update `"prestart"`**: `"([ -d dist/frontend ] || npm run build:frontend) && npm run build:backend && npm run build:gt"`.
- Keep `"gt"`, `"version:gen"`, `"build:gt"`, `"deploy"`, `"start"`, `"dev:frontend"`, `"dev"`, `"pretest"`, `"test"`, `"lint"`, `"lint:fix"`, `"format"`, `"clean"`, and `"version"` compatible.

---

### 4.2 Server Deployment Script (`scripts/deploy.sh`)

`scripts/deploy.sh` (`chmod +x`, `set -e`) executes five stages:

1. **Environment & PM2 Bootstrap (`ensure_pm2`)**:
   - Source `$HOME/.nvm/nvm.sh`, `$HOME/.bashrc`, and `$HOME/.profile`.
   - If `pm2` is absent from `PATH`, attempt `npm install -g pm2` (with `sudo -n` fallback, then `npm install pm2 --save-dev` fallback) and prepend `./node_modules/.bin` to `PATH` when present.
   - Print directory, Node, NPM, and PM2 versions.

2. **`[1/5]` Git Synchronization & Version Derivation**:
   - Capture `PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")`.
   - Run `git fetch origin main --tags -f` and `git reset --hard origin/main`.
   - Capture `NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")`.
   - Preserve exact `TARGET_VERSION` derivation (`node scripts/build-gt.js --version-only --silent` with `GIT_DESCRIBE` / `BASE_VERSION+GIT_COMMIT` bash fallback, matching `tests/deployScriptVersion.test.ts`).
   - Compute `DIFF_AVAILABLE=0` and `CHANGED_FILES=""`:
     - Only set `DIFF_AVAILABLE=1` when `PREV_COMMIT` and `NEW_COMMIT` are both non-empty and `git cat-file -e "${PREV_COMMIT}^{commit}" 2>/dev/null` succeeds.
     - If `DIFF_AVAILABLE -eq 1` and `PREV_COMMIT != NEW_COMMIT`: populate `CHANGED_FILES=$(git diff --name-only "$PREV_COMMIT" "$NEW_COMMIT" 2>/dev/null || echo "")` (if `git diff` fails, reset `DIFF_AVAILABLE=0`).

3. **`[2/5]` Smart Dependency Installation**:
   - `NPM_FLAGS="--no-audit --no-fund --prefer-offline --include=dev"`
   - **Root install check (`ROOT_INSTALL_NEEDED`)**: Triggered if `FORCE_INSTALL=1`, `! -d "node_modules"`, `! -f "node_modules/.bin/tsc"`, `! -f "node_modules/.bin/esbuild"`, `! -d "node_modules/node-pty"`, `DIFF_AVAILABLE -eq 0`, or `CHANGED_FILES` matches `^package(-lock)?\.json$`.
     - Run `NODE_ENV=development npm install $NPM_FLAGS` (never pass `--ignore-scripts` so `node-pty` prebuild/compilation scripts execute).
   - **Frontend install check (`FRONTEND_INSTALL_NEEDED`)**: Triggered if `FORCE_INSTALL=1`, `! -d "frontend/node_modules"`, `! -f "frontend/node_modules/.bin/vite"`, `DIFF_AVAILABLE -eq 0`, or `CHANGED_FILES` matches `^frontend/package(-lock)?\.json$`.
     - Run `(cd frontend && NODE_ENV=development npm install $NPM_FLAGS)`.

4. **`[3/5]` Incremental Build & Type Verification**:
   - **Frontend build check (`FRONTEND_BUILD_NEEDED`)**: Triggered if `FORCE_BUILD=1`, `! -f "dist/frontend/index.html"`, `DIFF_AVAILABLE -eq 0`, `FRONTEND_INSTALL_NEEDED -eq 1`, or `CHANGED_FILES` matches `^frontend/`.
     - When needed, run `npm run build:frontend`; otherwise print skip notice (`Frontend up to date. Skipping build.`).
   - **Backend verification & bundling** (always runs, ~2.3s total):
     - `npm run typecheck` (`tsc --noEmit`)
     - `npm run build:backend` (`node scripts/build-gt.js --server`)
     - `npm run build:gt` (`node scripts/build-gt.js`)

5. **`[4/5]` PM2 Process Reload**:
   - Resolve `PM2_BIN` (`pm2`, `./node_modules/.bin/pm2`, or `npx pm2`).
   - Run `$PM2_BIN reload ecosystem.config.js --update-env || $PM2_BIN start ecosystem.config.js --update-env`.
   - Run `$PM2_BIN status gt-hub || true`.

6. **`[5/5]` Health Check & Version Verification**:
   - Determine `PORT="8000"`; if `.env` defines `PORT=...`, extract and strip quotes/whitespace.
   - `sleep 2`, then poll `http://127.0.0.1:${PORT}/health` up to 5 attempts (`curl -fsSL -m 5`, 1s interval).
   - Match `'"status"[[:space:]]*:[[:space:]]*"ok"'`, print reported version, or warn cleanly if attempts exhaust.

---

### 4.3 GitHub Actions CD Workflow (`.github/workflows/deploy.yml`)

- **Triggers**: `push` on `main`, `workflow_dispatch`; `concurrency: { group: deploy, cancel-in-progress: false }`.
- **Env / Secrets**:
  - `GT_SERVER: ${{ secrets.GT_SERVER }}`
  - `GT_KEY: ${{ secrets.GT_KEY }}`
  - `DEPLOY_PATH: ${{ secrets.DEPLOY_PATH || '~/gt-hub' }}`
  - `TARGET_HOST: ${{ secrets.GT_HOST || 'gt-hub' }}`
- **Steps**:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` (`node-version: 20`)
  3. Validate `GT_SERVER`, `GT_KEY`, `DEPLOY_PATH` non-empty (fail fast with `::error::`).
  4. **Acquire `gt` CLI (`./gt.cjs`)**:
     - Primary fast path: `curl -fsSL -m 15 "${GT_SERVER%/}/gt" -o ./gt.cjs` and verify `grep -q 'gt (Gemini Terminal)' ./gt.cjs`.
     - Fallback path (if primary download or signature check fails): run `npm install --no-audit --no-fund --prefer-offline && npm run build:gt && cp ./dist/gt.js ./gt.cjs`, then verify signature again (failing workflow if invalid). Because `postinstall` is removed, this fallback installs only root dependencies.
  5. **Trigger Remote Deployment**:
     - Execute `node ./gt.cjs exec --poll --verbose -e DEPLOY_PATH="$DEPLOY_PATH" "$TARGET_HOST" bash -c '...'`.
     - Preserve NVM/shell profile sourcing, tilde expansion, candidate directory probing fallback, `npm` check, and `cd "$DEPLOY_PATH" && npm run deploy`.

---

### 4.4 GitHub Actions CI Workflow (`.github/workflows/ci.yml`)

- **Triggers**: `pull_request` on `main`, and `workflow_dispatch` (removes duplicate trigger on `push: main` so CI does not contend with `deploy.yml`).
- **Concurrency**: `group: ci-${{ github.ref }}`, `cancel-in-progress: true`.
- **Steps**:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4`:
     ```yaml
     node-version: 20
     cache: 'npm'
     cache-dependency-path: |
       package-lock.json
       frontend/package-lock.json
     ```
  3. Install dependencies once per workspace:
     ```bash
     npm install --no-audit --no-fund --prefer-offline
     npm --prefix frontend install --no-audit --no-fund --prefer-offline
     ```
  4. Run `npm test`, `npm run typecheck`, and `npm run build`.

---

### 4.5 Documentation (`CLAUDE.md`)

Update `CLAUDE.md` build & installation commands to document:
- `npm run install:all` (installing both root and frontend dependencies after removing `postinstall`)
- `npm run typecheck` (`tsc --noEmit`)
- `npm run build:backend` (`esbuild` server bundle to `dist/src/index.js`)

---

## 5. Error Handling & Edge Cases

1. **Unreachable `PREV_COMMIT` (Force-Push, Shallow Clone, First Deploy)**: If `PREV_COMMIT` is empty or `git cat-file -e "${PREV_COMMIT}^{commit}"` fails, `DIFF_AVAILABLE=0` forces both root/frontend dependency checks and frontend build to run conservatively.
2. **Broken/Incomplete Previous Build**: Even when `PREV_COMMIT == NEW_COMMIT` (re-deploying the same commit via `workflow_dispatch` or `npm run deploy`), missing `dist/frontend/index.html` or missing binaries (`esbuild`, `tsc`, `node-pty`, `vite`) automatically trigger the required install/build step.
3. **`node-pty` Native Addon Integrity**: Root `npm install` never passes `--ignore-scripts`, preserving `node-pty` native binary installation/compilation.
4. **Remote `$GT_SERVER/gt` Outage During `gt-hub` Deploy**: `deploy.yml` detects HTTP/curl failures or corrupt/HTML error responses via `grep -q 'gt (Gemini Terminal)'` and seamlessly builds `./gt.cjs` locally without frontend install overhead.
5. **Custom `PORT` in `.env`**: `scripts/deploy.sh` reads `PORT` from `.env` (default `8000`), ensuring health verification probes the real listening port.
6. **Manual Full Rebuild Escape Hatch**: Setting `FORCE_INSTALL=1` and/or `FORCE_BUILD=1` forces full installation/frontend rebuild on demand.

---

## 6. Verification Strategy

1. **New Test Suite (`tests/deployPipeline.test.ts`)**:
   - Verify `scripts/deploy.sh` exists, is executable (`mode & 0o111`), passes `bash -n`, preserves `node-pty` install scripts (no `--ignore-scripts`), contains incremental diff checks (`git diff`, `DIFF_AVAILABLE`, `FORCE_BUILD`, `FORCE_INSTALL`), checks `dist/frontend/index.html`, runs `typecheck`, `build:backend`, `build:gt`, and reads `PORT` from `.env` (default `8000`).
   - Verify `package.json` removes `postinstall`, removes unconditional `npm install` from `build:frontend`, registers `typecheck`, `install:all`, `build:backend` (`node scripts/build-gt.js --server`), and `deploy`.
   - Verify `buildServer()` builds a working `dist/src/index.js` into a temp output path without bundling external dependencies (`express`, `ws`, `node-pty`) and injects version metadata.
   - Verify `.github/workflows/deploy.yml` uses `$GT_SERVER/gt` fast download with local `build:gt` fallback and valid `bash -n` remote execution shell block.
   - Verify `.github/workflows/ci.yml` targets `pull_request` / `workflow_dispatch`, caches both lockfiles, and runs single-pass root/frontend installs.
2. **Regression Verification**:
   - Run `npm test -- tests/deployScriptVersion.test.ts tests/gracefulShutdown.test.ts tests/gtInstallEndpoints.test.ts tests/deployPipeline.test.ts`
   - Run `npm run typecheck`
   - Run `npm run build`
   - Run full `npm test`
