# `gt-hub` MCP Server (`gt mcp` & `/api/terminal/mcp`) Architecture & Design Spec

- **Date**: 2026-11-12
- **Status**: Draft (Pending User Review)
- **Author**: Claude Code & User

---

## 1. Goal & Intended Outcome

Expose `gt-hub` and `gt` CLI capabilities to Large Language Models (LLMs) and AI Agents via the **Model Context Protocol (MCP)** using a **Shared Isomorphic MCP Core + Dual Backend Adapters** architecture:

1. **CLI Local Stdio Mode (`gt mcp`)**: Built directly into the standalone `dist/gt.js` single-file executable with zero heavy external SDK dependencies. Supports local AI coding assistants and desktop clients (Claude Code, Claude Desktop, Cursor, Windsurf, etc.) over JSON-RPC 2.0 `stdio`.
2. **Hub Server Remote HTTP Mode (`/api/terminal/mcp`)**: Mounted on the Express server under `/api/terminal/mcp` (protected by `adminAuthMiddleware`), enabling remote MCP clients, cloud agent platforms, and bots to invoke `gt-hub` capabilities over HTTP without installing the CLI.
3. **Full 4-Domain Capability Coverage**: Expose 17 atomic tools spanning **Nodes**, **Exec/Tasks**, **Remote Files**, and **Distributed Cron**.
4. **Built-in Security Guardrails & Output Protection**:
   - **Read-Only Mode (`readOnly`)**: Hides non-read-only tools from `tools/list` and blocks any write/exec/delete invocations in `tools/call`.
   - **Node Allowlist (`allowedNodes`)**: Restricts node visibility and operations strictly to specified node IDs or names.
   - **Output Truncation (`maxOutputChars`)**: Prevents large command outputs or file reads from overflowing the LLM context window, appending clear pagination hints (`offset` / `limit`).

---

## 2. Architecture & Directory Structure

### 2.1 File Layout

```text
src/
├── shared/
│   └── mcp/
│       ├── types.ts             # JSON-RPC 2.0 types, MCP protocol types, McpSecurityPolicy, McpBackendAdapter interface
│       ├── tools.ts             # 17 MCP Tool definitions, JSON Schemas, readOnly & destructive metadata
│       ├── guard.ts             # Security policy evaluation (readOnly, allowedNodes matching, output truncation)
│       └── server.ts            # McpEngine class: JSON-RPC 2.0 router (initialize, ping, tools/list, tools/call)
├── client/
│   ├── commands/
│   │   └── mcp.ts               # CLI Stdio transport (stdin readline -> McpEngine -> stdout) + RestApiClientAdapter
│   └── index.ts                 # Register `gt mcp` subcommand (--read-only, --nodes, --max-output, -s, -k, -c)
└── terminal/
    ├── adapters/
    │   └── mcpDirectAdapter.ts  # Server-side DirectServiceAdapter calling internal services directly in memory
    ├── controllers/
    │   └── terminalMcpController.ts # Express handler for POST/GET /api/terminal/mcp
    └── routes/
        └── terminalRoutes.ts    # Mount `/mcp` route under adminAuthMiddleware
```

### 2.2 Isomorphic `McpBackendAdapter` Interface

`McpEngine` is decoupled from transport and execution details via `McpBackendAdapter`:

```typescript
export interface McpSecurityPolicy {
  readOnly?: boolean;
  allowedNodes?: string[];
  maxOutputChars?: number;
}

export interface McpHostEntry {
  id: string;
  name?: string;
  online?: boolean;
  connected?: boolean;
  [key: string]: any;
}

export interface McpBackendAdapter {
  // 1. Cluster Nodes
  listNodes(): Promise<McpHostEntry[]>;

  // 2. Command & Task Execution
  startExec(
    hostId: string,
    opts: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      waitMs?: number;
      env?: Record<string, string>;
      stdin?: string;
    }
  ): Promise<any>;
  getExecStatus(hostId: string, taskId: string, offset?: number): Promise<any>;
  killExec(hostId: string, taskId: string, signal?: string): Promise<any>;
  listExec(hostId: string, limit?: number): Promise<any>;

  // 3. Remote File Management
  listFiles(hostId: string, targetPath?: string): Promise<any>;
  readFileContent(hostId: string, targetPath: string): Promise<any>;
  saveFileContent(hostId: string, targetPath: string, content: string): Promise<any>;
  createDirectory(hostId: string, parentPath: string, dirName: string): Promise<any>;
  deleteItem(hostId: string, targetPath: string): Promise<any>;
  renameFile(hostId: string, oldPath: string, newPath: string): Promise<any>;

  // 4. Distributed Cron Management
  listCronJobs(hostId: string): Promise<any>;
  addCronJob(hostId: string, body: Record<string, any>): Promise<any>;
  updateCronJob(hostId: string, jobId: string, body: Record<string, any>): Promise<any>;
  deleteCronJob(hostId: string, jobId: string): Promise<any>;
  triggerCronJob(hostId: string, jobId: string): Promise<any>;
  getCronJobLogs(hostId: string, jobId: string, offset?: number): Promise<any>;
}
```

