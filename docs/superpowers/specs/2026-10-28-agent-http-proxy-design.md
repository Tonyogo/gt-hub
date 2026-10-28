# Agent HTTP & TCP Proxy Design Specification (Phase 1)

**Date**: 2026-10-28
**Status**: Draft / Approved in Brainstorming
**Scope**: Phase 1 — Core Agent Proxy Protocol, Hub HTTP Proxy Routes, and `gt` CLI (`gt forward` & `gt proxy`)

---

## 1. Purpose & Goals

Enable `gt` Agents to act as both **reverse tunnel gateways** (exposing local or intranet HTTP/TCP services running on or near the Agent node) and **outbound forward proxies** (allowing callers or CLI users to route HTTP/HTTPS/TCP requests through the Agent's network environment).

### Phase 1 Deliverables
1. **Multiplexed Dual-Mode Proxy Protocol**: Extend the existing `/api/terminal/agent-ws` connection with structured HTTP proxy control/streaming frames and raw TCP tunnel frames without interfering with terminal PTY sessions, file RPCs, or heartbeat liveness.
2. **Hub HTTP Proxy Endpoints**:
   - Reverse port proxy: `ALL /api/proxy/:hostId/port/:port/*` (and `/api/proxy/:hostId/port/:port`)
   - Outbound URL proxy: `ALL /api/proxy/:hostId/request`
3. **Hub TCP Tunnel WebSocket Endpoint**:
   - `/api/terminal/proxy-ws` (and `/api/admin/terminal/proxy-ws`) for CLI-to-Agent raw TCP streams.
4. **Client CLI Commands**:
   - `gt forward <node> <mapping...>`: Local-to-remote TCP port forwarding (`[bindAddr:]localPort:remotePort` or `[bindAddr:]localPort:remoteHost:remotePort`).
   - `gt proxy <node> [-p 1080] [-b 127.0.0.1]`: Standard local HTTP/HTTPS forward proxy supporting both regular HTTP proxy requests and HTTPS `CONNECT` tunneling.

*(Note: Frontend Web UI proxy panel and port preview integration are deferred to Phase 2.)*

---

## 2. Architecture & Protocol Design

### 2.1 Binary Protocol Extensions (`src/shared/protocol/binaryProtocol.ts`)

Extend `BIN_MSG_TYPE` with three new frame types using the existing `[1B msgType][1B idLen][id (ASCII)][payload]` envelope:

```ts
export const BIN_MSG_TYPE = {
  STREAM_INPUT: 0x01,
  STREAM_OUTPUT: 0x02,
  TERMINAL_RAW: 0x03,
  HISTORY_SYNC: 0x04,
  PROXY_HTTP_REQ_BODY: 0x05, // Hub -> Agent: HTTP request body chunk (id = reqId)
  PROXY_HTTP_RES_BODY: 0x06, // Agent -> Hub: HTTP response body chunk (id = reqId)
  PROXY_TCP_DATA: 0x07,      // Bidirectional: Raw TCP tunnel chunk (id = streamId)
} as const;
```

- **Isolation Requirement**: Both `src/terminal/routes/terminalWs.ts` (Hub side) and `src/agent/daemon.ts` (Agent side) MUST explicitly intercept `0x05`, `0x06`, and `0x07` in their binary message handlers before falling back to `hostMgr.handleAgentData` or PTY stdin, ensuring proxy payloads never leak into terminal screens.
- **Chunk Size**: All streaming body and TCP payloads are sliced into chunks of at most `32 * 1024` bytes (32KB) to prevent WebSocket head-of-line blocking.

### 2.2 Control Signaling Messages (`JSON:{...}`)

All control messages travel over the existing `JSON:` prefixed text frame channel on `/api/terminal/agent-ws` (and `/api/terminal/proxy-ws` for CLI TCP streams).

#### Mode A: HTTP Request/Response Streaming (`reqId`)
1. `proxy_http_start` (Hub → Agent):
   ```json
   {
     "type": "proxy_http_start",
     "reqId": "hpx-1730000000000-abc123",
     "method": "POST",
     "url": "http://127.0.0.1:3000/v1/items?page=1",
     "headers": { "content-type": "application/json", "host": "127.0.0.1:3000" },
     "timeoutMs": 60000,
     "bodyEnd": false
   }
   ```
   *(If the request has no body, e.g., `GET` or `HEAD` with `content-length: 0`, `bodyEnd` is set to `true` and no `proxy_http_req_end` frame is needed.)*
2. `PROXY_HTTP_REQ_BODY (0x05)` (Hub → Agent): Zero or more binary chunks carrying the request body.
3. `proxy_http_req_end` (Hub → Agent):
   ```json
   { "type": "proxy_http_req_end", "reqId": "hpx-1730000000000-abc123" }
   ```
4. `proxy_http_abort` (Hub → Agent): Sent if the downstream HTTP client disconnects prematurely or times out.
   ```json
   { "type": "proxy_http_abort", "reqId": "hpx-1730000000000-abc123" }
   ```
5. `proxy_http_headers` (Agent → Hub): Sent as soon as the upstream target responds with status and headers.
   ```json
   {
     "type": "proxy_http_headers",
     "reqId": "hpx-1730000000000-abc123",
     "statusCode": 200,
     "statusMessage": "OK",
     "headers": { "content-type": "application/json" }
   }
   ```
6. `PROXY_HTTP_RES_BODY (0x06)` (Agent → Hub): Zero or more binary chunks carrying the raw upstream response body (compression encodings from upstream are preserved as-is).
7. `proxy_http_end` (Agent → Hub): Sent when the upstream response finishes normally or fails with an error.
   ```json
   {
     "type": "proxy_http_end",
     "reqId": "hpx-1730000000000-abc123",
     "error": "connect ECONNREFUSED 127.0.0.1:3000",
     "code": "ECONNREFUSED"
   }
   ```

#### Mode B: Raw TCP Stream Tunneling (`streamId`)
1. `proxy_tcp_connect` (CLI → Hub → Agent):
   ```json
   {
     "type": "proxy_tcp_connect",
     "streamId": "tcp-1730000000000-xyz789",
     "host": "127.0.0.1",
     "port": 3000,
     "timeoutMs": 15000
   }
   ```
2. `proxy_tcp_connected` (Agent → Hub → CLI):
   ```json
   {
     "type": "proxy_tcp_connected",
     "streamId": "tcp-1730000000000-xyz789"
   }
   ```
3. `PROXY_TCP_DATA (0x07)` (Bidirectional CLI ↔ Hub ↔ Agent): Raw TCP bytes for `streamId`.
4. `proxy_tcp_close` (Bidirectional CLI ↔ Hub ↔ Agent): Sent when either side closes the TCP socket or when connection establishment fails.
   ```json
   {
     "type": "proxy_tcp_close",
     "streamId": "tcp-1730000000000-xyz789",
     "error": "connect ECONNREFUSED 127.0.0.1:3000",
     "code": "ECONNREFUSED"
   }
   ```

---

## 3. Component Design

### 3.1 Hub Side: `TerminalProxyBridge` (`src/terminal/services/terminalProxyBridge.ts`)

Manages both HTTP proxy transactions and CLI TCP tunnel multiplexing:
- **`handleHttpProxyRequest(req, res, hostId, targetUrl, timeoutMs)`**:
  - Resolves `canonicalHostId` via `terminalHostManager.resolveCanonicalHostId(hostId)`. Returns `404` if host is unknown or `502` if offline.
  - Sanitizes outbound headers: strips hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `proxy-authorization`, `proxy-connection`), strips Hub credentials (`x-admin-key`, `x-gt-*`), and sets `Host` to match `new URL(targetUrl).host`.
  - Sends `proxy_http_start` over the Agent's WebSocket.
  - Streams `req` data chunks via `PROXY_HTTP_REQ_BODY (0x05)` (if `req` is not already ended; if `req.body` was pre-parsed or buffered, serializes it cleanly, though mounting `/api/proxy` before `express.json()` ensures pure streaming).
  - On `proxy_http_headers`: writes status code and sanitized response headers (`res.writeHead(...)`), marking `res` so `compressionMiddleware` does not double-compress.
  - On `PROXY_HTTP_RES_BODY`: calls `res.write(chunk)` directly.
  - On `proxy_http_end`:
    - If `error` is present and headers were not sent yet, responds with `502 Bad Gateway` JSON `{ error: ..., code: ... }`.
    - If headers were already sent and an error occurs mid-stream, destroys `res`.
    - Otherwise calls `res.end()`.
  - Listens to `req.on('close')`: if response is not complete, removes active request entry and sends `proxy_http_abort` to the Agent.

