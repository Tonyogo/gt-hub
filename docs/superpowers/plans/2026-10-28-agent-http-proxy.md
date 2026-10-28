# Agent HTTP & TCP Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `gt` Agents to act as reverse HTTP/TCP gateways (local/intranet service exposure) and outbound HTTP/HTTPS/TCP proxies via Hub routes (`/api/proxy/...`), a multiplexed TCP tunnel WebSocket (`/api/terminal/proxy-ws`), and CLI commands (`gt forward` & `gt proxy`).

**Architecture:** We extend the binary packet protocol (`0x05`, `0x06`, `0x07`) and `JSON:` control messages over the existing `/api/terminal/agent-ws` tunnel. On the Agent side, `ProxyHandler` executes streaming HTTP/HTTPS requests (`http`/`https`) and raw TCP connections (`net`). On the Hub side, `TerminalProxyBridge` bridges Express HTTP requests (`/api/proxy/:hostId/...`) and CLI WebSocket TCP streams (`/api/terminal/proxy-ws`) to the target Agent's WebSocket.

**Tech Stack:** TypeScript, Node.js (`http`, `https`, `net`, `url`), Express, `ws`, Commander.js, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-http-proxy-design.md`

## Global Constraints

- Binary frame types MUST be `PROXY_HTTP_REQ_BODY = 0x05`, `PROXY_HTTP_RES_BODY = 0x06`, and `PROXY_TCP_DATA = 0x07` in `src/shared/protocol/binaryProtocol.ts`.
- Proxy binary frames (`0x05`, `0x06`, `0x07`) MUST be intercepted in both `src/terminal/routes/terminalWs.ts` and `src/agent/daemon.ts` so they never fall through to `hostMgr.handleAgentData` or the agent's PTY input.
- Streaming payload chunks MUST be sliced to at most `32 * 1024` bytes (32KB) per binary frame.
- `/api/proxy` and `/api/admin/proxy` MUST be mounted in `src/server/app.ts` BEFORE `app.use(express.json({ limit: '10mb' }))` to preserve unconsumed request streams.
- Outbound proxy requests from Hub MUST strip hop-by-hop headers and Hub auth credentials (`x-admin-key`, `x-gt-*` control headers, and `key` / `x-admin-key` / `ticket` query params on port-proxy URLs).
- Max concurrent proxy streams per Agent is `128` (`MAX_CONCURRENT_PROXY_STREAMS = 128`).
- Always run targeted tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

1. **Multi-value response headers (`Set-Cookie`) and upstream compression (`Content-Encoding: gzip`)**: `ProxyHandler` and `TerminalProxyBridge` must preserve `string | string[]` header values (especially `set-cookie`) and avoid double-compressing responses in `compressionMiddleware`.
2. **Binary frame leakage into PTY**: When an HTTP request or TCP stream is aborted right as binary chunks (`0x05`, `0x06`, `0x07`) arrive, unknown `reqId`/`streamId` frames must be silently dropped rather than forwarded to the terminal PTY.
3. **Express `req` premature client disconnect (`req.on('close')`)**: If an HTTP caller aborts mid-upload or mid-download, `TerminalProxyBridge` must emit `proxy_http_abort` to the Agent, and `ProxyHandler` must immediately destroy the upstream `http.ClientRequest`.
4. **Early client TCP data before `proxy_tcp_connected`**: When a local socket connects to `gt forward` or sends HTTP data through `gt proxy`, data received before Agent's `proxy_tcp_connected` arrives must be buffered in order and flushed once connected.
5. **Agent disconnect while HTTP / TCP streams are in flight**: `terminalProxyBridge.handleAgentDisconnected(hostId)` must return `502 Bad Gateway` for pending HTTP requests (or destroy partial responses) and send `proxy_tcp_close` to all active CLI TCP streams for that host.

---

### Task 1: Binary Protocol Extensions & Agent `ProxyHandler`

**Files:**
- Modify: `src/shared/protocol/binaryProtocol.ts`
- Create: `src/agent/handlers/proxyHandler.ts`
- Modify: `src/agent/index.ts`
- Test: `tests/proxyHandler.test.ts`

**Interfaces:**
- Consumes: `encodeBinaryPacket`, `decodeBinaryPacket` from `src/shared/protocol/binaryProtocol.ts`
- Produces:
  - `BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY` (`0x05`), `BIN_MSG_TYPE.PROXY_HTTP_RES_BODY` (`0x06`), `BIN_MSG_TYPE.PROXY_TCP_DATA` (`0x07`) in `src/shared/protocol/binaryProtocol.ts`
  - `ProxyHandler` class in `src/agent/handlers/proxyHandler.ts`:
    ```ts
    export interface ProxyHandlerOptions {
      send: (data: string | Buffer) => void;
      getBufferedAmount?: () => number;
      onActivity?: () => void;
      allowProxy?: boolean;
      maxConcurrentStreams?: number;
    }
    export class ProxyHandler {
      constructor(options: ProxyHandlerOptions);
      public handleControlMessage(msg: any): boolean;
      public handleBinaryFrame(decoded: DecodedBinaryPacket): boolean;
      public destroyAll(): void;
      public getActiveCount(): { httpCount: number; tcpCount: number };
    }
    ```

- [x] **Step 1: Write the failing test in `tests/proxyHandler.test.ts`**

Create `tests/proxyHandler.test.ts` testing:
1. `BIN_MSG_TYPE` has `PROXY_HTTP_REQ_BODY = 0x05`, `PROXY_HTTP_RES_BODY = 0x06`, `PROXY_TCP_DATA = 0x07`.
2. `ProxyHandler` executes `proxy_http_start` (GET and streaming POST with `0x05` chunks + `proxy_http_req_end`) against a local `http.createServer`, emitting `proxy_http_headers` (preserving multi-value `set-cookie`), `0x06` response chunks sliced `<= 32768` bytes, and `proxy_http_end`.
3. `ProxyHandler` handles `proxy_http_abort` by destroying the in-flight upstream request, and ignores trailing `0x05` chunks for unknown `reqId` (returning `true` from `handleBinaryFrame` so they don't leak to PTY).
4. `ProxyHandler` handles `proxy_tcp_connect`, `0x07` (`PROXY_TCP_DATA`), and `proxy_tcp_close` against a local `net.createServer` echo server, plus connection errors (`ECONNREFUSED`).
5. `ProxyHandler` rejects requests when `allowProxy: false` or `maxConcurrentStreams` is exceeded.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyHandler.test.ts`
Expected: FAIL with module `../src/agent/handlers/proxyHandler` not found.

