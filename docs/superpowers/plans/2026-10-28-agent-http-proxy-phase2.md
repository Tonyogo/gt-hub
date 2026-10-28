# Agent HTTP & TCP Proxy (Phase 2: Web UI & Port Discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Agent listening TCP port auto-discovery (`GET /api/proxy/:hostId/ports`), browser proxy session cookie authentication (`gt_proxy_session`) for seamless iframe/tab web previews, and the Frontend `TerminalProxyView` sub-tab (Port Forwarding Preview + HTTP Request Debugger).

**Architecture:** We extend `ProxyHandler` and `TerminalProxyBridge` with `proxy_list_ports` / `proxy_list_ports_res` RPC signaling and cross-platform TCP port scanning. In `proxyRoutes.ts`, we introduce `proxyAuthMiddleware` that issues and validates an HMAC-signed `gt_proxy_session` cookie (stripping it before forwarding upstream) and supports `_gt_host` / `_gt_proto` query parameters. On the frontend, we add `TerminalProxyView.tsx` and wire it as the 5th sub-tab (`proxy`) in `UnifiedTerminalView.tsx`.

**Tech Stack:** TypeScript, Node.js (`crypto`, `child_process`, `fs`), Express, React 18, Tailwind CSS, Lucide React, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-http-proxy-phase2-design.md`

## Global Constraints

- Port scanning (`scanListeningTcpPorts`) MUST use zero external npm dependencies (relying on `/proc/net/tcp*`, `ss`, `lsof`, or `netstat` with graceful fallback to empty array on error).
- Browser session cookie MUST be named `gt_proxy_session` (`HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`), signed with `HMAC-SHA256` using `config.adminSecretKey`.
- `TerminalProxyBridge` MUST strip `gt_proxy_session` from outbound `Cookie` headers (and delete `Cookie` header if empty after stripping) so the Hub session token never leaks to upstream servers.
- `/api/proxy/:hostId/port/:port/*` MUST accept optional `_gt_host` and `_gt_proto` query parameters (falling back to `x-gt-target-host` / `127.0.0.1` and `x-gt-target-proto` / `http`) and strip `_gt_host` and `_gt_proto` from the forwarded upstream query string.
- Always run targeted tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

1. **Outbound `Cookie` header sanitization**: When a browser request carries `Cookie: gt_proxy_session=abc; app_sid=xyz`, upstream must receive `Cookie: app_sid=xyz`. When `Cookie: gt_proxy_session=abc` is the only cookie, the `cookie` header must be removed completely from outbound headers.
2. **Tampered or expired `gt_proxy_session` cookie**: Requests with an invalid HMAC signature or expired timestamp in `gt_proxy_session` (and no valid `x-admin-key` or `ticket`) must be rejected with `401 Unauthorized`.
3. **Agent disconnect while `listListeningPorts` RPC is pending**: `terminalProxyBridge.handleAgentDisconnected(hostId)` must immediately resolve pending port-list promises for `hostId` with `{ success: false, error: 'Agent disconnected' }`.
4. **Port scanner deduplication and IPv4/IPv6 dual-stack**: When a process listens on both `127.0.0.1:3000` and `::1:3000` (or `0.0.0.0` and `::`), `scanListeningTcpPorts()` must deduplicate by `port` and return sorted valid ports (`1..65535`).
5. **Sub-tab state preservation in `UnifiedTerminalView`**: Switching between `interactive`, `files`, `cron`, `tasks`, and `proxy` sub-tabs must keep `TerminalProxyView` mounted (toggled via `flex` / `hidden` class like the other 4 views) so user input and iframe preview state are not lost when switching tabs.

---

### Task 1: Agent Listening Port Scanner & `proxy_list_ports` RPC

**Files:**
- Modify: `src/agent/handlers/proxyHandler.ts`
- Modify: `src/terminal/services/terminalProxyBridge.ts`
- Test: `tests/proxyPhase2.test.ts`

**Interfaces:**
- Consumes: `ProxyHandler` in `src/agent/handlers/proxyHandler.ts`, `TerminalProxyBridge` in `src/terminal/services/terminalProxyBridge.ts`
- Produces:
  - In `src/agent/handlers/proxyHandler.ts`:
    ```ts
    export interface ListeningPortInfo {
      port: number;
      address: string;
      pid?: number;
      process?: string;
    }
    export function scanListeningTcpPorts(): Promise<ListeningPortInfo[]>;
    export function parseProcNetTcp(content: string, isIpv6?: boolean): ListeningPortInfo[];
    ```
    And handles `{ type: 'proxy_list_ports', reqId: string }` in `ProxyHandler.handleControlMessage`, replying with `{ type: 'proxy_list_ports_res', reqId, success: true, ports }`.
  - In `src/terminal/services/terminalProxyBridge.ts`:
    ```ts
    public listListeningPorts(
      hostId: string,
      timeoutMs?: number
    ): Promise<{ success: boolean; status?: number; ports?: ListeningPortInfo[]; error?: string }>;
    ```

- [x] **Step 1: Write the failing test in `tests/proxyPhase2.test.ts`**

Create `tests/proxyPhase2.test.ts` testing:
1. `parseProcNetTcp` accurately parses Linux `/proc/net/tcp` hex lines (state `0A` = LISTEN) into `{ port, address }`.
2. `scanListeningTcpPorts()` detects an active ephemeral `net.createServer()` listening port on the current machine, sorted and deduplicated by port.
3. `ProxyHandler` handles `proxy_list_ports` and emits `proxy_list_ports_res` with discovered ports (or error if `allowProxy: false`).

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyPhase2.test.ts`
Expected: FAIL with `scanListeningTcpPorts is not a function`.

- [x] **Step 3: Implement `scanListeningTcpPorts`, `parseProcNetTcp`, `proxy_list_ports` in `src/agent/handlers/proxyHandler.ts` and `listListeningPorts` in `src/terminal/services/terminalProxyBridge.ts`**

1. In `src/agent/handlers/proxyHandler.ts`:
   - Implement `parseProcNetTcp(content: string, isIpv6 = false): ListeningPortInfo[]` (checking `st === '0A'`).
   - Implement `scanListeningTcpPorts(): Promise<ListeningPortInfo[]>`:
     - On Linux: try `ss -tlnp` (parsing `LISTEN ... addr:port` and `users:(("proc",pid=123,...))`), fallback/merge with `/proc/net/tcp` and `/proc/net/tcp6`.
     - On macOS (`darwin`): run `lsof -iTCP -sTCP:LISTEN -P -n`.
     - On Windows (`win32`): run `netstat -ano -p tcp`.
     - Deduplicate by `port` (preferring entries with `process` name and IPv4 address), sort ascending by `port`.
   - In `ProxyHandler.handleControlMessage`: handle `case 'proxy_list_ports':`, check `allowProxy !== false`, call `scanListeningTcpPorts()`, and send `proxy_list_ports_res`.
2. In `src/terminal/services/terminalProxyBridge.ts`:
   - Add `pendingPortListRpcs = new Map<string, { hostId: string; timer: NodeJS.Timeout; resolve: (res: any) => void }>()`
   - Implement `listListeningPorts(hostId: string, timeoutMs = 10000)`.
   - Handle `control.type === 'proxy_list_ports_res'` in `handleAgentControlMessage`.
   - Clean up `pendingPortListRpcs` for `hostId` inside `handleAgentDisconnected(hostId)`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxyPhase2.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/agent/handlers/proxyHandler.ts src/terminal/services/terminalProxyBridge.ts tests/proxyPhase2.test.ts
git commit -m "feat(proxy): add agent listening TCP port scanner and proxy_list_ports RPC"
```

---

### Task 2: Browser Session Cookie Auth (`gt_proxy_session`), Cookie Stripping & `/api/proxy/:hostId/ports` Route

**Files:**
- Modify: `src/terminal/routes/proxyRoutes.ts`
- Modify: `src/terminal/services/terminalProxyBridge.ts`
- Modify: `tests/proxyPhase2.test.ts`

**Interfaces:**
- Consumes: `terminalProxyBridge.listListeningPorts` from Task 1, `ticketManager` from `src/server/modules/auth/ticketManager.ts`, `config` from `config/default.ts`
- Produces:
  - In `src/terminal/routes/proxyRoutes.ts`:
    - `createProxySessionToken(secretKey: string, ttlMs?: number): string`
    - `verifyProxySessionToken(token: string, secretKey: string): boolean`
    - `proxyAuthMiddleware(req: Request, res: Response, next: NextFunction): void`
    - `GET /api/proxy/:hostId/ports` endpoint
    - `_gt_host` and `_gt_proto` query param support on `/api/proxy/:hostId/port/:port*`
  - In `src/terminal/services/terminalProxyBridge.ts`:
    - `stripProxySessionCookie(cookieHeader: string | string[] | undefined): string | undefined`

- [x] **Step 1: Extend `tests/proxyPhase2.test.ts` with Hub route and session cookie tests**

Add tests in `tests/proxyPhase2.test.ts` verifying:
1. `GET /api/proxy/:hostId/ports` returns `200` with `{ ports: [...] }` containing the local test server's port, `404` for unknown host, and `502` when agent disconnects.
2. Browser session cookie flow:
   - Request 1: `GET /api/proxy/:hostId/port/:port/page?ticket=<oneTimeTicket>` succeeds (`200`), sets `Set-Cookie: gt_proxy_session=...; Path=/; HttpOnly; SameSite=Lax`, and strips `ticket` from upstream query.
   - Request 2: `GET /api/proxy/:hostId/port/:port/asset.js` with `Cookie: gt_proxy_session=<token>; user_pref=dark` (no `x-admin-key` and no `ticket`) succeeds (`200`), and the upstream server receives `Cookie: user_pref=dark` (with `gt_proxy_session` stripped).
   - Request 3: `GET /api/proxy/:hostId/port/:port/asset.js` with tampered or expired `gt_proxy_session` cookie returns `401`.
3. `_gt_host` and `_gt_proto` query parameters on `/api/proxy/:hostId/port/:port/test?_gt_host=127.0.0.1&_gt_proto=http&foo=1` route to `http://127.0.0.1:<port>/test?foo=1` with `_gt_host` and `_gt_proto` stripped.

- [x] **Step 2: Run test to verify the new tests fail**

Run: `npm test -- tests/proxyPhase2.test.ts`
Expected: FAIL on `/api/proxy/:hostId/ports` (404) and cookie authentication (401).

- [x] **Step 3: Implement `proxyAuthMiddleware`, `GET /:hostId/ports`, `_gt_host`/`_gt_proto`, and `stripProxySessionCookie`**

1. In `src/terminal/services/terminalProxyBridge.ts`:
   - Export `stripProxySessionCookie(cookieHeader: string | string[] | undefined): string | undefined` that removes `gt_proxy_session=...` pairs from `Cookie` header and returns `undefined` if no cookies remain.
   - Apply `stripProxySessionCookie` when building `outboundHeaders` in `handleHttpProxyRequest`.
2. In `src/terminal/routes/proxyRoutes.ts`:
   - Implement `createProxySessionToken` and `verifyProxySessionToken` using `crypto.createHmac('sha256', secretKey)` and `safeCompareSecret`.
   - Implement `proxyAuthMiddleware`:
     - If `!secretKey`, call `next()`.
     - Check one-time `?ticket=` (`ticketManager.consumeTicket`) or `x-admin-key` / `key`. If valid and authenticated via `ticket` or query `key`, attach `Set-Cookie: gt_proxy_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`.
     - Otherwise parse `req.headers.cookie` for `gt_proxy_session` and validate with `verifyProxySessionToken`. If valid, call `next()`.
     - Otherwise return `401 { error: 'Unauthorized: Invalid x-admin-key or proxy session' }`.
   - Add `router.get('/:hostId/ports', async (req, res) => ...)` calling `terminalProxyBridge.listListeningPorts(hostId)`.
   - In `router.all(['/:hostId/port/:port', '/:hostId/port/:port/*'])`: read `_gt_host` and `_gt_proto` from `searchParams` before deleting `key`, `x-admin-key`, `ticket`, `_gt_host`, `_gt_proto`. Validate `targetProto` is `'http'` or `'https'`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/proxyPhase2.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/terminal/routes/proxyRoutes.ts src/terminal/services/terminalProxyBridge.ts tests/proxyPhase2.test.ts
git commit -m "feat(server): add /api/proxy/:hostId/ports endpoint and gt_proxy_session cookie auth"
```

---

### Task 3: Frontend `TerminalProxyView` & `UnifiedTerminalView` Integration

**Files:**
- Create: `frontend/src/components/terminal/TerminalProxyView.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `frontend/src/i18n/translations.ts`
- Test: `tests/proxyUi.test.ts`

**Interfaces:**
- Consumes: `GET /api/proxy/:hostId/ports`, `ALL /api/proxy/:hostId/port/:port/*`, `ALL /api/proxy/:hostId/request`, `POST /api/auth/ticket`
- Produces:
  - `TerminalProxyView` component and `TerminalProxyHandle` (`{ refresh: () => void }`) in `frontend/src/components/terminal/TerminalProxyView.tsx`.
  - Updated `TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks' | 'proxy'` in `frontend/src/components/UnifiedTerminalView.tsx`.

- [x] **Step 1: Write the failing test in `tests/proxyUi.test.ts`**

Create `tests/proxyUi.test.ts` verifying:
1. `UnifiedTerminalView.tsx` includes `'proxy'` in `TerminalSubTab`, renders the `proxy` sub-tab button (`data-testid="subtab-proxy"`), and mounts `TerminalProxyView`.
2. `TerminalProxyView.tsx` implements both `port` (Port Forward & Preview) and `request` (HTTP Request Debugger) modes, calls `/api/proxy/:hostId/ports` for port discovery, calls `/api/auth/ticket` when opening/previewing a proxied port, and sends `/api/proxy/:hostId/request` with `x-gt-target-url` in the HTTP Request Debugger.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/proxyUi.test.ts`
Expected: FAIL with `TerminalProxyView.tsx` not found.

- [x] **Step 3: Implement `TerminalProxyView.tsx`, update `UnifiedTerminalView.tsx` and `translations.ts`**

1. In `frontend/src/i18n/translations.ts`, add `proxy` keys for both `zh` and `en` (`tabName`, `portMode`, `requestMode`, `listeningPorts`, `noListeningPorts`, `preview`, `openNewTab`, `copyCliForward`, `copyCliProxy`, `sendRequest`, `responseHeaders`, `responseBody`, etc.).
2. Create `frontend/src/components/terminal/TerminalProxyView.tsx`:
   - Handle empty/unselected host state using `TerminalEmptyState` (matching `TerminalTaskView.tsx` and `TerminalCronView.tsx`).
   - **Mode 1 (`port`)**:
     - Auto-fetch listening ports from `/api/proxy/${encodeURIComponent(activeHostId)}/ports` when `isActive && activeHostId` changes or `refresh()` is called.
     - Render clickable port badges (`:port` + process name + address).
     - Provide inputs for Protocol (`http`/`https`), Target Host (`127.0.0.1`), Port (`3000`), and Subpath (`/`).
     - Provide buttons:
       - `加载预览 / Preview` (`data-testid="proxy-load-preview-btn"`): fetches ticket via `POST /api/auth/ticket` (falling back to no ticket if auth disabled) and sets iframe `src`.
       - `新窗口打开 / Open in New Tab` (`data-testid="proxy-open-tab-btn"`): fetches ticket and calls `window.open(...)`.
       - `复制 gt forward / Copy CLI` (`data-testid="proxy-copy-forward-btn"`): copies `gt forward <hostId> <port>:<port>` (or `<port>:<host>:<port>`).
     - Render embedded `<iframe data-testid="proxy-preview-iframe" ... />` when preview URL is active.
   - **Mode 2 (`request`)**:
     - Method selector (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`), Target URL input (`data-testid="proxy-request-url-input"`), custom headers textarea (`Key: Value` or JSON), request body textarea, `insecure` checkbox (`x-gt-insecure: 1`), and `Send` button (`data-testid="proxy-send-request-btn"`).
     - Send request to `/api/proxy/${encodeURIComponent(activeHostId)}/request` with `x-gt-target-url` header, measure latency (`ms`), and render status code badge, elapsed time, formatted response body, and response headers.
3. In `frontend/src/components/UnifiedTerminalView.tsx`:
   - Import `Globe` from `lucide-react` and `TerminalProxyView, { TerminalProxyHandle }` from `./terminal/TerminalProxyView`.
   - Update `export type TerminalSubTab = 'interactive' | 'files' | 'cron' | 'tasks' | 'proxy';`.
   - Add `proxyRef = useRef<TerminalProxyHandle>(null)`.
   - Add the `proxy` sub-tab button (`data-testid="subtab-proxy"`), top-bar refresh button when `subTab === 'proxy'`, and the `<div className={\`flex-1 min-h-0 \${subTab === 'proxy' ? 'flex' : 'hidden'} flex-col\`}>` panel mounting `<TerminalProxyView ref={proxyRef} ... />`.

- [x] **Step 4: Run test and full build to verify everything passes**

Run: `npm run build && npm test -- tests/proxyHandler.test.ts tests/proxyHub.test.ts tests/proxyCli.test.ts tests/proxyPhase2.test.ts tests/proxyUi.test.ts`
Expected: Full frontend + backend + CLI build succeeds, and all 5 proxy test suites PASS.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalProxyView.tsx frontend/src/components/UnifiedTerminalView.tsx frontend/src/i18n/translations.ts tests/proxyUi.test.ts
git commit -m "feat(frontend): add TerminalProxyView sub-tab with port preview and HTTP debugger"
```
