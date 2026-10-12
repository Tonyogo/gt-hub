# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commonly Used Commands

### Build Commands
- Full project build: `npm run build` (generates version metadata, builds frontend, compiles backend TypeScript, and bundles CLI)
- Build backend only: `npm run build:backend`
- Build frontend only: `npm run build:frontend`
- Build CLI executable only: `npm run build:gt` (bundles `src/bin/gt.ts` into `dist/gt.js` via esbuild)
- Generate version data: `npm run version:gen` (writes to `src/shared/version.json`)
- Clean build outputs: `npm run clean`

### Development & Execution
- Backend development server (with hot reload): `npm run dev` (`ts-node-dev`)
- Frontend development server: `npm run dev:frontend` (Vite dev server at `http://localhost:5174`, proxies `/api/terminal` to port 8000)
- Production server start: `npm start`
- Run local `gt` CLI: `npm run gt -- <args>` or `node scripts/gt.js <args>` (automatically re-bundles `dist/gt.js` if source files are newer)
- Production deploy script: `npm run deploy` (`bash scripts/deploy.sh`)

### Testing
- Run all test suites: `npm test` (pretest builds `dist/gt.js`; runs Jest with `--detectOpenHandles --forceExit`)
- Run a single test file: `npm test -- tests/<test-file-name>.test.ts`
- Run specific tests matching a pattern: `npm test -- -t "<pattern>"`

## High-Level Architecture

`gt-hub` is a centralized WebSocket Hub, WebTerminal service, and reverse agent cluster management system for Gemini Terminal (`gt`). It coordinates browser terminal clients, remote/local agent nodes, and the standalone `gt` CLI.

### Subsystems & Directory Layout

- **Server (`src/server/`, `src/terminal/`)**:
  - Express application (`src/server/app.ts`) and HTTP/WebSocket bootstrap (`src/server/index.ts`).
  - WebSocket multiplexing (`src/terminal/routes/terminalWs.ts`): The HTTP server listens for `upgrade` requests and dispatches to three WebSocket endpoints:
    - `/api/terminal/ws`: Browser terminal connections (xterm.js sessions).
    - `/api/terminal/agent-ws`: Reverse tunnels from remote host agent daemons, tracked by `terminalHostManager` (`src/terminal/services/terminalHostManager.ts`).
    - `/api/terminal/exec-ws`: Real-time streaming CLI execution sessions, bridged by `terminalExecBridge` (`src/terminal/services/terminalExecBridge.ts`).
  - Auth & Security: Admin secret key authentication via `x-admin-key` header or query parameter, verified with timing-safe comparison (`src/shared/utils/security.ts`).
  - Public endpoints: `/install.sh` and `/gt` direct binary downloads (`src/server/modules/download/downloadRoutes.ts`).
  - Static hosting: Serves built SPA assets from `dist/frontend` (`src/server/modules/static/staticMiddleware.ts`).
  - Default config: `config/default.ts` (default port 8000, `GT_KEY` secret, log levels).

- **Client CLI (`src/client/`, `src/bin/gt.ts`)**:
  - Bundled as a standalone zero-dependency executable (`dist/gt.js`) using esbuild (`node-pty` and `ws` externalized).
  - Commander-based CLI (`src/client/index.ts`) providing Docker/kubectl-style commands:
    - `gt auth`: Authentication credentials and login status.
    - `gt config`: Multi-context management (`~/.gt/config.json` managed via `ConfigStore`), enabling environment switching (`gt config use-context <name>`).
    - `gt nodes` / `gt ps`: Cluster node discovery, connection health, and node pruning.
    - `gt exec`: Remote command execution with interactive TTY (`-it`), detached mode (`-d`), streaming output, and remote exit code forwarding.
    - `gt cp`: Bi-directional file transfer between local filesystem and remote nodes using chunked HTTP range transfers.
    - `gt task`: Remote task inspection, log tailing (`-f`), and cancellation (`kill`).
    - `gt version`: Local and remote server version diagnostics (`--client`, `--json`).
    - `gt agent`: Local reverse agent daemon management.

- **Agent Daemon (`src/agent/`)**:
  - Background reverse agent daemon managed via `gt agent <start|stop|restart|status|logs|name>`.
  - State, PID, and logs stored under `~/.gt/`.
  - Connects out to the Hub via `/api/terminal/agent-ws` with automatic reconnects and heartbeat.
  - Executes commands and handles terminal sessions via PTY (`node-pty` with fallback child_process drivers in `src/agent/pty/drivers.ts`).
  - Handles file chunk RPC transfers and remote task management (`src/agent/tasks/taskManager.ts`).

- **Frontend (`frontend/`)**:
  - React 18 SPA built with Vite, TypeScript, and Tailwind CSS.
  - Uses Xterm.js for terminal emulation and Monaco Editor for file editing.
  - Bundles into `dist/frontend` during `npm run build:frontend`.

- **Build & Versioning Pipeline (`scripts/`, `src/shared/`)**:
  - `package.json` is the single source of truth for the base version.
  - `scripts/generate-version.js` calculates git commit, tag descriptions, and build timestamps, writing `src/shared/version.json`.
  - `scripts/build-gt.js` compiles `src/bin/gt.ts` into `dist/gt.js` while injecting compile-time defines (`__GT_VERSION__`, `__GT_GIT_COMMIT__`, `__GT_BUILD_TIME__`).
