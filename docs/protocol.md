# `gt` Client / Hub / Agent Protocol Standard (`PROTOCOL_VERSION = 2`)

> Authoritative specification for the Gemini Terminal (`gt`) WebSocket & HTTP communication protocol implemented across `src/shared/protocol/*`, `src/terminal/*`, `src/agent/*`, `src/client/*`, and `frontend/*`.

---

## 1. Versioning & Compatibility Model

| Constant / Field | Value | Source |
|---|---|---|
| `PROTOCOL_VERSION` | `2` | `src/shared/protocol/events.ts` |
| Legacy Fallback | `1` | Implicit when peer omits `protocolVersion` or `capabilities` |

Protocol v2 introduces explicit capability negotiation while maintaining **100% wire backward compatibility** with v1 agents, hubs, CLI mocks, and browser clients:

- **v1 Peers**: Communicate via text `JSON:<payload>` control frames (`compress: false`), unframed main PTY binary frames, Base64-encoded split/exec streams, and in-band `[0x04]` (`EOT`) EOF signaling on `/api/terminal/exec-ws`.
- **v2 Peers**: Advertise capabilities during connection/session handshakes, negotiate binary control envelopes (`CONTROL_JSON`), zero-copy `TERMINAL_RAW` main-pane framing (`id = "main"`), raw binary chunk RPCs (`FILE_CHUNK_REQ` / `FILE_CHUNK_RES`), raw binary stdin with out-of-band `exec_stdin_eof` signaling, and strict WebSocket binary-vs-text frame discrimination (`isBinary`).

---

## 2. Transport Endpoints & Authentication

### 2.1 WebSocket Multiplexing (`src/terminal/routes/terminalWs.ts`)

HTTP `Upgrade` requests are matched strictly by normalized pathname (supporting both `/api/terminal/*` and `/api/admin/terminal/*` aliases):

| Endpoint | Participants | Purpose |
|---|---|---|
| `/api/terminal/ws` | Browser xterm.js <-> Hub | Interactive main terminal and split pane I/O (`?hostId=<id>&paneId=<pane>&binaryControl=0\|1`) |
| `/api/terminal/agent-ws` | Agent Daemon <-> Hub | Reverse persistent cluster tunnel & multiplexed RPC/stream transport |
| `/api/terminal/exec-ws` | CLI (`gt exec`) <-> Hub | Streaming remote command execution (`?hostId=<id>&binaryControl=0\|1`) |
| `/api/terminal/proxy-ws` | CLI (`gt proxy`) <-> Hub | Reverse TCP port-forwarding tunnel (`?hostId=<id>&binaryControl=0\|1`) |

**WebSocket Deflate Settings (`src/shared/protocol/wsOptions.ts`)**:
- `perMessageDeflate.threshold = 1024`
- `zlibDeflateOptions.level = 3`
- `clientNoContextTakeover = true`, `serverNoContextTakeover = true`
- Control packets and pre-compressed/small binary frames pass `compress: false` via `sendWsSafe`.

### 2.2 Authentication & Redaction

1. **Header Authentication (Preferred)**: All Node.js clients (`gt` CLI and `gt agent`) send credentials in HTTP request header `x-admin-key`, verified with timing-safe comparison (`safeCompareSecret` in `src/shared/utils/security.ts`).
2. **WS Query Parameter Exclusion**: Node WebSocket clients (`daemon.ts`, `exec.ts`, `interactiveExec.ts`, `proxy.ts`, `resolveWsEndpointUrl` / `resolveWebSocketUrl`) MUST NOT append `key` or `x-admin-key` to WS URLs. Only browser/native `globalThis.WebSocket` fallback in `NativeWebSocketAdapter` (`src/shared/utils/wsAdapter.ts`) translates `headers['x-admin-key']` to `?x-admin-key=` because browser `WebSocket` cannot set custom upgrade headers. Subpath base URLs (e.g. `https://example.com/gt-hub`) are preserved by `resolveEndpointUrl` and `resolveWsEndpointUrl`.
3. **Browser One-Time Tickets & Proxy Sessions**: Browser terminals exchange admin auth for short-lived tickets (`?ticket=...`), and HTTP proxy routes (`/api/proxy/*`) use HMAC-signed HTTP-only cookie `gt_proxy_session` (`proxyAuthMiddleware` in `src/terminal/routes/proxyRoutes.ts`).
4. **Log Redaction**: Unauthenticated WebSocket upgrades (`401 Unauthorized`) log paths sanitized by `redactWsUrlSecrets` (masking `key`, `x-admin-key`, `admin_key`, `ticket` as `***`). Failed auth attempts are rate-limited (`429 Too Many Requests`).

