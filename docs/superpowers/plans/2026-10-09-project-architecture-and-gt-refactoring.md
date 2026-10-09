# Project Architecture and gt-hub Structural Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `gt-hub`'s monolithic `scripts/gt.js` into modular TypeScript sub-packages (`src/client`, `src/agent`, `src/shared`), reorganize the backend server under `src/server`, introduce `esbuild` single-file bundling, and clean up build configurations while preserving 100% backward compatibility for all existing tests and remote distribution.

**Architecture:** Split the codebase into shared protocol/domain models, modular CLI client, modular Agent daemon, and modular Hub server. Use `esbuild` to bundle `src/bin/gt.ts` into a standalone zero-dependency executable (`dist/gt.js`) and maintain `scripts/gt.js` as an export & execution proxy for test and CLI compatibility. Cleanly partition server code into Express middlewares, controller modules, and focused domain services.

**Tech Stack:** TypeScript 5.4, Node.js (v18/v20), Express 4.19, ws 8.21, node-pty 1.1, esbuild 0.20+, Jest 29, ts-jest.

**Spec:** `docs/superpowers/specs/2026-10-09-project-architecture-and-gt-refactoring-design.md`

## Global Constraints

- Runtime platform: Node.js 18+ (tested on Node 20).
- Bundled CLI (`dist/gt.js`) MUST be executable standalone without requiring local `node_modules` on the remote target host.
- Optional dependencies (`node-pty`, `ws`) MUST remain dynamic and gracefully fall back when not present.
- All 35+ symbols currently exported by `scripts/gt.js` MUST remain accessible when `require('../scripts/gt.js')` is called in tests.
- Backend server routes `/install.sh`, `/gt`, `/api/terminal/install`, `/api/terminal/gt`, `/api/terminal/*`, `/api/admin/terminal/*`, and `/api/auth/*` must maintain exact behavior and contract compatibility.

## Review Focus

1. **CLI Argument Passthrough via Proxy**: `node scripts/gt.js <cmd> [args]` and `gt <cmd> [args]` must forward arguments and exit codes without truncation.
2. **Dynamic Dependency Graceful Fallback**: Running `dist/gt.js` in an environment without `ws` or `node-pty` must fall back to native `WebSocket` / POSIX/Pipe without throw on startup.
3. **CommonJS Export Identity for Tests**: `const { AgentDaemonManager, TaskManager, ... } = require('../scripts/gt.js')` must resolve instances and classes identically to existing tests.
4. **Installer Dynamic URL Injection**: `GET /install.sh` must parse `x-forwarded-proto` and `x-forwarded-host` to replace `INJECTED_HUB_URL` without breaking script syntax.
5. **Clean Server Output Directory**: Running `npm run build` must compile clean server output into `dist/server/` (and maintain `dist/src/index.js` compatibility for PM2 if needed) without leaking `dist/tests/`.

---

### Task 1: Build Tooling & esbuild Setup

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: npm package ecosystem
- Produces: `npm run build:gt` script command generating `dist/gt.js`

- [ ] **Step 1: Install esbuild and update package.json**

Add `esbuild` to `devDependencies`, update build scripts to compile `gt`, and add `pretest` step.
```bash
npm install --save-dev esbuild
```

In `package.json`, update `scripts`:
```json
"scripts": {
  "gt": "node scripts/gt.js",
  "build:gt": "esbuild src/bin/gt.ts --bundle --platform=node --target=node18 --outfile=dist/gt.js --banner:js=\"#!/usr/bin/env node\" --external:node-pty --external:ws",
  "postinstall": "cd frontend && ( [ -d node_modules ] || npm install )",
  "build:frontend": "cd frontend && ( [ -d node_modules ] || npm install ) && npm run build",
  "build:backend": "tsc",
  "build": "npm run build:frontend && npm run build:backend && npm run build:gt",
  "deploy": "bash scripts/deploy.sh",
  "prestart": "([ -d dist/frontend ] || npm run build:frontend) && npm run build:backend && npm run build:gt",
  "start": "node dist/src/index.js",
  "dev:frontend": "cd frontend && npm run dev",
  "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
  "pretest": "npm run build:gt",
  "test": "jest --detectOpenHandles --forceExit",
  "clean": "rm -rf dist"
}
```

- [ ] **Step 2: Update tsconfig.json to exclude tests from production output**

Adjust `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "rootDir": "./",
    "outDir": "./dist",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "config/**/*"],
  "exclude": ["node_modules", "dist", "frontend", "tests"]
}
```

- [ ] **Step 3: Commit build tooling setup**

