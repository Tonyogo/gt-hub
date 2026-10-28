# Agent HTTP & TCP Proxy Design Specification (Phase 2: Web UI & Port Discovery)

**Date**: 2026-10-28
**Status**: Approved in Brainstorming
**Scope**: Phase 2 — Agent Listening Port Discovery, Browser Session Cookie Auth for Proxy Routes, and Frontend `TerminalProxyView` Sub-Tab (Port Preview + HTTP Request Debugger)

---

## 1. Purpose & Goals

Build upon the Phase 1 proxy foundation to provide a first-class Web UI experience inside `gt-hub`, allowing users to:
1. Automatically discover active listening TCP ports on any connected Agent node.
2. Preview Agent-hosted local/intranet web services directly inside an embedded `<iframe>` or a new browser tab without sub-resource (`<script>`, `<link>`, `<img>`, `fetch`) `401 Unauthorized` failures.
3. Test arbitrary outbound or internal HTTP/HTTPS requests from the selected Agent node via an interactive HTTP Request Debugger, and copy ready-to-run `gt forward` / `gt proxy` CLI commands.

---

## 2. Backend & Agent Enhancements

### 2.1 Agent Listening Port Discovery (`proxy_list_ports`)

- **Protocol Control Messages**:
  - Hub → Agent:
    ```json
    { "type": "proxy_list_ports", "reqId": "ports-1730000000000-abc123" }
    ```
  - Agent → Hub:
    ```json
    {
      "type": "proxy_list_ports_res",
      "reqId": "ports-1730000000000-abc123",
      "success": true,
      "ports": [
        { "port": 3000, "address": "127.0.0.1", "pid": 12345, "process": "node" },
        { "port": 8080, "address": "0.0.0.0", "pid": 23456, "process": "python3" }
      ]
    }
    ```
- **Agent Port Scanner (`src/agent/handlers/proxyHandler.ts`)**:
  - Exports `scanListeningTcpPorts(): Promise<ListeningPortInfo[]>`.
  - Cross-platform zero-dependency implementation:
    - **Linux**: Runs `ss -tlnp` (fallback to `netstat -tlnp`, and fallback to reading `/proc/net/tcp` + `/proc/net/tcp6` for state `0A`) to extract listening TCP ports, bind addresses (`0.0.0.0`, `127.0.0.1`, `::`, `::1`), PID, and process name.
    - **macOS (`darwin`)**: Runs `lsof -iTCP -sTCP:LISTEN -P -n` to extract process name, PID, address, and port.
    - **Windows (`win32`)**: Runs `netstat -ano -p tcp` and parses `LISTENING` lines.
  - Deduplicates by `port` (preferring entries with process metadata) and sorts ascending by `port`.
- **Hub Bridge & Endpoint**:
  - `terminalProxyBridge.listListeningPorts(hostId: string, timeoutMs?: number): Promise<{ success: boolean; ports?: ListeningPortInfo[]; error?: string }>` in `src/terminal/services/terminalProxyBridge.ts`.
  - `GET /api/proxy/:hostId/ports` in `src/terminal/routes/proxyRoutes.ts`: returns `200 { ports: [...] }`, `404` if unknown host, or `502` if offline/failed.

### 2.2 Browser Proxy Session Cookie (`gt_proxy_session`)

When opening `/api/proxy/:hostId/port/:port/` in an `<iframe>` or new browser tab with `?ticket=<ticket>`, the one-time ticket is consumed on the initial HTML document request. Subsequent sub-resource requests (`style.css`, `app.js`, `favicon.ico`, XHR) sent by the browser will not carry `x-admin-key` or a fresh `ticket`.

