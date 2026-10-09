# Manual Authentication Flags & Server-Side Machine Mutex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable manual authentication flags (`-s / --server` and `-k / --key`) across all `gt` commands, standardize environment variables strictly to `GT_SERVER` and `GT_KEY`, and enforce server-side single-agent-per-machine mutex per target Hub using persistent `machineId`.

**Architecture:** Update `ConfigStore` and server configuration to use `GT_SERVER` and `GT_KEY`. Remove CLI argument restrictions in `src/agent/daemon.ts` and forward authentication flags to background daemon processes. Extend `resolveWebSocketUrl` and `terminalWs` to exchange `machineId`, and enforce mutual exclusion in `TerminalHostManager.registerAgent` such that any incoming connection with an already-online `machineId` is rejected with code 4009.

**Tech Stack:** TypeScript 5.4, Express 4.19, ws 8.21, esbuild, Jest 29, ts-jest.

**Spec:** `docs/superpowers/specs/2026-10-09-gt-manual-auth-and-single-agent-per-machine-design.md`

## Global Constraints

- Authentication environment variables are strictly `GT_SERVER` and `GT_KEY` (no legacy fallback).
- Default Hub URL is `http://localhost:8000`.
- All `gt` subcommands (`run`, `agent start`, `agent run`, `exec`, `ps`, `hosts`, `cp`, `logs`, etc.) must accept `-s, --server <url>` and `-k, --key <secret>`.
- The server must reject any second agent attempting to register with the same `machineId` while an existing agent is online, returning WebSocket close code `4009` and error message starting with `Conflict: Machine`.
- When an existing agent with matching `machineId` is offline, the server must automatically prune the dead record and allow the new connection to take over.

## Review Focus

1. **Precedence Hierarchy**: Command line flag (`-s / -k`) > Environment variable (`GT_SERVER / GT_KEY`) > Local config file (`~/.gt/config.json`) > Default (`http://localhost:8000` / `''`).
2. **Daemon Child Process Argument Passthrough**: Starting a daemon with `gt run -d -s http://hub:8000 -k mysecret` must pass the server and key to the detached child process.
3. **Machine Mutex Rejection**: When an agent connection is rejected due to machine conflict, the agent process must print the error and exit with status code 1 instead of spinning in reconnect loops.
4. **Offline Host Automatic Pruning**: When a previous agent on the machine crashed or disconnected (status `offline`), a newly started agent with the same `machineId` must successfully register.
5. **CLI Bundle Synchronization**: Rebuilding via `npm run build:gt` must produce a standalone `dist/gt.js` incorporating the new authentication options and machineId protocol.

---

### Task 1: Environment Variables Standardization & Domain Model Update

**Files:**
- Modify: `src/shared/types/host.ts`
- Modify: `src/client/config/configStore.ts`
- Modify: `config/default.ts`
- Modify: `src/client/index.ts`
- Test: `tests/gtConfig.test.ts`

**Interfaces:**
- Consumes: `process.env.GT_SERVER`, `process.env.GT_KEY`
- Produces:
  - `ConfigStore.getEffectiveConfig({ server?, key? })`
  - `ManagedHost.machineId?: string`
  - `HostInfo.machineId?: string`

- [ ] **Step 1: Write failing test for GT_SERVER and GT_KEY resolution**

Update `tests/gtConfig.test.ts` to assert that `ConfigStore.getEffectiveConfig` uses `GT_SERVER` and `GT_KEY`, and does not read `TERMINAL_SERVER` or `ADMIN_SECRET_KEY`:
```typescript
it('resolves server and key from GT_SERVER and GT_KEY environment variables', () => {
  const { ConfigStore } = require('../src/client/config/configStore');
  const result = ConfigStore.getEffectiveConfig({}, {
    GT_SERVER: 'http://custom-hub:9999',
    GT_KEY: 'test-gt-key'
  });
  expect(result.server).toBe('http://custom-hub:9999');
  expect(result.key).toBe('test-gt-key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtConfig.test.ts -t "resolves server and key from GT_SERVER"`
Expected: FAIL

- [ ] **Step 3: Implement GT_SERVER, GT_KEY in config files & add machineId to types**

