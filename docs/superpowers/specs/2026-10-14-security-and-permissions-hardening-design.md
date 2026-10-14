# Design Spec: Security and Permissions Hardening

- **Date:** 2026-10-14
- **Status:** Draft / Review
- **Authors:** AI Assistant, yatao
- **Category:** Architecture / Security

---

## 1. Background & Problem Statement

In the current `gt-hub` codebase, security analysis revealed three major vulnerabilities and permission concerns:

1. **Unconditional Bypass on Empty Secret Key in Production:**
   - In `src/shared/utils/security.ts`, `safeCompareSecret` treats an empty `expected` secret as "authentication disabled" and unconditionally returns `true`. If `GT_KEY` is accidentally omitted in production deployments, all WebTerminal sessions, remote command executions, and file operations become completely unauthenticated.
2. **Secret Key Leakage via URL Query Parameters:**
   - Browser WebSockets (`new WebSocket()`) and SSE log streams (`new EventSource()`) currently pass `x-admin-key` via query parameters (e.g. `?x-admin-key=...`). These query strings are logged in plaintext by reverse proxies (Nginx), CDNs, browser histories, and developer tool network monitors.
3. **Unrestricted Agent Execution & File System Access:**
   - The Agent daemon executes RPC file commands and shell tasks with the full privileges of its running OS user. It lacks path boundary controls or protection for sensitive system credentials (such as SSH keys, `/etc/shadow`, or agent configurations).

---

## 2. Design Goals & Non-Goals

### Goals
- **Fail-safe Production Startup:** Prevent accidental unauthenticated exposure in production while preserving seamless zero-config local development.
- **Zero Long-Lived Credentials in URLs:** Eliminate long-lived secrets from query parameters for WebSockets, SSE streams, and file downloads.
- **Agent Permission Modes:** Provide configurable execution boundaries using `--permission-mode <default | bypass>`, offering sensible sensitive-path protection by default while preserving full-access escape hatches for maintenance.
- **Strict Backward Compatibility:** Ensure existing `gt` CLI binaries, non-browser clients, and current deployments can transition smoothly without sudden breakage.

### Non-Goals
- Replacing OS-level user permission isolation (e.g., running Agent in chroot/Docker by default).
- Implementing multi-tenant role-based access control (RBAC).

---

## 3. Detailed Architecture & Implementation

### 3.1 Server-Side Secret Lifecycle Validation & Ticket Manager

#### 3.1.1 Production Secret Check (`src/server/index.ts` / `src/server/config/default.ts`)
Before the HTTP/WebSocket server listens on `config.port`, validate the security configuration:
- If `process.env.NODE_ENV === 'production'` and `config.adminSecretKey` is empty or whitespace:
  - If `process.env.GT_ALLOW_INSECURE_NO_AUTH === 'true'`:
    - Log a prominent security warning: `[Security] WARNING: Running in production without GT_KEY! Explicitly allowed via GT_ALLOW_INSECURE_NO_AUTH=true.`
    - Allow server bootstrap to proceed.
  - Otherwise:
    - Log a critical error message detailing that `GT_KEY` is required in production mode or `GT_ALLOW_INSECURE_NO_AUTH=true` must be explicitly specified.
    - Terminate startup immediately with `process.exit(1)`.
- In non-production environments (`development`, `test`), maintain zero-config convenience with an informational log if no key is configured.

#### 3.1.2 Short-Lived One-Time Ticket Manager (`src/server/modules/auth/ticketManager.ts`)
To allow browser WebSockets and SSE connections to authenticate without exposing the long-lived admin key in URLs, introduce an in-memory ticket manager:
- **Generation:** Generate high-entropy 48-character hex strings via `crypto.randomBytes(24).toString('hex')`.
- **Storage:** In-memory `Map<string, { createdAt: number; expiresAt: number; hostId?: string }>`.
- **TTL & Invalidation:**
  - Default TTL: 30 seconds (`30000ms`).
  - Single-use consumption: `consumeTicket(ticket: string): boolean`. Once validated, the ticket is immediately deleted from memory.
  - Automatic cleanup: Periodic sweep every 60 seconds to purge expired entries.
