# Fix Agent Handshake Timeout, Half-Open Heartbeat Deadlock, and Connection Status Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Linux/Cloudflare issue where `gt agent start` shows `Status : Running` locally while the Hub server cannot see the node due to premature 4s handshake termination, half-open TCP socket `bufferedAmount` heartbeat deadlock, and duplicate `HISTORY_SYNC` bursts on reconnect.

**Architecture:**
1. Increase `HANDSHAKE_TIMEOUT_MS` from `4000` (4s) to `15000` (15s) in `src/agent/daemon.ts` so cross-region DNS resolution (Linux default 5s timeout) + Cloudflare TLS + origin WebSocket upgrade are not prematurely terminated by the agent.
2. Fix the heartbeat deadlock in `startHeartbeat()` (`src/agent/daemon.ts`): stop calling `onHeartbeatActivity()` unconditionally whenever `ws.bufferedAmount > 0` (which perpetually resets `lastPongReceived` on dead/half-open TCP connections where outbound `ping` frames accumulate in the socket buffer). Instead, only allow temporary deferral while `activeFileRpcCount > 0` up to a hard ceiling of `HEARTBEAT_TIMEOUT_MS * 2` (`120000` ms), ensuring stalled half-open connections always terminate and reconnect after 60s of silence.
3. Deduplicate `sendHistorySync()` on reconnect so it is sent once upon receiving `control.type === 'registered'` rather than twice back-to-back in `ws.on('open')` and `registered`, and persist real-time `connectionState` / `lastError` into `agent.json` for `gt agent status`.

**Tech Stack:** Node.js, TypeScript, `ws`, Jest.

**Spec:** In-chat approved design (2026-11-05).

## Global Constraints

- Preserve `Status     : Running` line format in `gt agent status` so `scripts/install-gt.sh` and existing CLI tests (`tests/gtAgentDaemon.test.ts`) remain 100% compatible.
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.
- Rebuild `dist/gt.js` (`npm run build:gt`) before running integration tests that invoke `scripts/gt.js` or `dist/gt.js`.

## Review Focus

- A half-open WebSocket connection where `ws.bufferedAmount > 0` (e.g., un-ACKed `ping` or PTY output stuck in the send buffer) and no inbound `pong` or `message` arrives must terminate within `HEARTBEAT_TIMEOUT_MS` (60s), never looping forever.
- An active `file_rpc` transfer that invokes `onHeartbeatActivity()` as chunks are read/replied must keep the connection alive, but if the socket completely stalls for more than `2 * HEARTBEAT_TIMEOUT_MS` (120s) without completing or receiving data, it must still terminate.
- On agent reconnection (`ptyProcess` already spawned), `HISTORY_SYNC` must be sent only once (after `registered` confirmation) rather than twice (`open` + `registered`).
- `gt agent status` must still report `Status     : Running` while also surfacing `Connection` state (`online` / `connecting` / `reconnecting`) and `lastError` when persisted in `agent.json`.
- `updateDaemonConnectionStatus` must never recreate `agent.json` after `cleanup` / `isExiting` has started or if `agent.json` belongs to a different PID.

---

### Task 1: Increase Handshake Timeout, Fix Half-Open Heartbeat Deadlock, and Deduplicate Reconnect History Sync

**Files:**
- Modify: `src/agent/daemon.ts:24-27,610-620,710-764,1080-1091,1140-1150,1245-1253`
- Modify: `tests/terminalAgentKeepalive.test.ts`

**Interfaces:**
- Produces:
  - `export const HANDSHAKE_TIMEOUT_MS = 15000;` in `src/agent/daemon.ts`
  - `export function isHeartbeatTimedOut(opts: { now: number; lastPongReceived: number; activeFileRpcCount?: number; timeoutMs?: number }): boolean` in `src/agent/daemon.ts` (exported via `src/agent/index.ts` and `src/bin/gt.ts` for direct unit testing):
    - Returns `false` if `now - lastPongReceived <= timeoutMs` (default `HEARTBEAT_TIMEOUT_MS = 60000`).
    - If `activeFileRpcCount > 0`, returns `now - lastPongReceived > timeoutMs * 2` (hard cap `120000` ms).
    - Otherwise returns `true` regardless of `ws.bufferedAmount`.