In `src/shared/types/host.ts`:
Add `machineId?: string` to `ManagedHost` and `HostInfo`.

In `config/default.ts`:
```typescript
export const config: HubConfig = {
  port: process.env.PORT ? (Number(process.env.PORT) || 8000) : 8000,
  adminSecretKey: process.env.GT_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  timeZone: process.env.TIME_ZONE || process.env.TZ || 'Asia/Shanghai',
  enableUi: process.env.ENABLE_UI !== 'false',
};
```

In `src/client/config/configStore.ts`:
```typescript
static getEffectiveConfig(cliOpts: { server?: string; key?: string } = {}, env: Record<string, string | undefined> = process.env): { server: string; key: string } {
  const stored = this.load();
  const server = (cliOpts && cliOpts.server) ||
    env.GT_SERVER ||
    stored.server ||
    DEFAULT_SERVER_URL;
  const key = (cliOpts && cliOpts.key) ||
    env.GT_KEY ||
    stored.key ||
    '';
  return { server, key };
}
```

In `src/client/index.ts`:
Update help text in `printHelp()`:
`-s, --server <url>   Hub server URL (Default: env GT_SERVER or http://localhost:8000)`
`-k, --key <secret>  Admin secret key (Default: env GT_KEY)`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/gtConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/shared/types/host.ts src/client/config/configStore.ts config/default.ts src/client/index.ts tests/gtConfig.test.ts
git commit -m "feat: standardize auth environment variables to GT_SERVER and GT_KEY

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Agent Manual Authentication Flags & Child Process Passthrough

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Consumes: CLI options `--server`, `-s`, `--key`, `-k`
- Produces: `runAgent(agentArgs, globalOpts)` accepting manual `--server` and `--key` flags and forwarding them to daemon processes

- [ ] **Step 1: Write failing test in tests/gtAgentDaemon.test.ts**

Replace the old test that asserted rejection of `--server` and `--key` with tests asserting acceptance:
```typescript
it('accepts --server and --key flags without throwing removed errors', () => {
  const res = spawnSync('node', [gtPath, 'agent', '--server=http://localhost:8000', '--key=my-secret'], {
    env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
    encoding: 'utf-8',
    timeout: 3000,
  });

  expect(res.stderr).not.toContain("Error: '--server' is removed");
  expect(res.stderr).not.toContain("Error: '--key' is removed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtAgentDaemon.test.ts -t "accepts --server and --key flags"`
Expected: FAIL (because daemon.ts currently still contains the rejection checks)

- [ ] **Step 3: Remove restrictions and support manual auth flags in daemon.ts**

