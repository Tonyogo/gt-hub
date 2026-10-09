# Manual Authentication Flags and Single Agent per Machine per Hub Design

## 1. Overview
This specification details the design for:
1. Enabling manual authentication options (`-s, --server <url>` and `-k, --key <secret>`) across all `gt` CLI commands, including `gt run` and `gt agent start/run`.
2. Cleanly standardizing authentication environment variables to `GT_SERVER` and `GT_KEY`, removing dependencies on legacy variable names.
3. Enforcing a strict server-side constraint where each physical/virtual machine (identified by a persistent `machineId`) can have at most one active (online) agent connected to the same Target Hub at any given time.

---

## 2. Authentication & Environment Variables

### 2.1 Unified Environment Variables
Legacy environment variables (`TERMINAL_SERVER`, `ADMIN_SECRET_KEY`, `GEMINI_PROXY_URL`) are removed. The system strictly standardizes on:
- **`GT_SERVER`**: Hub server base URL (default: `http://localhost:8000`).
- **`GT_KEY`**: Hub administration secret key (default: `''`).

### 2.2 Precedence Order
All client commands (`gt exec`, `gt run`, `gt agent`, `gt cp`, `gt hosts`, `gt ps`, `gt logs`, `gt login`, etc.) resolve server and key using the following order of precedence:
1. Explicit CLI arguments (`-s / --server`, `-k / --key`).
2. Environment variables (`GT_SERVER`, `GT_KEY`).
3. Persistent configuration (`~/.gt/config.json`).
4. Fallback defaults (`DEFAULT_SERVER_URL = 'http://localhost:8000'`, empty key `''`).

### 2.3 Agent Flag Passthrough
- Remove the legacy error checks in `src/agent/daemon.ts` that previously prohibited `--server` and `--key`.
- When spawning a background daemon (`gt run -d`, `gt agent start`), the resolved `--server` and `--key` flags must be forwarded to the child process arguments (`cleanArgs`).

---

## 3. Server-Side "Single Agent per Machine" Enforcement

### 3.1 Machine Identity (`machineId`)
1. `ConfigStore.getMachineId()` generates a random hex identifier on first run and persists it in `~/.gt/config.json`.
2. When the Agent connects to `/api/terminal/agent-ws`, it includes `machineId` in the WebSocket connection query string:
   ```text
   /api/terminal/agent-ws?hostId=<hostId>&name=<name>&machineId=<machineId>&hostname=<hostname>&platform=<platform>&ip=<ip>
   ```
3. The server extracts `machineId` and stores it on the `ManagedHost` structure. If `machineId` is missing from an agent, the server falls back to using `hostId`.

### 3.2 Registration Conflict & Mutex Algorithm (`hostManager.ts`)
Inside `terminalHostManager.registerAgent(metadata)`:
1. **Active Machine Conflict Check**:
   Iterate over all existing registered hosts in `this.hosts`:
   - If an existing host has `status === 'online'`, matching `machineId === metadata.machineId`, and is held by a different WebSocket connection:
     ```typescript
     if (existingHost.status === 'online' && existingHost.machineId === metadata.machineId && existingHost.agentWs !== metadata.agentWs) {
       return {
         success: false,
         error: `Conflict: Machine (${metadata.machineId}) already has an active agent '${existingHost.name}' (ID: ${existingId}) connected to this Hub. Each machine can only have ONE agent per Hub.`
       };
     }
     ```
2. **Offline Host Cleanup (Auto-Prune)**:
   - If an existing host has matching `machineId` but `status === 'offline'`, the server cleans up the dead session and purges the old host record to allow the new agent from the same machine to register cleanly.
3. **Rejection Handling (`terminalWs.ts`)**:
   - If `registerAgent` returns `success: false`, the server sends a rejection frame:
     ```json
     JSON:{"type":"rejected","code":4009,"reason":"<error message>"}
     ```
   - The server closes the socket with code `4009` and the reason string.

### 3.3 Agent Client Response
When the agent receives `{ type: 'rejected', reason: ... }`:
1. It prints a clear error message in red:
   ```text
   [Error] Registration rejected by server: Conflict: Machine (...) already has an active agent '...'
   ```
2. It sets `isExiting = true`, terminates the socket, and immediately exits with status code `1` (without attempting reconnect loops).

---

## 4. Impacted Files & Interfaces

1. **`src/shared/types/host.ts`**:
   - Add `machineId?: string` to `ManagedHost` and `AgentMetadata`.
2. **`src/client/config/configStore.ts`**:
   - Update `ConfigStore.getEffectiveConfig()` to read `process.env.GT_SERVER` and `process.env.GT_KEY`.
3. **`src/agent/daemon.ts`**:
   - Remove legacy restrictions blocking `-s / --server` and `-k / --key`.
   - Forward server and key into daemon child arguments.
   - Include `machineId` in `resolveWebSocketUrl(...)` query params.
   - Cleanly handle `rejected` error messages.
4. **`src/client/index.ts`**:
   - Update `printHelp()` descriptions to reference `GT_SERVER` and `GT_KEY`.
5. **`src/server/modules/terminal/services/hostManager.ts` & `src/server/modules/terminal/ws/terminalWs.ts`**:
   - Record `machineId` on host.
   - Implement active machine conflict rejection and offline machine prune.
6. **Tests**:
   - Update tests currently referencing `TERMINAL_SERVER` / `ADMIN_SECRET_KEY` to `GT_SERVER` / `GT_KEY`.
   - Update `tests/gtAgentDaemon.test.ts` to assert that `--server` and `--key` are accepted.
   - Add integration tests asserting that two agents from the same machine with different names connecting to the same hub are rejected on the second connection.

---

## 5. Verification Plan

1. **Unit Tests**:
   - Test `ConfigStore.getEffectiveConfig()` with `GT_SERVER` and `GT_KEY`.
   - Test `AgentDaemonManager` flag parsing accepting `-s` and `-k`.
2. **Integration Tests**:
   - Start an in-memory Hub server.
   - Connect Agent 1 with `machineId = "machine-A"`. Verify registration succeeds.
   - Connect Agent 2 with `machineId = "machine-A"` (different hostId and name). Verify server returns rejection code 4009 and Agent 2 exits.
   - Disconnect Agent 1 (trigger offline). Connect Agent 3 with `machineId = "machine-A"`. Verify Agent 3 successfully registers and takes over.