### 2.3 Dual Backend Implementations

1. **`DirectServiceAdapter` (`src/terminal/adapters/mcpDirectAdapter.ts`)**:
   - Used by `/api/terminal/mcp` inside the Hub Server process.
   - Invokes `terminalHostManager`, `terminalExecService`, `terminalFileService`, and `terminalCronService` directly in memory with zero HTTP loopback overhead.
2. **`RestApiClientAdapter` (`src/client/commands/mcp.ts`)**:
   - Used by `gt mcp` in the CLI process.
   - Uses `makeRequest` (`src/client/utils/terminalUI.ts`) to call the Hub's existing `/api/terminal/*` REST endpoints (`GET /hosts`, `POST /exec/:hostId`, `GET /files/:hostId/list`, `GET /cron/:nodeId`, etc.).
   - Ensures `gt mcp` works seamlessly even against an older Hub server before the server is upgraded, while handling MCP `initialize` and `tools/list` locally with zero network latency.

---

## 3. MCP Tool Catalog & Schemas (17 Tools)

All tools are defined in `src/shared/mcp/tools.ts` with JSON Schema `inputSchema`, `readOnly` flag, and MCP `annotations`:

| Domain | Tool Name | `readOnly` | `destructive` | Input Parameters (`inputSchema`) | Description |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **Nodes** | `gt_list_nodes` | `true` | `false` | `{ all?: boolean }` | List registered agent nodes (`all: false` by default for online-only; filtered by `allowedNodes` if configured). |
| **Exec/Task** | `gt_exec` | `false` | `false` | `{ node: string, command: string, cwd?: string, env?: Record<string, string>, stdin?: string, timeoutMs?: number, waitMs?: number, detach?: boolean }` | Execute a shell command on `node`. Defaults to synchronous wait (`waitMs: 30000`); if `detach: true`, sets `waitMs: 0` and returns `taskId` immediately. |
| | `gt_task_list` | `true` | `false` | `{ node: string, limit?: number }` | List recent execution tasks on `node` (default `limit: 20`). |
| | `gt_task_status` | `true` | `false` | `{ node: string, taskId: string, offset?: number }` | Get task status, exit code, and incremental output starting at byte/char `offset`. |
| | `gt_task_kill` | `false` | `true` | `{ node: string, taskId: string, signal?: string }` | Terminate a running task on `node` (default signal `SIGTERM`). |
| **Files** | `gt_list_files` | `true` | `false` | `{ node: string, path?: string }` | List directory entries on `node`. |
| | `gt_read_file` | `true` | `false` | `{ node: string, path: string, offset?: number, limit?: number }` | Read text file content from `node` with optional character `offset` and `limit`. |
| | `gt_write_file` | `false` | `false` | `{ node: string, path: string, content: string }` | Write or overwrite text file content on `node`. |
| | `gt_mkdir` | `false` | `false` | `{ node: string, path: string, dirName: string }` | Create a new directory `dirName` inside `path` on `node`. |
| | `gt_delete_file` | `false` | `true` | `{ node: string, path: string }` | Delete a file or directory at `path` on `node`. |
| | `gt_rename_file` | `false` | `false` | `{ node: string, oldPath: string, newPath: string }` | Rename or move a file/directory from `oldPath` to `newPath` on `node`. |
| **Cron** | `gt_cron_list` | `true` | `false` | `{ node: string }` | List scheduled cron jobs on `node`. |
| | `gt_cron_add` | `false` | `false` | `{ node: string, name: string, cron: string, command: string, cwd?: string, timeoutMs?: number, concurrency?: "forbid"\|"allow", paused?: boolean }` | Create a scheduled cron job on `node`. |
| | `gt_cron_update` | `false` | `false` | `{ node: string, jobId: string, status?: "active"\|"paused", name?: string, cron?: string, command?: string, cwd?: string, timeoutMs?: number, concurrency?: "forbid"\|"allow" }` | Update or pause/resume an existing cron job on `node`. |
| | `gt_cron_delete` | `false` | `true` | `{ node: string, jobId: string }` | Delete a cron job `jobId` on `node`. |
| | `gt_cron_run` | `false` | `false` | `{ node: string, jobId: string }` | Trigger immediate execution of cron job `jobId` on `node`. |
| | `gt_cron_logs` | `true` | `false` | `{ node: string, jobId: string, offset?: number }` | Fetch execution logs for cron job `jobId` on `node`. |