In `src/agent/daemon.ts`:
1. Parse `--server`, `-s`, `--server=`, `-s=`, `--key`, `-k`, `--key=`, `-k=` in `agentArgs` into `options.server` and `options.key`.
2. Remove the blocks throwing `"Error: '--server' is removed"` and `"Error: '--key' is removed"`.
3. Resolve effective credentials using:
```typescript
const effectiveConfig = ConfigStore.getEffectiveConfig({
  server: options.server || globalOpts.cliServer || globalOpts.server,
  key: options.key || globalOpts.cliKey || globalOpts.key,
});
const serverArg = effectiveConfig.server;
const adminKey = effectiveConfig.key;
```
4. When `isDaemon && !isInternalDaemon`, include `--server=${serverArg}` and `--key=${adminKey}` in `cleanArgs` so the detached child process inherits the target credentials.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/gtAgentDaemon.test.ts -t "accepts --server and --key flags"`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/agent/daemon.ts tests/gtAgentDaemon.test.ts
git commit -m "feat(agent): support manual --server and --key authentication flags

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Agent MachineId Exchange & Rejection Handling

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `src/client/utils/terminalUI.ts`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Consumes: `ConfigStore.getMachineId()`
- Produces: Query parameter `machineId` included in `resolveWebSocketUrl` and immediate agent exit on 4009 rejection

- [ ] **Step 1: Write test for machineId parameter in resolveWebSocketUrl**

In `tests/gtCli.test.ts` or `tests/gtAgentDaemon.test.ts`:
```typescript
it('includes machineId query parameter in agent WebSocket URL', () => {
  const { resolveWebSocketUrl } = require('../scripts/gt.js');
  const url = resolveWebSocketUrl('http://localhost:8000', {
    hostId: 'host-1',
    name: 'test-node',
    machineId: 'test-machine-id',
  });
  expect(url).toContain('machineId=test-machine-id');
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `npx jest tests/gtCli.test.ts -t "includes machineId query parameter"`

- [ ] **Step 3: Update daemon.ts to pass machineId and handle rejected reason cleanly**

In `src/agent/daemon.ts`:
1. In `connect()`:
```typescript
const targetWsUrl = resolveWebSocketUrl(serverArg, {
  hostId,
  name: hostName,
  hostname,
  ip: localIp,
  platform,
  machineId,
});
```
2. In `ws.on('message')`:
```typescript
if (control.type === 'rejected') {
  isExiting = true;
  console.error(`\x1b[31m[Error] Registration rejected by server: ${control.reason || 'Registration conflict'}\x1b[0m`);
  if (ws) {
    try { ws.close(); } catch {}
  }
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:gt && npx jest tests/gtCli.test.ts -t "includes machineId query parameter"`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/agent/daemon.ts tests/gtCli.test.ts
git commit -m "feat(agent): include machineId in websocket handshake and cleanly handle server rejection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Server-Side Single-Agent-per-Machine Enforcement

**Files:**
- Modify: `src/server/modules/terminal/services/hostManager.ts`
- Modify: `src/server/modules/terminal/ws/terminalWs.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Create: `tests/terminalMachineMutex.test.ts`

**Interfaces:**
- Consumes: `machineId` query parameter in `/api/terminal/agent-ws`
- Produces:
  - `hostManager.registerAgent({ hostId, name, machineId, agentWs, ... })`
  - Mutual exclusion rejecting active agents with matching `machineId`
  - Automatic pruning of offline hosts with matching `machineId`

- [ ] **Step 1: Write integration tests for machine mutex in tests/terminalMachineMutex.test.ts**

Create `tests/terminalMachineMutex.test.ts`:
```typescript
import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { TerminalHostManager } from '../src/server/modules/terminal/services/hostManager';
import { setupTerminalWebSocket } from '../src/server/modules/terminal/ws/terminalWs';

describe('Server-side Single Agent per Machine Enforcement', () => {
  let server: http.Server;
  let port: number;
  let hostManager: TerminalHostManager;

  beforeAll((done) => {
    const app = express();
    server = http.createServer(app);
    hostManager = new TerminalHostManager();
    setupTerminalWebSocket(server, hostManager);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('rejects second active agent connecting with the same machineId', (done) => {
    const ws1 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-1&name=node-1&machineId=machine-xyz`);

    ws1.on('open', () => {
      // Connect second agent with same machineId but different hostId & name
      const ws2 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-2&name=node-2&machineId=machine-xyz`);

      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString().replace(/^JSON:/, ''));
        if (msg.type === 'rejected') {
          expect(msg.code).toBe(4009);
          expect(msg.reason).toContain('Conflict: Machine (machine-xyz) already has an active agent');
          ws1.close();
          ws2.close();
          done();
        }
      });
    });
  });

  it('allows new agent with same machineId to connect after old agent goes offline', (done) => {
    const ws1 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-old&name=node-old&machineId=machine-takeover`);

    ws1.on('open', () => {
      ws1.close(); // Disconnect agent 1 (becomes offline)
    });

    ws1.on('close', () => {
      setTimeout(() => {
        const ws2 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-new&name=node-new&machineId=machine-takeover`);
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString().replace(/^JSON:/, ''));
          if (msg.type === 'registered') {
            expect(msg.status).toBe('online');
            ws2.close();
            done();
          }
        });
      }, 50);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalMachineMutex.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement machineId extraction and mutex enforcement**