- [x] **Step 3: Extend `BIN_MSG_TYPE` in `src/shared/protocol/binaryProtocol.ts` and implement `ProxyHandler` in `src/agent/handlers/proxyHandler.ts`**

1. In `src/shared/protocol/binaryProtocol.ts`, add:
   ```ts
   PROXY_HTTP_REQ_BODY: 0x05,
   PROXY_HTTP_RES_BODY: 0x06,
   PROXY_TCP_DATA: 0x07,
   ```
2. In `src/agent/handlers/proxyHandler.ts`, implement `ProxyHandler`:
   - `MAX_CHUNK_BYTES = 32 * 1024`, `DEFAULT_MAX_CONCURRENT = 128`.
   - `handleControlMessage(msg)`: handles `proxy_http_start`, `proxy_http_req_end`, `proxy_http_abort`, `proxy_tcp_connect`, `proxy_tcp_close`. Returns `true` if handled, `false` otherwise.
   - `handleBinaryFrame(decoded)`: handles `BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY` (`0x05`) and `BIN_MSG_TYPE.PROXY_TCP_DATA` (`0x07`). Always returns `true` for `0x05`, `0x06`, `0x07` even if `id` is no longer active so unknown proxy frames never leak to PTY.
   - For HTTP requests: use `http.request` or `https.request` (supporting `rejectUnauthorized: false` if `msg.insecure === true`). Set timeout via `req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' })))`.
   - Export `ProxyHandler` from `src/agent/index.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxyHandler.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/shared/protocol/binaryProtocol.ts src/agent/handlers/proxyHandler.ts src/agent/index.ts tests/proxyHandler.test.ts
git commit -m "feat(agent): add proxy binary frame types and agent ProxyHandler"
```

---

### Task 2: Wire `ProxyHandler` into Agent Daemon (`src/agent/daemon.ts`)

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `src/client/index.ts`

