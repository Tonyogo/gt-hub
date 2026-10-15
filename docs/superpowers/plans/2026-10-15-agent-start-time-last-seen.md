# Agent Start Time for LAST SEEN in gt ps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report Agent daemon startup timestamp from the Agent to Hub, and display elapsed uptime from Agent start time under LAST SEEN in `gt ps` / `gt nodes` for online agents while retaining offline last-seen timestamps.

**Architecture:** The Agent process captures its startup timestamp (`agentStartTime = Date.now()`) and supplies it as a query parameter when establishing reverse tunnel WebSocket connections to the Hub. Hub stores `startTime` in `ManagedHost` state. The CLI (`gt ps` / `gt nodes`) formats `h.startTime` for online agents and falls back to `h.lastSeen` for offline agents or legacy hosts without `startTime`.

**Tech Stack:** Node.js, TypeScript, WebSocket (`ws`), Commander CLI, Jest.

**Spec:** In-chat bounded design approved by user (conversation 2026-10-15).

## Global Constraints

- Preserve `h.lastSeen` updating logic on WebSocket ping/messages for Hub internal pruning and timeout checks.
- Zero extra dependencies; maintain standalone bundle compatibility for `dist/gt.js`.
- Backward compatible: If an older Agent connects without `startTime`, `gt ps` must gracefully fall back to `h.lastSeen`.
- If an agent is offline, LAST SEEN must continue reflecting when it disconnected (`h.lastSeen`).

## Review Focus

1. **Agent Reconnects**: Agent reconnects to Hub after network flap; `agentStartTime` must remain the original process startup time, not the reconnect time.
2. **Offline Host Fallback**: Offline hosts must display when they were last seen (`h.lastSeen`), not their startup time.
3. **Missing/Invalid startTime**: Hosts without `startTime` (or `NaN`/null) must gracefully display `h.lastSeen`.
4. **Local Version Synchronization**: Existing local agent detection and local version overrides in `gt ps` must not be broken.
5. **Column Alignment**: Table column width calculations in `gt ps` must properly account for elapsed time strings (e.g. `2h ago`, `3d ago`).

---

### Task 1: Add `startTime` to Shared Host Types & Hub Host Manager

**Files:**
- Modify: `src/shared/types/host.ts:3-26`
- Modify: `src/terminal/services/terminalHostManager.ts:474-600`
- Test: `tests/terminalHostManager.test.ts`

**Interfaces:**
- Produces: `ManagedHost.startTime?: number`, `HostInfo.startTime?: number`, `registerAgent({ ..., startTime?: number })`

- [x] **Step 1: Write the failing test for `startTime` in `TerminalHostManager`**

Add tests to `tests/terminalHostManager.test.ts` verifying that `registerAgent` records `startTime`, updates `startTime` when explicitly provided, and preserves it when re-registering or touching:

```typescript
  test('records and updates agent startTime in ManagedHost', () => {
    const mockWs = { readyState: 1, send: jest.fn() };
    const agentStartTime = Date.now() - 3600000; // 1 hour ago
    const res = manager.registerAgent({
      hostId: 'agent-uptime-test',
      name: 'Uptime-Node',
      startTime: agentStartTime,
      agentWs: mockWs,
    });
    const host = res.host!;
    expect(host.startTime).toBe(agentStartTime);

    const retrieved = manager.getHost('agent-uptime-test');
    expect(retrieved?.startTime).toBe(agentStartTime);

    // Reconnection with updated startTime (e.g. agent restarted)
    const newStartTime = Date.now();
    manager.registerAgent({
      hostId: 'agent-uptime-test',
      name: 'Uptime-Node',
      startTime: newStartTime,
      agentWs: mockWs,
    });
    expect(manager.getHost('agent-uptime-test')?.startTime).toBe(newStartTime);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest --detectOpenHandles --forceExit tests/terminalHostManager.test.ts`
Expected: FAIL or TypeScript compilation errors due to `startTime` missing from `registerAgent` parameter type.

- [x] **Step 3: Update `host.ts` and `terminalHostManager.ts`**

Update `src/shared/types/host.ts`:
```typescript
export interface ManagedHost {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: HostStatus;
  lastSeen: number;
  startTime?: number;
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
  startTime?: number;
  machineId?: string;
  version?: string;
}
```