---

## 3. Capability Negotiation & Handshakes

### 3.1 Agent Registration (`/api/terminal/agent-ws`)

**Request URL Query Parameters** (sent by `daemon.ts` via `resolveWebSocketUrl`):
- Identity/Metadata: `hostId`, `name`, `hostname`, `ip`, `platform`, `machineId`, `version`, `startTime` (keys `key`, `x-admin-key`, `timezone`, `timeZone` are explicitly stripped).
- Capability Advertisement:
  - `protocolVersion=2`
  - `binaryControl=1`
  - `binaryFile=1`
  - `framedTerminal=1`

**Hub Evaluation (`negotiateProtocolCapabilities` in `src/shared/protocol/binaryProtocol.ts`)**:
- Computes `protocolVersion = min(clientVersion, PROTOCOL_VERSION)` and boolean flags (`binaryControl`, `binaryFile`, `framedTerminal`, `stdinEof`, `binaryExec`).
- Checks host name conflicts in `terminalHostManager.registerAgent(...)`:
  - **On conflict**: Hub sends `rejected` control frame (`{ type: "rejected", reason, code: 4009 }`) and closes with WS code `4009`. Agent exits with status `1` without reconnecting.
  - **On success**: Hub sends `registered`:
    ```json
    {
      "type": "registered",
      "hostId": "<canonicalId>",
      "name": "<hostName>",
      "status": "online",
      "protocolVersion": 2,
      "capabilities": {
        "binaryControl": true,
        "binaryFile": true,
        "framedTerminal": true
      }
    }
    ```

**Agent Handshake Settlement (`src/agent/daemon.ts`)**:
- Initial socket flags `_binaryControl`, `_binaryFile`, `_framedTerminal` start as `false`.
- Main PTY output generated between `ws.open` and capability confirmation is queued in `pendingOutputQueue`, and initial `isFirstSpawn` PTY `reset` & `resize` notifications are deferred until the handshake settles so they respect negotiated `_binaryControl`.
- Upon receiving `registered`, Agent applies the server-confirmed `capabilities` flags, marks `_handshakeSettled = true`, emits any deferred initial `reset`/`resize`, flushes queued PTY output using `TERMINAL_RAW` (`id = "main"`) if `framedTerminal === true` (or raw binary if `false`), and sends history sync on reconnection.
- If talking to a legacy mock Hub that never sends `registered`, a 3000ms `.unref()` grace timer settles `_handshakeSettled = true` with v1 unframed defaults.

### 3.2 CLI Exec Negotiation (`/api/terminal/exec-ws`)

1. CLI connects and sends `exec_start` text control message:
   ```json
   {
     "type": "exec_start",
     "protocolVersion": 2,
     "command": "cat -",
     "cwd": "/tmp",
     "env": {},
     "timeoutMs": 300000,
     "tty": false,
     "interactive": false,
     "cols": 80,
     "rows": 24
   }
   ```
2. Hub (`terminalExecBridge.ts`) verifies that the host exists, is online, and has an active `agentWs` (`readyState === OPEN`), dispatches `cmd_exec` (`action: "start_stream"`, `stdinEof: true`) to the agent, and replies to CLI:
   ```json
   {
     "type": "exec_started",
     "taskId": "exec-...",
     "protocolVersion": 2,
     "capabilities": {
       "stdinEof": true,
       "binaryStdin": true,
       "binaryControl": false
     }
   }
   ```
   > `/api/terminal/exec-ws` enforces strict WebSocket opcode separation (`isBinary === false` for text JSON control frames, `isBinary === true` for raw binary stdin/stdout chunks), preventing `0x08` (`\b`) / `0x03` stdout collisions; accordingly `capabilities.binaryControl` is always `false`.