---

## 4. Security Guardrails & Output Truncation (`src/shared/mcp/guard.ts`)

### 4.1 Read-Only Mode (`policy.readOnly === true`)
1. **Discovery Filtering (`tools/list`)**: Only the 7 tools with `readOnly: true` (`gt_list_nodes`, `gt_task_list`, `gt_task_status`, `gt_list_files`, `gt_read_file`, `gt_cron_list`, `gt_cron_logs`) are returned.
2. **Execution Blocking (`tools/call`)**: Any attempt to call a tool with `readOnly: false` is immediately rejected before reaching the adapter, returning an MCP tool error result (`isError: true`) with message:
   `Permission denied: tool "<toolName>" is disabled in read-only mode.`

### 4.2 Node Allowlist & Smart Node Resolution (`policy.allowedNodes`)
1. **Allowlist Matching**:
   - `allowedNodes` accepts a list of node IDs or node names (case-insensitive, trimmed).
   - A host entry matches the allowlist if its `id` or `name` (case-insensitive) equals any entry in `allowedNodes`.
2. **Node Resolution (`resolveTargetNode(nodeInput, hosts, policy)`)**:
   - First filters `hosts` by `policy.allowedNodes` (if non-empty).
   - Resolves `nodeInput` across the permitted hosts in order:
     1. Exact `id` match;
     2. Case-insensitive exact `name` or `id` match;
     3. Unambiguous prefix match on `id` or `name`.
   - If `nodeInput` matches a host that is excluded by `allowedNodes` (or if `allowedNodes` is set and `nodeInput` is not permitted), returns:
     `Access denied: node "<nodeInput>" is not in the allowed nodes list.`
   - If no host matches, returns:
     `Node "<nodeInput>" not found.`

### 4.3 Output Truncation (`truncateText(text, maxOutputChars)`)
- Default `maxOutputChars` is `32768` (configurable via `--max-output <chars>` on CLI or `x-mcp-max-output` / `?maxOutput=` on HTTP).
- Applied to:
  - `gt_exec` and `gt_task_status` output (`output` / `stdout` / `stderr` fields);
  - `gt_read_file` file content (after applying optional `offset` and `limit` slicing);
  - `gt_cron_logs` log content.
- When truncated, appends:
  `\n...[TRUNCATED: showing <shown> of <total> chars. Use offset=<nextOffset> to read more]`
  and sets metadata fields `truncated: true`, `totalChars: <total>`, `nextOffset: <nextOffset>` in the structured JSON payload.

---

## 5. Protocol Flow, Transports & Error Handling

### 5.1 JSON-RPC 2.0 Protocol Handling (`McpEngine`)
- **Supported Methods**:
  - `initialize`: Echoes client `protocolVersion` if provided (fallback `"2024-11-05"`), returns `capabilities: { tools: {} }` and `serverInfo: { name: "gt-mcp", version }`.
  - `notifications/initialized`, `notifications/cancelled`, or any JSON-RPC Notification (message without `id`): Returns `null` (no response frame emitted on stdio, `202 Accepted` on HTTP).
  - `ping`: Returns `{}`.
  - `tools/list`: Returns `{ tools: [...] }` filtered by `policy.readOnly`.
  - `tools/call`: Validates tool name and arguments, runs guardrails, executes via `McpBackendAdapter`, and returns:
    ```json
    {
      "content": [{ "type": "text", "text": "<pretty-printed JSON result>" }],
      "isError": false
    }
    ```
