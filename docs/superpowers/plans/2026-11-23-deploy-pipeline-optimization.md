# `gt-hub` Deployment & CI/CD Pipeline Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use Orca + `agy` workers in dedicated Orca worktrees (per global `CLAUDE.md` Multi-Agent Mode), implementing task-by-task with TDD discipline and commit-based handoffs.

**Goal:** Eliminate redundant dependency installs, slow full `tsc` backend emissions, unnecessary frontend rebuilds, and slow GitHub Actions CLI builds in `gt-hub`, cutting routine `main` deployment time from ~110–150s down to ~20–30s.

**Architecture:** Refactor `package.json` and `scripts/build-gt.js` so the backend bundles `src/index.ts` -> `dist/src/index.js` via existing `esbuild` (`packages: 'external'`) paired with `tsc --noEmit` typechecking; upgrade `scripts/deploy.sh` with `git diff`-based incremental dependency and frontend build skipping; and update `.github/workflows/deploy.yml` to fetch `gt` CLI directly from `$GT_SERVER/gt` with local fallback while scoping `.github/workflows/ci.yml` to `pull_request`/`workflow_dispatch` with dual-lockfile caching.

**Tech Stack:** Bash, Node.js 20, TypeScript 5.4, esbuild 0.28, Express 4, PM2, GitHub Actions, Jest 29.

**Spec:** `docs/superpowers/specs/2026-11-23-deploy-pipeline-optimization-design.md`

## Global Constraints

- Preserve `node-pty` native install/prebuild scripts: NEVER pass `--ignore-scripts` during root `npm install`.
- Maintain zero new npm dependencies: reuse existing `esbuild` (`^0.28.2`) in `devDependencies`.
- Preserve runtime output paths and PM2 compatibility: `dist/src/index.js`, `dist/gt.js`, `dist/frontend`, `ecosystem.config.js`, and `npm start` continue working unchanged.
- Keep `dist/` untracked (`.gitignore`d).
- Preserve all existing test contracts (`tests/deployScriptVersion.test.ts`, `tests/gracefulShutdown.test.ts`, `tests/gtInstallEndpoints.test.ts`).
- Always invoke Jest with `--detectOpenHandles --forceExit` (or `npm test -- <file>`).

## Review Focus

- **Unreachable `PREV_COMMIT` (force-push / shallow clone / first deploy)**: When `PREV_COMMIT` is empty or `git cat-file -e "${PREV_COMMIT}^{commit}"` fails, `compute_deploy_plan` in `scripts/deploy.sh` must conservatively enable `ROOT_INSTALL_NEEDED=1`, `FRONTEND_INSTALL_NEEDED=1`, and `FRONTEND_BUILD_NEEDED=1`.
- **Backend-only commit with existing vs missing `dist/frontend/index.html`**: When `PREV_COMMIT..NEW_COMMIT` only modifies `src/`, `FRONTEND_BUILD_NEEDED` must be `0` if `dist/frontend/index.html` exists and `1` if `dist/frontend/index.html` is missing.
- **`frontend/package.json` or `frontend/package-lock.json` change cascades to build**: Modifying `frontend/package*.json` must set both `FRONTEND_INSTALL_NEEDED=1` and `FRONTEND_BUILD_NEEDED=1` even if `frontend/src/` was untouched.
- **Custom `PORT` quoting/whitespace in `.env`**: `resolve_env_port` in `scripts/deploy.sh` must strip quotes and whitespace (e.g., `PORT="9000"` -> `9000`) and fall back to `8000` when unset.
- **Externalized dependencies & injected version in `esbuild` server bundle**: `buildServer()` output `dist/src/index.js` must keep `express`, `ws`, and `node-pty` external (`require(...)`), inject `__GT_VERSION__` matching `src/shared/version.json`, and boot cleanly under `NODE_ENV=test`.

---

### File Structure