3. On failure (offline host, missing command, duplicate `exec_start`), Hub sends structured `exec_error` (`{ type: "exec_error", error, code }`) and closes with code `1008` when terminating the session.

---

## 4. Wire Framing & Collision Prevention

### 4.1 Binary vs Text Frame Discrimination (`isBinaryMessageFrame`)

In Node `ws` v8+, **both** WebSocket text frames and binary frames deliver `Buffer` instances to `'message'` listeners; only the `isBinary` flag distinguishes frame opcode (`0x1` text vs `0x2` binary).

- **`isBinary === true`**: Frame is treated strictly as binary wire protocol (or raw binary stdin on `exec-ws` / raw PTY on unframed v1 connections).
- **`isBinary === false`**: Frame is ALWAYS UTF-8 text (e.g., terminal keystrokes such as `Ctrl+A` = `0x01`, `Ctrl+C` = `0x03`, `Ctrl+H` = `0x08`, `Tab` = `0x09`, or `JSON:<payload>` text control). Text frames MUST NEVER enter binary packet tag (`0x01..0x0a`) decoding.
- **`isBinary === undefined`** (legacy adapters/test mocks): `isBinaryMessageFrame` treats `Buffer` / `ArrayBuffer` / `ArrayBufferView` as binary-capable while bridges inspect known packet headers and `JSON:` prefixes defensively so unit-test `EventEmitter` mocks omitting `isBinary` remain compatible.

### 4.2 Binary Packet Envelope (`src/shared/protocol/binaryProtocol.ts`)

All structured binary protocol packets use the following compact big-endian framing layout:

```
+---------------+---------------+-------------------+----------------------+
| msgType (1B)  | idLen (1B)    | id (ASCII, 0..255)| payload (0..N bytes) |
+---------------+---------------+-------------------+----------------------+
  offset 0        offset 1        offset 2            offset 2 + idLen
```

| Byte | Constant (`BIN_MSG_TYPE`) | Direction | `id` Semantics | Payload |
|---|---|---|---|---|
| `0x01` | `STREAM_INPUT` | Hub -> Agent | `taskId` (`exec-...` or `pane-<id>`) | Raw `stdin` bytes |
| `0x02` | `STREAM_OUTPUT` | Agent -> Hub | `taskId` (`exec-...` or `pane-<id>`) | Raw batched UTF-8/binary output |
| `0x03` | `TERMINAL_RAW` | Bidirectional | `"main"` (v2 `framedTerminal`) or secondary `paneId` | Raw PTY terminal bytes |
| `0x04` | `HISTORY_SYNC` | Agent -> Hub -> Browser | `hostId` (main) or `paneId` (split pane) | Replay ring-buffer snapshot |
| `0x05` | `PROXY_HTTP_REQ_BODY` | Hub -> Agent | `reqId` | HTTP proxy request body slice |
| `0x06` | `PROXY_HTTP_RES_BODY` | Agent -> Hub | `reqId` | HTTP proxy response body slice |
| `0x07` | `PROXY_TCP_DATA` | CLI <-> Hub <-> Agent | `streamId` | Raw TCP socket chunk (<=32 KB/pkt) |
| `0x08` | `CONTROL_JSON` | Bidirectional (`_binaryControl`) | `clampPacketId(id)` (e.g. `hostId`/`reqId`) | UTF-8 JSON string (must pass `isValidControlPayload`) |
| `0x09` | `FILE_CHUNK_REQ` | Hub -> Agent | `reqId` | Hybrid JSON+Buffer upload/download chunk |
| `0x0a` | `FILE_CHUNK_RES` | Agent -> Hub | `reqId` | Hybrid JSON+Buffer download chunk response |