In `src/server/modules/terminal/ws/terminalWs.ts` (and `src/terminal/routes/terminalWs.ts`):
```typescript
const machineId = parsedUrl.searchParams.get('machineId') || hostId;
const agentMeta = { hostId, name, hostname, ip, platform, machineId };
(ws as any)._agentMeta = agentMeta;

const regResult = terminalHostManager.registerAgent({
  hostId,
  name,
  hostname,
  ip,
  platform,
  machineId,
  agentWs: ws,
});
```

In `src/server/modules/terminal/services/hostManager.ts`:
Update `registerAgent(metadata: { hostId: string; name?: string; hostname?: string; ip?: string; platform?: string; machineId?: string; agentWs: any; })`:
```typescript
const id = metadata.hostId.trim();
const targetName = (metadata.name || metadata.hostname || id).trim();
const machineId = (metadata.machineId || id).trim();

// 1. Check for Machine ID conflict against active (online) nodes
for (const [existingId, existingHost] of this.hosts.entries()) {
  if (existingHost.machineId === machineId) {
    if (existingHost.status === 'online' && existingHost.agentWs !== metadata.agentWs) {
      logger.warn(`[TerminalHostManager] Rejecting duplicate machine agent: machineId "${machineId}" is already held by active node "${existingHost.name}" (${existingId})`);
      return {
        success: false,
        error: `Conflict: Machine (${machineId}) already has an active agent '${existingHost.name}' (ID: ${existingId}) connected to this Hub. Each machine can only have ONE agent per Hub.`
      };
    } else if (existingHost.status === 'offline') {
      // Auto-prune offline host to allow clean takeover
      const session = this.sessions.get(existingId);
      if (session) {
        session.destroy();
        this.sessions.delete(existingId);
      }
      this.clearPendingRpcForHost(existingId);
      this.hosts.delete(existingId);
      logger.info(`[TerminalHostManager] Pruned offline host with matching machineId "${machineId}": ${existingId}`);
    }
  }
}

// 2. Check for name conflict against active (online) nodes (existing logic)
// ...
// 3. Register host and assign machineId
let host = this.hosts.get(id);
if (!host) {
  host = {
    id,
    name: targetName,
    hostname: metadata.hostname || id,
    ip: metadata.ip || '127.0.0.1',
    platform: metadata.platform || 'unknown',
    status: 'online',
    lastSeen: Date.now(),
    type: 'agent',
    machineId,
  };
  this.hosts.set(id, host);
} else {
  host.status = 'online';
  host.name = targetName;
  host.machineId = machineId;
  host.lastSeen = Date.now();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalMachineMutex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/server/modules/terminal/services/hostManager.ts src/server/modules/terminal/ws/terminalWs.ts src/terminal/routes/terminalWs.ts tests/terminalMachineMutex.test.ts
git commit -m "feat(server): enforce single agent per machine per hub mutex

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Update Existing Test Suites & Final Validation

**Files:**
- Modify: `tests/gtAgentStream.test.ts`
- Modify: `tests/gtAuthCommand.test.ts`
- Modify: `tests/gtCli.test.ts`
- Modify: `tests/gtExecPureStream.test.ts`
- Modify: `tests/gtLogsSmartDefault.test.ts`
- Modify: `tests/gtPsCommand.test.ts`
- Modify: `tests/terminalAgentConflict.test.ts`
- Rebuild: `npm run build`

**Interfaces:**
- Consumes: Updated codebase
- Produces: 100% passing test suite across all 90+ test files with `GT_SERVER` and `GT_KEY`

- [ ] **Step 1: Replace legacy env vars in existing test suites**

Update tests that passed `TERMINAL_SERVER` and `ADMIN_SECRET_KEY` in `env` options:
- Change `TERMINAL_SERVER` to `GT_SERVER`
- Change `ADMIN_SECRET_KEY` to `GT_KEY`

- [ ] **Step 2: Run full build**

Run: `npm run build`
Expected: Frontend, backend, and `dist/gt.js` compile cleanly.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All test suites pass.

- [ ] **Step 4: Verify manual CLI execution**

Run:
```bash
node dist/gt.js --help
node dist/gt.js run -s http://localhost:8000 -k testkey --help
```

- [ ] **Step 5: Commit changes**

```bash
git add tests/
git commit -m "test: align all existing tests with GT_SERVER and GT_KEY

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
