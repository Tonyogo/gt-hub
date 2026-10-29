# Web Terminal Split-Pane (Left/Right) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable iTerm2-style left/right split-pane terminals in `UnifiedTerminalView` where both panes share the selected host node while running independent persistent PTY shell sessions with independent dimensions and scrollback history.

**Architecture:** We extend the Hub (`TerminalHostManager` and `terminalWs.ts`), Reverse Agent (`daemon.ts` + `SecondaryPanePtyManager`), and Frontend (`WebTerminalView` + `UnifiedTerminalView`) with a `paneId` (`'main' | 'split'`) multiplexing channel. The primary `'main'` pane preserves its exact existing wire format for 100% backward compatibility, while secondary panes (`'split'`) multiplex terminal I/O via `BIN_MSG_TYPE.TERMINAL_RAW (0x03)` and `BIN_MSG_TYPE.HISTORY_SYNC (0x04)` binary frames and `paneId`-tagged JSON control messages (`resize`, `reset`, `history_req`, `pane_close`, `pane_exit`).

**Tech Stack:** TypeScript, React 18, Tailwind CSS, Xterm.js (`@xterm/xterm`, `@xterm/addon-fit`), `ws` WebSocket, `node-pty` / POSIX PTY drivers, Jest.

**Spec:** `docs/superpowers/specs/2026-10-29-terminal-split-pane-design.md`

## Global Constraints

- Primary pane (`paneId === 'main'` or omitted) wire protocol MUST remain 100% backward-compatible with existing Hub and Agent tests.
- Split ratio MUST be clamped between `20` and `80` percent, defaulting to `50` percent, and reset to `50` on divider double-click.
- While split mode is open, browser refresh or transient WebSocket reconnects MUST preserve and replay the `'split'` pane's history buffer.
- Explicitly closing the split pane (`pane_close`) or exiting the shell (`exit` inside the `'split'` pane -> `pane_exit`) MUST terminate the `'split'` PTY process, clear its history buffer on Agent and Hub, and collapse the UI back to single-pane mode.
- Always run targeted Jest test files with `npm test -- tests/<file>.test.ts` (never run the full suite during iterative steps).

## Review Focus

1. **Invalid or malicious `paneId` query parameters on `/api/terminal/ws`:** Any `paneId` not matching `/^[a-zA-Z0-9_-]{1,32}$/` must fall back to `'main'` so arbitrary keys cannot pollute session maps or binary packet headers (max 255 ASCII bytes).
2. **Agent disconnect while `'split'` pane is active:** When an agent disconnects or is unregistered, both `'main'` and `'split'` sessions on the Hub must send `agent_offline` and close attached browser sockets cleanly.
3. **Natural shell exit (`exit` command) in `'split'` pane vs `'main'` pane:** `'main'` pane respawns after 500ms on exit, whereas `'split'` pane must NOT respawn—it must emit `pane_exit`, delete its pane state, and collapse the frontend split view.
4. **Explicit `pane_close` on `'main'` pane:** Sending `pane_close` for `paneId === 'main'` must be ignored so the primary host session is never destroyed by a split-close request.
5. **Toolbar action routing when `'split'` pane is focused vs closed:** When `'split'` is focused, `Reconnect`, `Reset`, `Scripts`, and `Select Mode` act on `'split'`, and when the split pane closes, `activePane` must immediately reset to `'main'` so toolbar buttons never target an unmounted ref.

---

### Task 1: Multi-Pane Session Management in Hub (`TerminalHostManager`)

**Files:**
- Modify: `src/terminal/services/terminalHostManager.ts`
- Test: `tests/terminalSplitPaneHub.test.ts`

**Interfaces:**
- Consumes: `BIN_MSG_TYPE`, `encodeBinaryPacket` from `src/shared/protocol/binaryProtocol.ts`
- Produces:
  - `RemoteAgentTerminalSession`:
    - `constructor(hostId: string, agentWs?: any, paneId: string = 'main')`
    - `public readonly paneId: string`
    - `public notifyPaneExited(exitCode?: number): void`
  - `TerminalHostManager`:
    - `public static normalizePaneId(paneId?: string | null): string` (returns `'main'` if empty or not matching `/^[a-zA-Z0-9_-]{1,32}$/`)
    - `public getSession(hostIdOrName?: string, paneId: string = 'main'): RemoteAgentTerminalSession | null`
    - `public destroyPaneSession(hostIdOrName: string, paneId: string, notifyAgent?: boolean): boolean`
    - `public handleAgentPaneData(hostId: string, paneId: string, data: any): void`
    - `public handleAgentPaneHistorySync(hostId: string, paneId: string, history: Buffer | string): void`
    - `public handleAgentPaneExit(hostId: string, paneId: string, exitCode?: number): void`

- [x] **Step 1: Write the failing test in `tests/terminalSplitPaneHub.test.ts`**