- **Batch Requests**: If an array of JSON-RPC messages is received, processes each item in parallel and returns an array of non-null responses (or `null` if all were notifications).

### 5.2 Error Layering
1. **JSON-RPC Protocol Errors** (returned as top-level `error: { code, message }`):
   - `-32700`: Parse error (invalid JSON)
   - `-32600`: Invalid Request (missing `jsonrpc: "2.0"` or invalid structure)
   - `-32601`: Method not found (unknown RPC method)
   - `-32602`: Invalid params (e.g. `tools/call` missing `name`)
2. **Tool Execution & Guardrail Errors** (returned as normal JSON-RPC `result` with `isError: true`):
   - Missing required tool arguments, read-only guardrail blocks, node allowlist rejections, offline node errors, non-zero remote errors, or file-not-found errors return:
     ```json
     {
       "content": [{ "type": "text", "text": "{\"success\":false,\"error\":\"...\"}" }],
       "isError": true
     }
     ```
   - This allows the LLM to inspect the error message and self-correct without crashing the MCP transport session.

### 5.3 CLI Stdio Transport (`gt mcp`)
- **CLI Options**:
  - `gt mcp [-s, --server <url>] [-k, --key <secret>] [-c, --context <name>] [--read-only] [--nodes <n1,n2>] [--max-output <chars>]`
- **Stream Discipline**:
  - Reads newline-delimited JSON-RPC messages from `process.stdin` via `readline`.
  - Writes serialized JSON-RPC responses followed by `\n` to `process.stdout`.
  - Redirects `console.log` / `console.info` / `console.warn` during `gt mcp` execution to `process.stderr` so no stray logs ever corrupt the `stdout` JSON-RPC stream.

### 5.4 Server HTTP Transport (`/api/terminal/mcp`)
- **Authentication**: Protected by existing `adminAuthMiddleware` in `src/terminal/routes/terminalRoutes.ts`.
- **Policy Extraction**:
  - `readOnly`: `req.headers['x-mcp-readonly'] === 'true'` or `req.query.readOnly === 'true'` or `req.query.readOnly === '1'`
  - `allowedNodes`: comma-separated string from `req.headers['x-mcp-nodes']` or `req.query.nodes`
  - `maxOutputChars`: positive integer from `req.headers['x-mcp-max-output']` or `req.query.maxOutput`
- **HTTP Endpoints**:
  - `POST /api/terminal/mcp`: Processes JSON-RPC 2.0 request or batch. Returns `202 Accepted` with empty body when the response is `null` (notification), or `200 OK` with `application/json` body.
  - `GET /api/terminal/mcp`: Returns `200 OK` server discovery metadata (`{ success: true, name: "gt-mcp", version, protocol: "mcp-jsonrpc-2.0" }`) for health checks.

---

## 6. Testing Strategy

1. **Unit Tests (`tests/mcp-engine.test.ts`)**:
   - Mock `McpBackendAdapter` to verify `initialize`, `notifications/initialized`, `ping`, `tools/list`, and all 17 tools in `tools/call`.
   - Verify `readOnly: true` hides write tools in `tools/list` and blocks direct calls in `tools/call` with `isError: true`.
   - Verify `allowedNodes` filters `gt_list_nodes`, resolves case-insensitive node names/IDs, and blocks unauthorized nodes.
   - Verify `maxOutputChars` truncates oversized command output, file content, and cron logs while preserving pagination metadata (`truncated`, `totalChars`, `nextOffset`).
   - Verify JSON-RPC error codes (`-32700`, `-32600`, `-32601`, `-32602`) and batch request handling.
2. **Integration Tests (`tests/mcp-integration.test.ts`)**:
   - Test `POST /api/terminal/mcp` and `GET /api/terminal/mcp` on the Express app (`supertest`), verifying `x-admin-key` authentication, `x-mcp-readonly` / `x-mcp-nodes` headers, and `DirectServiceAdapter` execution.
   - Test `RestApiClientAdapter` and `gt mcp` stdio stream processing end-to-end against a test HTTP server.