- **`proxyAuthMiddleware` (`src/terminal/routes/proxyRoutes.ts`)**:
  - Accepts authentication in the following order:
    1. Valid `x-admin-key` header or query param (`key` / `x-admin-key`).
    2. Valid one-time `?ticket=` query param (consumed via `ticketManager.consumeTicket`).
    3. Valid signed `gt_proxy_session` cookie from `req.headers.cookie`.
  - **Signed Session Token Format**:
    - Payload: `${expiresAtMs}.${nonce}` signed with `crypto.createHmac('sha256', secretKey).update(payload).digest('hex')` (`${expiresAtMs}.${nonce}.${signature}`), verified via timing-safe comparison and expiration check (`TTL = 12 hours`).
  - Whenever a request authenticates via `?ticket=` or query `key`, the middleware sets:
    `Set-Cookie: gt_proxy_session=<signedToken>; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
  - **Cookie Sanitization**: `TerminalProxyBridge` strips `gt_proxy_session` from outbound `Cookie` headers before forwarding to the upstream target so the Hub session token is never leaked to proxied services.

---

## 3. Frontend Design (`TerminalProxyView`)

### 3.1 Top Navigation Bar Integration (`frontend/src/components/UnifiedTerminalView.tsx`)
- Extend `TerminalSubTab`:
  ```ts
  export type TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks' | 'proxy';
  ```
- Add a 5th sub-tab button with `Globe` icon from `lucide-react` labeled `t('proxy.tabName', '网络代理')`.
- When `subTab === 'proxy'`, display a top-bar Refresh button calling `proxyRef.current?.refresh()`.
- Add `zh` and `en` translation keys under `proxy.*` in `frontend/src/i18n/translations.ts`.

### 3.2 `TerminalProxyView` Component (`frontend/src/components/terminal/TerminalProxyView.tsx`)

Exposes `TerminalProxyHandle { refresh: () => void }` via `forwardRef`.
Provides two sub-modes selectable via a segmented toggle at the top of the panel:

#### Mode 1: Port Forward & Web Preview (`port`)
- **Listening Ports Sidebar / Bar**:
  - Fetches `GET /api/proxy/${encodeURIComponent(activeHostId)}/ports` when active or refreshed.
  - Displays discovered ports as interactive chips/cards showing `:port`, `process` (if available), and `address`. Clicking a port populates the target port input and triggers preview.
- **Target Controls**:
  - Protocol selector (`http` / `https`), Target Host input (default `127.0.0.1`), Target Port input (`1-65535`), Subpath input (default `/`).
  - Action buttons:
    - **Preview in Page (`加载预览`)**: Requests a one-time ticket via `POST /api/auth/ticket` (if `adminKey` is active) and sets the `<iframe>` `src` to `/api/proxy/${encodeURIComponent(activeHostId)}/port/${port}${subpath}?ticket=${ticket}` (with optional `host` / `proto` query params supported by `proxyRoutes.ts`).
    - **Open in New Tab (`新窗口打开`)**: Requests a fresh ticket and opens the URL via `window.open(url, '_blank', 'noopener,noreferrer')`.
    - **Copy CLI Command (`复制 gt forward`)**: Copies `gt forward ${activeHostId} ${port}:${targetHost === '127.0.0.1' ? '' : targetHost + ':'}${port}` to clipboard with visual feedback.
- **Query Parameter Support on Port Proxy Route**:
  - Because browser `<iframe src="...">` and `window.open(...)` cannot attach custom `x-gt-target-host` or `x-gt-target-proto` headers, `proxyRoutes.ts` also accepts optional query params `_gt_host` and `_gt_proto` (and strips them before forwarding to the upstream service).

#### Mode 2: HTTP Request Debugger (`request`)
- **Request Builder**:
  - HTTP Method dropdown (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`).
  - Target URL input (e.g., `https://httpbin.org/get` or `http://127.0.0.1:8080/api/health`).
  - Custom Request Headers input (JSON or `Key: Value` lines) & Request Body textarea (shown for non-GET/HEAD methods).
  - Toggle for `Ignore TLS Certificate Errors` (`x-gt-insecure: 1`) and CLI helper button to copy `gt proxy ${activeHostId} -p 1080`.
- **Response Inspector**:
  - Executes request via `apiFetch('/api/proxy/' + encodeURIComponent(activeHostId) + '/request', ...)` with `x-gt-target-url` header, measuring elapsed latency in milliseconds.
  - Displays Status Code badge, elapsed time (`ms`), and response body / response headers tabs (auto-formatting JSON responses).

---

## 4. Testing Strategy

1. **Backend Port Discovery & Session Cookie Tests (`tests/proxyPhase2.test.ts`)**:
   - Verify `scanListeningTcpPorts` detects a live local `net.Server` port.
   - Verify `GET /api/proxy/:hostId/ports` returns the listening ports list from the connected Agent.
   - Verify browser session cookie flow: first request to `/api/proxy/:hostId/port/:port/index.html?ticket=<validTicket>` returns `200` + `Set-Cookie: gt_proxy_session=...`, and a second request to `/api/proxy/:hostId/port/:port/app.js` using only `Cookie: gt_proxy_session=...` (no `ticket` or `x-admin-key`) succeeds with `200` while stripping `gt_proxy_session` from upstream headers.
   - Verify `_gt_host` and `_gt_proto` query parameters on `/api/proxy/:hostId/port/:port/*` work and are stripped from upstream query string.
2. **Frontend Component Tests (`frontend/src/components/terminal/__tests__/TerminalProxyView.test.tsx` or `tests/proxyUi.test.ts`)**:
   - Verify `UnifiedTerminalView` renders the new `proxy` sub-tab and `TerminalProxyView` switches between Port Preview and HTTP Request Debugger modes.