| File | Responsibility |
| :--- | :--- |
| `scripts/build-gt.js` | Add `buildServer(options)` and `--server` CLI flag using lazy `esbuild` (`packages: 'external'`) and shared `generateVersionData()` to emit `dist/src/index.js`. |
| `package.json` | Remove `postinstall`, remove unconditional `npm install` from `build:frontend`, add `install:all` and `typecheck`, switch `build:backend` to `node scripts/build-gt.js --server`, simplify `build` and `prestart`. |
| `scripts/deploy.sh` | Implement modular `ensure_pm2`, `resolve_env_port`, and `compute_deploy_plan` helpers for `git diff`-based incremental install/build, `typecheck` + `esbuild` backend/CLI build, PM2 reload, and `.env`-aware `/health` verification. |
| `.github/workflows/deploy.yml` | Download `./gt.cjs` from `${GT_SERVER%/}/gt` with `'gt (Gemini Terminal)'` validation and root-only `npm install && npm run build:gt` fallback; parameterize `DEPLOY_PATH` and `TARGET_HOST` with defaults. |
| `.github/workflows/ci.yml` | Trigger on `pull_request` (`main`) and `workflow_dispatch`; cache both `package-lock.json` and `frontend/package-lock.json`; single-pass root and frontend install; run `npm test`, `npm run typecheck`, `npm run build`. |
| `CLAUDE.md` | Document `npm run install:all`, `npm run typecheck`, and `esbuild`-based `build:backend`. |
| `tests/deployPipeline.test.ts` | Contract and behavioral tests covering `buildServer`, `package.json`, `scripts/deploy.sh` bash functions across real temp git repos, and `.github/workflows/*.yml`. |

---

### Task 1: Fast `esbuild` Server Bundler, `package.json` Script Cleanup & Docs

**Files:**
- Modify: `scripts/build-gt.js:97-173`
- Modify: `package.json:9-29`
- Modify: `CLAUDE.md:5-30`
- Create: `tests/deployPipeline.test.ts`

**Interfaces:**
- Produces in `scripts/build-gt.js`:
  - `buildServer(options?: { rootDir?: string; versionData?: VersionData; outfile?: string; esbuildOptions?: object; silent?: boolean }): { versionData: VersionData; outfile: string; buildResult: BuildResult }`
  - CLI support: `node scripts/build-gt.js --server [--silent] [--root <path>]`
- Produces in `package.json`:
  - `scripts.install:all`: `"npm install --no-audit --no-fund && npm --prefix frontend install --no-audit --no-fund"`
  - `scripts.typecheck`: `"tsc --noEmit"`
  - `scripts.build:frontend`: `"([ -d frontend/node_modules ] || npm --prefix frontend install --no-audit --no-fund --prefer-offline) && npm --prefix frontend run build"`
  - `scripts.build:backend`: `"node scripts/build-gt.js --server"`
  - `scripts.build`: `"npm run build:frontend && npm run build:backend && npm run build:gt"`
  - `scripts.prestart`: `"([ -d dist/frontend ] || npm run build:frontend) && npm run build:backend && npm run build:gt"`
  - Absence of `scripts.postinstall`.

- [x] **Step 1: Write failing tests in `tests/deployPipeline.test.ts` for `buildServer` and `package.json` contracts**

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT_DIR = path.resolve(__dirname, '..');