> **Why `TERMINAL_RAW` (`id = "main"`) matters**: Unframed main PTY output bytes starting with `\x03` (`ETX`), `\x04` (`EOT`), `\x07` (`BEL`), `\t` (`0x09`), or `\n` (`0x0a`) numerically collide with binary packet tags `0x03..0x0a`. Wrapping main PTY frames in `TERMINAL_RAW("main")` when `framedTerminal=true` eliminates packet hijacking and silent output loss.

### 4.3 Hybrid Metadata + Raw Data Packet (`FILE_CHUNK_REQ` / `FILE_CHUNK_RES`)

```
+----------+-------+-------+------------------+-------------------------+-----------------------+
| msgType  | idLen | id    | metaLen (UInt32BE)| meta (UTF-8 JSON)       | rawData (0..N bytes)  |
+----------+-------+-------+------------------+-------------------------+-----------------------+
```

Used for zero-Base64 chunked file upload (`FILE_CHUNK_REQ`, `action: "upload_chunk"`) and download (`FILE_CHUNK_RES`, returning `{ success, error?, size, offset, length, encoding? } + rawBuffer`).

### 4.4 Control Frame Encoding & Anti-Spoofing (`sendControlFrame` & `VALID_CONTROL_TYPES`)

- **Outbound**: `sendControlFrame(ws, payload, id?)` sends `BIN_MSG_TYPE.CONTROL_JSON` (`binary: true, compress: false`) with `clampPacketId(id)` if `ws._binaryControl === true`, or `'JSON:' + JSON.stringify(payload)` (`binary: false, compress: false`) otherwise.
- **Inbound Filtering & Host Isolation**:
  - `isValidControlPayload(obj)` validates `obj` is a non-null, non-array object whose `type` is in the strict `VALID_CONTROL_TYPES` whitelist.
  - On `/api/terminal/ws`, malformed `CONTROL_JSON` packets and unrecognized `isBinary === true` frames under `_binaryControl === true` are dropped rather than forwarded to `session.write(...)`.
  - On `/api/terminal/exec-ws`, control parsing uses the dedicated `EXEC_WS_CONTROL_TYPES` set (`exec_start`, `resize`, `exec_stdin_eof`, `exec_kill`, `ping`) ONLY on non-binary or pre-start frames so user JSON stdin (even `{ "type": "custom" }` or `{ "type": "exec_stdin_eof" }` inside a binary stdin pipe) is never swallowed. `TerminalExecBridge.handleAgentStreamMessage` enforces `session.hostId === hostId` before relaying `STREAM_OUTPUT`, `cmd_stream_data`, or `cmd_stream_exit`.
  - On `/api/terminal/proxy-ws`, unrecognized `isBinary === true` frames are dropped without UTF-8 `JSON:` fallback (in both `terminalProxyBridge.ts` and `CliTcpTunnelClient`), TCP streams are scoped per `(hostId, streamId)`, and `handleAgentBinaryFrame` / `handleAgentControlMessage` verify `state.hostId === hostId` / `pending.hostId === hostId`.
  - On browser clients (`WebTerminalView.tsx`, `useTerminalWebSocket.ts`, `frontend/src/utils/terminalProtocol.ts`), connections advertise `binaryControl=1`, send an initial `ping` on `open`, decode both `ArrayBuffer` and `Uint8Array` binary `CONTROL_JSON` (`0x08`) frames, and once binary `CONTROL_JSON` is confirmed from Hub (`binaryControlConfirmed`), ignore inbound text `JSON:` control prefixes so even literal `JSON:{"type":"reset"}` terminal output renders cleanly in xterm.js; prior to binary confirmation (v1 Hub fallback), `JSON:` text parsing still applies ONLY to known browser terminal control types (`agent_offline`, `pane_exit`, `pong`, `reset`, `status/exit`).

---

## 5. Control Message Catalog

### 5.1 Lifecycle & Keepalive (`Agent <-> Hub <-> Client`)

