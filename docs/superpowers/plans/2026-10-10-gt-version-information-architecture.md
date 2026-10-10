# Full-Stack Version Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a full-stack version management architecture across CLI, Hub Server, and Agent nodes: build-time metadata injection via esbuild, multi-tier `gt -v` and `gt version` commands, agent version reporting during WebSocket handshake, and a dedicated `VERSION` column in `gt nodes` and `gt ps`.

**Architecture:** Create `src/shared/version.ts` to provide structured `VersionInfo` with compile-time constants injected via esbuild (`scripts/build-gt.js`) and safe dev/test fallbacks. Provide `GET /api/terminal/version` on the Hub Server. Update Agent WebSocket connection to include its version in connection query parameters, store it in `TerminalHostManager`, and display `VERSION` in `gt nodes` / `gt ps` tabular outputs.

**Tech Stack:** TypeScript 5.4, esbuild, Commander.js 12.x, Express 4.x, ws, Jest 29.

**Spec:** `docs/superpowers/specs/2026-10-10-gt-version-information-architecture-design.md`

## Global Constraints

- `package.json#version` is the single source of truth for version numbering; no hardcoded version strings in source code.
- Standalone CLI bundle (`dist/gt.js`) must be zero-dependency and executable without `package.json` or `.git` directory present.
- `gt -v` and `gt --version` must execute locally without making network calls.
- `gt version` queries the target Hub Server by default, supports `--client` for local-only, and supports `--json` for automation.
- Cluster nodes listing (`gt nodes`, `gt ps`) must display a dedicated `VERSION` column, displaying `-` if agent version is missing.

## Review Focus

1. **Dev & Test Fallback**: Calling `getClientVersion()` or `getServerVersion()` in unbundled environments (e.g. Jest or `ts-node-dev`) where `__GT_*__` defines are absent must gracefully read `package.json` and not throw `ReferenceError`.
2. **Server Unreachable Graceful Degradation**: Running `gt version` when the Hub server is offline or unreachable must print Client info and display a friendly server connection error instead of crashing with unhandled rejection.
3. **Legacy/Missing Agent Version**: When an Agent connects without a version parameter (or an existing offline agent has no version), `gt nodes` and `gt ps` must display `-` without misaligning columns.
4. **Structured JSON Output**: Running `gt version --json` must produce valid JSON matching the schema regardless of whether the server is reachable or errored.
5. **Standalone Bundle Purity**: Running `dist/gt.js -v` from an empty temporary directory without `node_modules` or `.git` must successfully output the injected version, git commit, and build time.

---

### Task 1: Version Metadata Model & Build-Time Injection

**Files:**
- Create: `src/shared/version.ts`
- Create: `scripts/build-gt.js`
- Modify: `package.json`
- Test: `tests/gtVersion.test.ts`

**Interfaces:**
- Consumes: `package.json#version`, `git rev-parse --short HEAD`
- Produces:
  ```typescript
  export interface VersionInfo {
    version: string;
    gitCommit: string;
    buildTime: string;
    platform: string;
  }
  export function getVersionInfo(): VersionInfo;
  export function formatShortVersion(info?: VersionInfo): string;
  ```

- [ ] **Step 1: Write failing unit tests for version metadata in tests/gtVersion.test.ts**

Create `tests/gtVersion.test.ts`:
```typescript
import { getVersionInfo, formatShortVersion, VersionInfo } from '../src/shared/version';
import pkg from '../package.json';

describe('Version Metadata Resolver', () => {
  it('returns valid VersionInfo with package version in fallback/dev mode', () => {
    const info = getVersionInfo();
    expect(info).toBeDefined();
    expect(info.version).toBe(pkg.version);
    expect(typeof info.gitCommit).toBe('string');
    expect(typeof info.buildTime).toBe('string');
    expect(info.platform).toBe(`${process.platform}/${process.arch}`);
  });

  it('formats short version line correctly', () => {
    const mockInfo: VersionInfo = {
      version: '1.2.3',
      gitCommit: 'abcdef1',
      buildTime: '2026-10-10T12:00:00Z',
      platform: 'linux/x64',
    };
    const line = formatShortVersion(mockInfo);
    expect(line).toBe('gt version 1.2.3 (commit: abcdef1, built: 2026-10-10T12:00:00Z, linux/x64)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtVersion.test.ts`
