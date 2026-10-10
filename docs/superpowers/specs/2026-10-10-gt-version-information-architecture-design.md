# Full-Stack Version Information Architecture Design Spec

## 1. Overview & Objectives
This specification establishes a robust, full-stack version management and diagnostic architecture across `gt-hub` and the `gt` CLI ecosystem:

1. **Single Source of Truth**: `package.json` serves as the baseline version source. Upgrades are managed standardly via `npm version [patch|minor|major]`. No hardcoded version strings exist in application source code.
2. **Build-Time Metadata Injection**: `esbuild` and backend builds automatically inject version metadata (`version`, `gitCommit`, `buildTime`, `platform`), creating a standalone executable (`dist/gt.js`) that does not depend on runtime `package.json` or `.git` directories.
3. **Multi-Tier CLI Version Commands**:
   - `gt -v` / `gt --version`: Ultra-fast, single-line local version display.
   - `gt version`: Multi-tier diagnostic display covering both local Client and connected Target Hub Server (supports `--client`, `--json`, and target context/server flags).
4. **Agent Version Telemetry**: Agents report their running version during WebSocket handshakes to the Hub.
5. **Cluster Node Observability**: `gt nodes` and `gt ps` display a dedicated `VERSION` column in tabular output.

---

## 2. Version Metadata Schema & Resolution

### 2.1 Metadata Model (`src/shared/version.ts`)
```typescript
export interface VersionInfo {
  version: string;     // e.g. "1.0.0"
  gitCommit: string;   // e.g. "ba40658"
  buildTime: string;   // e.g. "2026-10-10T12:00:00Z"
  platform: string;    // e.g. "linux/x64"
}
```

### 2.2 Global Build Injections & Graceful Fallback
Global build definitions:
- `__GT_VERSION__`: Injected from `package.json#version`
- `__GT_GIT_COMMIT__`: Injected from `git rev-parse --short HEAD`
- `__GT_BUILD_TIME__`: Injected from `new Date().toISOString()`

Resolution helper:
```typescript
declare const __GT_VERSION__: string | undefined;
declare const __GT_GIT_COMMIT__: string | undefined;
declare const __GT_BUILD_TIME__: string | undefined;

export function getClientVersion(): VersionInfo {
  const version = typeof __GT_VERSION__ !== 'undefined'
    ? __GT_VERSION__
    : require('../../package.json').version;
  const gitCommit = typeof __GT_GIT_COMMIT__ !== 'undefined'
    ? __GT_GIT_COMMIT__
    : 'dev';
  const buildTime = typeof __GT_BUILD_TIME__ !== 'undefined'
    ? __GT_BUILD_TIME__
    : new Date().toISOString();
  const platform = `${process.platform}/${process.arch}`;

  return { version, gitCommit, buildTime, platform };
}
```

---

## 3. Build Tooling & Scripts

### 3.1 Build Script Automation (`scripts/build-gt.js` or `package.json`)
Update `package.json` `build:gt`:
```bash
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
VERSION=$(node -p "require('./package.json').version")
```
Pass to `esbuild`:
```text
--define:__GT_VERSION__="${VERSION}"
--define:__GT_GIT_COMMIT__="${GIT_COMMIT}"
--define:__GT_BUILD_TIME__="${BUILD_TIME}"
```

---

## 4. Hub Server API

### 4.1 Endpoint: `GET /api/terminal/version`
- Protected by `adminAuthMiddleware`.
- Returns `VersionInfo` of the running Hub server.
- Response payload:
```json
{
  "version": "1.0.0",
  "gitCommit": "ba40658",
  "buildTime": "2026-10-10T11:50:00Z",
  "platform": "linux/x64"
}
```

### 4.2 Endpoint: `GET /health`
- Unauthenticated health check.
- Returns `{ "status": "ok", "version": "1.0.0" }`.

---

## 5. Agent Handshake & HostManager Registry

### 5.1 Agent WebSocket Handshake (`src/agent/daemon.ts`)
When connecting to Target Hub, Agent appends `version` to the query parameters:
```typescript
const clientVer = getClientVersion();
const targetWsUrl = resolveWebSocketUrl(serverArg, {
  hostId,
  name: hostName,
  hostname,
  ip: localIp,
  platform,
  machineId,
  version: clientVer.version,
});
```

### 5.2 Server Host Management (`src/server/modules/terminal/services/hostManager.ts`)
- In `ManagedHost` and `HostInfo`, add `version?: string`.
- When an agent connects via `registerAgent()`, record `metadata.version`.
- Persist `version` on re-registration/heartbeats.
- Return `version` in `/api/terminal/hosts`.

---

## 6. CLI Commands & Formatting

### 6.1 `gt -v` / `gt --version`
Short-form single line output:
```text
gt version 1.0.0 (commit: ba40658, built: 2026-10-10T12:00:00Z, linux/x64)
```

### 6.2 `gt version`
Comprehensive version command:
```text
gt version [options]

Options:
  --client              Only print client version (offline mode)
  -s, --server <url>    Target Hub server URL
  -k, --key <secret>    Admin secret key
  -c, --context <name>  Target Hub context
  --json                Output in JSON format
```

Output formats:
1. **Default (Text)**:
```text
Client:
  Version:    1.0.0
  Git Commit: ba40658
  Build Time: 2026-10-10T12:00:00Z
  OS/Arch:    linux/x64

Server (http://localhost:8000):
  Version:    1.0.0
  Git Commit: ba40658
  Build Time: 2026-10-10T11:50:00Z
  OS/Arch:    linux/x64
```
If the Hub is unreachable:
```text
Server (http://localhost:8000):
  Error:      Unable to connect to Hub (connect ECONNREFUSED)
```

2. **`--json`**:
```json
{
  "client": {
    "version": "1.0.0",
    "gitCommit": "ba40658",
    "buildTime": "2026-10-10T12:00:00Z",
    "platform": "linux/x64"
  },
  "server": {
    "url": "http://localhost:8000",
    "version": "1.0.0",
    "gitCommit": "ba40658",
    "buildTime": "2026-10-10T11:50:00Z",
    "platform": "linux/x64"
  }
}
```

### 6.3 `gt nodes` & `gt ps` Table Formatting
Add `VERSION` column to the tabular display:
```text
NODE ID             NAME                     STATUS      VERSION   PLATFORM    IP                 LAST SEEN
---------------------------------------------------------------------------------------------------------------
c4d930fe86a7        worker-bj                online      1.0.0     linux       192.168.1.10       Just now
```
Fallback to `-` for agents connecting without version information.

---

## 7. Testing & Verification

1. **Unit Tests**:
   - `tests/gtVersion.test.ts`: Verify `getClientVersion()` returns structured object with fallback defaults.
   - `tests/gtCommanderCli.test.ts`: Test `gt -v`, `gt version`, `gt version --client`, `gt version --json`.
2. **Integration Tests**:
   - Verify `GET /api/terminal/version` returns Hub version.
   - Verify agent registration records `version` and reflects in `GET /api/terminal/hosts`.
   - Verify `gt nodes` displays the `VERSION` column.
3. **Build & Zero-Dependency Test**:
   - Verify `npm run build:gt` generates bundle with injected `__GT_*__` constants.