| `type` | Required / Optional Fields | Semantics |
|---|---|---|
| `ping` | `timestamp?` | Application heartbeat probe |
| `pong` | `timestamp?` | Heartbeat reply |
| `registered` | `hostId`, `status`, `protocolVersion?`, `capabilities?` | Confirms agent tunnel registration & active capabilities |
| `rejected` | `reason`, `code?` | Rejects agent registration (`4009` on duplicate name) |
| `meta` | `name?`, `hostname?`, `ip?`, `platform?`, `version?`, `startTime?`, `info?` | Metadata refresh (does NOT reset existing terminal dimensions/stream state on the same socket) |
| `status` | `event`, `...` | Terminal status notification (`event: "exit"`) |

### 5.2 Interactive Terminal & Split Panes

| `type` | Fields | Direction | Semantics |
|---|---|---|---|
| `resize` | `cols`, `rows`, `paneId?`, `force?` | Browser/CLI <-> Hub <-> Agent | Clamp `cols` `[10, 500]`, `rows` `[5, 200]`; `paneId` omitted or `"main"` targets main PTY |
| `reset` | `paneId?`, `reason?` | Browser <-> Hub <-> Agent | Respawn shell PTY & clear client screen/replay state |
| `history_req` | `paneId?` | Hub -> Agent | Request replay buffer (`HISTORY_SYNC` or empty `{ type: "history_sync", history: "" }`) |
| `history_sync` | `paneId?`, `history` | Agent -> Hub | Empty history notification when `TerminalHistoryBuffer` is empty |
| `pane_close` | `paneId` | Browser -> Hub -> Agent | Terminates secondary pane (`SecondaryPanePtyManager` or `StreamSessionManager` `pane-<id>`) |
| `pane_exit` | `paneId`, `exitCode?` | Agent -> Hub -> Browser | Secondary pane process exited |
| `agent_offline` | `hostId`, `paneId?` | Hub -> Browser | Agent disconnected; Hub closes browser WS with `1012` |

### 5.3 Execution RPC & Streaming

**Agent Command RPC (`cmd_exec`)**:
- `cmd_exec`: `{ type: "cmd_exec", reqId, action, taskId?, command?, cwd?, timeoutMs?, env?, stdin?, offset?, signal?, limit?, includeFinishOutput?, finishMaxOutputBytes? }`
  - `action` values: `"start"`, `"poll"`, `"status"`, `"stream"`, `"kill"`, `"list"`, `"start_stream"`.
- `cmd_exec_res`: `{ type: "cmd_exec_res", reqId, taskId?, success, data?, error? }`
- `cmd_task_finished`: push notification on background task completion (`status`: `"completed" | "failed" | "timeout" | "killed"`).

**Streaming Execution (`Agent <-> Hub`)**:
- `cmd_exec (action: "start_stream")`: starts `StreamSessionManager` session (`tty`, `interactive`, `cols`, `rows`, `timeoutMs`, `stdinEof`).
  - When `!tty && stdinEof` (`InteractivePipeDriver` fallback), `rawBinaryStdin = true` disables `0x0d -> 0x0a` CR translation and `0x03` SIGINT interception so non-TTY stdin is 100% binary-clean.
  - When `!tty && !taskId.startsWith('pane-')`, `StreamSessionManager` also bypasses `StringDecoder('utf8')` and string-based `StreamBatcher`, flushing raw `Buffer` chunks (max 64 KB / 8ms) so arbitrary binary stdout (e.g., `0xff`, `0xfe`, `\x00`) is preserved byte-for-byte without `U+FFFD` replacement.
- `cmd_stream_input`: legacy Base64 stdin `{ taskId, data }`; preferred v2 path is binary `BIN_MSG_TYPE.STREAM_INPUT`.
- `cmd_stream_data`: legacy Base64 stdout `{ taskId, data }`; preferred v2 path is binary `BIN_MSG_TYPE.STREAM_OUTPUT`.
- `cmd_stream_resize`: `{ taskId, cols, rows }`.
- `cmd_stream_eof`: `{ taskId }` — closes `stdin` cleanly (`endInput`, writing `0x04` only if backed by PTY).
- `cmd_stream_kill`: `{ taskId, signal? }`.
- `cmd_stream_exit`: `{ taskId, exitCode, signal? }`.