**Interfaces:**
- Consumes: `ProxyHandler` from `src/agent/handlers/proxyHandler.ts`, `BIN_MSG_TYPE` from `src/shared/protocol/binaryProtocol.ts`
- Produces: Agent WebSocket lifecycle integration for `ProxyHandler` and `--no-proxy` option support.

- [x] **Step 1: Add `--no-proxy` option and wire `ProxyHandler` in `src/agent/daemon.ts` and `src/client/index.ts`**

1. In `src/agent/daemon.ts`:
   - Parse `--no-proxy` (`options.noProxy = true`).
   - Instantiate `proxyHandler: ProxyHandler | null = null` inside `ws.on('open')` (cleaning up any previous instance with `proxyHandler?.destroyAll()` on reconnect/close/exit):
     ```ts
     proxyHandler = new ProxyHandler({
       send: (payload: string | Buffer) => {
         if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
           ws.send(payload);
         }
       },
       getBufferedAmount: () => (ws && typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0),
       onActivity: onHeartbeatActivity,
       allowProxy: !options.noProxy,
     });
     ```
   - In `ws.on('message', (data: any, isBinary?: boolean) => ...)`:
     - Update binary detection check:
       ```ts
       if (
         isBinary ||
         (Buffer.isBuffer(data) &&
           data.length > 0 &&
           (data[0] === BIN_MSG_TYPE.STREAM_INPUT ||
             data[0] === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY ||
             data[0] === BIN_MSG_TYPE.PROXY_TCP_DATA))
       ) {
         const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
         const decoded = decodeBinaryPacket(buf);
         if (decoded) {
           if (decoded.msgType === BIN_MSG_TYPE.STREAM_INPUT) {
             if (streamSessionManager) {
               streamSessionManager.writeRawInput(decoded.id, decoded.payload);
             }
             return;
           }
           if (proxyHandler && proxyHandler.handleBinaryFrame(decoded)) {
             return;
           }
         }
       }
       ```
     - In `if (control)` block:
       ```ts
       if (proxyHandler && proxyHandler.handleControlMessage(control)) {
         return;
       }
       ```
   - On `ws.on('close')`, `ws.on('error')`, and `cleanupAndExit`: call `if (proxyHandler) { proxyHandler.destroyAll(); }`.
2. In `src/client/index.ts`: add `.option('--no-proxy', 'Disable HTTP/TCP proxy capabilities on this agent')` to `agent start` and `agent restart`, forwarding `--no-proxy` to `runAgent`.

- [x] **Step 2: Run existing agent and protocol tests to verify no regressions**

Run: `npm test -- tests/proxyHandler.test.ts`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add src/agent/daemon.ts src/client/index.ts
git commit -m "feat(agent): wire ProxyHandler into agent daemon WebSocket loop"
```

---

### Task 3: Hub `TerminalProxyBridge`, `/api/proxy` Routes & WebSocket Multiplexing

**Files:**
- Create: `src/terminal/services/terminalProxyBridge.ts`
- Create: `src/terminal/routes/proxyRoutes.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Modify: `src/server/app.ts`
- Test: `tests/proxyHub.test.ts`

**Interfaces:**
- Consumes: `terminalHostManager` from `src/terminal/services/terminalHostManager.ts`, `BIN_MSG_TYPE`, `encodeBinaryPacket`, `decodeBinaryPacket` from `src/shared/protocol/binaryProtocol.ts`, `adminAuthMiddleware` from `src/server/middlewares/adminAuth.ts`
- Produces:
  - `TerminalProxyBridge` and singleton `terminalProxyBridge` in `src/terminal/services/terminalProxyBridge.ts`:
    ```ts
    export interface HttpProxyRequestOptions {
      hostId: string;
      targetUrl: string;
      timeoutMs?: number;
      insecure?: boolean;
    }
    export class TerminalProxyBridge {
      public handleHttpProxyRequest(req: Request, res: Response, options: HttpProxyRequestOptions): void;
      public handleAgentControlMessage(hostId: string, control: any): boolean;
      public handleAgentBinaryFrame(hostId: string, decoded: DecodedBinaryPacket): boolean;
      public handleCliConnection(ws: any, req: http.IncomingMessage): void;
      public handleAgentDisconnected(hostId: string): void;
    }
    export const terminalProxyBridge: TerminalProxyBridge;
    ```
  - Express router `proxyRoutes` in `src/terminal/routes/proxyRoutes.ts`:
    - `ALL /:hostId/port/:port` and `ALL /:hostId/port/:port/*`
    - `ALL /:hostId/request`
  - WebSocket upgrade support for `/api/terminal/proxy-ws` and `/api/admin/terminal/proxy-ws` in `src/terminal/routes/terminalWs.ts`.