- **API Endpoint:**
  - `POST /api/auth/ticket`
  - Protected by existing `adminAuthMiddleware` (requires valid `x-admin-key` header).
  - Response: `{ success: true, ticket: string, expiresIn: number }`.

#### 3.1.3 WebSocket & SSE Handshake Authentication Refactor
Update `src/terminal/routes/terminalWs.ts` and `src/terminal/controllers/terminalLogController.ts`:
- **Authentication Priority:**
  1. **Ticket Auth:** If query parameter `ticket` is provided, validate via `ticketManager.consumeTicket(ticket)`. If valid, grant access.
  2. **Header Auth:** Check `req.headers['x-admin-key']` (standard for CLI and server-to-server calls).
  3. **Legacy Query Fallback:** Check query parameter `x-admin-key` or `key` with `safeCompareSecret` to maintain backward compatibility with older clients.

---

### 3.2 Frontend & Client Authentication Flow Refactor

#### 3.2.1 Frontend Ticket Service (`frontend/src/utils/apiClient.ts`)
- Add helper `requestAuthTicket(): Promise<string | null>`.
- Calls `POST /api/auth/ticket` with current `x-admin-key` header.
- If server returns 401 or network fails, throw meaningful error; if server does not require auth (no key configured), return `null`.

#### 3.2.2 WebSocket Connection (`useTerminalWebSocket.ts` & `WebTerminalView.tsx`)
- When establishing terminal connection:
  - If an admin key is present, invoke `requestAuthTicket()`.
  - Assemble URL: `${wsBase}/api/terminal/ws?ticket=${ticket}&hostId=${hostId}`.
  - **Remove** all `x-admin-key` / `key` from query strings.
- On auto-reconnect:
  - Re-request a fresh ticket before attempting reconnect handshake.

#### 3.2.3 Logs View & File Downloads (`TerminalLogsView.tsx`, `TerminalFileManagerView.tsx`)
- `TerminalLogsView.tsx`: Acquire ticket before instantiating `new EventSource('/api/terminal/logs?stream=true&ticket=' + ticket)`. Re-fetch ticket when recreating the event stream.
- `TerminalFileManagerView.tsx`:
  - For direct file downloads, obtain a short-lived ticket to construct download links (`/api/terminal/files/download?...&ticket=${ticket}`).
  - Or download via authenticated `apiFetch` and trigger browser file save via Object URL.

#### 3.2.4 CLI Client Audit (`src/client/`)
- Verify all CLI HTTP requests and WebSocket connections (`gt exec`, `gt cp`) pass `x-admin-key` exclusively through HTTP headers, stripping unnecessary query parameters.

---

### 3.3 Agent Execution Boundaries & Permission Modes

#### 3.3.1 Permission Mode Parameter & Configuration
Add `--permission-mode <default | bypass>` to `gt agent start`:
- **CLI Options:**
  - `gt agent start [options]`
  - Option definition: `-p, --permission-mode <mode>`: Permission mode for file and command operations (`default` or `bypass`). Default: `default`.
  - Optional workspace: `-w, --workspace <path>`: Restrict file operations to the specified directory.
- **Environment Variables:**
  - `GT_PERMISSION_MODE=default|bypass`
  - `GT_AGENT_WORKSPACE=<path>`
- **Precedence:** CLI flags override environment variables, which override configuration files.

#### 3.3.2 Mode Behaviors
- **`bypass` Mode:**
  - Operates identically to the current implementation.
  - Disables all path blacklists and workspace boundaries.
  - Emits startup warning:
    `[AgentSecurity] WARNING: Running with --permission-mode bypass. Path restrictions and workspace boundaries are disabled.`