```typescript
import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { BIN_MSG_TYPE, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';

describe('TerminalHostManager Multi-Pane Session Management', () => {
  let manager: TerminalHostManager;
  let mockAgentWs: any;
  const hostId = 'node-split-1';

  beforeEach(() => {
    manager = new TerminalHostManager();
    mockAgentWs = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };
    manager.registerAgent({
      hostId,
      name: 'split-test-node',
      agentWs: mockAgentWs,
    });
  });

  it('normalizes invalid paneId values to main', () => {
    expect(TerminalHostManager.normalizePaneId(undefined)).toBe('main');
    expect(TerminalHostManager.normalizePaneId('')).toBe('main');
    expect(TerminalHostManager.normalizePaneId('split')).toBe('split');
    expect(TerminalHostManager.normalizePaneId('bad/pane id!')).toBe('main');
  });

  it('isolates main and split sessions with independent history and dimensions', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;

    expect(mainSession).toBeDefined();
    expect(splitSession).toBeDefined();
    expect(mainSession).not.toBe(splitSession);
    expect(mainSession.paneId).toBe('main');
    expect(splitSession.paneId).toBe('split');

    mainSession.resize(120, 40);
    splitSession.resize(60, 40);

    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'resize', cols: 120, rows: 40 })}`
    );
    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'resize', paneId: 'split', cols: 60, rows: 40 })}`
    );

    manager.handleAgentData(hostId, 'main-output-line\r\n');
    manager.handleAgentPaneData(hostId, 'split', Buffer.from('split-output-line\r\n', 'utf-8'));

    expect(mainSession.getHistory()).toContain('main-output-line');
    expect(mainSession.getHistory()).not.toContain('split-output-line');
    expect(splitSession.getHistory()).toContain('split-output-line');
    expect(splitSession.getHistory()).not.toContain('main-output-line');
  });

  it('encodes split pane input as BIN_MSG_TYPE.TERMINAL_RAW with paneId and keeps main input raw', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;

    mainSession.write('ls -la\r');
    expect(mockAgentWs.send).toHaveBeenLastCalledWith('ls -la\r');

    splitSession.write('pwd\r');
    const lastSent = mockAgentWs.send.mock.calls[mockAgentWs.send.mock.calls.length - 1][0];
    expect(Buffer.isBuffer(lastSent)).toBe(true);
    const decoded = decodeBinaryPacket(lastSent);
    expect(decoded).not.toBeNull();
    expect(decoded!.msgType).toBe(BIN_MSG_TYPE.TERMINAL_RAW);
    expect(decoded!.id).toBe('split');
    expect(decoded!.payload.toString('utf-8')).toBe('pwd\r');
  });

  it('destroys split pane session on destroyPaneSession and refuses to destroy main session', () => {
    const splitSession = manager.getSession(hostId, 'split')!;
    manager.handleAgentPaneData(hostId, 'split', 'cached-split-text');
    expect(splitSession.getHistory()).toContain('cached-split-text');

    // Refuses to destroy main
    expect(manager.destroyPaneSession(hostId, 'main', true)).toBe(false);

    // Destroys split and notifies agent
    expect(manager.destroyPaneSession(hostId, 'split', true)).toBe(true);
    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'pane_close', paneId: 'split' })}`
    );

    // Subsequent getSession creates a fresh split session with empty history
    const freshSplit = manager.getSession(hostId, 'split')!;
    expect(freshSplit).not.toBe(splitSession);
    expect(freshSplit.getHistory()).toBe('');
  });

  it('notifies attached split clients on handleAgentPaneExit and cleans up split session', () => {
    const splitSession = manager.getSession(hostId, 'split')!;
    const clientWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
    splitSession.attach(clientWs);

    manager.handleAgentPaneExit(hostId, 'split', 0);

    expect(clientWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'pane_exit', paneId: 'split', exitCode: 0 })}`
    );
  });

  it('propagates agent disconnect to both main and split pane clients', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;
    const mainClient = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const splitClient = { readyState: 1, send: jest.fn(), close: jest.fn() };

    mainSession.attach(mainClient);
    splitSession.attach(splitClient);

    manager.unregisterAgent(hostId, mockAgentWs);

    expect(mainClient.send).toHaveBeenCalledWith(expect.stringContaining('agent_offline'));
    expect(splitClient.send).toHaveBeenCalledWith(expect.stringContaining('agent_offline'));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalSplitPaneHub.test.ts`
Expected: FAIL with TypeScript/missing method errors (`normalizePaneId`, `destroyPaneSession`, `handleAgentPaneData`, `handleAgentPaneExit` not defined).

- [x] **Step 3: Implement multi-pane session support in `src/terminal/services/terminalHostManager.ts`**

Update `RemoteAgentTerminalSession` and `TerminalHostManager`:
- Import `BIN_MSG_TYPE, encodeBinaryPacket` from `../../shared/protocol/binaryProtocol`.
- Add `public readonly paneId: string` to `RemoteAgentTerminalSession` (`constructor(hostId: string, agentWs?: any, paneId: string = 'main')`).
- In `RemoteAgentTerminalSession`:
  - When `this.paneId === 'main'`, keep existing `write`, `resize`, `reset`, and `attach` (`history_req`) JSON payloads unchanged.
  - When `this.paneId !== 'main'`:
    - `attach`: send `JSON:${JSON.stringify({ type: 'history_req', paneId: this.paneId })}`.
    - `write`: encode input as `encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, this.paneId, Buffer.from(data, 'utf-8'))` before sending or buffering in `pendingInputBuffer: Array<string | Buffer>`.
    - `resize`: include `paneId: this.paneId` in `resize` JSON frames.
    - `reset`: include `paneId: this.paneId` in `reset` JSON frame sent to `agentWs`.
  - Add `public notifyPaneExited(exitCode: number = 0): void` that broadcasts `JSON:${JSON.stringify({ type: 'pane_exit', paneId: this.paneId, exitCode })}` to all `this.activeSockets` and clears `this.history`.