- **`handleCliConnection(ws, req)` (for `/api/terminal/proxy-ws`)**:
  - Validates target `hostId` from query string (`?hostId=<idOrName>`).
  - Multiplexes multiple `streamId` TCP streams over a single CLI WebSocket connection (so one `gt forward` or `gt proxy` process only needs one WebSocket connection to the Hub).
  - Forwards `proxy_tcp_connect`, `proxy_tcp_close`, and `PROXY_TCP_DATA (0x07)` frames between the CLI WebSocket and the target Agent WebSocket.
  - Cleans up all streams owned by the CLI WebSocket when the CLI disconnects, sending `proxy_tcp_close` to the Agent for each open `streamId`.

- **`handleAgentDisconnected(hostId)`**:
  - Immediately fails all pending HTTP requests for `hostId` with `502 Bad Gateway` (or destroys in-flight streams).
  - Sends `proxy_tcp_close` (`error: "Agent disconnected"`) to all active CLI TCP streams targeting `hostId`.

### 3.2 Hub Side: `proxyRoutes.ts` & `app.ts` Integration

- **Mounting Order in `src/server/app.ts`**:
  Mount `/api/proxy` and `/api/admin/proxy` **before** `app.use(express.json({ limit: '10mb' }))` so that request bodies (`POST`/`PUT`/`PATCH`, multipart uploads, binary streams) remain unconsumed readable streams.
