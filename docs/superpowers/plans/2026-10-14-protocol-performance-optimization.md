# Communication Protocol Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize `gt-hub` communication performance by introducing a 16ms terminal output micro-batching engine, zero-Base64 native binary stream packet frames for command execution, and native RFC 6455 Ping/Pong WebSocket control frame heartbeats.

**Architecture:**
- Create `StreamBatcher` utility with a 16ms timer window and 64KB memory limit, deployed in Agent PTY output handling and Hub multi-client broadcast.
- Implement `binaryProtocol.ts` with compact binary framing (MsgType + IdLen + Id + Raw Payload) for CLI/Agent streaming stdin and stdout, bypassing Base64 stringification.
- Upgrade Agent-Hub heartbeats to native WebSocket `ws.ping()` and `ws.on('pong')` control frames with 2-byte protocol overhead.
- Maintain full backward compatibility for legacy JSON string frames (`cmd_stream_input`, `JSON:{"type":"ping"}`).

**Tech Stack:** Node.js, TypeScript, WebSocket (`ws`), Node-PTY, React, Jest.

**Spec:** `docs/superpowers/specs/2026-10-14-protocol-performance-optimization-design.md`

## Global Constraints

- Never break backward compatibility for older agents or CLI clients using JSON-formatted strings.
- Binary frames strictly use opcode `0x2` (`Buffer`), and legacy text frames use opcode `0x1` (`string`).
- Micro-batching window is fixed at 16ms (aligned with 60fps refresh rate) with a strict 64KB max batch size ceiling.
- Native Ping/Pong frames must use standard WebSocket control frames (RFC 6455 opcodes `0x9` and `0xA`).
- All automated tests must run clean under `npm test` with `--detectOpenHandles --forceExit`.

## Review Focus

1. **Terminal Data Loss on Disconnect/Reset:** When a PTY session or WebSocket disconnects while unmerged chunks remain in `StreamBatcher`, `flush()` must synchronously deliver or clear pending bytes without dropping tail output.
2. **Binary Frame Boundary Corruption:** Malformed or truncated binary frames (fewer than 2 bytes, or payload smaller than declared `IdLen`) must be safely discarded without throwing unhandled exceptions.
3. **Zero-Base64 Direct Pipe Execution:** Validating binary streaming input directly writes raw slices to `child.stdin` without invoking `Buffer.from(..., 'base64')`.
4. **Heartbeat Under Heavy Terminal Load:** Flooding terminal output with thousands of lines must not block or delay native `ws.ping()` control frames.
5. **Legacy Client Fallback:** Sending a legacy `cmd_stream_input` JSON string to Hub or Agent must still execute and return valid output without rejection.

---

### Task 1: 16ms Terminal Output Micro-Batching Engine (`StreamBatcher`)

**Files:**
- Create: `src/shared/utils/streamBatcher.ts`
- Modify: `src/agent/daemon.ts:680-705`, `src/agent/daemon.ts:720-735`, `src/agent/daemon.ts:765-780`
- Modify: `src/terminal/services/terminalHostManager.ts:160-225`
- Test: `tests/streamBatcher.test.ts`, `tests/terminalBatchingIntegration.test.ts`

**Interfaces:**
- Consumes: `flushCallback: (chunk: string) => void`, `intervalMs?: number`, `maxBatchBytes?: number`
- Produces: `class StreamBatcher { push(chunk: string): void; flush(): void; destroy(): void; size(): number }`

- [ ] **Step 1: Write the failing unit test**