Expected: FAIL (Cannot find module `../src/shared/version`)

- [ ] **Step 3: Implement src/shared/version.ts**

Create `src/shared/version.ts`:
```typescript
import path from 'path';

export interface VersionInfo {
  version: string;
  gitCommit: string;
  buildTime: string;
  platform: string;
}

declare const __GT_VERSION__: string | undefined;
declare const __GT_GIT_COMMIT__: string | undefined;
declare const __GT_BUILD_TIME__: string | undefined;

export function getVersionInfo(): VersionInfo {
  let version: string;
  let gitCommit: string;
  let buildTime: string;

  if (typeof __GT_VERSION__ !== 'undefined') {
    version = __GT_VERSION__;
  } else {
    try {
      // Fallback for unbundled/dev/test execution
      const pkg = require(path.join(__dirname, '../../package.json'));
      version = pkg.version || '0.0.0';
    } catch {
      version = '0.0.0';
    }
  }

  if (typeof __GT_GIT_COMMIT__ !== 'undefined') {
    gitCommit = __GT_GIT_COMMIT__;
  } else {
    gitCommit = 'dev';
  }

  if (typeof __GT_BUILD_TIME__ !== 'undefined') {
    buildTime = __GT_BUILD_TIME__;
  } else {
    buildTime = new Date().toISOString();
  }

  const platform = `${process.platform}/${process.arch}`;

  return {
    version,
    gitCommit,
    buildTime,
    platform,
  };
}

export function formatShortVersion(info: VersionInfo = getVersionInfo()): string {
  return `gt version ${info.version} (commit: ${info.gitCommit}, built: ${info.buildTime}, ${info.platform})`;
}
```

- [ ] **Step 4: Create scripts/build-gt.js and update package.json**

Create `scripts/build-gt.js`:
```javascript
const esbuild = require('esbuild');
const { execSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}

const buildTime = new Date().toISOString();
const version = pkg.version || '1.0.0';

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/bin/gt.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, '../dist/gt.js'),
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty', 'ws'],
  define: {
    '__GT_VERSION__': JSON.stringify(version),
    '__GT_GIT_COMMIT__': JSON.stringify(gitCommit),
    '__GT_BUILD_TIME__': JSON.stringify(buildTime),
  },
});
console.log(`[build:gt] Built dist/gt.js v${version} (${gitCommit}) built at ${buildTime}`);
```

Update `package.json` line 11:
Change `"build:gt"` from the raw esbuild CLI command to:
```json
"build:gt": "node scripts/build-gt.js",
```

- [ ] **Step 5: Run unit tests and build script to verify**

Run: `npx jest tests/gtVersion.test.ts && npm run build:gt`
Expected: PASS

- [ ] **Step 6: Commit Task 1**

```bash
git add src/shared/version.ts scripts/build-gt.js package.json tests/gtVersion.test.ts
git commit -m "feat(version): add version metadata model and esbuild injection script

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Hub Server Version API & Health Check Endpoint

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/terminal/routes/terminalRoutes.ts`
- Modify: `src/terminal/controllers/terminalHostController.ts`
- Test: `tests/gtServerVersion.test.ts`

**Interfaces:**
- Consumes: `getVersionInfo()` from `src/shared/version`
- Produces:
  - `GET /api/terminal/version` -> `VersionInfo`
  - `GET /health` -> `{ status: 'ok', version: string }`

- [ ] **Step 1: Write integration tests for server version endpoints in tests/gtServerVersion.test.ts**