- [x] **Step 1: Write the failing test in `tests/proxyHub.test.ts`**

Create `tests/proxyHub.test.ts` spinning up the Hub server (`app` + `setupTerminalWebSocket`), connecting a simulated Agent WebSocket running `ProxyHandler`, and spinning up a local target HTTP/TCP server:
1. `GET /api/proxy/:hostId/port/:port/hello?foo=bar&key=secret` forwards `GET /hello?foo=bar` (stripping `key` and `x-admin-key`) to `127.0.0.1:<port>`, returning status, headers (including multi-value `set-cookie`), and body.
2. `POST /api/proxy/:hostId/port/:port/echo` streams large JSON and binary buffers (>100KB) without being consumed/corrupted by `express.json()` or double-compressed by `compressionMiddleware`.
3. `ALL /api/proxy/:hostId/request` forwards to arbitrary URL specified via `x-gt-target-url` header or `?url=` query param; returns `400` on invalid URL/protocol, `404` on unknown host, `502` on offline host or `ECONNREFUSED`, and `504` on upstream `ETIMEDOUT`.
4. Client aborting an in-flight HTTP request triggers `proxy_http_abort` on the Agent and cleans up `terminalProxyBridge` state.
5. Connecting to `/api/terminal/proxy-ws?hostId=<id>` tunnels `proxy_tcp_connect`, `PROXY_TCP_DATA (0x07)`, and `proxy_tcp_close` end-to-end, and notifies the CLI with `proxy_tcp_close` when the Agent disconnects.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyHub.test.ts`
Expected: FAIL with module `../src/terminal/services/terminalProxyBridge` not found.

- [x] **Step 3: Implement `TerminalProxyBridge`, `proxyRoutes`, `terminalWs.ts` integration, and `app.ts` mounting**

1. Create `src/terminal/services/terminalProxyBridge.ts`:
   - Implement `handleHttpProxyRequest`:
     - Resolve canonical host ID via `terminalHostManager.resolveCanonicalHostId(options.hostId)`. If not found -> `404 { error: ... }`. If offline or no active WS -> `502 { error: ... }`.
     - Strip hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-authorization`, `proxy-connection`) and Hub headers (`x-admin-key`, `x-gt-*`). Set `headers.host = parsedTargetUrl.host`.
     - Send `proxy_http_start` with `bodyEnd: isBodyless`. If not bodyless, stream `req` data chunks as `BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY` (`<= 32KB` slices) and `proxy_http_req_end` on `req.on('end')`.
     - On `proxy_http_headers`: strip hop-by-hop response headers, set headers on `res` (supporting array values like `set-cookie`), set `res.statusCode = statusCode`, and call `res.flushHeaders()` (or write head on first chunk/end).
     - On `PROXY_HTTP_RES_BODY`: write chunk with `res.write(chunk)`.
     - On `proxy_http_end`: if `error` and `!res.headersSent`, return `504` when `code === 'ETIMEDOUT'`, `403` when `code === 'EACCES'`, else `502`, with `{ error, code }`. If `error` and `res.headersSent`, call `res.destroy()`. Otherwise `res.end()`.
   - Implement `handleCliConnection` for `/api/terminal/proxy-ws`:
     - Map `streamId` -> `{ streamId, hostId: canonicalHostId, cliWs }`.
     - Forward `proxy_tcp_connect`, `proxy_tcp_close`, and `PROXY_TCP_DATA (0x07)` between `cliWs` and the Agent's session/WebSocket.