- [x] **Step 1: Write failing tests in `tests/terminalAgentKeepalive.test.ts`**

Update the `HANDSHAKE_TIMEOUT_MS` assertion to `15000` and add unit tests for `isHeartbeatTimedOut` verifying that a stalled socket with `bufferedAmount > 0` and no active `file_rpc` times out after `HEARTBEAT_TIMEOUT_MS`:

```ts
  it('should export correct keepalive constants', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(60000);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(15000);
  });

  describe('isHeartbeatTimedOut (half-open socket protection)', () => {
    it('times out after HEARTBEAT_TIMEOUT_MS even when socket has buffered outbound bytes', () => {
      const now = 100000;
      expect(
        isHeartbeatTimedOut({
          now,
          lastPongReceived: now - 60001,
          activeFileRpcCount: 0,
          timeoutMs: 60000,
        })
      ).toBe(true);
    });

    it('defers timeout during active file_rpc up to 2x HEARTBEAT_TIMEOUT_MS hard cap', () => {
      const now = 200000;
      expect(
        isHeartbeatTimedOut({
          now,
          lastPongReceived: now - 75000,
          activeFileRpcCount: 1,
          timeoutMs: 60000,
        })
      ).toBe(false);
      expect(
        isHeartbeatTimedOut({
          now,
          lastPongReceived: now - 120001,
          activeFileRpcCount: 1,
          timeoutMs: 60000,
        })
      ).toBe(true);
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalAgentKeepalive.test.ts`
Expected: FAIL (`expect(HANDSHAKE_TIMEOUT_MS).toBe(15000)` received `4000`, `isHeartbeatTimedOut` is not a function)

- [x] **Step 3: Implement `HANDSHAKE_TIMEOUT_MS = 15000`, `isHeartbeatTimedOut`, heartbeat fix, and history sync deduplication in `src/agent/daemon.ts`**

1. Set `export const HANDSHAKE_TIMEOUT_MS = 15000;`.
2. Export `isHeartbeatTimedOut`:
   ```ts
   export function isHeartbeatTimedOut({
     now = Date.now(),
     lastPongReceived,
     activeFileRpcCount = 0,
     timeoutMs = HEARTBEAT_TIMEOUT_MS,
   }: {
     now?: number;
     lastPongReceived: number;
     activeFileRpcCount?: number;
     timeoutMs?: number;
   }): boolean {
     const elapsed = now - lastPongReceived;
     if (activeFileRpcCount > 0) {
       return elapsed > timeoutMs * 2;
     }
     return elapsed > timeoutMs;
   }
   ```
3. Track `let activeFileRpcCount = 0;` in `runAgent`:
   - Reset `activeFileRpcCount = 0;` in `connect()` and `ws.on('close')`.
   - In `control.type === 'file_rpc'`, increment `activeFileRpcCount++` before `handleFileRpc(...)` and decrement `activeFileRpcCount = Math.max(0, activeFileRpcCount - 1)` in `.finally(...)`.
   - In `startHeartbeat()`, remove both `if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > 0) { onHeartbeatActivity(); }` blocks and use `isHeartbeatTimedOut({ now: Date.now(), lastPongReceived, activeFileRpcCount })` in both the interval check and `heartbeatTimeoutTimer` callback.