Create `tests/gtServerVersion.test.ts`:
```typescript
import request from 'supertest';
import app from '../src/server/app';
import config from '../src/config/default';
import pkg from '../package.json';

describe('Hub Server Version Endpoints', () => {
  it('GET /health returns status ok with version', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(pkg.version);
  });

  it('GET /api/terminal/version rejects unauthorized requests when key is set', async () => {
    const origKey = config.adminSecretKey;
    config.adminSecretKey = 'test-secret-key';
    try {
      const res = await request(app).get('/api/terminal/version');
      expect(res.status).toBe(401);
    } finally {
      config.adminSecretKey = origKey;
    }
  });

  it('GET /api/terminal/version returns VersionInfo with valid key', async () => {
    const origKey = config.adminSecretKey;
    config.adminSecretKey = 'test-secret-key';
    try {
      const res = await request(app)
        .get('/api/terminal/version')
        .set('x-admin-key', 'test-secret-key');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(pkg.version);
      expect(res.body.gitCommit).toBeDefined();
      expect(res.body.buildTime).toBeDefined();
      expect(res.body.platform).toBeDefined();
    } finally {
      config.adminSecretKey = origKey;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtServerVersion.test.ts`
Expected: FAIL (Endpoints not returning version or route missing)

- [ ] **Step 3: Update src/server/app.ts and terminal routes/controllers**

In `src/server/app.ts`, update `/health`:
```typescript
import { getVersionInfo } from '../shared/version';

// Server Health check
app.get('/health', (req: Request, res: Response) => {
  const info = getVersionInfo();
  res.status(200).json({ status: 'ok', version: info.version });
});
```

In `src/terminal/controllers/terminalHostController.ts`, add `getVersion`:
```typescript
import { getVersionInfo } from '../../shared/version';

class TerminalHostController {
  // ... existing methods ...

  public async getVersion(req: Request, res: Response): Promise<void> {
    res.json(getVersionInfo());
  }
}
```

In `src/terminal/routes/terminalRoutes.ts`, register `GET /version`:
```typescript
// System Info
router.get('/version', (req, res) => terminalHostController.getVersion(req, res));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/gtServerVersion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/app.ts src/terminal/controllers/terminalHostController.ts src/terminal/routes/terminalRoutes.ts tests/gtServerVersion.test.ts
git commit -m "feat(server): expose /health version and /api/terminal/version endpoint

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Agent Version Telemetry & Hub HostManager Recording

**Files:**
- Modify: `src/shared/types/host.ts`
- Modify: `src/client/utils/terminalUI.ts`
- Modify: `src/agent/daemon.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Modify: `src/server/modules/terminal/services/hostManager.ts`
- Test: `tests/gtAgentVersionTelemetry.test.ts`

**Interfaces:**
- Consumes: `getVersionInfo().version`
- Produces: `ManagedHost.version?: string`, `HostInfo.version?: string`

- [ ] **Step 1: Write unit test in tests/gtAgentVersionTelemetry.test.ts**

Create `tests/gtAgentVersionTelemetry.test.ts`:
```typescript
import { TerminalHostManager } from '../src/server/modules/terminal/services/hostManager';

describe('Agent Version Telemetry in HostManager', () => {
  let hostManager: TerminalHostManager;

  beforeEach(() => {
    hostManager = new TerminalHostManager();
  });

  it('records agent version upon registration', () => {
    const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const res = hostManager.registerAgent({
      hostId: 'machine-1',
      name: 'node-worker',
      hostname: 'worker-box',
      ip: '10.0.0.1',
      platform: 'linux',
      machineId: 'machine-1',
      version: '1.2.3',
      agentWs: mockWs,
    });

    expect(res.success).toBe(true);
    expect(res.host).toBeDefined();
    expect(res.host?.version).toBe('1.2.3');

    const hosts = hostManager.getHosts();
    const stored = hosts.find(h => h.id === 'machine-1');
    expect(stored?.version).toBe('1.2.3');
  });

  it('gracefully handles registration without version', () => {
    const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const res = hostManager.registerAgent({
      hostId: 'machine-legacy',
      name: 'legacy-worker',
      agentWs: mockWs,
    });

    expect(res.success).toBe(true);
    expect(res.host?.version).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtAgentVersionTelemetry.test.ts`
Expected: FAIL (Type error or `version` not supported on `registerAgent`)

- [ ] **Step 3: Update types, terminalUI, daemon, terminalWs, and hostManager**