```bash
git add package.json tsconfig.json package-lock.json
git commit -m "build: setup esbuild and refine tsconfig include paths

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Shared Layer Implementation (`src/shared/`)

**Files:**
- Create: `src/shared/protocol/events.ts`
- Create: `src/shared/protocol/messages.ts`
- Create: `src/shared/types/host.ts`
- Create: `src/shared/types/task.ts`
- Create: `src/shared/types/file.ts`
- Create: `src/shared/utils/wsAdapter.ts`
- Create: `src/shared/utils/rangeParser.ts`
- Create: `src/shared/utils/timeHelpers.ts`
- Test: `tests/sharedRangeParser.test.ts`
- Test: `tests/sharedWsAdapter.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `WS_PREFIX`, `WS_MSG_TYPES`, `RPC_FILE_ACTIONS` from `protocol/events`
  - `createWebSocketAdapter(customWs)` from `utils/wsAdapter`
  - `parseRangeHeader(header, total)` from `utils/rangeParser`
  - `formatRelativeTime(ts)` from `utils/timeHelpers`
  - Domain types for `Host`, `Task`, `File`

- [ ] **Step 1: Write unit tests for shared utilities**

Create `tests/sharedWsAdapter.test.ts` and `tests/sharedRangeParser.test.ts` to test `createWebSocketAdapter` and `parseRangeHeader`.

- [ ] **Step 2: Implement protocol constants and message types**

Create `src/shared/protocol/events.ts` and `src/shared/protocol/messages.ts`.
Extract `WS_PREFIX`, `WS_MSG_TYPES`, `RPC_FILE_ACTIONS`, request/response envelopes.

- [ ] **Step 3: Implement domain types**

Create `src/shared/types/host.ts`, `src/shared/types/task.ts`, `src/shared/types/file.ts`.

- [ ] **Step 4: Implement shared utilities**

Implement `src/shared/utils/wsAdapter.ts` (ported from `createWebSocketAdapter` in `scripts/gt.js`), `src/shared/utils/rangeParser.ts` (migrated from `src/terminal/utils/rangeParser.ts`), and `src/shared/utils/timeHelpers.ts`.

- [ ] **Step 5: Run tests to verify shared layer**

Run: `npx jest tests/sharedRangeParser.test.ts tests/sharedWsAdapter.test.ts tests/rangeParser.test.ts`
Expected: PASS

- [ ] **Step 6: Commit shared layer**

```bash
git add src/shared/ tests/sharedRangeParser.test.ts tests/sharedWsAdapter.test.ts
git commit -m "feat(shared): implement protocol constants, types, and cross-platform utils

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Agent Modularization (`src/agent/`)

**Files:**
- Create: `src/agent/tasks/taskManager.ts`
- Create: `src/agent/pty/drivers.ts`
- Create: `src/agent/pty/sessionManager.ts`
- Create: `src/agent/handlers/cmdExecHandler.ts`
- Create: `src/agent/handlers/fileRpcHandler.ts`
- Create: `src/agent/daemon.ts`
- Create: `src/agent/index.ts`

**Interfaces:**
- Consumes: `src/shared/protocol/`, `src/shared/types/`, `src/shared/utils/`
- Produces:
  - `TaskManager`, `taskManager`, `killProcessTree`, `killProcessTreeSync`, `resolveWorkingDir`, `getDefaultShell`
  - `NodePtyDriver`, `PosixPtyDriver`, `InteractivePipeDriver`, `hasSystemPython3`, `tryRequirePty`, `StreamSessionManager`
  - `handleCmdExec`, `handleFileRpc`
  - `AgentDaemonManager`, `HANDSHAKE_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TIMEOUT_MS`
  - `runAgent(args, options)`

- [ ] **Step 1: Implement tasks/taskManager.ts**

Port process management, `killProcessTree`, `killProcessTreeSync`, working dir resolution, and `TaskManager` class with process tracking.

- [ ] **Step 2: Implement pty/drivers.ts & pty/sessionManager.ts**

Port `NodePtyDriver`, `PosixPtyDriver`, `InteractivePipeDriver`, `tryRequirePty`, and `StreamSessionManager` with dimension nudging, debounce, and PTY resize stabilization.

- [ ] **Step 3: Implement handlers/cmdExecHandler.ts & handlers/fileRpcHandler.ts**

Port command execution RPC handling (`handleCmdExec`) and file RPC handling (`handleFileRpc` with slice reading/writing, stat, listing).

- [ ] **Step 4: Implement daemon.ts & agent/index.ts**

Port `AgentDaemonManager` (long-polling/WebSocket connection, registration handshake, heartbeats, reconnect logic, message routing) and `runAgent`.

- [ ] **Step 5: Verify agent compilation with tsc**

Run: `npx tsc --noEmit`
Expected: No type errors in `src/agent/`

- [ ] **Step 6: Commit agent modules**

```bash
git add src/agent/
git commit -m "feat(agent): modularize daemon, PTY drivers, task manager, and RPC handlers

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: CLI Client Modularization (`src/client/`)