- **`default` Mode (Protected):**
  - **Sensitive Path Blacklist:**
    - User SSH keys: `~/.ssh/**` (e.g., `id_rsa`, `id_ed25519`, `authorized_keys`)
    - User GPG keys: `~/.gnupg/**`
    - Unix auth credentials: `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers`, `/etc/sudoers.d/**`, `/etc/pam.d/**`
    - Windows credentials: `C:\Windows\System32\config\SAM`, `C:\Windows\System32\config\SYSTEM`
    - Agent configuration files: `~/.gt/agent.json`, `~/.gt/config.json`
  - **Symlink & Path Traversal Resolution:**
    - Canonicalize target paths using `path.resolve` and `fs.realpathSync` (when the path exists) to prevent symlink bypasses.
  - **Workspace Boundary (if configured):**
    - Ensure resolved path resides strictly within the configured workspace directory (`path.relative(workspace, resolvedPath)` must not begin with `..`).

#### 3.3.3 File RPC Guard & Audit Logging (`src/agent/security/pathGuard.ts`)
- Wrap file RPC handlers (`read`, `write`, `delete`, `rename`, `mkdir`, `list`) with `checkPathPermission(targetPath, permissionMode, workspace)`.
- If a check fails:
  - Reject RPC with `{ success: false, error: 'SecurityException: Access to sensitive path or outside workspace is restricted' }`.
  - Log audit event in `~/.gt/agent.log`:
    `[SECURITY_AUDIT] BLOCKED file_rpc ${action} on path: "${targetPath}" (mode: ${mode})`.
- If allowed:
  - Proceed with operation and log normal debug/info output.

---

## 4. Error Handling & Edge Cases

1. **Ticket Expiry during WebSocket Reconnection:**
   - Network flapping may cause reconnect attempts after the initial 30-second ticket has expired.
   - Handled by always generating a fresh ticket in frontend reconnect hooks.
2. **Clock Skew:**
   - Ticket expiration relies purely on server-side monotonicity (`Date.now() + 30000`). Client system clock offsets do not affect ticket validity.
3. **Symlinks to Non-Existent Files (Creation via write):**
   - When creating new files, `fs.realpath` may fail if parent or target doesn't exist yet. The path validator inspects the realpath of the closest existing parent directory combined with the canonicalized target filename.
4. **Agent Running as Non-Root vs Root:**
   - Even when running as root, `default` mode prevents accidental overwrites or reads of `/etc/shadow` and SSH keys via remote WebTerminal UI.

---

## 5. Testing Plan

### 5.1 Unit & Integration Tests
- **Security Check Unit Tests (`tests/securityConfig.test.ts`):**
  - Test production startup failure when `GT_KEY` is missing.
  - Test production startup bypass when `GT_ALLOW_INSECURE_NO_AUTH=true`.
  - Test normal development startup when `GT_KEY` is empty.
- **Ticket Manager Tests (`tests/ticketManager.test.ts`):**
  - Test ticket generation, successful single-use consumption, and immediate invalidation on second consumption.
  - Test rejection of expired tickets (> 30s).
  - Test sweep cleanup of expired entries.
- **WebSocket Ticket Auth Tests (`tests/terminalWsTicketAuth.test.ts`):**
  - Test successful connection with valid ticket.
  - Test rejected connection with invalid or already consumed ticket.
  - Test legacy header and query fallback backward compatibility.
- **Agent Path Guard Tests (`tests/agentPathGuard.test.ts`):**
  - Test `default` mode blocking access to `~/.ssh/id_rsa`, `/etc/shadow`, `~/.gt/agent.json`.
  - Test symlink resolution preventing traversal into blacklisted targets.
  - Test `--workspace` boundary enforcement.
  - Test `bypass` mode allowing full access across all paths.
- **Frontend Integration (`tests/frontendTicketAuth.test.ts`):**
  - Verify frontend fetches ticket before opening WebSocket and strips `x-admin-key` from WS URL.

---

## 6. Compatibility & Rollout Strategy

- **Zero Downtime / Seamless Upgrade:**
  - Hub and Agent upgrades can occur independently.
  - Older agents or CLIs will continue connecting via header/query parameters.
  - Frontend immediately shifts to ticket-based connections.
- **Production Rollout Note:**
  - Deployments must ensure `GT_KEY` is defined in production environments or `GT_ALLOW_INSECURE_NO_AUTH=true` is set.
