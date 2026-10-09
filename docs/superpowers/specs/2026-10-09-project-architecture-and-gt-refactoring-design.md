# Project Architecture and gt-hub Structural Refactoring Design

## Overview
This document specifies the architectural redesign and implementation details for refactoring `gt-hub` into a modular, strongly typed, and cleanly layered system.

The primary goals are:
1. Relocate and decompose the 4,600+ line monolithic `scripts/gt.js` into modular TypeScript packages under `src/client/`, `src/agent/`, and `src/shared/`.
2. Introduce `esbuild` to compile and bundle the `gt` CLI and Agent into a single-file, zero-dependency executable (`dist/gt.js`), preserving backward-compatible distribution over `curl` and `scripts/gt.js`.
3. Standardize communication protocols and domain models inside `src/shared/` to eliminate magic strings and duplicate interfaces between Server, Agent, and Client.
4. Refactor the backend server into `src/server/` with high-cohesion feature modules, eliminating hollow modules (`src/admin/`), extracting RPC scheduling from `HostManager`, and isolating static file / script delivery out of `app.ts`.
5. Clean up TypeScript build configurations (`tsconfig.json`) to keep production builds cleanly targeted without test contamination.

---

## 1. Directory Structure

```text
src/
├── bin/
│   └── gt.ts                     # Entry point for building standalone gt bundle and exports
│
├── shared/                       # Shared contracts between Server, Agent, Client, and Web
│   ├── protocol/
│   │   ├── events.ts             # WebSocket prefixes, message types, and RPC action constants
│   │   └── messages.ts           # Protocol payload types (Exec, File, Resize, etc.)
│   ├── types/
│   │   ├── host.ts               # Host metadata, statuses, and managed host structures
│   │   ├── task.ts               # Execution tasks, processes, and life-cycle events
│   │   └── file.ts               # File stats, items, and range request definitions
│   └── utils/
│       ├── rangeParser.ts        # Byte-range parsing utility
│       ├── timeHelpers.ts        # Time and duration formatting
│       └── wsAdapter.ts          # Dual-environment WebSocket adapter (native WebSocket + ws)
│
├── client/                       # gt CLI command-line client
│   ├── index.ts                  # CLI entry point, argument parsing, command dispatch
│   ├── config/
│   │   └── configStore.ts        # ~/.gtrc file configuration, defaults, and token management
│   ├── commands/
│   │   ├── auth.ts               # gt auth
│   │   ├── cp.ts                 # gt cp (slice uploading, range downloading, path resolver)
│   │   ├── exec.ts               # gt exec (remote execution, pure streaming)
│   │   ├── hosts.ts              # gt hosts / ps
│   │   ├── logs.ts               # gt logs
│   │   └── manage.ts             # gt kill / restart
│   ├── interactive/
│   │   └── interactiveExec.ts    # Interactive PTY session over WebSocket
│   └── utils/
│       └── terminalUI.ts         # Table rendering, formatting templates, shell escaping
│
├── agent/                        # gt Agent reverse daemon
│   ├── index.ts                  # runAgent entry point and option parser
│   ├── daemon.ts                 # AgentDaemonManager: WebSocket lifecycle, reconnection, ping/pong
│   ├── pty/
│   │   ├── drivers.ts            # NodePtyDriver, PosixPtyDriver, InteractivePipeDriver
│   │   └── sessionManager.ts     # StreamSessionManager: PTY process lifecycle & size stabilization
│   ├── tasks/
│   │   └── taskManager.ts        # TaskManager: process tracking and tree kill logic
│   └── handlers/
│       ├��─ cmdExecHandler.ts     # Remote execution RPC handler
│       └── fileRpcHandler.ts     # Remote file listing/stat/slice RPC handler
│
└── server/                       # Hub backend server
    ├── index.ts                  # Server bootstrap (HTTP server & WebSocket initialization)
    ├── app.ts                    # Express application instance and middleware configuration
    ├── config/
    │   └── default.ts            # Server environment configuration loader
    ├── middlewares/
    │   ├── adminAuth.ts          # Unified admin key authentication middleware
    │   └── errorHandler.ts       # Global Express error handling middleware
    └── modules/
        ├── auth/
        │   ├── authController.ts # Authentication check & status endpoints
        │   └── authRoutes.ts     # Express router for /api/auth
        ├── download/
        │   ├── downloadController.ts # Dynamic installer script URL injection & gt download
        │   └── downloadRoutes.ts # Routes for /install.sh, /gt, /api/terminal/install, etc.
        ├── terminal/
        │   ├── controllers/      # terminalHostController, terminalFileController, etc.
        │   ├── services/
        │   │   ├���─ hostManager.ts    # Host registry & connection state management
        │   │   ├── rpcDispatcher.ts  # RPC correlation, pending maps, and timeouts
        │   │   ├── execBridge.ts     # Streaming execution bridge
        │   │   ├── execService.ts    # Execution management
        │   │   ├── fileService.ts    # Server-side file operations
        │   │   └── logService.ts     # Audit log storage and retrieval
        │   ├── ws/
        │   │   └── terminalWs.ts     # WebSocket endpoints (/ws, /agent-ws, /exec-ws)
        │   └── routes/
        │       └── terminalRoutes.ts # Express router for /api/terminal
        └── static/
            └── staticMiddleware.ts   # Frontend SPA static file delivery & route fallback
```