**Files:**
- Create: `src/client/config/configStore.ts`
- Create: `src/client/utils/terminalUI.ts`
- Create: `src/client/interactive/interactiveExec.ts`
- Create: `src/client/commands/auth.ts`
- Create: `src/client/commands/hosts.ts`
- Create: `src/client/commands/ps.ts`
- Create: `src/client/commands/logs.ts`
- Create: `src/client/commands/manage.ts`
- Create: `src/client/commands/cp.ts`
- Create: `src/client/commands/exec.ts`
- Create: `src/client/index.ts`

**Interfaces:**
- Consumes: `src/shared/`, `src/agent/`
- Produces:
  - `ConfigStore`, `DEFAULT_SERVER_URL`
  - `formatTemplate`, `quoteShellArg`, `resolveWebSocketUrl`, `parseControlMessage`
  - `resolveTaskId`, `resolveHost`, `isRemoteSpec`, `parseRemoteSpec`, `parseCpArgs`, `uploadLocalFile`, `downloadRemoteFile`, `runCp`
  - `parseExecArgs`, `runInteractiveExec`
  - `runClient(argv)` CLI dispatcher

- [ ] **Step 1: Implement config/configStore.ts and utils/terminalUI.ts**

Port `ConfigStore` (`~/.gtrc` reader/writer, server and key resolver), formatting utilities (`formatTemplate`, `quoteShellArg`, request helper).

- [ ] **Step 2: Implement commands (auth, hosts, ps, logs, manage, cp, exec)**

Port individual subcommands into dedicated modules:
- `commands/cp.ts`: `parseCpArgs`, `uploadLocalFile`, `downloadRemoteFile`, `runCp`
- `commands/exec.ts`: `parseExecArgs`, exec streaming
- `interactive/interactiveExec.ts`: raw terminal mode and WebSocket multiplexing

- [ ] **Step 3: Implement client/index.ts**

Create command parser and dispatcher handling all CLI subcommands (`hosts`, `exec`, `ps`, `logs`, `cp`, `kill`, `restart`, `auth`, `agent`, `--help`, `--version`).

- [ ] **Step 4: Verify client compilation with tsc**

Run: `npx tsc --noEmit`
Expected: No type errors in `src/client/`

- [ ] **Step 5: Commit client modules**

```bash
git add src/client/
git commit -m "feat(client): modularize CLI commands, config store, and interactive exec

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Packaging Entry Point & Backward-Compatibility Shim

**Files:**
- Create: `src/bin/gt.ts`
- Modify: `scripts/gt.js`
- Test: Existing test suites (`tests/gt*.test.ts`, `tests/terminal*.test.ts`)

**Interfaces:**
- Consumes: `src/client/`, `src/agent/`, `src/shared/`
- Produces:
  - `dist/gt.js`: Standalone executable bundled by esbuild
  - `scripts/gt.js`: CJS wrapper re-exporting everything from `dist/gt.js` and executing when run directly

- [ ] **Step 1: Implement src/bin/gt.ts**

Aggregate all exports and main CLI entry:
```typescript
import { runClient } from '../client';
import { runAgent } from '../agent';
// Export all classes, functions, and constants required by existing test suites
export * from '../shared/utils/wsAdapter';
export * from '../client/config/configStore';
export * from '../client/commands/cp';
export * from '../agent/tasks/taskManager';
export * from '../agent/pty/drivers';
export * from '../agent/pty/sessionManager';
export * from '../agent/daemon';
// Main runner when executed directly
if (require.main === module) {
  runClient(process.argv.slice(2));
}
```

- [ ] **Step 2: Build bundle using esbuild**

Run: `npm run build:gt`
Expected: `dist/gt.js` is created and executable.

- [ ] **Step 3: Update scripts/gt.js to proxy to dist/gt.js**

Refactor `scripts/gt.js`:
```javascript
#!/usr/bin/env node
const path = require('path');
const distPath = path.resolve(__dirname, '../dist/gt.js');