- **Route 1: `ALL /api/proxy/:hostId/port/:port` & `ALL /api/proxy/:hostId/port/:port/*`**
  - Validates `:port` is an integer between `1` and `65535` (returns `400` otherwise).
  - Determines target host from optional header `x-gt-target-host` (defaults to `127.0.0.1`) and optional scheme `x-gt-target-proto` (`http` or `https`, defaults to `http`).
  - Reconstructs path and query string (removing `key`, `x-admin-key`, and `ticket` query params used for Hub auth).
  - Delegates to `terminalProxyBridge.handleHttpProxyRequest`.
- **Route 2: `ALL /api/proxy/:hostId/request`**
  - Extracts target URL from header `x-gt-target-url` or query param `?url=`.
  - Validates that the URL uses `http:` or `https:` protocol (returns `400` otherwise).
  - Delegates to `terminalProxyBridge.handleHttpProxyRequest`.

### 3.3 Agent Side: `ProxyHandler` (`src/agent/handlers/proxyHandler.ts`)

- Maintains `activeHttpRequests: Map<string, http.ClientRequest>` and `activeTcpSockets: Map<string, net.Socket>`.
- Enforces `MAX_CONCURRENT_PROXY_STREAMS = 128` per Agent to protect resource limits.
- Respects option `--no-proxy` or `permissionMode === 'readonly'` (if configured to disallow network proxy, configurable via `--no-proxy` flag; enabled by default).
- **HTTP Execution**:
  - Uses `http.request` or `https.request` (with `rejectUnauthorized: false` optional via header `x-gt-insecure: 1` for self-signed intranet services).
  - Streams response chunks in `<= 32KB` slices via `encodeBinaryPacket(BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, reqId, slice)`.
  - Applies backpressure: if `ws.bufferedAmount > 4 * 1024 * 1024`, pauses upstream response stream until buffered amount drops.
  - Invokes `onHeartbeatActivity()` on every chunk sent or received.
- **TCP Execution**:
  - Uses `net.createConnection({ host, port })`.
  - On `'connect'`, sends `proxy_tcp_connected`.
  - On `'data'`, slices into `<= 32KB` frames and sends `PROXY_TCP_DATA (0x07)`.
  - On `'error'` or `'close'`, sends `proxy_tcp_close` and removes socket from map.
  - On Agent WebSocket disconnect, destroys all active `http.ClientRequest` and `net.Socket` instances immediately.

### 3.4 Client CLI Commands (`src/client/commands/proxy.ts`)