1. In `src/shared/types/host.ts`:
```typescript
export interface ManagedHost {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: HostStatus;
  lastSeen: number;
  type: 'agent';
  machineId?: string;
  version?: string;
}

export interface HostInfo {
  id: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  status?: HostStatus;
  lastSeen?: number;
  machineId?: string;
  version?: string;
}
```

2. In `src/client/utils/terminalUI.ts` inside `resolveWebSocketUrl`:
Update the params type:
```typescript
params?: {
  hostId?: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  machineId?: string;
  version?: string;
}
```
And append `version`:
```typescript
if (params.version) {
  queryParts.push(`version=${encodeURIComponent(params.version)}`);
}
```

3. In `src/agent/daemon.ts`:
Import `getVersionInfo`:
```typescript
import { getVersionInfo } from '../shared/version';
```
In `connect()`:
```typescript
const clientVersion = getVersionInfo().version;
const targetWsUrl = resolveWebSocketUrl(serverArg, {
  hostId,
  name: hostName,
  hostname,
  ip: localIp,
  platform,
  machineId,
  version: clientVersion,
});
```

4. In `src/terminal/routes/terminalWs.ts`:
Extract `version`:
```typescript
const version = parsedUrl.searchParams.get('version') || undefined;
```
Pass to `hostMgr.registerAgent`:
```typescript
const regResult = hostMgr.registerAgent({
  hostId,
  name,
  hostname,
  ip,
  platform,
  machineId,
  version,
  agentWs: ws,
});
```

5. In `src/server/modules/terminal/services/hostManager.ts`:
Update `registerAgent` param type to include `version?: string`:
```typescript
public registerAgent(metadata: {
  hostId: string;
  name?: string;
  hostname?: string;
  ip?: string;
  platform?: string;
  machineId?: string;
  version?: string;
  agentWs?: any;
}): { success: boolean; host?: ManagedHost; error?: string }
```
And in host initialization and update:
```typescript
if (!host) {
  host = {
    id,
    name: targetName,
    hostname: metadata.hostname || id,
    ip: metadata.ip || '127.0.0.1',
    platform: metadata.platform || 'linux',
    status: 'online',
    lastSeen: Date.now(),
    type: 'agent',
    machineId,
    version: metadata.version,
    agentWs: metadata.agentWs,
  };
  this.hosts.set(id, host);
} else {
  // ...
  if (metadata.version) host.version = metadata.version;
}
```

- [ ] **Step 4: Run unit tests to verify**