// Auto-build if dist/gt.js doesn't exist
const fs = require('fs');
if (!fs.existsSync(distPath)) {
  const { execSync } = require('child_process');
  execSync('npm run build:gt', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
}

const gt = require(distPath);
module.exports = gt;

if (require.main === module) {
  // Directly invoked via `node scripts/gt.js`
  if (typeof gt.main === 'function') {
    gt.main();
  }
}
```

- [ ] **Step 4: Run existing CLI and Agent test suites**

Run: `npx jest tests/gtCli.test.ts tests/gtAgentDaemon.test.ts tests/gtCpCommand.test.ts tests/terminalAgent.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit bundling and compatibility shim**

```bash
git add src/bin/gt.ts scripts/gt.js dist/gt.js
git commit -m "feat(gt): bundle standalone executable via esbuild with full CJS test compatibility

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Server Modularization (`src/server/`)

**Files:**
- Create: `src/server/config/default.ts`
- Create: `src/server/middlewares/adminAuth.ts`
- Create: `src/server/middlewares/errorHandler.ts`
- Create: `src/server/modules/auth/authController.ts`
- Create: `src/server/modules/auth/authRoutes.ts`
- Create: `src/server/modules/download/downloadController.ts`
- Create: `src/server/modules/download/downloadRoutes.ts`
- Create: `src/server/modules/static/staticMiddleware.ts`
- Create: `src/server/modules/terminal/services/rpcDispatcher.ts`
- Modify: `src/terminal/services/terminalHostManager.ts` -> `src/server/modules/terminal/services/hostManager.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Modify: `src/app.ts` (re-export `src/server/app`)
- Modify: `src/index.ts` (re-export `src/server/index`)

**Interfaces:**
- Consumes: `src/shared/`, Express, ws
- Produces:
  - Clean Express `app` without bloated download/static logic
  - Modular `downloadController` injecting installer hub URL
  - Modular `rpcDispatcher` managing pending RPC promises
  - Re-export shims in `src/app.ts` and `src/terminal/*` so existing tests keep passing

- [ ] **Step 1: Implement download and static modules**

Extract download controller (`/install.sh`, `/gt`) with URL detection into `src/server/modules/download/downloadController.ts`.
Extract frontend static serving into `src/server/modules/static/staticMiddleware.ts`.

- [ ] **Step 2: Implement rpcDispatcher.ts and decouple hostManager.ts**

Create `src/server/modules/terminal/services/rpcDispatcher.ts` to manage RPC tracking maps, timeouts, and callbacks.
Refactor host management in `src/server/modules/terminal/services/hostManager.ts` to delegate RPC requests to `rpcDispatcher`.

- [ ] **Step 3: Implement clean src/server/app.ts and src/server/index.ts**

Assemble Express app cleanly:
```typescript
app.use(express.json({ limit: '50mb' }));
app.use(downloadRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/admin/terminal', terminalRoutes); // Compatibility
app.use(staticMiddleware);
```

- [ ] **Step 4: Update src/app.ts and src/index.ts as bridges for existing imports**

Maintain backward compatibility for tests that import from `../src/app` or `../src/terminal/services/terminalHostManager`:
Re-export from the new `src/server/` modules.

- [ ] **Step 5: Run backend server tests**

Run: `npx jest tests/authRoutes.test.ts tests/gtInstallEndpoints.test.ts tests/terminalHostManager.test.ts tests/terminalExecWsRoute.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit server refactoring**

```bash
git add src/server/ src/app.ts src/index.ts src/terminal/
git commit -m "refactor(server): modularize backend into src/server with rpcDispatcher and clean app assembly

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Full Verification, Clean-up & Ecosystem Validation

**Files:**
- Modify: `.gitignore` (remove `package-lock.json` ignore to ensure deterministic builds)
- Verify: `ecosystem.config.js`
- Verify: `scripts/deploy.sh`
- Verify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Entire project
- Produces: Complete passing test suite, clean build artifacts, reproducible dependencies

- [ ] **Step 1: Remove package-lock.json from .gitignore**

Ensure `package-lock.json` is committed and tracked.

- [ ] **Step 2: Run full build suite**

Run: `npm run build`
Expected:
- Frontend built into `dist/frontend/`
- Backend built into `dist/`
- `dist/gt.js` bundled cleanly by `esbuild`

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All 70+ test suites pass without regression.

- [ ] **Step 4: Verify CLI and installer endpoints locally**

Verify:
```bash
node dist/gt.js --help
node scripts/gt.js --help
curl -s http://localhost:8000/install.sh (or mocked via test)
```

- [ ] **Step 5: Final commit**

```bash
git add .gitignore package-lock.json
git commit -m "chore: ensure lockfile tracking and verify complete refactored build and test suites

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