describe('Deploy Pipeline Optimization - Build & Package Contracts', () => {
  it('removes postinstall and duplicate frontend installs from package.json and registers typecheck/esbuild backend', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.scripts['install:all']).toBe(
      'npm install --no-audit --no-fund && npm --prefix frontend install --no-audit --no-fund'
    );
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts['build:frontend']).not.toMatch(/^cd frontend && npm install &&/);
    expect(pkg.scripts['build:frontend']).toContain('npm --prefix frontend run build');
    expect(pkg.scripts['build:backend']).toBe('node scripts/build-gt.js --server');
    expect(pkg.scripts.build).toBe('npm run build:frontend && npm run build:backend && npm run build:gt');
    expect(pkg.scripts.deploy).toBe('bash scripts/deploy.sh');
  });

  it('buildServer bundles src/index.ts with externalized packages, valid JS syntax, and matching version info', () => {
    const buildGtModule = require('../scripts/build-gt.js');
    expect(typeof buildGtModule.buildServer).toBe('function');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-server-build-'));
    const outfile = path.join(tmpDir, 'index.js');

    try {
      const result = buildGtModule.buildServer({ outfile, silent: true });
      expect(fs.existsSync(outfile)).toBe(true);
      expect(result.versionData.version).toBeTruthy();

      execFileSync('node', ['--check', outfile]);

      const bundleContent = fs.readFileSync(outfile, 'utf8');
      expect(bundleContent).toContain('require("express")');
      expect(bundleContent).toContain('require("ws")');
      expect(bundleContent).toContain('node-pty');

      // Verify runtime startup under NODE_ENV=test resolves express & injected version
      const probeOut = execFileSync(
        'node',
        [
          '-e',
          `const mod = require(${JSON.stringify(outfile)});
           const http = require('http');
           const server = http.createServer(mod.app);
           server.listen(0, '127.0.0.1', () => {
             const port = server.address().port;
             http.get('http://127.0.0.1:' + port + '/health', (res) => {
               let body = '';
               res.on('data', (c) => (body += c));
               res.on('end', () => {
                 console.log(body);
                 try { mod.wss && mod.wss.close(); } catch {}
                 server.close(() => process.exit(0));
               });
             });
           });`,
        ],
        {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            NODE_PATH: path.join(ROOT_DIR, 'node_modules'),
          },
          encoding: 'utf8',
        }
      ).trim();

      const health = JSON.parse(probeOut) as { status: string; version: string };
      expect(health.status).toBe('ok');
      expect(health.version).toBe(result.versionData.version);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/deployPipeline.test.ts`
Expected: FAIL because `pkg.scripts.postinstall` still exists and `buildGtModule.buildServer` is `undefined`.

- [x] **Step 3: Implement `buildServer()` + `--server` flag in `scripts/build-gt.js`, update `package.json`, and update `CLAUDE.md`**

In `scripts/build-gt.js`:
- Add `buildServer(options = {})` reusing `generateVersionData({ rootDir })` and `getEsbuild().buildSync(...)` with `entryPoints: [path.join(rootDir, 'src/index.ts')]`, `bundle: true`, `platform: 'node'`, `target: 'node18'`, `format: 'cjs'`, `packages: 'external'`, `outfile: options.outfile || path.join(rootDir, 'dist/src/index.js')`, and `define` for `__GT_VERSION__`, `__GT_GIT_COMMIT__`, `__GT_BUILD_TIME__`.
- Handle `--server` in the CLI block (`if (require.main === module)`), update `--help` text to document `--server`, and export `buildServer` in `module.exports`.

In `package.json`:
- Apply exact script definitions listed in **Interfaces** above.

In `CLAUDE.md`:
- Document `npm run install:all`, `npm run typecheck`, and note `npm run build:backend` bundles `src/index.ts` via `esbuild` into `dist/src/index.js`.

- [x] **Step 4: Run tests, typecheck, and build verification**

Run:
```bash
npm test -- tests/deployPipeline.test.ts tests/deployScriptVersion.test.ts tests/gtInstallEndpoints.test.ts tests/gracefulShutdown.test.ts
npm run typecheck
npm run build:backend
npm run build:gt
```
Expected: All targeted tests PASS, `typecheck` exits 0, `dist/src/index.js` and `dist/gt.js` build cleanly.

- [x] **Step 5: Commit Task 1**

```bash
git add scripts/build-gt.js package.json CLAUDE.md tests/deployPipeline.test.ts
git commit -m "perf(build): bundle backend with esbuild and remove redundant postinstall"
```

---

### Task 2: Smart Incremental Server Deployment Script (`scripts/deploy.sh`)

**Files:**
- Modify: `scripts/deploy.sh:1-80`
- Modify: `tests/deployPipeline.test.ts`

**Interfaces:**
- Produces in `scripts/deploy.sh` (source-safe when `BASH_SOURCE[0] != $0`, executes `set -e; main "$@"` only when invoked directly):
  - `ensure_pm2()`: sources `~/.nvm/nvm.sh`, `~/.bashrc`, `~/.profile`; installs `pm2` if missing; prepends `./node_modules/.bin` to `PATH`.
  - `resolve_env_port(env_file?: string)`: reads `PORT` from `.env` (stripping surrounding quotes/whitespace), echoes port (default `8000`).
  - `compute_deploy_plan(prev_commit: string, new_commit: string, force_install?: string, force_build?: string)`: sets and exports/populates `DIFF_AVAILABLE`, `CHANGED_FILES`, `ROOT_INSTALL_NEEDED`, `FRONTEND_INSTALL_NEEDED`, `FRONTEND_BUILD_NEEDED` (`0` or `1`).
  - `main()`: runs `[1/5]` Git Sync & Version Derivation -> `[2/5]` Smart Dependency Installation -> `[3/5]` Incremental Build & Type Verification (`build:frontend` if needed, then `typecheck`, `build:backend`, `build:gt`) -> `[4/5]` PM2 Reload -> `[5/5]` Health Check via `resolve_env_port`.

- [x] **Step 1: Add failing tests for `scripts/deploy.sh` contract and incremental plan logic in `tests/deployPipeline.test.ts`**

Add a `describe('Deploy Script Incremental Plan & Contract', ...)` block to `tests/deployPipeline.test.ts`:
- Static contract checks:
  - `scripts/deploy.sh` exists, has executable permissions (`(stat.mode & 0o111) !== 0`), and passes `execFileSync('bash', ['-n', deployScriptPath])`.
  - File contents contain `ensure_pm2`, `resolve_env_port`, `compute_deploy_plan`, `npm run typecheck`, `npm run build:backend`, `npm run build:gt`, `ecosystem.config.js`, and do NOT contain `--ignore-scripts`.
- Functional tests in a temp git repository (`os.tmpdir()`) that `source`s `scripts/deploy.sh` and runs `resolve_env_port` and `compute_deploy_plan`:
  1. `resolve_env_port`: returns `8000` when `.env` is missing or lacks `PORT`, returns `9123` for `PORT="9123"` / `PORT='9123'` / `PORT= 9123 `.
  2. Unreachable/empty `PREV_COMMIT`: sets `DIFF_AVAILABLE=0`, `ROOT_INSTALL_NEEDED=1`, `FRONTEND_INSTALL_NEEDED=1`, `FRONTEND_BUILD_NEEDED=1`.
  3. Backend-only commit (`src/server/app.ts`) when `node_modules/.bin/{tsc,esbuild}`, `node_modules/node-pty`, `frontend/node_modules/.bin/vite`, and `dist/frontend/index.html` exist: sets `ROOT_INSTALL_NEEDED=0`, `FRONTEND_INSTALL_NEEDED=0`, `FRONTEND_BUILD_NEEDED=0`.
  4. Same backend-only commit when `dist/frontend/index.html` is missing: sets `FRONTEND_BUILD_NEEDED=1` while keeping `ROOT_INSTALL_NEEDED=0` and `FRONTEND_INSTALL_NEEDED=0`.
  5. `frontend/package.json` modified: sets `FRONTEND_INSTALL_NEEDED=1` and `FRONTEND_BUILD_NEEDED=1` while `ROOT_INSTALL_NEEDED=0`.
  6. `frontend/src/App.tsx` modified: sets `FRONTEND_BUILD_NEEDED=1` while `ROOT_INSTALL_NEEDED=0` and `FRONTEND_INSTALL_NEEDED=0`.
  7. Root `package.json` modified: sets `ROOT_INSTALL_NEEDED=1` while `FRONTEND_INSTALL_NEEDED=0` and `FRONTEND_BUILD_NEEDED=0`.
  8. `FORCE_INSTALL=1` and `FORCE_BUILD=1` overrides: force all expected flags to `1`.

- [x] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/deployPipeline.test.ts`
Expected: FAIL because `resolve_env_port` and `compute_deploy_plan` do not exist in `scripts/deploy.sh`.

- [x] **Step 3: Implement modular incremental deployment pipeline in `scripts/deploy.sh`**

Update `scripts/deploy.sh`:
- Implement `ensure_pm2`, `resolve_env_port`, `compute_deploy_plan`, and `main`.
- Ensure `compute_deploy_plan` validates `git cat-file -e "${prev_commit}^{commit}" 2>/dev/null` and `git diff --name-only "$prev_commit" "$new_commit"` cleanly without failing under `set -e`, falling back to `DIFF_AVAILABLE=0` on any error.
- Preserve the exact `TARGET_VERSION` derivation snippet tested by `tests/deployScriptVersion.test.ts`.
- Guard direct execution with:
  ```bash
  if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    set -e
    main "$@"
  fi
  ```

- [x] **Step 4: Run targeted tests to verify pass**

Run: `npm test -- tests/deployPipeline.test.ts tests/deployScriptVersion.test.ts`
Expected: PASS across all tests in both files.

- [x] **Step 5: Commit Task 2**

```bash
git add scripts/deploy.sh tests/deployPipeline.test.ts
git commit -m "perf(deploy): add incremental install and frontend build checks to deploy.sh"
```

---

### Task 3: Optimize `.github/workflows/deploy.yml` & `.github/workflows/ci.yml`

**Files:**
- Modify: `.github/workflows/deploy.yml:1-108`
- Modify: `.github/workflows/ci.yml:1-43`
- Modify: `tests/deployPipeline.test.ts`

**Interfaces:**
- `.github/workflows/deploy.yml`:
  - Triggers: `push.branches: [main]`, `workflow_dispatch`.
  - Concurrency: `group: deploy`, `cancel-in-progress: false`.
  - Env: `GT_SERVER: ${{ secrets.GT_SERVER }}`, `GT_KEY: ${{ secrets.GT_KEY }}`, `DEPLOY_PATH: ${{ secrets.DEPLOY_PATH || '~/gt-hub' }}`, `TARGET_HOST: ${{ secrets.GT_HOST || 'gt-hub' }}`.
  - `gt` CLI step: downloads `${GT_SERVER%/}/gt` -> `./gt.cjs` checking `'gt (Gemini Terminal)'`; falls back to `npm install --no-audit --no-fund --prefer-offline && npm run build:gt && cp ./dist/gt.js ./gt.cjs` only when primary download/check fails.
  - Remote execution: runs `node ./gt.cjs exec --poll --verbose -e DEPLOY_PATH="$DEPLOY_PATH" "$TARGET_HOST" bash -c '...'` with shell profile sourcing, tilde expansion, candidate directory probing, and `npm run deploy`.
- `.github/workflows/ci.yml`:
  - Triggers: `pull_request.branches: [main]`, `workflow_dispatch`.
  - Concurrency: `group: ci-${{ github.ref }}`, `cancel-in-progress: true`.
  - `actions/setup-node@v4` with `cache: 'npm'` and `cache-dependency-path` listing `package-lock.json` and `frontend/package-lock.json`.
  - Installs root and frontend once each (`--no-audit --no-fund --prefer-offline`), then runs `npm test`, `npm run typecheck`, `npm run build`.

- [x] **Step 1: Add failing tests for `deploy.yml` and `ci.yml` in `tests/deployPipeline.test.ts`**

Add a `describe('GitHub Actions CI/CD Workflows', ...)` block to `tests/deployPipeline.test.ts`:
- `deploy.yml`:
  - Triggers on `push` (`main`) and `workflow_dispatch`, keeps `group: deploy` and `cancel-in-progress: false`.
  - Uses `${GT_SERVER%/}/gt` download into `./gt.cjs` with `grep -q 'gt (Gemini Terminal)' ./gt.cjs`.
  - Has fallback block building `./dist/gt.js` and copying to `./gt.cjs` when `DOWNLOAD_SUCCESS` is not `1` (no top-level unconditional `Install dependencies & Build local gt CLI` step!).
  - Invokes `node ./gt.cjs exec`, preserves NVM/shell sourcing + `npm run deploy`, and the extracted `bash -c '...'` block passes `execFileSync('bash', ['-n', '-c', block])`.
- `ci.yml`:
  - Triggers on `pull_request` (`main`) and `workflow_dispatch`, and does NOT have a `push:` trigger on `main`.
  - Configures `cache: 'npm'` and `cache-dependency-path` referencing both `package-lock.json` and `frontend/package-lock.json`.
  - Runs single root install (`npm install --no-audit --no-fund --prefer-offline`) and single frontend install (`npm --prefix frontend install --no-audit --no-fund --prefer-offline`), then `npm test`, `npm run typecheck`, `npm run build`.

- [x] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/deployPipeline.test.ts`
Expected: FAIL on `deploy.yml` and `ci.yml` assertions.

- [x] **Step 3: Update `.github/workflows/deploy.yml` and `.github/workflows/ci.yml`**

Edit both workflow files to match the exact specifications in **Interfaces** above.

- [x] **Step 4: Run full verification suite**

Run:
```bash
npm test -- tests/deployPipeline.test.ts tests/deployScriptVersion.test.ts tests/gracefulShutdown.test.ts tests/gtInstallEndpoints.test.ts
npm run typecheck
npm run build
npm test
```
Expected: All tests pass, `typecheck` passes with exit code 0, full `npm run build` succeeds, and full Jest suite passes.

- [x] **Step 5: Commit Task 3**

```bash
git add .github/workflows/deploy.yml .github/workflows/ci.yml tests/deployPipeline.test.ts
git commit -m "perf(ci): fetch gt cli from hub with local fallback and cache ci workflow"
```

---

## Plan Self-Review

1. **Spec Coverage**:
   - `buildServer` (`scripts/build-gt.js` `--server`) -> Task 1
   - `package.json` cleanup (`postinstall` removal, `build:frontend`, `build:backend`, `typecheck`, `install:all`, `build`, `prestart`) -> Task 1
   - `CLAUDE.md` updates -> Task 1
   - `scripts/deploy.sh` (`ensure_pm2`, `resolve_env_port`, `compute_deploy_plan`, smart installs, conditional frontend build, typecheck + esbuild backend/gt, PM2 reload, `.env`-aware health check) -> Task 2
   - `.github/workflows/deploy.yml` (`curl $GT_SERVER/gt` fast path + local fallback) -> Task 3
   - `.github/workflows/ci.yml` (`pull_request` + `workflow_dispatch`, dual lockfile cache, single-pass installs) -> Task 3
   - `tests/deployPipeline.test.ts` -> Tasks 1, 2, 3
2. **Step Granularity & Clarity**: Every task follows failing test -> run to fail -> minimal implementation -> verification -> commit, with unambiguous signatures and exact test conditions.
3. **Review Focus Coverage**: All 5 high-risk edge cases are explicitly covered in Task 1 and Task 2 tests.