Run: `npx jest tests/gtAgentVersionTelemetry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add src/shared/types/host.ts src/client/utils/terminalUI.ts src/agent/daemon.ts src/terminal/routes/terminalWs.ts src/server/modules/terminal/services/hostManager.ts tests/gtAgentVersionTelemetry.test.ts
git commit -m "feat(agent): report agent version in websocket handshake and record in host manager

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: CLI Commands (`gt -v`, `gt version`, and `gt nodes` / `gt ps` Table)

**Files:**
- Create: `src/client/commands/version.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/commands/hosts.ts`
- Test: `tests/gtCommanderCli.test.ts`
- Test: `tests/gtPsCommand.test.ts`

**Interfaces:**
- Consumes: `getVersionInfo()` from `src/shared/version`, `GET /api/terminal/version`
- Produces:
  - `gt -v` / `gt --version` -> single-line format
  - `gt version [--client] [--json] [-s <url>] [-k <key>] [-c <context>]`
  - `gt nodes` / `gt ps` tabular output with `VERSION` column

- [ ] **Step 1: Write tests in tests/gtCommanderCli.test.ts and tests/gtPsCommand.test.ts**

In `tests/gtCommanderCli.test.ts`, add:
```typescript
it('gt -v and gt --version output single-line version with commit and build info', () => {
  const res = spawnSync('node', [gtPath, '-v'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(res.status).toBe(0);
  expect(res.stdout).toMatch(/^gt version \d+\.\d+\.\d+ \(commit: [^,]+, built: [^,]+, [^)]+\)/);
});

it('gt version --client outputs formatted local client version info', () => {
  const res = spawnSync('node', [gtPath, 'version', '--client'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('Client:');
  expect(res.stdout).toContain('Version:');
  expect(res.stdout).toContain('Git Commit:');
  expect(res.stdout).toContain('Build Time:');
  expect(res.stdout).toContain('OS/Arch:');
  expect(res.stdout).not.toContain('Server:');
});

it('gt version --client --json outputs structured json', () => {
  const res = spawnSync('node', [gtPath, 'version', '--client', '--json'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(res.status).toBe(0);
  const data = JSON.parse(res.stdout.trim());
  expect(data.client).toBeDefined();
  expect(data.client.version).toBeDefined();
  expect(data.client.gitCommit).toBeDefined();
  expect(data.client.platform).toBeDefined();
});
```

In `tests/gtPsCommand.test.ts`, verify `VERSION` column in table header:
```typescript
expect(res.stdout).toContain('VERSION');
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run build:gt && npx jest tests/gtCommanderCli.test.ts -t "version"`
Expected: FAIL (`version` command not recognized or flag output mismatch)

- [ ] **Step 3: Implement src/client/commands/version.ts**

Create `src/client/commands/version.ts`:
```typescript
import { getVersionInfo, VersionInfo } from '../../shared/version';
import { makeRequest } from '../utils/terminalUI';

export async function handleVersionCommand({
  server,
  key,
  clientOnly = false,
  jsonOutput = false,
}: {
  server: string;
  key: string;
  clientOnly?: boolean;
  jsonOutput?: boolean;
}): Promise<void> {
  const clientInfo = getVersionInfo();

  let serverInfo: (VersionInfo & { url: string }) | null = null;
  let serverError: string | null = null;

  if (!clientOnly) {
    try {
      const res = await makeRequest({
        serverUrl: server,
        endpoint: '/api/terminal/version',
        method: 'GET',
        apiKey: key,
      });

      if (res.status === 200 && res.data && res.data.version) {
        serverInfo = {
          url: server,
          version: res.data.version,
          gitCommit: res.data.gitCommit || 'unknown',
          buildTime: res.data.buildTime || 'unknown',
          platform: res.data.platform || 'unknown',
        };
      } else {
        serverError = res.data?.error || `HTTP ${res.status}`;
      }
    } catch (err: any) {
      serverError = err.message || 'Unable to connect to Hub';
    }
  }

  if (jsonOutput) {
    const output: Record<string, any> = { client: clientInfo };
    if (!clientOnly) {
      if (serverInfo) {
        output.server = serverInfo;
      } else {
        output.server = {
          url: server,
          error: serverError,
        };
      }
    }
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Formatted human-readable output
  console.log('Client:');
  console.log(`  Version:    ${clientInfo.version}`);
  console.log(`  Git Commit: ${clientInfo.gitCommit}`);
  console.log(`  Build Time: ${clientInfo.buildTime}`);
  console.log(`  OS/Arch:    ${clientInfo.platform}`);

  if (!clientOnly) {
    console.log('');
    console.log(`Server (${server}):`);
    if (serverInfo) {
      console.log(`  Version:    ${serverInfo.version}`);
      console.log(`  Git Commit: ${serverInfo.gitCommit}`);
      console.log(`  Build Time: ${serverInfo.buildTime}`);
      console.log(`  OS/Arch:    ${serverInfo.platform}`);
    } else {
      console.log(`  Error:      ${serverError}`);
    }
  }

  process.exit(0);
}
```

- [ ] **Step 4: Update src/client/index.ts to register gt version and update -v**

In `src/client/index.ts`:
1. Import `getVersionInfo`, `formatShortVersion` from `../shared/version`.
2. Update `program.version(...)`:
```typescript
const versionInfo = getVersionInfo();
export const VERSION = versionInfo.version;

program
  .name('gt')
  .usage('[GLOBAL_OPTIONS] COMMAND [ARGS...]')
  .description('gt (Gemini Terminal) - Unified Docker-Style Terminal CLI')
  .version(formatShortVersion(versionInfo), '-v, --version', 'Output the version number')
```
3. Register `gt version`:
```typescript
program
  .command('version')
  .description('Show full gt version and environment information')
  .option('--client', 'Only print client version (offline mode)')
  .option('-s, --server <url>', 'Hub server URL')
  .option('-k, --key <secret>', 'Admin secret key')
  .option('-c, --context <name>', 'Target Hub context')
  .option('--json', 'Output in JSON format')
  .action(async (opts: Record<string, any>) => {
    const eff = resolveEffective(opts);
    await handleVersionCommand({
      server: eff.server,
      key: eff.key,
      clientOnly: !!opts.client,
      jsonOutput: resolveJson(opts),
    });
  });
```

- [ ] **Step 5: Add VERSION column in src/client/commands/hosts.ts**

In `src/client/commands/hosts.ts`:
Update column headers:
```typescript
console.log(
  'NODE ID'.padEnd(20) +
  'NAME'.padEnd(25) +
  'STATUS'.padEnd(12) +
  'VERSION'.padEnd(12) +
  'PLATFORM'.padEnd(12) +
  'IP'.padEnd(18) +
  'LAST SEEN'
);
console.log('-'.repeat(107));
```
Update row printing:
```typescript
for (const h of hosts) {
  const statusStr = h.status === 'online' ? 'online' : 'offline';
  const verStr = h.version || '-';
  console.log(
    (h.id || '').padEnd(20) +
    (h.name || h.hostname || '').padEnd(25) +
    statusStr.padEnd(12) +
    verStr.padEnd(12) +
    (h.platform || '').padEnd(12) +
    (h.ip || '').padEnd(18) +
    formatRelativeTime(h.lastSeen)
  );
}
```

- [ ] **Step 6: Build standalone bundle and run tests**

Run: `npm run build:gt && npx jest tests/gtCommanderCli.test.ts tests/gtPsCommand.test.ts`
Expected: PASS

- [ ] **Step 7: Commit Task 4**

```bash
git add src/client/commands/version.ts src/client/index.ts src/client/commands/hosts.ts tests/gtCommanderCli.test.ts tests/gtPsCommand.test.ts
git commit -m "feat(cli): add gt version command and include VERSION column in node listing

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Documentation & Full Test Suite Verification

**Files:**
- Modify: `README.md`
- Verify: Full test suite

**Interfaces:**
- Consumes: All updated CLI commands and server endpoints
- Produces: Updated docs, 100% passing test suites

- [ ] **Step 1: Update README.md with version command documentation**

In `README.md`, add:
- Section describing `gt -v` and `gt version [--client] [--json]`.
- Updated table in `gt nodes` / `gt ps` showing `VERSION` column.
- Note on `npm version [patch|minor|major]` release workflow.

- [ ] **Step 2: Clean build and execute all test suites**

Run:
```bash
npm run clean && npm run build
npm test
```
Expected: All test suites pass.

- [ ] **Step 3: Commit Task 5**

```bash
git add README.md
git commit -m "docs: update README with gt version commands and node VERSION column

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Plan Self-Review Checklist

- **Spec coverage**:
  - `package.json` single source of truth + `npm version` workflow -> Task 1 & Task 5.
  - Build-time injection (`__GT_*__`) with dev fallback -> Task 1.
  - `GET /api/terminal/version` and `GET /health` with version -> Task 2.
  - Agent WebSocket reporting and Hub HostManager storage -> Task 3.
  - `gt -v` single line + `gt version` client/server diagnosis + `--client` + `--json` -> Task 4.
  - `gt nodes` / `gt ps` tabular `VERSION` column -> Task 4.
- **Placeholder scan**: All steps contain complete code snippets and commands.
- **Review Focus coverage**:
  - Dev/test fallback verified in Task 1 (`tests/gtVersion.test.ts`).
  - Server unreachable error handling in Task 4 (`handleVersionCommand`).
  - Legacy/missing agent version fallback `-` in Task 3 & 4.
  - `--json` output structure verified in Task 4 (`tests/gtCommanderCli.test.ts`).
  - Standalone bundle verified via `npm run build:gt` and execution in Task 4 & 5.