- In `TerminalHostManager`:
  - Add `private paneSessions: Map<string, RemoteAgentTerminalSession> = new Map()` keyed by `${canonicalId}::${paneId}` for `paneId !== 'main'`.
  - Implement `public static normalizePaneId(paneId?: string | null): string`.
  - Update `getSession(hostIdOrName?: string, paneId: string = 'main'): RemoteAgentTerminalSession | null` to return the main session when `normalizedPaneId === 'main'`, or lazily create/return the `RemoteAgentTerminalSession(canonicalId, mainSession.getAgentWs(), normalizedPaneId)` in `this.paneSessions` when the host is online.
  - Implement `destroyPaneSession`, `handleAgentPaneData`, `handleAgentPaneHistorySync`, `handleAgentPaneExit`, and ensure `registerAgent`, `unregisterAgent`, `touchAgent`, and `pruneOfflineHosts` also update/disconnect/destroy all `this.paneSessions` matching `${id}::`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalSplitPaneHub.test.ts`
Expected: PASS (all 6 tests pass).

---

### Task 2: WebSocket Multiplexing for Split Panes (`terminalWs.ts`)

**Files:**
- Modify: `src/terminal/routes/terminalWs.ts:170-370`
- Test: `tests/terminalSplitPaneWs.test.ts`

**Interfaces:**
- Consumes: `TerminalHostManager` methods from Task 1 (`normalizePaneId`, `getSession`, `destroyPaneSession`, `handleAgentPaneData`, `handleAgentPaneHistorySync`, `handleAgentPaneExit`)
- Produces: WebSocket query param `?hostId=<id>&paneId=<paneId>` support and `pane_close` / `pane_exit` / `TERMINAL_RAW` / `HISTORY_SYNC` routing in `setupTerminalWebSocket`.

- [x] **Step 1: Write the failing test in `tests/terminalSplitPaneWs.test.ts`**

```typescript
import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { BIN_MSG_TYPE, encodeBinaryPacket, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';
import config from '../config/default';

describe('Terminal WebSocket Split-Pane Multiplexing', () => {
  let server: http.Server;
  let port: number;
  let wss: any;
  let hostMgr: TerminalHostManager;
  const originalKey = config.adminSecretKey;

  beforeEach((done) => {
    config.adminSecretKey = 'split-ws-key';
    hostMgr = new TerminalHostManager();
    const app = express();
    server = http.createServer(app);
    wss = setupTerminalWebSocket(server, hostMgr);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    config.adminSecretKey = originalKey;
    if (wss) {
      try { wss.close(); } catch {}
    }
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    server.close(done);
  });

  it('multiplexes main and split pane I/O, resize, pane_close, and pane_exit independently', (done) => {
    const hostId = 'host-mux-1';
    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${hostId}&name=MuxNode&key=split-ws-key`
    );

    const agentReceivedControls: any[] = [];
    const agentReceivedSplitInputs: string[] = [];

    agentWs.on('open', () => {
      const mainClient = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal/ws?hostId=${hostId}&paneId=main&key=split-ws-key`
      );
      const splitClient = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal/ws?hostId=${hostId}&paneId=split&key=split-ws-key`
      );

      let mainOutput = '';
      let splitOutput = '';
      let splitExited = false;

      agentWs.on('message', (data, isBinary) => {
        if (isBinary) {
          const decoded = decodeBinaryPacket(Buffer.from(data as any));
          if (decoded && decoded.msgType === BIN_MSG_TYPE.TERMINAL_RAW && decoded.id === 'split') {
            agentReceivedSplitInputs.push(decoded.payload.toString('utf-8'));
            // Echo back to split pane only
            agentWs.send(encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, 'split', 'SPLIT_ACK\r\n'));
          }
          return;
        }
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const ctrl = JSON.parse(str.slice(5));
          agentReceivedControls.push(ctrl);
          if (ctrl.type === 'pane_close' && ctrl.paneId === 'split') {
            // Simulate agent confirming exit or closing
            mainClient.close();
            splitClient.close();
            agentWs.close();
            expect(mainOutput).toContain('MAIN_ACK');
            expect(mainOutput).not.toContain('SPLIT_ACK');
            expect(splitOutput).toContain('SPLIT_ACK');
            expect(splitOutput).not.toContain('MAIN_ACK');
            expect(agentReceivedSplitInputs).toContain('echo split\n');
            expect(splitExited).toBe(true);
            done();
          }
          return;
        }
        if (str === 'echo main\n') {
          agentWs.send('MAIN_ACK\r\n');
        }
      });

      let openCount = 0;
      const onBothClientsOpen = () => {
        openCount++;
        if (openCount < 2) return;
        mainClient.send(`JSON:${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`);
        splitClient.send(`JSON:${JSON.stringify({ type: 'resize', cols: 40, rows: 24 })}`);
        mainClient.send('echo main\n');
        splitClient.send('echo split\n');
      };

      mainClient.on('open', onBothClientsOpen);
      splitClient.on('open', onBothClientsOpen);

      mainClient.on('message', (msg) => {
        mainOutput += msg.toString();
      });

      splitClient.on('message', (msg) => {
        const str = msg.toString();
        if (str.startsWith('JSON:')) {
          const parsed = JSON.parse(str.slice(5));
          if (parsed.type === 'pane_exit' && parsed.paneId === 'split') {
            splitExited = true;
            // Now test client sending pane_close
            splitClient.send(`JSON:${JSON.stringify({ type: 'pane_close' })}`);
          }
          return;
        }
        splitOutput += str;
        if (splitOutput.includes('SPLIT_ACK') && !splitExited) {
          agentWs.send(`JSON:${JSON.stringify({ type: 'pane_exit', paneId: 'split', exitCode: 0 })}`);
        }
      });
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalSplitPaneWs.test.ts`
Expected: FAIL (timeout or `split` output mixed with `main` session).

- [x] **Step 3: Update `src/terminal/routes/terminalWs.ts` to route `paneId` frames**

In `src/terminal/routes/terminalWs.ts`:
- In `agentWss.on('connection')` binary message block (`lines 178-200`):
  - If `decoded && decoded.msgType === BIN_MSG_TYPE.TERMINAL_RAW`: call `hostMgr.handleAgentPaneData(hostId, decoded.id, decoded.payload); return;`.
  - If `decoded && decoded.msgType === BIN_MSG_TYPE.HISTORY_SYNC`: if `decoded.id && decoded.id !== hostId`, call `hostMgr.handleAgentPaneHistorySync(hostId, decoded.id, decoded.payload)`, else `hostMgr.handleAgentHistorySync(hostId, decoded.payload)`; `return;`.
- In `agentWss.on('connection')` JSON control block (`lines 203-267`):
  - If `control.type === 'history_sync'`: if `control.paneId && control.paneId !== 'main'`, call `hostMgr.handleAgentPaneHistorySync(hostId, control.paneId, control.history)`, else `hostMgr.handleAgentHistorySync(hostId, control.history)`; `return;`.
  - If `control.type === 'reset'`: resolve `const targetPane = control.paneId || 'main'`; call `hostMgr.getSession(hostId, targetPane)?.reset(true, false); return;`.
  - If `control.type === 'pane_exit'`: call `hostMgr.handleAgentPaneExit(hostId, control.paneId || 'split', control.exitCode); return;`.
- In `wss.on('connection')` (`lines 294-370`):
  - Parse `const paneId = TerminalHostManager.normalizePaneId(parsedUrl.searchParams.get('paneId'));` (or `hostMgr.constructor.normalizePaneId` / `TerminalHostManager.normalizePaneId`).
  - Obtain session via `const session = hostMgr.getSession(hostId, paneId);`.
  - In `ws.on('message')` JSON control handler: if `control.type === 'pane_close'`: call `hostMgr.destroyPaneSession(hostId, paneId, true); return;`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalSplitPaneWs.test.ts tests/terminalWs.test.ts`
Expected: PASS.

---

### Task 3: Agent Secondary Pane PTY Manager (`src/agent/pty/panePtyManager.ts` & `src/agent/daemon.ts`)

**Files:**
- Create: `src/agent/pty/panePtyManager.ts`
- Modify: `src/agent/daemon.ts:600-1280`
- Test: `tests/agentSplitPanePty.test.ts`

**Interfaces:**
- Consumes: `tryRequirePty`, `hasSystemPython3`, `PosixPtyDriver`, `InteractivePipeDriver` from `src/agent/pty/drivers.ts`; `TerminalHistoryBuffer` from `src/agent/pty/terminalHistoryBuffer.ts`; `StreamBatcher` from `src/shared/utils/streamBatcher.ts`; `BIN_MSG_TYPE`, `encodeBinaryPacket` from `src/shared/protocol/binaryProtocol.ts`.
- Produces:
  - `SecondaryPanePtyManager` in `src/agent/pty/panePtyManager.ts`:
    - `constructor(opts: { shell?: string; cwd?: string; env?: Record<string, string>; maxScrollbackBytes?: number; sendBinary: (packet: Buffer) => void; sendControl: (msg: Record<string, any>) => void })`
    - `write(paneId: string, data: string | Buffer): void`
    - `resize(paneId: string, cols: number, rows: number): void`
    - `reset(paneId: string): void`
    - `sendHistorySync(paneId: string): void`
    - `sendAllHistorySync(): void`
    - `closePane(paneId: string): void`
    - `destroyAll(): void`
    - `hasPane(paneId: string): boolean`

- [x] **Step 1: Write the failing test in `tests/agentSplitPanePty.test.ts`**

```typescript
import { SecondaryPanePtyManager } from '../src/agent/pty/panePtyManager';
import { BIN_MSG_TYPE, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';

describe('SecondaryPanePtyManager Lifecycle & Multiplexing', () => {
  let manager: SecondaryPanePtyManager;
  let binaryPackets: Buffer[];
  let controlMessages: Record<string, any>[];

  beforeEach(() => {
    binaryPackets = [];
    controlMessages = [];
    manager = new SecondaryPanePtyManager({
      maxScrollbackBytes: 64 * 1024,
      sendBinary: (pkt) => binaryPackets.push(pkt),
      sendControl: (msg) => controlMessages.push(msg),
    });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('lazily spawns a secondary PTY on resize/write and emits TERMINAL_RAW packets tagged with paneId', (done) => {
    expect(manager.hasPane('split')).toBe(false);

    manager.resize('split', 70, 24);
    expect(manager.hasPane('split')).toBe(true);

    manager.write('split', 'echo SPLIT_HELLO_123\r');

    const checkInterval = setInterval(() => {
      const combined = binaryPackets
        .map((pkt) => decodeBinaryPacket(pkt))
        .filter((d) => d && d.msgType === BIN_MSG_TYPE.TERMINAL_RAW && d.id === 'split')
        .map((d) => d!.payload.toString('utf-8'))
        .join('');

      if (combined.includes('SPLIT_HELLO_123')) {
        clearInterval(checkInterval);
        done();
      }
    }, 50);
  });

  it('destroys pane without respawning when shell exits via exit command and emits pane_exit', (done) => {
    manager.resize('split', 80, 24);
    manager.write('split', 'exit\r');

    const checkInterval = setInterval(() => {
      const exitCtrl = controlMessages.find((m) => m.type === 'pane_exit' && m.paneId === 'split');
      if (exitCtrl) {
        clearInterval(checkInterval);
        expect(manager.hasPane('split')).toBe(false);
        done();
      }
    }, 50);
  });

  it('terminates pane immediately on closePane without emitting unsolicited respawn', () => {
    manager.resize('split', 80, 24);
    expect(manager.hasPane('split')).toBe(true);

    manager.closePane('split');
    expect(manager.hasPane('split')).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agentSplitPanePty.test.ts`
Expected: FAIL with `Cannot find module '../src/agent/pty/panePtyManager'`.

- [x] **Step 3: Implement `SecondaryPanePtyManager` in `src/agent/pty/panePtyManager.ts` and wire into `src/agent/daemon.ts`**

1. Create `src/agent/pty/panePtyManager.ts`:
   - Manage a `Map<string, ManagedSecondaryPane>` where each entry has `paneId`, `ptyProcess`, `batcher` (`StreamBatcher`), `decoder` (`StringDecoder`), `history` (`TerminalHistoryBuffer`), `cols`, `rows`, and `isClosing: boolean`.
   - Use the same 3-layer PTY spawn logic as `daemon.ts` (`tryRequirePty()` → `PosixPtyDriver` → `InteractivePipeDriver`).
   - On PTY `onData`, push decoded UTF-8 chunks through `StreamBatcher` (8ms), append to `pane.history`, and call `this.sendBinary(encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, paneId, buf))`.
   - On PTY `onExit`, flush batcher, remove pane from map, and if `!pane.isClosing`, call `this.sendControl({ type: 'pane_exit', paneId, exitCode })`.
   - `closePane(paneId)` sets `pane.isClosing = true`, kills `pane.ptyProcess`, clears `pane.history`, and deletes `paneId` from the map.
   - `sendHistorySync(paneId)` ensures the pane is spawned and, if `pane.history.getBuffer().length > 0`, calls `this.sendBinary(encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, paneId, pane.history.getBuffer()))`.
2. Update `src/agent/daemon.ts`:
   - Instantiate `const secondaryPaneManager = new SecondaryPanePtyManager(...)` using the agent's shell/env/scrollback settings and sending over `ws`.
   - In `ws.on('message')`:
     - When `decoded.msgType === BIN_MSG_TYPE.TERMINAL_RAW`: call `secondaryPaneManager.write(decoded.id, decoded.payload); return;`.
     - When `control.type === 'resize'` and `control.paneId && control.paneId !== 'main'`: call `secondaryPaneManager.resize(control.paneId, cols, rows); return;`.
     - When `control.type === 'reset'` and `control.paneId && control.paneId !== 'main'`: call `secondaryPaneManager.reset(control.paneId); return;`.
     - When `control.type === 'history_req'` and `control.paneId && control.paneId !== 'main'`: call `secondaryPaneManager.sendHistorySync(control.paneId); return;`.
     - When `control.type === 'pane_close'` and `control.paneId && control.paneId !== 'main'`: call `secondaryPaneManager.closePane(control.paneId); return;`.
   - On `registered` reconnection (`control.type === 'registered'`), also call `secondaryPaneManager.sendAllHistorySync()`.
   - In `cleanup()`, call `secondaryPaneManager.destroyAll()`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agentSplitPanePty.test.ts tests/gtAgentDaemon.test.ts`
Expected: PASS.

---

### Task 4: Frontend `WebTerminalView` & `useTerminalWebSocket` Pane Support

**Files:**
- Modify: `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/i18n/locales/en.ts`
- Modify: `frontend/src/i18n/locales/zh.ts`
- Test: `tests/frontendSplitPaneTerminal.test.ts`

**Interfaces:**
- Consumes: `/api/terminal/ws?hostId=...&paneId=...`, `pane_close`, `pane_exit` from Task 2
- Produces:
  - `WebTerminalViewProps` additions:
    - `paneId?: 'main' | 'split'`
    - `isFocusedPane?: boolean`
    - `onFocusPane?: () => void`
    - `onPaneExit?: () => void`
  - `WebTerminalHandle` additions:
    - `closePaneSession: () => void`
    - `focus: () => void`
    - `setFontSizeSynced?: (size: number) => void`
  - i18n keys in `webTerminal`:
    - `splitPane`: `'Split Right'` / `'左右分屏'`
    - `closeSplitPane`: `'Close Split Pane'` / `'关闭分屏'`
    - `paneMain`: `'Pane 1'` / `'主终端 #1'`
    - `paneSplit`: `'Pane 2'` / `'分屏终端 #2'`

- [x] **Step 1: Write the failing test in `tests/frontendSplitPaneTerminal.test.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('WebTerminalView & useTerminalWebSocket Split-Pane Support', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const hookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalWebSocket.ts');
  const zhPath = path.resolve(__dirname, '../frontend/src/i18n/locales/zh.ts');
  const enPath = path.resolve(__dirname, '../frontend/src/i18n/locales/en.ts');

  it('WebTerminalViewProps and WebTerminalHandle declare paneId, focus, and closePaneSession interfaces', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');
    expect(content).toContain("paneId?: 'main' | 'split'");
    expect(content).toContain('isFocusedPane?: boolean');
    expect(content).toContain('onFocusPane?: () => void');
    expect(content).toContain('onPaneExit?: () => void');
    expect(content).toContain('closePaneSession: () => void');
    expect(content).toContain('focus: () => void');
  });

  it('appends paneId query parameter to WebSocket URL and handles pane_exit / pane_close', () => {
    const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
    const hookContent = fs.readFileSync(hookPath, 'utf-8');
    expect(webTerminalContent).toContain('paneId=');
    expect(webTerminalContent).toContain("parsed.type === 'pane_exit'");
    expect(webTerminalContent).toContain("type: 'pane_close'");
    expect(hookContent).toContain('paneId');
  });

  it('defines split pane translation keys in both zh and en locales', () => {
    const zh = fs.readFileSync(zhPath, 'utf-8');
    const en = fs.readFileSync(enPath, 'utf-8');
    expect(zh).toContain('splitPane:');
    expect(zh).toContain('closeSplitPane:');
    expect(en).toContain('splitPane:');
    expect(en).toContain('closeSplitPane:');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendSplitPaneTerminal.test.ts`
Expected: FAIL (`paneId?: 'main' | 'split'` not found in `WebTerminalView.tsx`).

- [x] **Step 3: Implement `paneId`, `closePaneSession`, `focus`, and `onPaneExit` in `WebTerminalView.tsx`, `useTerminalWebSocket.ts`, and i18n files**

1. In `frontend/src/i18n/locales/en.ts` and `frontend/src/i18n/locales/zh.ts`, add under `webTerminal`:
   - `splitPane`: `"Split Terminal"` / `"左右分屏"`
   - `closeSplitPane`: `"Close Split"` / `"关闭分屏"`
   - `paneMain`: `"Terminal #1"` / `"终端 #1"`
   - `paneSplit`: `"Terminal #2"` / `"终端 #2"`
2. In `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`:
   - Add optional `paneId?: 'main' | 'split'` and `onPaneExit?: () => void` to `UseTerminalWebSocketOptions`.
   - Include `&paneId=${encodeURIComponent(paneId)}` in `wsUrl` when `paneId && paneId !== 'main'`.
   - Handle `parsed.type === 'pane_exit'` by setting `isProcessExitedRef.current = true`, clearing timers, and calling `onPaneExit?.()`.
3. In `frontend/src/components/WebTerminalView.tsx`:
   - Add `paneId = 'main'`, `isFocusedPane = true`, `onFocusPane`, `onPaneExit` to `WebTerminalViewProps`.
   - Add `closePaneSession: () => void` and `focus: () => void` to `WebTerminalHandle`.
   - In `initWebSocket`, append `${paneId && paneId !== 'main' ? `&paneId=${encodeURIComponent(paneId)}` : ''}` to `wsUrl`.
   - In `ws.onmessage`, when `parsed.type === 'pane_exit'`, mark `isProcessExitedRef.current = true`, `setIsConnected(false)`, `clearReconnectTimers()`, and invoke `onPaneExitRef.current?.()`.
   - Implement `closePaneSession` in `useImperativeHandle`: sets `isProcessExitedRef.current = true`, `clearReconnectTimers()`, sends `JSON:${JSON.stringify({ type: 'pane_close', paneId })}` if `wsRef.current?.readyState === WebSocket.OPEN`, and closes `wsRef.current`.
   - Implement `focus: () => { xtermRef.current?.focus(); }` in `useImperativeHandle`.
   - Trigger `onFocusPaneRef.current?.()` on `onMouseDown` / `onTouchStart` of the terminal container and on `helperTextarea` focus.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/frontendSplitPaneTerminal.test.ts tests/terminalUnifiedHandles.test.ts`
Expected: PASS.

---

### Task 5: Frontend `UnifiedTerminalView` Split-Pane Workspace, Draggable Splitter & Shortcuts

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/frontendSplitPaneWorkspace.test.ts`

**Interfaces:**
- Consumes: `WebTerminalView` and `WebTerminalHandle` (`paneId`, `isFocusedPane`, `onFocusPane`, `onPaneExit`, `closePaneSession`, `focus`) from Task 4
- Produces:
  - Split-pane toggle button (`data-testid="split-terminal-btn"`) in top toolbar and (`data-testid="mobile-split-terminal-btn"`) in mobile menu
  - Side-by-side dual `WebTerminalView` workspace with draggable divider (`data-testid="terminal-split-divider"`)
  - Close split pane button (`data-testid="close-split-pane-btn"`)
  - Active pane focus tracking (`activePane: 'main' | 'split'`) and keyboard shortcuts (`Alt+D`, `Alt+W`, `Alt+ArrowLeft`, `Alt+ArrowRight`)

- [x] **Step 1: Write the failing test in `tests/frontendSplitPaneWorkspace.test.ts`**

```typescript
/** @jest-environment jsdom */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

// Mock child views to test UnifiedTerminalView split layout, focus routing, and divider dragging cleanly
const mockHandleInstances: Record<string, any> = {};

jest.mock('../frontend/src/components/WebTerminalView', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      const paneId = props.paneId || 'main';
      const handle = React.useMemo(() => ({
        zoomIn: jest.fn(),
        zoomOut: jest.fn(),
        reconnect: jest.fn(),
        resetSession: jest.fn(),
        toggleSelectMode: jest.fn(),
        openScriptDrawer: jest.fn(),
        fit: jest.fn(),
        closePaneSession: jest.fn(),
        focus: jest.fn(),
        isSelectMode: false,
      }), []);
      mockHandleInstances[paneId] = { handle, props };
      React.useImperativeHandle(ref, () => handle, [handle]);
      return (
        <div
          data-testid={`mock-terminal-pane-${paneId}`}
          data-focused={props.isFocusedPane ? 'true' : 'false'}
          onMouseDown={() => props.onFocusPane?.()}
        >
          Pane:{paneId}
        </div>
      );
    }),
  };
});

jest.mock('../frontend/src/components/terminal/TerminalFileManagerView', () => ({
  __esModule: true,
  default: React.forwardRef(() => <div data-testid="mock-files" />),
}));
jest.mock('../frontend/src/components/terminal/TerminalCronView', () => ({
  __esModule: true,
  default: React.forwardRef(() => <div data-testid="mock-cron" />),
}));
jest.mock('../frontend/src/components/terminal/TerminalTaskView', () => ({
  __esModule: true,
  default: React.forwardRef(() => <div data-testid="mock-tasks" />),
}));
jest.mock('../frontend/src/components/terminal/TerminalProxyView', () => ({
  __esModule: true,
  default: React.forwardRef(() => <div data-testid="mock-proxy" />),
}));
jest.mock('../frontend/src/components/terminal/TerminalHostSelector', () => ({
  TerminalHostSelector: () => <div data-testid="mock-host-selector" />,
}));

import UnifiedTerminalView from '../frontend/src/components/UnifiedTerminalView';
import { LanguageProvider } from '../frontend/src/i18n/LanguageContext';
import { ThemeProvider } from '../frontend/src/theme/ThemeContext';

describe('UnifiedTerminalView Split-Pane Workspace', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.keys(mockHandleInstances).forEach((k) => delete mockHandleInstances[k]);
  });

  const renderView = () =>
    render(
      <ThemeProvider>
        <LanguageProvider>
          <UnifiedTerminalView adminKey="test-key" />
        </LanguageProvider>
      </ThemeProvider>
    );

  it('toggles split pane open and closed via toolbar button and calls closePaneSession', () => {
    const { getByTestId, queryByTestId } = renderView();

    // Initially only main pane is rendered
    expect(getByTestId('mock-terminal-pane-main')).toBeTruthy();
    expect(queryByTestId('mock-terminal-pane-split')).toBeNull();

    // Click split button to open right pane
    const splitBtn = getByTestId('split-terminal-btn');
    fireEvent.click(splitBtn);

    expect(getByTestId('mock-terminal-pane-split')).toBeTruthy();
    expect(getByTestId('terminal-split-divider')).toBeTruthy();
    expect(getByTestId('mock-terminal-pane-split').getAttribute('data-focused')).toBe('true');

    // Route script drawer button to currently focused (split) pane
    fireEvent.click(getByTestId('unified-open-scripts-btn'));
    expect(mockHandleInstances['split'].handle.openScriptDrawer).toHaveBeenCalledTimes(1);
    expect(mockHandleInstances['main'].handle.openScriptDrawer).not.toHaveBeenCalled();

    // Click main pane to switch focus back to main
    fireEvent.mouseDown(getByTestId('mock-terminal-pane-main'));
    expect(getByTestId('mock-terminal-pane-main').getAttribute('data-focused')).toBe('true');

    fireEvent.click(getByTestId('unified-open-scripts-btn'));
    expect(mockHandleInstances['main'].handle.openScriptDrawer).toHaveBeenCalledTimes(1);

    // Close split pane via close button
    const splitHandle = mockHandleInstances['split'].handle;
    fireEvent.click(getByTestId('close-split-pane-btn'));
    expect(splitHandle.closePaneSession).toHaveBeenCalledTimes(1);
    expect(queryByTestId('mock-terminal-pane-split')).toBeNull();
  });

  it('auto-collapses split view when split pane triggers onPaneExit (e.g. user types exit)', () => {
    const { getByTestId, queryByTestId } = renderView();

    fireEvent.click(getByTestId('split-terminal-btn'));
    expect(getByTestId('mock-terminal-pane-split')).toBeTruthy();

    act(() => {
      mockHandleInstances['split'].props.onPaneExit?.();
    });

    expect(queryByTestId('mock-terminal-pane-split')).toBeNull();
    expect(getByTestId('mock-terminal-pane-main').getAttribute('data-focused')).toBe('true');
  });

  it('supports keyboard shortcuts Alt+D to open split, Alt+ArrowLeft/Right to switch focus, and Alt+W to close', () => {
    const { getByTestId, queryByTestId } = renderView();

    fireEvent.keyDown(window, { key: 'd', altKey: true });
    expect(getByTestId('mock-terminal-pane-split')).toBeTruthy();
    expect(getByTestId('mock-terminal-pane-split').getAttribute('data-focused')).toBe('true');

    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    expect(getByTestId('mock-terminal-pane-main').getAttribute('data-focused')).toBe('true');

    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(getByTestId('mock-terminal-pane-split').getAttribute('data-focused')).toBe('true');

    fireEvent.keyDown(window, { key: 'w', altKey: true });
    expect(queryByTestId('mock-terminal-pane-split')).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts`
Expected: FAIL (`Unable to find an element by: [data-testid="split-terminal-btn"]`).

- [x] **Step 3: Implement split-pane workspace, draggable divider, focus routing, and shortcuts in `frontend/src/components/UnifiedTerminalView.tsx`**

In `frontend/src/components/UnifiedTerminalView.tsx`:
- Import `Columns2, X` from `lucide-react`.
- Add state:
  - `isSplitMode`: initialized from `localStorage.getItem('terminal_split_enabled') === 'true'`.
  - `splitRatio`: initialized from `localStorage.getItem('terminal_split_ratio')` clamped to `[20, 80]`, default `50`.
  - `activePane`: `'main' | 'split'`, default `'main'`.
  - `splitTerminalRef = useRef<WebTerminalHandle>(null)` and `splitContainerRef = useRef<HTMLDivElement>(null)`.
  - Helper `getActiveTerminalRef()` returning `isSplitMode && activePane === 'split' ? splitTerminalRef.current : terminalRef.current`.
  - Helper `fitAllPanes(force = false)` calling `terminalRef.current?.fit(force)` and `splitTerminalRef.current?.fit(force)`.
- Implement `openSplitPane()` and `closeSplitPane(notifyBackend = true)`:
  - `openSplitPane`: sets `isSplitMode(true)`, `localStorage.setItem('terminal_split_enabled', 'true')`, `setActivePane('split')`, and schedules `fitAllPanes(true)` + `splitTerminalRef.current?.focus()`.
  - `closeSplitPane`: if `notifyBackend`, calls `splitTerminalRef.current?.closePaneSession()`; sets `isSplitMode(false)`, `localStorage.setItem('terminal_split_enabled', 'false')`, `setActivePane('main')`, and schedules `terminalRef.current?.fit(true)` + `terminalRef.current?.focus()`.
- Add `data-testid="split-terminal-btn"` button in top toolbar (`subTab === 'interactive'`) and `data-testid="mobile-split-terminal-btn"` in mobile more menu.
- Implement draggable vertical divider (`data-testid="terminal-split-divider"`):
  - On mouse/touch drag across `splitContainerRef`, compute percentage `((clientX - rect.left) / rect.width) * 100`, clamp to `[20, 80]`, update `splitRatio` + `localStorage`, and schedule `fitAllPanes(false)`.
  - On `onDoubleClick`, reset `splitRatio` to `50` and call `fitAllPanes(true)`.
- When `isSplitMode` is true, render a compact header strip above each pane showing `#1` / `#2` focus state and `data-testid="close-split-pane-btn"` on the right pane, with `WebTerminalView` (`paneId="main"` and `paneId="split"`) mounted side-by-side.
- Add `window` `keydown` listener when `subTab === 'interactive'` for `Alt+D` (`e.code === 'KeyD'` or `e.key.toLowerCase() === 'd'`), `Alt+W` (`e.code === 'KeyW'` or `e.key.toLowerCase() === 'w'`), and `Alt+ArrowLeft` / `Alt+ArrowRight`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/terminalUnifiedTopBarControls.test.ts tests/terminalUnifiedLayout.test.ts`
Expected: PASS.