1. **`gt forward <node> <mapping...> [-b, --bind <address>]`**
   - Supports one or more port mappings per invocation:
     - `3000` → `127.0.0.1:3000` -> `127.0.0.1:3000`
     - `8080:3000` → `127.0.0.1:8080` -> `127.0.0.1:3000`
     - `8080:192.168.1.20:80` → `127.0.0.1:8080` -> `192.168.1.20:80`
   - Opens a persistent WebSocket to `/api/terminal/proxy-ws?hostId=<resolvedNodeId>` (with automatic reconnect on transient network drops).
   - Starts local `net.Server` listener(s). Each incoming local TCP connection allocates a `streamId`, sends `proxy_tcp_connect`, buffers initial data until `proxy_tcp_connected`, and then pipes bidirectional `PROXY_TCP_DATA` frames.

2. **`gt proxy <node> [-p, --port <port>] [-b, --bind <address>]`**
   - Default port: `1080`, default bind address: `127.0.0.1`.
   - Starts a local `http.Server`:
     - **Standard HTTP Proxy requests** (`req.url` starts with `http://`): Parses target `hostname`, `port` (default 80), and path; opens a `streamId` via `proxy_tcp_connect` (or forwards via TCP stream), writes reconstructed HTTP request line + headers (stripping `Proxy-Connection`), and pipes the socket bidirectionally.
     - **HTTPS `CONNECT` requests** (`server.on('connect', (req, clientSocket, head) => ...)`): Parses `host:port` from `req.url`, sends `proxy_tcp_connect`, waits for `proxy_tcp_connected`, writes `HTTP/1.1 200 Connection Established\r\n\r\n` to `clientSocket`, flushes `head` if non-empty, and pipes `clientSocket` ↔ `PROXY_TCP_DATA (0x07)`.

---

## 4. Error Handling & Edge Cases

| Scenario | Behavior |
| :--- | :--- |
| Unknown `hostId` on `/api/proxy/:hostId/...` | `404 Not Found` (`{ error: "Host not found" }`) |
| Offline `hostId` on `/api/proxy/:hostId/...` | `502 Bad Gateway` (`{ error: "Agent is offline" }`) |
| Invalid port or non-HTTP(S) URL | `400 Bad Request` (`{ error: "Invalid target port or URL" }`) |
| Target port refuses connection (`ECONNREFUSED`) | `502 Bad Gateway` (`{ error: "Proxy error: connect ECONNREFUSED ...", code: "ECONNREFUSED" }`) |
| Upstream request timeout (`timeoutMs` exceeded) | Agent aborts upstream request and sends `proxy_http_end` with `ETIMEDOUT`; Hub returns `504 Gateway Timeout` if headers not sent |
| Client aborts download mid-stream | Hub detects `req.on('close')` and sends `proxy_http_abort`; Agent destroys upstream socket |
| Agent disconnects mid-stream | Hub destroys all active HTTP responses and notifies all attached CLI proxy WebSockets |

---

## 5. Testing Strategy

Create `tests/proxy.test.ts` covering:
1. **Binary Protocol Encoding/Decoding**: Verify `0x05`, `0x06`, and `0x07` frame roundtrips and ensure they do not trigger terminal output handlers.
2. **Hub Reverse Port Proxy (`/api/proxy/:hostId/port/:port/*`)**:
   - Spin up a local test HTTP server (handling GET query params, POST JSON echo, streaming chunked response, binary payload, custom headers, and 404/500 statuses).
   - Verify end-to-end request/response through Hub → Agent WS → `ProxyHandler` → test HTTP server.
3. **Hub Outbound Request Proxy (`/api/proxy/:hostId/request`)**:
   - Verify forwarding via `x-gt-target-url` header and `?url=` query param.
   - Verify connection error handling (`ECONNREFUSED` returns `502`) and timeout handling (`504`).
4. **TCP Tunnel & CLI (`gt forward` & `gt proxy`)**:
   - Verify raw TCP port forwarding (`createForwardServer`) through `/api/terminal/proxy-ws`.
   - Verify local HTTP proxy server (`createLocalProxyServer`) handling both standard HTTP proxy requests and `CONNECT` tunneling.
   - Verify cleanup on client disconnect and Agent disconnect.
