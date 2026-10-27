# Fix Agent Heartbeat Disconnect & Chunk Retry During File Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `"Agent <id> reconnected; previous RPC cancelled"` errors during file downloads and stop periodic `code: 1006` agent reconnects over Cloudflare Tunnel.

**Architecture:**
1. Fix the Agent heartbeat in `src/agent/daemon.ts`: send application-level `JSON:{"type":"ping"}` alongside `ws.ping()`, increase `HEARTBEAT_TIMEOUT_MS` to `60000` (60s), and refresh heartbeat activity (`onHeartbeatActivity()`) whenever outbound data is being transmitted or `ws.bufferedAmount > 0` so active file transfers never self-terminate the WebSocket.
2. Tune `src/terminal/services/terminalFileService.ts` and `src/agent/handlers/fileRpcHandler.ts`: use non-blocking async `gzipAsync`/`gunzipAsync`, set `DEFAULT_DOWNLOAD_CHUNK_SIZE = 512 * 1024` (512KB) with `DEFAULT_PREFETCH_CONCURRENCY = 2` to prevent WebSocket head-of-line blocking, and add automatic chunk-level retry (up to 3 attempts with backoff) when an RPC fails due to transient agent reconnection.

**Tech Stack:** Node.js (`zlib`, `util.promisify`), TypeScript, Jest.

**Spec:** `docs/superpowers/specs/2026-10-27-large-file-transfer-and-compression-design.md`

## Global Constraints

- Maintain full backward compatibility with all existing tests (`tests/gtAgentDaemon.test.ts`, `tests/agentNativePingPong.test.ts`, `tests/fileRpcCompressionAndPrefetch.test.ts`, `tests/terminalFileRangeDownload.test.ts`).
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

- When `ws.ping()` is not echoed back by an intermediate reverse proxy (such as Cloudflare Tunnel), the application-level `JSON:{"type":"ping"}` -> `JSON:{"type":"pong"}` exchange must keep `lastPongReceived` fresh so the agent does not disconnect every 20s with `code: 1006`.
- While the agent is actively reading/sending large file chunks (`handleFileRpc`) or `ws.bufferedAmount > 0`, the heartbeat timer must not kill the connection.
- If an agent socket briefly reconnects mid-download (`"Agent ... reconnected; previous RPC cancelled"`), `TerminalFileService` must retry the failed chunk (up to 3 times) and complete the download stream without throwing an error to the HTTP client.

---

### Task 1: Fix Agent Heartbeat Over Cloudflare Tunnel & Prevent Self-Termination During File Transfers

**Files:**
- Modify: `src/agent/daemon.ts:22-25,673-730`
- Modify: `src/agent/handlers/fileRpcHandler.ts:1-35,120-150,245-305`
- Test: `tests/agentNativePingPong.test.ts`

**Interfaces:**
- Produces:
  - `HEARTBEAT_TIMEOUT_MS = 60000` in `src/agent/daemon.ts`
  - In `startHeartbeat()` (`src/agent/daemon.ts`):
    - If `ws.bufferedAmount && ws.bufferedAmount > 0`, call `onHeartbeatActivity()` so saturated upload buffers do not trigger a false-positive timeout.
    - Send both `if (typeof ws.ping === 'function') ws.ping();` AND `ws.send('JSON:' + JSON.stringify({ type: 'ping' }));` so Cloudflare Tunnel / proxies that drop control pings still deliver application-level `pong` messages (which already trigger `onHeartbeatActivity()` on message receipt at line 1037).
  - In `src/agent/handlers/fileRpcHandler.ts`:
    - Use `const gzipAsync = util.promisify(zlib.gzip);` instead of synchronous `zlib.gzipSync` in `read` and `download_chunk` so compression never blocks the event loop or delays pong frames.

- [x] **Step 1: Update `src/agent/daemon.ts` and `src/agent/handlers/fileRpcHandler.ts`**

1. In `src/agent/daemon.ts`:
   - Change `export const HEARTBEAT_TIMEOUT_MS = 60000;` (was `20000`).
   - In `startHeartbeat()`:
     - Before checking timeout, if `typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > 0`, call `onHeartbeatActivity()`.
     - When sending ping: call `if (typeof ws.ping === 'function') { try { ws.ping(); } catch {} }` AND always send `ws.send(\`JSON:\${JSON.stringify({ type: 'ping' })}\`);`.
   - When `handleFileRpc` is invoked or replies, call `onHeartbeatActivity()`.