2. Create `src/terminal/routes/proxyRoutes.ts`:
   - Apply `adminAuthMiddleware`.
   - `router.all('/:hostId/port/:port*', ...)` (covering both `/:hostId/port/:port` and `/:hostId/port/:port/*`): validate port `1..65535`, read optional `x-gt-target-host` (default `'127.0.0.1'`), `x-gt-target-proto` (`'http'` or `'https'`, default `'http'`), `x-gt-timeout`, `x-gt-insecure`, strip `key`, `x-admin-key`, `ticket` from query string, build target URL, and invoke `terminalProxyBridge.handleHttpProxyRequest`.
   - `router.all('/:hostId/request', ...)`: extract URL from `req.headers['x-gt-target-url']` or `req.query.url`, validate `http:` or `https:`, and invoke `terminalProxyBridge.handleHttpProxyRequest`.
3. Modify `src/terminal/routes/terminalWs.ts`:
   - Add `proxyWss` for `/api/terminal/proxy-ws` and `/api/admin/terminal/proxy-ws`, delegating connection to `terminalProxyBridge.handleCliConnection(ws, req)` and closing `proxyWss` on server shutdown.
   - In `agentWss.on('message')`:
     - For binary messages: if `decoded && (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY || decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA || decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY)`, call `terminalProxyBridge.handleAgentBinaryFrame(hostId, decoded)` and `return`.
     - For `JSON:` control messages: if `terminalProxyBridge.handleAgentControlMessage(hostId, control)` returns `true`, `return`.
   - In `agentWss` `close` and `error` handlers: call `terminalProxyBridge.handleAgentDisconnected(hostId)`.
4. Modify `src/server/app.ts`:
   - Import `proxyRoutes` from `../terminal/routes/proxyRoutes` and mount `app.use('/api/proxy', proxyRoutes)` and `app.use('/api/admin/proxy', proxyRoutes)` **before** `app.use(express.json({ limit: '10mb' }))`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxyHub.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/terminal/services/terminalProxyBridge.ts src/terminal/routes/proxyRoutes.ts src/terminal/routes/terminalWs.ts src/server/app.ts tests/proxyHub.test.ts