---

## 2. Shared Protocol & Type System (`src/shared/`)

### Protocol Constants (`src/shared/protocol/events.ts`)
```typescript
export const WS_PREFIX = {
  JSON: 'JSON:',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export const WS_MSG_TYPES = {
  PING: 'ping',
  PONG: 'pong',
  RESIZE: 'resize',
  RESET: 'reset',
  REGISTERED: 'registered',
  REJECTED: 'rejected',
  META: 'meta',
  CMD_EXEC: 'cmd_exec',
  FILE_RPC: 'file_rpc',
  TASK_ACTION: 'task_action',
} as const;

export const RPC_FILE_ACTIONS = {
  LIST: 'list',
  STAT: 'stat',
  READ_CHUNK: 'read_chunk',
  WRITE_CHUNK: 'write_chunk',
  RM: 'rm',
  MKDIR: 'mkdir',
  MOVE: 'move',
} as const;
```

### Protocol Payloads (`src/shared/protocol/messages.ts`)
- All WebSocket control frames inherit a base structure `{ type: string; [key: string]: any }`.
- RPC envelopes:
  - Request: `{ type: 'cmd_exec' | 'file_rpc'; requestId: string; ...payload }`
  - Response: `{ type: 'cmd_exec_res' | 'file_rpc_res'; requestId: string; success: boolean; data?: any; error?: string }`

---

## 3. Build, Packaging, and Backward Compatibility

### Packaging `gt` via `esbuild`
1. Install `esbuild` as a development dependency.
2. Build configuration in `package.json`:
   ```bash
   esbuild src/bin/gt.ts --bundle --platform=node --target=node18 --outfile=dist/gt.js --banner:js="#!/usr/bin/env node" --external:node-pty --external:ws
   ```
3. Mark `node-pty` and `ws` as external so that optional native modules are dynamically loaded with graceful fallback at runtime without bloating or failing the bundle on heterogeneous target environments.

### Backward-Compatibility Shim (`scripts/gt.js`)
To ensure that existing test suites, external scripts, and local developer workflows remain unaffected:
- Maintain `scripts/gt.js` as a light CommonJS bridge exporting everything from `dist/gt.js` (or delegating execution if called directly as a script).
- Add `"pretest": "npm run build:gt"` to ensure `dist/gt.js` is fresh whenever tests run.
- Keep the `bin` field in `package.json` pointing to `./scripts/gt.js` or `./dist/gt.js`.

---

## 4. Server Architecture Refactoring (`src/server/`)

### Isolation of Responsibilities
1. **`app.ts` Decoupling**:
   - `app.ts` only sets up Express plugins, global JSON parsers, routes, and error handling.
   - Script injection logic (e.g. dynamically replacing `INJECTED_HUB_URL` in `install-gt.sh`) moves to `downloadController.ts`.
   - Frontend SPA fallback routing moves to `staticMiddleware.ts`.
2. **Elimination of `src/admin`**:
   - Move `adminAuth.ts` to `src/server/middlewares/adminAuth.ts`.
   - Remove redundant `adminRoutes.ts`, mounting `/api/admin/terminal` directly to `terminalRoutes` as a compatibility alias.
3. **RPC Extraction in `terminalHostManager.ts`**:
   - Extract `sendCmdExec` and `sendFileRpc` pending callback tracking, timeout clearing, and correlation IDs into `rpcDispatcher.ts`.
   - `HostManager` retains responsibility only for active WebSocket registrations, host heartbeats, and status queries.

---

## 5. Build Configuration Clean-up (`tsconfig.json`)

1. Update root `tsconfig.json` to configure:
   - `rootDir: "./"` with `outDir: "./dist"` or create a dedicated `tsconfig.server.json` with `rootDir: "./src/server"`.
   - Ensure `tests/` are excluded from the production build artifacts, preventing test files from being emitted into `dist/tests/`.
2. Maintain `jest.config.js` with `ts-jest` for running TypeScript tests seamlessly from `tests/`.

---

## 6. Verification and Acceptance Criteria

1. **Compilation**: `npm run build` succeeds cleanly, producing:
   - `dist/server/index.js` (Server runtime)
   - `dist/gt.js` (Standalone CLI/Agent executable)
   - `dist/frontend/` (Frontend web app)
2. **Compatibility**: All existing unit and integration tests (approx. 70 test files in `tests/`) pass without regressions:
   ```bash
   npm test
   ```
3. **Execution**:
   - `node scripts/gt.js --help` works identically.
   - `node dist/gt.js --help` works identically.
   - Running the server (`npm start` or PM2) loads `dist/server/index.js` and serves all APIs and WebSocket connections.
4. **Distribution**:
   - `GET /install.sh` returns dynamically interpolated installer script.
   - `GET /gt` streams the bundled `dist/gt.js`.