2. In `src/agent/handlers/fileRpcHandler.ts`:
   - Import ` { promisify } from 'util'` and define `const gzipAsync = promisify(zlib.gzip);`.
   - Replace `zlib.gzipSync(...)` in `read` and `download_chunk` with `await gzipAsync(..., { level: zlib.constants.Z_BEST_SPEED })`.

- [x] **Step 2: Run agent heartbeat and daemon tests**

Run: `npm test -- tests/agentNativePingPong.test.ts tests/gtAgentDaemon.test.ts`
Expected: PASS

---

### Task 2: Tune Chunk Size/Concurrency & Add Automatic Chunk Retry on Reconnect in `TerminalFileService`

**Files:**
- Modify: `src/terminal/services/terminalFileService.ts`
- Modify: `tests/fileRpcCompressionAndPrefetch.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_DOWNLOAD_CHUNK_SIZE = 512 * 1024` (512KB) and `DEFAULT_PREFETCH_CONCURRENCY = 2` in `src/terminal/services/terminalFileService.ts`
  - `decodeAgentChunkBufferAsync(resData: any): Promise<Buffer>` using `promisify(zlib.gunzip)` (while keeping synchronous `decodeAgentChunkBuffer` exported for backward compatibility).
  - Automatic retry in `rpcAgentWithRetry(hostId, action, targetPath, params, timeoutMs, maxRetries = 3)` for `stat`, `read`, and `download_chunk` when `res?.error` contains `'reconnected'` or `'not connected'` or `'offline'`, waiting `500 * attempt` ms before retrying.

- [x] **Step 1: Write the failing test in `tests/fileRpcCompressionAndPrefetch.test.ts` for mid-stream reconnect retry**

Add test `'retries download_chunk automatically when agent briefly reconnects mid-stream'`:
- Simulate chunk 1 returning `{ success: false, error: 'Agent prefetch-retry-node reconnected; previous RPC cancelled' }` on its first attempt and succeeding on the second attempt.
- Assert the stream completes with the full expected buffer without throwing a stream error.

- [x] **Step 2: Implement `rpcAgentWithRetry` and 512KB / 2-concurrency tuning in `src/terminal/services/terminalFileService.ts`**

- Set `export const DEFAULT_DOWNLOAD_CHUNK_SIZE = 512 * 1024;` and `export const DEFAULT_PREFETCH_CONCURRENCY = 2;`.
- Implement `private async rpcAgentWithRetry(hostId: string, action: string, targetPath: string, params?: any, timeoutMs?: number, maxRetries: number = 3): Promise<any>`:
  - Loop `attempt = 0` to `maxRetries`:
    - Call `const res = await this.rpcAgent(hostId, action, targetPath, params, timeoutMs);`
    - If `res && res.success` return `res`.
    - Check if `res?.error` matches `/reconnected|previous RPC cancelled|not connected|offline/i`. If so and `attempt < maxRetries`, wait `new Promise(r => setTimeout(r, 400 * (attempt + 1)))` and retry; otherwise return `res`.
- Use `this.rpcAgentWithRetry` in `listFiles`, `readFileContent`, `getFileStat`, `getFileStream`, and `createAgentChunkedStream`.

- [x] **Step 3: Run targeted tests and build**

Run: `npm test -- tests/fileRpcCompressionAndPrefetch.test.ts tests/terminalFileRangeDownload.test.ts tests/httpCompressionAndInlinePreview.test.ts && npm run build`
Expected: PASS on all tests and build succeeds.

- [x] **Step 4: Commit**

```bash
git add src/agent/daemon.ts src/agent/handlers/fileRpcHandler.ts src/terminal/services/terminalFileService.ts tests/fileRpcCompressionAndPrefetch.test.ts tests/agentNativePingPong.test.ts docs/superpowers/plans/2026-10-27-fix-agent-heartbeat-and-chunk-retry.md
git commit -m "fix(files): prevent agent heartbeat disconnect over Cloudflare and retry chunks on reconnect"
```
