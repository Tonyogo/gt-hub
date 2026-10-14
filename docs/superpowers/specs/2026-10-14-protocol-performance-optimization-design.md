# Design Spec: Communication Protocol Performance Optimization

- **Date:** 2026-10-14
- **Status:** Draft / Review
- **Authors:** AI Assistant, yatao
- **Category:** Architecture / Performance & Networking

---

## 1. Background & Problem Statement

`gt-hub` coordinates high-throughput bidirectional streams between remote agent daemons, the central hub server, browser terminal sessions (xterm.js), and the CLI (`gt exec`, `gt cp`). In the current implementation, three major protocol bottlenecks hinder performance:

1. **High-Frequency Small Packets Without Micro-Batching:**
   - When remote PTY processes output bursty data (e.g. `cat large_file.log`, compilation steps, interactive curses apps), `node-pty` generates hundreds of tiny data chunks per millisecond.
   - The Agent sends each raw chunk immediately as an isolated WebSocket frame, causing excessive network packet overhead (TCP/WS headers), kernel socket context switches, and frontend rendering stutter.
2. **Double Base64 Encoding and GC Pressure:**
   - In `terminalExecBridge` and remote task streams, raw binary streams are converted to Base64 strings before being embedded in JSON messages:
     ```typescript
     this.sendToAgent(canonicalHostId, {
       type: 'cmd_stream_input',
       taskId: assignedTaskId,
       data: buf.toString('base64'),
     });
     ```
   - This introduces a **33% bandwidth overhead** and requires 5 allocation steps in memory: `Buffer -> Base64 String -> JSON.stringify -> JSON.parse -> Buffer.from(base64) -> child.stdin.write()`, consuming significant CPU cycles and triggering frequent V8 GC sweeps.
3. **Application-Layer Text Heartbeats:**
   - Heartbeats currently rely on UTF-8 strings (`JSON:{"type":"ping"}`) parsed by application-level JSON deserializers on every cycle.
   - During heavy terminal output, heartbeat messages share the same serialization queue, risking false-positive connection timeout drops under load.

---

## 2. Design Goals & Non-Goals

### Goals
- **16ms Output Micro-Batching:** Combine high-frequency PTY outputs into single WebSocket frames aligned with standard 60fps display refresh cycles (16ms window) and bounded by a 64KB memory limit.
- **Zero-Base64 Native Binary Streaming:** Introduce a compact binary protocol for streaming CLI execution and terminal stdin/stdout data, eliminating Base64 overhead and reducing bandwidth by ~25%.
- **Native RFC 6455 Ping/Pong Heartbeats:** Switch agent-hub keepalives to standard 2-byte WebSocket control frames (`ws.ping()`), bypassing application-layer JSON parsers.
- **Strict Backward Compatibility:** Automatically fall back to legacy JSON strings (`cmd_stream_input`, `JSON:{"type":"ping"}`) when communicating with older agents or clients.

### Non-Goals
- Replacing WebSockets with WebTransport or QUIC.
- Full binary serialization (e.g. Protobuf/MsgPack) for low-frequency RPC control operations (e.g. node registration, file tree metadata).

---

## 3. Detailed Architecture & Implementation

### 3.1 16ms Terminal Stream Micro-Batching Engine (`StreamBatcher`)

#### 3.1.1 Batching Mechanism
Create a reusable `StreamBatcher` utility (`src/shared/utils/streamBatcher.ts`):
- **Flush Window:** Fixed timer interval of `16ms` (aligns with 60fps browser rendering).
- **Buffer Ceiling:** Maximum buffer size of `64KB` (`65536` bytes). If accumulated data exceeds this threshold before the 16ms timer expires, immediately flush the buffer.
- **Lifecycle Integration:**
  - In `src/agent/daemon.ts`: Wrap `ptyProcess.onData` emission.
  - In `src/terminal/services/terminalHostManager.ts`: Wrap `RemoteAgentTerminalSession.handleData` multi-client broadcast.
- **Guaranteed Delivery on Termination:**
  - Upon process exit, connection close, or terminal reset, `flush()` is invoked synchronously to ensure no trailing bytes are lost.

```typescript
export class StreamBatcher {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly maxBatchBytes: number = 64 * 1024;
  private readonly intervalMs: number = 16;
  private flushCallback: (batch: string) => void;

  constructor(flushCallback: (batch: string) => void, intervalMs: number = 16) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
  }

  public push(chunk: string): void {
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
    this.flushCallback(combined);
  }

  public destroy(): void {
    this.flush();
  }
}
```

---

### 3.2 Zero-Base64 Native Binary Streaming Protocol

#### 3.2.1 Binary Packet Frame Structure
Standardize binary frames transmitted over WebSocket connections:

```text
+-------------------+--------------------+------------------------+----------------------+
| 1 Byte (MsgType)  | 1 Byte (IdLen: N)  | N Bytes (ASCII TaskId) | M Bytes (Raw Payload)|
+-------------------+--------------------+------------------------+----------------------+
```

- **Byte 0 (MsgType):**
  - `0x01` (`BIN_MSG_TYPE.STREAM_INPUT`): CLI / client stdin payload to remote process.
  - `0x02` (`BIN_MSG_TYPE.STREAM_OUTPUT`): Remote process stdout/stderr payload to Hub / CLI.
  - `0x03` (`BIN_MSG_TYPE.TERMINAL_RAW`): Direct terminal PTY raw output.