**CLI Exec WebSocket (`/api/terminal/exec-ws`)**:
- CLI -> Hub: `exec_start`, `resize`, `exec_stdin_eof`, `exec_kill`, `ping`, plus raw stdin bytes sent strictly as binary WebSocket frames (`binary: true`).
  - Both `runStreamExec` (`exec.ts`) and `runInteractiveExec` (`interactiveExec.ts`) wait for `exec_started` (with a 3000ms `.unref()` fallback for legacy/mock servers) before attaching `process.stdin` and streaming input live, avoiding UTF-8 pre-buffering and capability races. In `runStreamExec`, stdin is attached whenever `options.interactive` or `!process.stdin.isTTY`; if `!options.interactive && process.stdin.isTTY`, EOF (`exec_stdin_eof` or `0x04` fallback) is sent immediately after `exec_started`.
  - On `process.stdin` `end`/`close` (when `!tty || !isTTY`), CLI sends `exec_stdin_eof` when `exec_started.capabilities.stdinEof === true`, falling back to `Buffer.from([0x04])` only when conversing with a v1 server/mock omitting `capabilities.stdinEof`.
  - On `SIGINT`/`SIGTERM`, both streaming and interactive exec forward `exec_kill` (`SIGINT` / `SIGTERM`) before closing the WebSocket and exiting (`130` / `143`), and route `[Host Offline]` / `[Agent Disconnected]` notifications to `process.stderr`.
  - `runStreamExec` separates pre-`exec_started` transport/upgrade failures (which may fall back to HTTP polling) from HTTP `401`/`403`/`429` upgrade rejections (`unexpected-response`), `1008` rejections, and post-`exec_started` disconnects (`1001` server shutdown, `1005` statusless close without `exec_exit`, `1012` agent disconnect, socket error/close), which MUST NOT re-execute the command via HTTP polling or falsely exit `0`.
- Hub -> CLI: `exec_started`, `exec_exit`, `exec_error`, `pong`, plus raw binary `stdout`/`stderr` chunks.
  - On normal `cmd_stream_exit`, Hub deletes the active session BEFORE `cliWs.close(1000)` so socket teardown does not emit a spurious `cmd_stream_kill`.

### 5.4 File RPC

- `file_rpc`: `{ type: "file_rpc", reqId, action, path?, params? }`
  - `RPC_FILE_ACTIONS`: `list`, `read`, `write`, `mkdir`, `rename`, `delete`, `stat`, `download_chunk`, `upload_chunk`.
- `file_rpc_res`: `{ type: "file_rpc_res", reqId, success, data?, error? }`

### 5.5 Reverse Proxy & Diagnostics

- HTTP Proxy Control: `proxy_http_start`, `proxy_http_req_end`, `proxy_http_abort`, `proxy_http_pause`, `proxy_http_resume`, `proxy_http_headers` (`proxy_http_res_headers` accepted for backward compat), `proxy_http_end`.
- TCP Tunnel Control (`/api/terminal/proxy-ws`):
  - `proxy_tcp_connect`: `{ streamId, host, port }` — `streamId` MUST be non-empty ASCII <= 255 bytes; `port` MUST be integer `1..65535`.
  - `proxy_tcp_connected`: `{ streamId }` — triggers buffered pre-connect write flush (`pendingWrites`, capped at 2 MB per stream in `CliTcpTunnelClient`).
  - `proxy_tcp_close`: `{ streamId, error?, code? }`
  - `terminalProxyBridge.ts` dynamically looks up the current `agentWs` per message/stream rather than capturing a stale initial socket reference.
- Discovery & Probe RPCs: `proxy_list_ports` / `proxy_list_ports_res`, `proxy_net_ping` / `proxy_net_ping_res`, `proxy_net_probe` / `proxy_net_probe_res`.

### 5.6 Distributed Cron