4. In `ws.on('open')` (`src/agent/daemon.ts`), remove `else if (terminalHistory.getSize() > 0) { sendHistorySync(); }` so reconnection history sync is only sent once when `control.type === 'registered'` is received.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalAgentKeepalive.test.ts`
Expected: PASS

---

### Task 2: Persist Connection State in `agent.json` and Display in `gt agent status`

**Files:**
- Modify: `src/agent/daemon.ts:376-400,522-571,972-1046,1245-1316`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Produces:
  - `connectionState?: 'connecting' | 'online' | 'reconnecting'`, `reconnectAttempts?: number`, `lastError?: string | null`, `lastConnectedAt?: string` fields in `~/.gt/agent.json`.
  - `Connection : <state>` and optional `Last Error : <error>` output lines in `gt agent status` when `connectionState` is present in `agent.json`.

- [x] **Step 1: Write failing test in `tests/gtAgentDaemon.test.ts`**

Add a test in `tests/gtAgentDaemon.test.ts` verifying that `gt agent status` displays `Connection` and `Last Error` when `connectionState` / `lastError` are recorded in `agent.json`, while preserving `Status     : Running`:

```ts
  it('displays Connection state and Last Error in gt agent status when present in agent.json', () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager, getVersionInfo } = require('../scripts/gt.js');
    AgentDaemonManager.saveStatus({
      pid: process.pid,
      name: 'conn-state-node',
      server: 'https://gt.example.com',
      version: getVersionInfo().version,
      connectionState: 'reconnecting',
      reconnectAttempts: 3,
      lastError: 'Connection timed out (15s)',
    });

    const res = spawnSync('node', [gtPath, 'agent', 'status'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Status     : Running');
    expect(res.stdout).toContain('Connection : reconnecting (attempt #3)');
    expect(res.stdout).toContain('Last Error : Connection timed out (15s)');
    AgentDaemonManager.clearStatus();
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/gtAgentDaemon.test.ts -t "displays Connection state"`
Expected: FAIL (`expect(res.stdout).toContain('Connection : reconnecting (attempt #3)')`)

- [x] **Step 3: Implement connection state persistence and `gt agent status` output in `src/agent/daemon.ts`**

1. In `subCmd === 'status'` (`src/agent/daemon.ts`):
   - After `console.log('Status     : Running');`, if `current.connectionState` is defined:
     - Format `const connDetail = current.connectionState === 'reconnecting' && current.reconnectAttempts ? `${current.connectionState} (attempt #${current.reconnectAttempts})` : current.connectionState;`
     - Print `console.log(\`Connection : \${connDetail}\`);`
     - If `current.lastError`, print `console.log(\`Last Error : \${current.lastError}\`);`
2. In `runAgent` (`src/agent/daemon.ts`):
   - When spawning the background daemon (`AgentDaemonManager.saveStatus` at line 522), include `connectionState: 'connecting'`.
   - Define helper `updateDaemonState(patch: Record<string, any>)` inside `runAgent`:
     - If `isExiting` is true, return immediately.
     - Read `const s = AgentDaemonManager.getStatus();`. If `s && s.running && s.pid === process.pid`:
       - Strip `running` and `stale` from `s`, merge `patch`, and call `AgentDaemonManager.saveStatus(merged)`.
   - Track `let lastConnectionError: string | null = null;`.
   - In `connect()` timeout handler: set `lastConnectionError = \`Connection timed out (\${HANDSHAKE_TIMEOUT_MS / 1000}s)\`;`.
   - In `ws.on('error')`: set `lastConnectionError = msg || 'Connection error';`.
   - In `ws.on('open')` and `control.type === 'registered'`: set `lastConnectionError = null;` and call `updateDaemonState({ connectionState: 'online', reconnectAttempts: 0, lastError: null, lastConnectedAt: new Date().toISOString() })`.
   - In `scheduleReconnect()`: call `updateDaemonState({ connectionState: 'reconnecting', reconnectAttempts, lastError: lastConnectionError })`.

- [x] **Step 4: Run targeted tests and full build**

Run: `npm test -- tests/gtAgentDaemon.test.ts tests/terminalAgentKeepalive.test.ts tests/agentNativePingPong.test.ts tests/terminalNonFullscreenStability.test.ts && npm run build`
Expected: PASS on all test suites and build succeeds.

- [x] **Step 5: Commit**

```bash
git add src/agent/daemon.ts tests/terminalAgentKeepalive.test.ts tests/gtAgentDaemon.test.ts docs/superpowers/plans/2026-11-05-fix-agent-handshake-and-heartbeat-deadlock.md
git commit -m "fix(agent): resolve handshake timeout, half-open heartbeat deadlock, and expose connection status"
```