- **Byte 1 (IdLen):** Length $N$ of the task/session ID string ($0 \le N \le 255$).
- **Bytes $2$ to $2 + N - 1$:** Task ID or Host ID ASCII string.
- **Bytes $2 + N$ to End:** Raw payload without Base64 encoding.

#### 3.2.2 Helper Utilities (`src/shared/protocol/binaryProtocol.ts`)
- **Encoding:**
  ```typescript
  export function encodeBinaryPacket(msgType: number, id: string, payload: Buffer | Uint8Array | string): Buffer {
    const idBuf = Buffer.from(id, 'ascii');
    const dataBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const packet = Buffer.allocUnsafe(2 + idBuf.length + dataBuf.length);
    packet[0] = msgType;
    packet[1] = idBuf.length;
    idBuf.copy(packet, 2);
    dataBuf.copy(packet, 2 + idBuf.length);
    return packet;
  }
  ```
- **Decoding:**
  ```typescript
  export interface DecodedBinaryPacket {
    msgType: number;
    id: string;
    payload: Buffer;
  }

  export function decodeBinaryPacket(buf: Buffer): DecodedBinaryPacket | null {
    if (!buf || buf.length < 2) return null;
    const msgType = buf[0];
    const idLen = buf[1];
    if (buf.length < 2 + idLen) return null;
    const id = buf.toString('ascii', 2, 2 + idLen);
    const payload = buf.subarray(2 + idLen);
    return { msgType, id, payload };
  }
  ```

#### 3.2.3 Hub & Agent Stream Pipelining
- **In `src/terminal/services/terminalExecBridge.ts`:**
  - When CLI sends binary input over `exec-ws`, parse directly via `decodeBinaryPacket` or pass raw chunk straight to Agent as binary frame `0x01`.
  - When Agent sends binary execution output, forward payload directly to CLI WebSocket as binary frame, avoiding all Base64 encode/decode operations.
- **Backward Compatibility:**
  - If a message arrives as text (`typeof message === 'string'` or begins with `JSON:`), continue routing through the legacy `cmd_stream_input` JSON handler.

---

### 3.3 Native RFC 6455 Ping/Pong Control Frames

#### 3.3.1 Heartbeat Architecture
- **Agent Node (`src/agent/daemon.ts`):**
  - Replace timer sending `ws.send('JSON:{"type":"ping"}')` with `ws.ping()`.
  - Track `lastPongTime`: Update on `ws.on('pong', () => { lastPongTime = Date.now(); })`.
  - If `Date.now() - lastPongTime > 20000ms`, consider socket dead and trigger reconnect.
- **Hub Server (`src/terminal/routes/terminalWs.ts`):**
  - Listen for native ping on Agent WebSocket:
    ```typescript
    ws.on('ping', () => {
      hostMgr.touchAgent(hostId, ws, agentMeta);
      // ws library automatically responds with Pong control frame, but touching agent updates lastSeen
    });
    ```
- **Legacy Fallback:**
  - Preserve `control.type === 'ping'` handler in `terminalWs.ts` so older agents continue receiving `JSON:{"type":"pong"}` responses without disconnection.

---

## 4. Performance Benchmarks & Targets

| Metric | Before Optimization | After Optimization | Expected Improvement |
| :--- | :--- | :--- | :--- |
| **Packets per second (`cat 10MB.log`)** | ~3,500 pkts/s | ~60 pkts/s | **~98% reduction** |
| **Streaming Bandwidth Consumption** | 133% (Base64) | 100% (Binary) | **~25% bandwidth saved** |
| **Stream Processing Memory Allocations** | 5 copies per chunk | 1 slice (Zero-copy) | **~80% GC allocation drop** |
| **Heartbeat Overhead** | ~20 bytes text JSON | 2 bytes WS control frame | **90% reduction** |

---

## 5. Testing Plan

### 5.1 Unit Tests
- **`tests/streamBatcher.test.ts`:**
  - Test batching multiple rapid pushes within 16ms into a single flush.
  - Test immediate flush when reaching 64KB threshold.
  - Test manual and destruction `flush()` preventing data loss.
- **`tests/binaryProtocol.test.ts`:**
  - Test encoding and decoding of binary frames with varying task ID lengths and arbitrary binary payloads.
  - Test corrupted and partial packet boundary handling.

### 5.2 Integration Tests
- **`tests/terminalBinaryExec.test.ts`:**
  - Validate end-to-end binary streaming through `terminalExecBridge` without Base64 encoding.
  - Verify backward compatibility when sending legacy JSON `cmd_stream_input`.
- **`tests/agentNativePingPong.test.ts`:**
  - Validate agent keepalive using native `ws.ping()` and `ws.pong()` without JSON string ping/pong.

---

## 6. Compatibility & Rollout Strategy

- **Zero-Downtime Interoperability:**
  - Binary frames use WebSocket opcode `0x2` (`Buffer`), while legacy frames use opcode `0x1` (`String`). Hub and Agent can detect the format on the fly on a per-message basis.
  - Existing `gt` CLI binaries continue operating without modification.