git commit -m "feat(server): add TerminalProxyBridge, /api/proxy routes, and /api/terminal/proxy-ws"
```

---

### Task 4: Client CLI `gt forward` and `gt proxy` Commands

**Files:**
- Create: `src/client/commands/proxy.ts`
- Modify: `src/client/index.ts`
- Test: `tests/proxyCli.test.ts`

**Interfaces:**
- Consumes: `resolveHost`, `resolveWebSocketUrl` from `src/client/utils/terminalUI.ts`, `BIN_MSG_TYPE`, `encodeBinaryPacket`, `decodeBinaryPacket` from `src/shared/protocol/binaryProtocol.ts`
- Produces:
  - In `src/client/commands/proxy.ts`:
    ```ts
    export interface PortForwardSpec {
      bindAddress: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
    }
    export function parseForwardMapping(spec: string, defaultBindAddress?: string): PortForwardSpec;
    export function resolveProxyWebSocketUrl(serverUrl: string, hostId: string): string;
    export class CliTcpTunnelClient {
      constructor(options: { serverUrl: string; apiKey: string; hostId: string });
      public connect(): Promise<void>;
      public openStream(
        remoteHost: string,
        remotePort: number,
        onData: (chunk: Buffer) => void,
        onClose: (error?: string) => void
      ): { streamId: string; write: (chunk: Buffer) => void; close: () => void };
      public close(): void;
    }
    export async function startPortForwardListeners(
      tunnel: CliTcpTunnelClient,
      mappings: PortForwardSpec[]
    ): Promise<{ servers: net.Server[]; closeAll: () => Promise<void> }>;
    export async function startLocalHttpProxyServer(
      tunnel: CliTcpTunnelClient,
      options: { bindAddress?: string; port: number }
    ): Promise<{ server: http.Server; port: number; close: () => Promise<void> }>;
    export async function handleForwardCommand(options: {
      server: string;
      key: string;
      node: string;
      mappings: string[];
      bind?: string;
    }): Promise<void>;
    export async function handleProxyCommand(options: {
      server: string;
      key: string;
      node: string;
      port?: number;
      bind?: string;
    }): Promise<void>;
    ```
  - CLI subcommands `gt forward <node> <mappings...>` and `gt proxy <node>` in `src/client/index.ts`.

- [x] **Step 1: Write the failing test in `tests/proxyCli.test.ts`**

Create `tests/proxyCli.test.ts` testing:
1. `parseForwardMapping` parses `"3000"`, `"8080:3000"`, `"8080:192.168.1.10:80"`, and `"0.0.0.0:8080:127.0.0.1:3000"`, and throws on invalid ports.
2. `startPortForwardListeners` forwards TCP connections from a local port through `CliTcpTunnelClient` -> Hub `/api/terminal/proxy-ws` -> Agent `ProxyHandler` -> target server, including buffering early client bytes sent immediately upon `net.connect` before `proxy_tcp_connected` arrives.
3. `startLocalHttpProxyServer` handles:
   - Standard HTTP proxy requests (`GET http://127.0.0.1:<targetPort>/test` and `POST http://127.0.0.1:<targetPort>/echo` via proxy port).
   - HTTPS/TCP `CONNECT 127.0.0.1:<targetPort>` tunneling, returning `200 Connection Established` and piping bidirectional data cleanly.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyCli.test.ts`
Expected: FAIL with module `../src/client/commands/proxy` not found.

- [x] **Step 3: Implement `src/client/commands/proxy.ts` and register commands in `src/client/index.ts`**

1. In `src/client/commands/proxy.ts`:
   - Implement `parseForwardMapping(spec, defaultBind = '127.0.0.1')`.
   - Implement `CliTcpTunnelClient`: connects to `/api/terminal/proxy-ws?hostId=<hostId>` with `x-admin-key` header. When `openStream(remoteHost, remotePort, onData, onClose)` is called:
     - Generates `streamId = tcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.
     - Sends `JSON:${JSON.stringify({ type: 'proxy_tcp_connect', streamId, host: remoteHost, port: remotePort })}`.
     - Buffers any `write(chunk)` calls in `pendingWrites: Buffer[]` until `proxy_tcp_connected` arrives for `streamId`, then flushes them as `PROXY_TCP_DATA (0x07)` frames (`<= 32KB` slices).
   - Implement `startPortForwardListeners`: creates a `net.Server` per mapping, pipes incoming `socket` to `tunnel.openStream(m.remoteHost, m.remotePort, ...)`.
   - Implement `startLocalHttpProxyServer`: creates an `http.Server`:
     - Regular HTTP requests: parses target `url = new URL(req.url!)`, opens stream to `url.hostname` and `Number(url.port) || 80`, reconstructs relative request line (`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}\r\n...`) stripping `proxy-connection` and `proxy-authorization`, writes headers + streams `req` chunks to the tunnel, and writes incoming tunnel bytes directly to `req.socket`.
     - `server.on('connect', (req, clientSocket, head) => ...)`: parses `host:port` from `req.url`, opens tunnel stream, and once `proxy_tcp_connected` arrives (via an `onConnected` callback on `openStream`), writes `HTTP/1.1 200 Connection Established\r\n\r\n` to `clientSocket`, flushes `head` if non-empty, and pipes `clientSocket` ↔ tunnel stream.
   - Implement `handleForwardCommand` and `handleProxyCommand` (resolving host via `resolveHost`, starting tunnel + server, and waiting on `SIGINT`/`SIGTERM` for graceful shutdown).
2. In `src/client/index.ts`:
   - Export proxy functions and register:
     - `gt forward <node> <mappings...>` with `-b, --bind <address>`, `-s, --server`, `-k, --key`, `-c, --context`.
     - `gt proxy <node>` with `-p, --port <port>` (default `1080`), `-b, --bind <address>` (default `127.0.0.1`), `-s, --server`, `-k, --key`, `-c, --context`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxyCli.test.ts`
Expected: PASS

- [x] **Step 5: Run full build and all proxy test suites**

Run: `npm run build && npm test -- tests/proxyHandler.test.ts tests/proxyHub.test.ts tests/proxyCli.test.ts`
Expected: Build succeeds and all 3 test suites PASS with 0 open handles.

- [x] **Step 6: Commit**

```bash
git add src/client/commands/proxy.ts src/client/index.ts tests/proxyCli.test.ts
git commit -m "feat(cli): add gt forward and gt proxy commands"
```