- `cron_sync` / `cron_sync_res` (`jobs`, `serverTimezone?`)
- `cron_trigger` / `cron_trigger_res` (`jobId`, `requestId?`)
- `cron_list` / `cron_list_res`, `cron_history` / `cron_history_res`
- `cron_report`, `cron_error`

---

## 6. Heartbeats, Liveness & Close Codes

| Link | Probe Interval | Timeout | Action on Timeout |
|---|---|---|---|
| Agent -> Hub (`daemon.ts`) | 15s (`ws.ping()` + control `ping`) | 60s (`2x = 120s` while `activeFileRpcCount > 0`) | `ws.terminate()` -> exponential backoff reconnect (1s..30s) |
| Hub -> Agent (`terminalWs.ts`) | 30s default (`agentHeartbeatIntervalMs`, native `ws.ping()` + control `ping`) | 75s default (`agentHeartbeatTimeoutMs`) | `ws.terminate()` -> triggers `handleAgentDisconnected` for exec & proxy bridges |
| CLI Exec WS (`exec.ts`, `interactiveExec.ts`) | 15s (`ws.ping()` + `{ type: "ping" }`) | 45s inactivity | `ws.terminate()` / `ws.close()`, restore TTY raw mode & remove process listeners |
| CLI Proxy WS (`proxy.ts`) | 15s (`ws.ping()` + `JSON:{ type: "ping" }`) | 45s inactivity | `ws.terminate()` / `ws.close()`, fail active TCP streams |

**Defined WebSocket Close Codes**:
- `1000`: Normal process/session exit.
- `1001`: Hub server shutdown (`Server shutting down`).
- `1008`: Policy/parameter violation, unknown/offline host, or invalid `exec_start`.
- `1012`: Service restart / backing Agent disconnected (`Agent disconnected`).
- `4009`: Duplicate online Agent host name rejected (`rejected` + fatal Agent exit).

---

## 7. HTTP Client & Resumable File Transfer Contracts

1. **`makeRequest` & `resolveHost` (`src/client/utils/terminalUI.ts`)**:
   - Uses `resolveEndpointUrl` to preserve configured server subpath bases, sends `Accept-Encoding: gzip, deflate`, decompresses `gzip`/`deflate` (with `inflateRaw` fallback) response bodies before JSON parsing, accumulates raw `Buffer` chunks to protect multi-byte UTF-8 boundaries, validates `res.complete` / `res.on('close')` / `res.on('error')` / `req.on('close')` with a `settled` guard against premature termination, enforces `30000ms` default socket timeout, and resolves hosts cleanly in `resolveHost` (exact ID -> exact-case name -> case-insensitive name, throwing on duplicate online matches).
2. **`gt cp` (`src/client/commands/cp.ts`) & `gt proxy` Speedtest (`src/client/commands/proxy.ts`)**:
   - **Upload**: Uses `resolveEndpointUrl`, multipart `Content-Disposition` sanitizes `"` / `\r` / `\n` in filenames (`_`), streams chunks with backpressure and `settled` guards across `readStream` callbacks, enforces a 60s socket inactivity timeout, and guards premature connection/response teardown.
   - **Download**: Uses `resolveEndpointUrl`, resumes via HTTP `Range: bytes=<offset>-` with `.part` staging, validates `Content-Range` / `Content-Length`, handles `res.on('close')` (`!res.complete`) across both `200`/`206` and `>=400` branches, resets on `416`, retries transient `5xx`/`429`/socket errors up to 10 times (500ms..3000ms backoff), rejects immediately on local disk `writeStream` errors, and enforces a 60s socket inactivity timeout.
   - **Speedtest & Tunnel Client**: `CliTcpTunnelClient.connect()` handles `unexpected-response` and pre-open `close` without hanging; `runSpeedtestBenchmark` uses `resolveEndpointUrl`, sends `Accept-Encoding: gzip, deflate` with decompression, validates `res.complete` + `res.on('close')` + `req.on('close')` across ping, probe, download, and upload phases, and enforces 30s (ping/probe) / 120s (download/upload) request timeouts.