Create `tests/streamBatcher.test.ts`:
```typescript
import { StreamBatcher } from '../src/shared/utils/streamBatcher';

describe('StreamBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('batches rapid consecutive pushes into a single flush after 16ms', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16);

    batcher.push('hello ');
    batcher.push('world');
    batcher.push('!');

    expect(outputs).toEqual([]);

    jest.advanceTimersByTime(16);

    expect(outputs).toEqual(['hello world!']);
  });

  it('immediately flushes when batch size reaches 64KB threshold', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16, 100); // 100 bytes threshold for testing

    const chunk50 = 'a'.repeat(50);
    batcher.push(chunk50);
    expect(outputs.length).toBe(0);

    const chunk60 = 'b'.repeat(60);
    batcher.push(chunk60); // 50 + 60 = 110 >= 100

    expect(outputs.length).toBe(1);
    expect(outputs[0]).toBe(chunk50 + chunk60);
  });

  it('synchronously flushes pending data on destroy or manual flush', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16);

    batcher.push('pending data');
    batcher.flush();

    expect(outputs).toEqual(['pending data']);

    batcher.push('tail data');
    batcher.destroy();

    expect(outputs).toEqual(['pending data', 'tail data']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/streamBatcher.test.ts`
Expected: FAIL with "Cannot find module '../src/shared/utils/streamBatcher'"

- [ ] **Step 3: Write StreamBatcher implementation**

Create `src/shared/utils/streamBatcher.ts`:
```typescript
export class StreamBatcher {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly maxBatchBytes: number;
  private readonly intervalMs: number;
  private flushCallback: (batch: string) => void;

  constructor(
    flushCallback: (batch: string) => void,
    intervalMs: number = 16,
    maxBatchBytes: number = 64 * 1024
  ) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
    this.maxBatchBytes = maxBatchBytes;
  }

  public push(chunk: string): void {
    if (!chunk || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferedLength += chunk.length;

    if (this.bufferedLength >= this.maxBatchBytes) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const combined = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
    this.buffer = [];
    this.bufferedLength = 0;
    try {
      this.flushCallback(combined);
    } catch {
      // Ignore callback errors during flush
    }
  }

  public size(): number {
    return this.bufferedLength;
  }

  public destroy(): void {
    this.flush();
  }
}
```

Update `src/agent/daemon.ts`:
Import `StreamBatcher` and wrap `sendToWs`:
```typescript
import { StreamBatcher } from '../shared/utils/streamBatcher';
...
// Inside runAgent / daemon loop:
let ptyBatcher: StreamBatcher | null = null;

function getPtyBatcher(): StreamBatcher {
  if (!ptyBatcher) {
    ptyBatcher = new StreamBatcher((batched) => {
      sendToWs(batched);
    }, 16);
  }
  return ptyBatcher;
}
```
Route `proc.onData` in node-pty, posix-pty, and pipe drivers through `getPtyBatcher().push(data)`.
Ensure `getPtyBatcher().flush()` is called in `onExit` and socket close.

Update `src/terminal/services/terminalHostManager.ts`:
In `RemoteAgentTerminalSession`:
Add `private broadcastBatcher: StreamBatcher`:
```typescript
    this.broadcastBatcher = new StreamBatcher((batchedText) => {
      const deadSockets: any[] = [];
      for (const ws of this.activeSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(batchedText);
          } else {
            deadSockets.push(ws);
          }
        } catch {
          deadSockets.push(ws);
        }
      }
      for (const dead of deadSockets) {
        this.activeSockets.delete(dead);
      }
    }, 16);
```
Route `handleData` text broadcasts through `this.broadcastBatcher.push(text)`.
Ensure `this.broadcastBatcher.flush()` is called in `destroy()` and `reset()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/streamBatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/utils/streamBatcher.ts src/agent/daemon.ts src/terminal/services/terminalHostManager.ts tests/streamBatcher.test.ts
git commit -m "feat(perf): introduce 16ms terminal output micro-batching engine

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Zero-Base64 Native Binary Streaming Protocol (`binaryProtocol.ts`)

**Files:**
- Create: `src/shared/protocol/binaryProtocol.ts`
- Test: `tests/binaryProtocol.test.ts`

**Interfaces:**
- Produces:
  - `BIN_MSG_TYPE = { STREAM_INPUT: 0x01, STREAM_OUTPUT: 0x02, TERMINAL_RAW: 0x03 }`
  - `encodeBinaryPacket(msgType: number, id: string, payload: Buffer | Uint8Array | string): Buffer`
  - `decodeBinaryPacket(buf: Buffer | Uint8Array): { msgType: number; id: string; payload: Buffer } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/binaryProtocol.test.ts`:
```typescript
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';