Update `src/terminal/services/terminalHostManager.ts`:
- In `registerAgent` metadata interface, add `startTime?: number;`.
- In `registerAgent`, when creating `host`: set `startTime: metadata.startTime`.
- When updating existing `host`: if `metadata.startTime !== undefined`, set `host.startTime = metadata.startTime`.
- In `touchAgent`, if `metadata?.startTime !== undefined`, set `host.startTime = metadata.startTime`.
- In `registerHost`, add `startTime?: number;` to metadata and assign `host.startTime`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest --detectOpenHandles --forceExit tests/terminalHostManager.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/shared/types/host.ts src/terminal/services/terminalHostManager.ts tests/terminalHostManager.test.ts
git commit -m "feat(terminal): support startTime in ManagedHost and TerminalHostManager"
```

---

### Task 2: Hub WebSocket Route Query Parameter Extraction

**Files:**
- Modify: `src/terminal/routes/terminalWs.ts:95-135`
- Test: `tests/agentNativePingPong.test.ts`

**Interfaces:**
- Consumes: `registerAgent({ ..., startTime?: number })`
- Produces: Parses `startTime` query parameter from `/api/terminal/agent-ws` URL and passes to `registerAgent` & `_agentMeta`.

- [x] **Step 1: Write the failing test in `tests/agentNativePingPong.test.ts`**

Add a test case verifying that `startTime` passed in WebSocket query parameters is parsed and stored on `host.startTime`:

```typescript
  it('stores agent startTime passed in WebSocket query string', (done) => {
    const customStartTime = Date.now() - 7200000; // 2 hours ago
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=uptime-ws-test&name=uptime-ws-node&startTime=${customStartTime}`);

    ws.on('open', () => {
      setTimeout(() => {
        const host = terminalHostManager.getHost('uptime-ws-test');
        expect(host).toBeDefined();
        expect(host!.startTime).toBe(customStartTime);
        ws.close();
        terminalHostManager.unregisterAgent('uptime-ws-test');
        done();
      }, 50);
    });

    ws.on('error', (err) => {
      done(err);
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest --detectOpenHandles --forceExit tests/agentNativePingPong.test.ts`
Expected: FAIL (`host.startTime` is undefined).

- [x] **Step 3: Update `src/terminal/routes/terminalWs.ts`**

Parse `startTime` from URL:
```typescript
    const startTimeParam = parsedUrl.searchParams.get('startTime');
    const parsedStartTime = startTimeParam ? parseInt(startTimeParam, 10) : undefined;
    const startTime = (parsedStartTime && !isNaN(parsedStartTime)) ? parsedStartTime : undefined;

    const agentMeta = { hostId, name, hostname, ip, platform, machineId, version, startTime };
    (ws as any)._agentMeta = agentMeta;

    const regResult = hostMgr.registerAgent({
      hostId,
      name,
      hostname,
      ip,
      platform,
      machineId,
      version,
      startTime,
      agentWs: ws,
    });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest --detectOpenHandles --forceExit tests/agentNativePingPong.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/terminal/routes/terminalWs.ts tests/agentNativePingPong.test.ts
git commit -m "feat(terminal): extract agent startTime from agent-ws query parameter"
```

---

### Task 3: Agent Daemon Capture & Propagate Startup Timestamp

**Files:**
- Modify: `src/agent/daemon.ts:543-575,870-885`
- Test: Unit/Integration verification with existing agent tests

**Interfaces:**
- Produces: `agentStartTime` sent in `resolveWebSocketUrl` query parameters.

- [x] **Step 1: Inspect and update `src/agent/daemon.ts`**

In `handleAgentCommand`:
1. Define a process-level constant timestamp at startup:
```typescript
  const agentStartTime = Date.now();
```
2. When calling `resolveWebSocketUrl` in the WebSocket connection loop (reconnects reuse the same `agentStartTime`):
```typescript
    const targetWsUrl = resolveWebSocketUrl(serverArg, {
      hostId,
      name: hostName,
      hostname,
      ip: localIp,
      platform,
      machineId,
      version: clientVersion,
      startTime: agentStartTime,
    });
```

- [x] **Step 2: Run tests to ensure no regressions in agent startup**

Run: `npx jest --detectOpenHandles --forceExit tests/terminalAgentOfflineRaceFix.test.ts tests/agentNativePingPong.test.ts`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add src/agent/daemon.ts
git commit -m "feat(agent): record and transmit agent startup timestamp to Hub"
```

---

### Task 4: `gt ps` / `gt nodes` Display Agent Start Time under LAST SEEN

**Files:**
- Modify: `src/client/commands/hosts.ts:90-125`
- Test: `tests/gtPsCommand.test.ts`

**Interfaces:**
- Consumes: `h.status`, `h.startTime`, `h.lastSeen`
- Produces: Displays `formatRelativeTime(h.startTime)` for online nodes, `formatRelativeTime(h.lastSeen)` for offline nodes or legacy nodes without `startTime`.

- [x] **Step 1: Write failing tests in `tests/gtPsCommand.test.ts`**

Add tests to `tests/gtPsCommand.test.ts`:
1. Verify online node with `startTime` 2 hours ago and `lastSeen` 2 seconds ago renders `2h ago` in `gt ps`.
2. Verify offline node with `startTime` 5 hours ago and `lastSeen` 10 minutes ago renders `10m ago` in `gt ps -a`.
3. Verify online node without `startTime` falls back to `h.lastSeen`.

```typescript
  it('displays agent uptime (startTime to now) under LAST SEEN for online nodes', async () => {
    const twoHoursAgo = Date.now() - 7200000;
    const justNow = Date.now() - 2000;
    mockHosts = [
      { id: 'node-uptime', name: 'worker-uptime', status: 'online', platform: 'linux', ip: '10.0.0.1', startTime: twoHoursAgo, lastSeen: justNow },
    ];
    const res = await run(['ps']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('2h ago');
    expect(res.stdout).not.toContain('Just now');
  });

  it('displays disconnect time (lastSeen) under LAST SEEN for offline nodes', async () => {
    const fiveHoursAgo = Date.now() - 18000000;
    const tenMinsAgo = Date.now() - 600000;
    mockHosts = [
      { id: 'node-offline', name: 'worker-down', status: 'offline', platform: 'linux', ip: '10.0.0.2', startTime: fiveHoursAgo, lastSeen: tenMinsAgo },
    ];
    const res = await run(['ps', '-a']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('10m ago');
    expect(res.stdout).not.toContain('5h ago');
  });

  it('falls back to lastSeen when startTime is not provided on online node', async () => {
    const tenMinsAgo = Date.now() - 600000;
    mockHosts = [
      { id: 'node-legacy', name: 'worker-legacy', status: 'online', platform: 'linux', ip: '10.0.0.3', lastSeen: tenMinsAgo },
    ];
    const res = await run(['ps']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('10m ago');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/gtPsCommand.test.ts`
Expected: FAIL (`expected stdout to contain '2h ago'`, found `Just now`).

- [x] **Step 3: Update `src/client/commands/hosts.ts`**

In `src/client/commands/hosts.ts`:
Change:
```typescript
        const displayTime = (h.status === 'online' && typeof h.startTime === 'number' && !isNaN(h.startTime))
          ? h.startTime
          : h.lastSeen;
        const lastSeenStr = formatRelativeTime(displayTime);
```

- [x] **Step 4: Re-bundle CLI and run tests**

Run: `npm test -- tests/gtPsCommand.test.ts`
Expected: PASS (all 12 tests in `tests/gtPsCommand.test.ts` pass).

- [x] **Step 5: Commit**

```bash
git add src/client/commands/hosts.ts tests/gtPsCommand.test.ts
git commit -m "feat(cli): show agent uptime for online nodes under LAST SEEN in gt ps"
```

---

### Task 5: Full Project Verification & Build

**Files:**
- Verify: Full test suite and CLI builds

- [x] **Step 1: Run full build and test suites**

Run:
```bash
npm run build:backend
npm run build:gt
npm test -- tests/gtPsCommand.test.ts tests/terminalHostManager.test.ts tests/agentNativePingPong.test.ts
```
Expected: PASS

- [x] **Step 2: Verify git status is clean and commits are orderly**

Run: `git status`
Expected: Working tree clean, changes properly committed.