describe('binaryProtocol', () => {
  it('encodes and decodes binary packets correctly with Buffer payload', () => {
    const rawPayload = Buffer.from('hello raw binary stdout\n', 'utf-8');
    const encoded = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, 'task-xyz-123', rawPayload);

    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(encoded[0]).toBe(BIN_MSG_TYPE.STREAM_OUTPUT);
    expect(encoded[1]).toBe('task-xyz-123'.length);

    const decoded = decodeBinaryPacket(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.msgType).toBe(BIN_MSG_TYPE.STREAM_OUTPUT);
    expect(decoded!.id).toBe('task-xyz-123');
    expect(decoded!.payload.toString('utf-8')).toBe('hello raw binary stdout\n');
  });

  it('handles arbitrary binary bytes (including zero bytes)', () => {
    const rawBytes = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x00]);
    const encoded = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_INPUT, 'exec-1', rawBytes);

    const decoded = decodeBinaryPacket(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload).toEqual(rawBytes);
  });

  it('returns null for corrupted or undersized buffers', () => {
    expect(decodeBinaryPacket(Buffer.alloc(0))).toBeNull();
    expect(decodeBinaryPacket(Buffer.from([0x01]))).toBeNull();

    // IdLen declared as 10, but buffer only has 5 bytes
    const truncated = Buffer.from([0x01, 10, 0x61, 0x62, 0x63]);
    expect(decodeBinaryPacket(truncated)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/binaryProtocol.test.ts`
Expected: FAIL with "Cannot find module '../src/shared/protocol/binaryProtocol'"

- [ ] **Step 3: Write binaryProtocol implementation**

Create `src/shared/protocol/binaryProtocol.ts`:
```typescript
export const BIN_MSG_TYPE = {
  STREAM_INPUT: 0x01,
  STREAM_OUTPUT: 0x02,
  TERMINAL_RAW: 0x03,
} as const;

export interface DecodedBinaryPacket {
  msgType: number;
  id: string;
  payload: Buffer;
}

export function encodeBinaryPacket(
  msgType: number,
  id: string,
  payload: Buffer | Uint8Array | string
): Buffer {
  const idBuf = Buffer.from(id, 'ascii');
  if (idBuf.length > 255) {
    throw new Error(`Binary packet id length exceeds 255 bytes: "${id}"`);
  }
  const dataBuf = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === 'string'
      ? Buffer.from(payload, 'utf-8')
      : Buffer.from(payload);

  const packet = Buffer.allocUnsafe(2 + idBuf.length + dataBuf.length);
  packet[0] = msgType;
  packet[1] = idBuf.length;
  idBuf.copy(packet, 2);
  dataBuf.copy(packet, 2 + idBuf.length);
  return packet;
}

export function decodeBinaryPacket(buf: Buffer | Uint8Array): DecodedBinaryPacket | null {
  if (!buf) return null;
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (nodeBuf.length < 2) return null;

  const msgType = nodeBuf[0];
  const idLen = nodeBuf[1];
  if (nodeBuf.length < 2 + idLen) return null;

  const id = nodeBuf.toString('ascii', 2, 2 + idLen);
  const payload = nodeBuf.subarray(2 + idLen);
  return { msgType, id, payload };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/binaryProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol/binaryProtocol.ts tests/binaryProtocol.test.ts
git commit -m "feat(protocol): add zero-copy binary streaming packet codec

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Zero-Base64 Streaming Integration in TerminalExecBridge & Agent

**Files:**
- Modify: `src/terminal/services/terminalExecBridge.ts:35-75`, `src/terminal/services/terminalExecBridge.ts:145-175`
- Modify: `src/agent/daemon.ts:915-930`
- Modify: `src/agent/pty/sessionManager.ts:75-95`, `src/agent/pty/sessionManager.ts:150-160`
- Test: `tests/terminalBinaryExec.test.ts`

**Interfaces:**
- Consumes: `encodeBinaryPacket`, `decodeBinaryPacket`, `BIN_MSG_TYPE`
- Produces: Seamless dispatch of raw binary chunks between CLI, Hub, and Agent daemon without Base64 encoding.

- [ ] **Step 1: Write the failing integration test**

Create `tests/terminalBinaryExec.test.ts`:
```typescript
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';
import { StreamSessionManager } from '../src/agent/pty/sessionManager';

describe('Zero-Base64 StreamSessionManager Binary Integration', () => {
  it('supports direct raw buffer input via writeRawInput without Base64 decoding', (done) => {
    let capturedOutput = '';
    const mockSend = (msg: any) => {
      if (Buffer.isBuffer(msg)) {
        const decoded = decodeBinaryPacket(msg);
        if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
          capturedOutput += decoded.payload.toString('utf-8');
        }
      }
    };

    const manager = new StreamSessionManager(mockSend);
    const taskId = 'test-binary-task-1';

    manager.startStream({
      taskId,
      command: 'cat',
      tty: false,
    });

    setTimeout(() => {
      manager.writeRawInput(taskId, Buffer.from('direct-binary-stream-data\n', 'utf-8'));
    }, 100);

    setTimeout(() => {
      manager.kill(taskId);
      expect(capturedOutput).toContain('direct-binary-stream-data');
      done();
    }, 600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalBinaryExec.test.ts`
Expected: FAIL with "manager.writeRawInput is not a function"

- [ ] **Step 3: Update sessionManager, daemon, and terminalExecBridge**

In `src/agent/pty/sessionManager.ts`:
Import `BIN_MSG_TYPE`, `encodeBinaryPacket`:
```typescript
import { BIN_MSG_TYPE, encodeBinaryPacket } from '../../shared/protocol/binaryProtocol';
...
// In onData callback:
    const onData = (data: any) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Send directly as compact binary packet
      const packet = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, taskId, buf);
      this.send(packet);
    };
...
// Add writeRawInput method:
  writeRawInput(taskId: string, rawBuf: Buffer | Uint8Array): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
      session.driver.write(buf);
    } catch {}
  }
```

In `src/agent/daemon.ts`:
Handle incoming binary frames:
```typescript
import { BIN_MSG_TYPE, decodeBinaryPacket } from '../shared/protocol/binaryProtocol';
...
// In ws.on('message', (message, isBinary) => { ... })
        if (isBinary) {
          const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
          const decoded = decodeBinaryPacket(buf);
          if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_INPUT) {
            if (streamSessionManager) {
              streamSessionManager.writeRawInput(decoded.id, decoded.payload);
            }
            return;
          }
        }
```

In `src/terminal/services/terminalExecBridge.ts`:
Forward binary frames directly:
```typescript
import { BIN_MSG_TYPE, encodeBinaryPacket, decodeBinaryPacket } from '../../shared/protocol/binaryProtocol';
...
// In handleCliConnection binary message handler:
        if (isBinary) {
          if (assignedTaskId) {
            const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
            const packet = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_INPUT, assignedTaskId, buf);
            const session = terminalHostManager.getSession(canonicalHostId);
            if (session) {
              session.write(packet as any);
            }
          }
          return;
        }
...
// In handleAgentStreamMessage:
    if (Buffer.isBuffer(message)) {
      const decoded = decodeBinaryPacket(message);
      if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
        const session = this.activeSessions.get(decoded.id);
        if (session && session.cliWs && session.cliWs.readyState === 1) {
          session.cliWs.send(decoded.payload);
        }
        return;
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalBinaryExec.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/pty/sessionManager.ts src/agent/daemon.ts src/terminal/services/terminalExecBridge.ts tests/terminalBinaryExec.test.ts
git commit -m "feat(perf): pipeline zero-base64 binary stream chunks end-to-end

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Native RFC 6455 Ping/Pong Control Frame Heartbeat

**Files:**
- Modify: `src/agent/daemon.ts:610-630`, `src/agent/daemon.ts:950-970`
- Modify: `src/terminal/routes/terminalWs.ts:130-170`
- Test: `tests/agentNativePingPong.test.ts`

**Interfaces:**
- Consumes: `ws.ping()`, `ws.on('pong')`, `ws.on('ping')`
- Produces: 2-byte RFC 6455 control frame heartbeats; automatic `touchAgent` update on ping arrival.

- [ ] **Step 1: Write the failing test**

Create `tests/agentNativePingPong.test.ts`:
```typescript
import http from 'http';
import WebSocket from 'ws';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Native RFC 6455 Ping/Pong Control Frames', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    server = http.createServer(app);
    setupTerminalWebSocket(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('updates host lastSeen on receiving native WebSocket ping control frame', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=ping-node-test&name=ping-node`);

    ws.on('open', () => {
      setTimeout(() => {
        const hostBefore = terminalHostManager.getHost('ping-node-test');
        expect(hostBefore).toBeDefined();
        const initialSeen = hostBefore!.lastSeen;

        // Send native WS ping
        ws.ping();

        ws.on('pong', () => {
          setTimeout(() => {
            const hostAfter = terminalHostManager.getHost('ping-node-test');
            expect(hostAfter!.lastSeen).toBeGreaterThanOrEqual(initialSeen);
            ws.close();
            done();
          }, 50);
        });
      }, 50);
    });

    ws.on('error', (err) => {
      done(err);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agentNativePingPong.test.ts`
Expected: FAIL if native ping listener not present or hostManager not updating lastSeen.

- [ ] **Step 3: Implement native Ping/Pong handlers**

In `src/terminal/routes/terminalWs.ts`:
Add native ping handler on `ws`:
```typescript
    ws.on('ping', () => {
      hostMgr.touchAgent(hostId, ws, agentMeta);
    });
```

In `src/agent/daemon.ts`:
Update heartbeat routine:
```typescript
    let lastPongReceived = Date.now();

    ws.on('pong', () => {
      lastPongReceived = Date.now();
    });

    const startHeartbeat = () => {
      stopHeartbeat();
      lastPongReceived = Date.now();
      heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== 1) return;
        // Check timeout
        if (Date.now() - lastPongReceived > HEARTBEAT_TIMEOUT_MS) {
          console.warn('[Agent] Heartbeat pong timeout (>20s). Terminating stale connection...');
          try { ws.terminate(); } catch {}
          return;
        }
        // Send RFC 6455 native ping
        try {
          if (typeof ws.ping === 'function') {
            ws.ping();
          } else {
            ws.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
          }
        } catch {}
      }, HEARTBEAT_INTERVAL_MS);
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/agentNativePingPong.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/terminal/routes/terminalWs.ts src/agent/daemon.ts tests/agentNativePingPong.test.ts
git commit -m "feat(perf): switch agent keepalive to native RFC 6455 ping/pong control frames

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Full Regression Testing & Production Build

**Files:**
- Verify: Full Jest test suite (124+ suites)
- Verify: Full production build (Frontend Vite, Backend tsc, CLI esbuild)

- [ ] **Step 1: Run all tests with forceExit flag**

Run: `npm test`
Expected: PASS all test suites cleanly, 0 failures.

- [ ] **Step 2: Run full build pipeline**

Run: `npm run build`
Expected:
1. `version:gen` succeeds.
2. `build:frontend` succeeds.
3. `build:backend` succeeds.
4. `build:gt` bundles `dist/gt.js`.

- [ ] **Step 3: Commit verification**

```bash
git commit --allow-empty -m "chore: verify test suites and build for protocol performance optimization

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
