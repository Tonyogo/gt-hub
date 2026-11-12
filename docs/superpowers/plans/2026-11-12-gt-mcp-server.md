# gt-hub MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `gt-hub` and `gt` CLI capabilities (Nodes, Exec/Tasks, Remote Files, Distributed Cron) to LLMs via a shared isomorphic MCP JSON-RPC 2.0 core supporting both CLI local stdio (`gt mcp`) and Hub server HTTP (`/api/terminal/mcp`) with read-only and node-allowlist guardrails.

**Architecture:** Build a zero-dependency MCP protocol engine (`src/shared/mcp/`) decoupled from execution via the `McpBackendAdapter` interface. Wire it to `DirectServiceAdapter` on the Express server (`/api/terminal/mcp`) for zero-loopback execution and to `RestApiClientAdapter` in the CLI (`gt mcp`) for local stdio transport.

**Tech Stack:** TypeScript, Node.js (`readline`, `http`/`https`), Express 4, Commander.js, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-11-12-gt-mcp-server-design.md`

## Global Constraints

- Keep `dist/gt.js` zero external runtime SDK dependencies: do not install `@modelcontextprotocol/sdk` or `zod`.
- Always run targeted Jest tests with `npm test -- tests/<file>.test.ts` (`--detectOpenHandles --forceExit` are configured in `package.json`).
- Default `maxOutputChars` is `32768`; truncated outputs must append `\n...[TRUNCATED: showing <shown> of <total> chars. Use offset=<nextOffset> to read more]` and set `truncated: true`, `totalChars`, `nextOffset`.
- Read-only mode (`readOnly: true`) must expose only the 7 read-only tools (`gt_list_nodes`, `gt_task_list`, `gt_task_status`, `gt_list_files`, `gt_read_file`, `gt_cron_list`, `gt_cron_logs`) in `tools/list` and return `isError: true` with `"Permission denied: tool \"<toolName>\" is disabled in read-only mode."` if a non-read-only tool is called via `tools/call`.
- During `gt mcp` execution, redirect `console.log`, `console.info`, and `console.warn` to `process.stderr` so `process.stdout` carries exclusively newline-delimited JSON-RPC 2.0 frames.

## Review Focus

- Ambiguous node prefix matching (`resolveTargetNode`): when `nodeInput` matches multiple permitted nodes by prefix (e.g. `web-1` and `web-2` for input `"web"`), reject with an explicit ambiguity error listing candidates rather than silently picking the first node.
- JSON-RPC `id: null` vs omitted `id`: a message with `"id": null` must return a JSON-RPC response with `"id": null`, whereas a message with `id === undefined` is a Notification and must return `null` (no response frame on stdio, `202 Accepted` on HTTP).
- `gt_read_file` with binary files or negative/NaN `offset` and `limit`: reject `isBinary: true` files with `isError: true` (`"Cannot read binary file as text"`) and clamp negative/NaN `offset`/`limit` safely.
- Empty JSON-RPC batch array `[]`: receiving `[]` must return a single JSON-RPC `-32600` (`Invalid Request`) error object rather than `null` or `[]`.
- Blank lines vs malformed JSON on `gt mcp` `stdin`: ignore empty/whitespace-only lines on `stdin` without output, and respond to malformed non-empty lines with a `-32700` Parse error frame without terminating the stream loop.

---

### Task 1: MCP Core Types, 17 Tool Definitions & Security Guardrails

**Files:**
- Create: `src/shared/mcp/types.ts`
- Create: `src/shared/mcp/tools.ts`
- Create: `src/shared/mcp/guard.ts`
- Test: `tests/mcp-guard.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `src/shared/mcp/types.ts`: `McpSecurityPolicy`, `McpHostEntry`, `McpBackendAdapter`, `McpToolDefinition`, `JsonRpcRequest`, `JsonRpcResponse`, `McpToolCallResult`
  - `src/shared/mcp/tools.ts`: `MCP_TOOLS: McpToolDefinition[]`, `getMcpToolByName(name: string): McpToolDefinition | undefined`, `listMcpTools(policy?: McpSecurityPolicy): Array<Omit<McpToolDefinition, 'readOnly' | 'destructive'>>`
  - `src/shared/mcp/guard.ts`: `DEFAULT_MAX_OUTPUT_CHARS = 32768`, `isNodeAllowed(host: McpHostEntry, allowedNodes?: string[]): boolean`, `filterAllowedNodes(hosts: McpHostEntry[], policy?: McpSecurityPolicy): McpHostEntry[]`, `resolveTargetNode(nodeInput: string, hosts: McpHostEntry[], policy?: McpSecurityPolicy): { ok: true; hostId: string; host: McpHostEntry } | { ok: false; error: string }`, `checkToolPermission(toolName: string, policy?: McpSecurityPolicy): { ok: true; tool: McpToolDefinition } | { ok: false; error: string; code?: number }`, `truncateText(text: string, maxChars?: number, baseOffset?: number): { text: string; truncated: boolean; totalChars: number; nextOffset?: number }`

- [x] **Step 1: Write the failing test in `tests/mcp-guard.test.ts`**

```typescript
import { MCP_TOOLS, listMcpTools } from '../src/shared/mcp/tools';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  filterAllowedNodes,
  resolveTargetNode,
  checkToolPermission,
  truncateText,
} from '../src/shared/mcp/guard';
import { McpHostEntry } from '../src/shared/mcp/types';

describe('MCP Tools & Security Guardrails', () => {
  const sampleHosts: McpHostEntry[] = [
    { id: 'host-alpha-01', name: 'Prod-Web-1', status: 'online' },
    { id: 'host-alpha-02', name: 'Prod-Web-2', status: 'online' },
    { id: 'host-beta-01', name: 'Staging-DB', status: 'offline' },
  ];

  test('exposes all 17 tools by default and only 7 read-only tools when readOnly=true', () => {
    expect(MCP_TOOLS).toHaveLength(17);
    const allTools = listMcpTools({ readOnly: false });
    expect(allTools).toHaveLength(17);

    const roTools = listMcpTools({ readOnly: true });
    expect(roTools.map((t) => t.name)).toEqual([
      'gt_list_nodes',
      'gt_task_list',
      'gt_task_status',
      'gt_list_files',
      'gt_read_file',
      'gt_cron_list',
      'gt_cron_logs',
    ]);
  });

  test('checkToolPermission blocks write tools in read-only mode', () => {
    const denied = checkToolPermission('gt_exec', { readOnly: true });
    expect(denied).toEqual({
      ok: false,
      error: 'Permission denied: tool "gt_exec" is disabled in read-only mode.',
    });

    const allowed = checkToolPermission('gt_read_file', { readOnly: true });
    expect(allowed.ok).toBe(true);
  });

  test('resolveTargetNode resolves exact ID, case-insensitive name, and unique prefix within allowlist', () => {
    expect(resolveTargetNode('host-alpha-01', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-alpha-01',
      host: sampleHosts[0],
    });
    expect(resolveTargetNode('prod-web-2', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-alpha-02',
      host: sampleHosts[1],
    });
    expect(resolveTargetNode('staging', sampleHosts)).toEqual({
      ok: true,
      hostId: 'host-beta-01',
      host: sampleHosts[2],
    });
  });

  test('resolveTargetNode rejects disallowed nodes and ambiguous prefixes', () => {
    const denied = resolveTargetNode('Staging-DB', sampleHosts, {
      allowedNodes: ['Prod-Web-1', 'Prod-Web-2'],
    });
    expect(denied).toEqual({
      ok: false,
      error: 'Access denied: node "Staging-DB" is not in the allowed nodes list.',
    });

    const ambiguous = resolveTargetNode('Prod-Web', sampleHosts);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error).toContain('Ambiguous node identifier "Prod-Web"');
      expect(ambiguous.error).toContain('host-alpha-01');
      expect(ambiguous.error).toContain('host-alpha-02');
    }
  });

  test('filterAllowedNodes filters host list by id or name case-insensitively', () => {
    const filtered = filterAllowedNodes(sampleHosts, { allowedNodes: ['prod-web-1', 'host-beta-01'] });
    expect(filtered.map((h) => h.id)).toEqual(['host-alpha-01', 'host-beta-01']);
  });

  test('truncateText truncates strings exceeding maxChars and calculates nextOffset', () => {
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(32768);
    const raw = '0123456789abcdef';
    const res = truncateText(raw, 10, 5);
    expect(res.truncated).toBe(true);
    expect(res.totalChars).toBe(16);
    expect(res.nextOffset).toBe(15);
    expect(res.text).toBe(
      '0123456789\n...[TRUNCATED: showing 10 of 16 chars. Use offset=15 to read more]'
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp-guard.test.ts`
Expected: FAIL with `Cannot find module '../src/shared/mcp/tools'`

- [x] **Step 3: Implement `src/shared/mcp/types.ts`, `src/shared/mcp/tools.ts`, and `src/shared/mcp/guard.ts`**

Create `src/shared/mcp/types.ts` with `McpSecurityPolicy`, `McpHostEntry`, `McpBackendAdapter`, `McpToolDefinition` (with `name`, `description`, `readOnly`, `destructive`, `inputSchema`, `annotations`), `JsonRpcRequest`, `JsonRpcResponse`, and `McpToolCallResult`.
Create `src/shared/mcp/tools.ts` defining all 17 tools from Spec Section 3 in exact table order (`gt_list_nodes`, `gt_exec`, `gt_task_list`, `gt_task_status`, `gt_task_kill`, `gt_list_files`, `gt_read_file`, `gt_write_file`, `gt_mkdir`, `gt_delete_file`, `gt_rename_file`, `gt_cron_list`, `gt_cron_add`, `gt_cron_update`, `gt_cron_delete`, `gt_cron_run`, `gt_cron_logs`), `getMcpToolByName`, and `listMcpTools`.
Create `src/shared/mcp/guard.ts` implementing `DEFAULT_MAX_OUTPUT_CHARS = 32768`, `isNodeAllowed`, `filterAllowedNodes`, `resolveTargetNode`, `checkToolPermission`, and `truncateText`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/mcp-guard.test.ts`
Expected: PASS (6 passed)

---

### Task 2: Isomorphic `McpEngine` JSON-RPC 2.0 Dispatcher

**Files:**
- Create: `src/shared/mcp/server.ts`
- Test: `tests/mcp-engine.test.ts`

**Interfaces:**
- Consumes: `src/shared/mcp/types.ts`, `src/shared/mcp/tools.ts`, `src/shared/mcp/guard.ts`, `src/shared/version.ts` (`getVersionInfo`)
- Produces:
  - `src/shared/mcp/server.ts`:
    - `export class McpEngine`
    - `constructor(adapter: McpBackendAdapter, policy?: McpSecurityPolicy)`
    - `public async handleMessage(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>`
    - `public async handleRawLine(line: string): Promise<string | null>`

- [x] **Step 1: Write the failing test in `tests/mcp-engine.test.ts`**

```typescript
import { McpEngine } from '../src/shared/mcp/server';
import { McpBackendAdapter, McpHostEntry } from '../src/shared/mcp/types';

function createMockAdapter(): jest.Mocked<McpBackendAdapter> {
  const hosts: McpHostEntry[] = [
    { id: 'node-1', name: 'web-prod', status: 'online' },
    { id: 'node-2', name: 'db-offline', status: 'offline' },
  ];
  return {
    listNodes: jest.fn().mockResolvedValue(hosts),
    startExec: jest.fn().mockResolvedValue({
      success: true,
      taskId: 'task-100',
      completed: true,
      exitCode: 0,
      output: 'hello world\n',
    }),
    getExecStatus: jest.fn().mockResolvedValue({
      success: true,
      taskId: 'task-100',
      status: 'completed',
      exitCode: 0,
      output: 'chunk-output-data',
      nextOffset: 17,
    }),
    killExec: jest.fn().mockResolvedValue({ success: true, taskId: 'task-100' }),
    listExec: jest.fn().mockResolvedValue({ success: true, tasks: [{ taskId: 'task-100' }] }),
    listFiles: jest.fn().mockResolvedValue({ success: true, currentPath: '/tmp', files: [] }),
    readFileContent: jest.fn().mockResolvedValue({
      success: true,
      path: '/tmp/a.txt',
      content: '0123456789abcdef',
      size: 16,
      isBinary: false,
    }),
    saveFileContent: jest.fn().mockResolvedValue({ success: true }),
    createDirectory: jest.fn().mockResolvedValue({ success: true }),
    deleteItem: jest.fn().mockResolvedValue({ success: true }),
    renameFile: jest.fn().mockResolvedValue({ success: true }),
    listCronJobs: jest.fn().mockResolvedValue({ success: true, data: [] }),
    addCronJob: jest.fn().mockResolvedValue({ success: true, data: { id: 'job-1' } }),
    updateCronJob: jest.fn().mockResolvedValue({ success: true, data: { id: 'job-1', status: 'paused' } }),
    deleteCronJob: jest.fn().mockResolvedValue({ success: true }),
    triggerCronJob: jest.fn().mockResolvedValue({ success: true }),
    getCronJobLogs: jest.fn().mockResolvedValue({ success: true, data: [{ output: 'cron-log-line' }] }),
  };
}

describe('McpEngine JSON-RPC 2.0 Dispatcher', () => {
  test('handles initialize, notifications/initialized, and ping', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const initRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(initRes.result.protocolVersion).toBe('2025-03-26');
    expect(initRes.result.serverInfo.name).toBe('gt-mcp');

    const notifRes = await engine.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notifRes).toBeNull();

    const pingRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 'ping-1',
      method: 'ping',
    });
    expect(pingRes.result).toEqual({});
  });

  test('distinguishes id: null (valid request) from omitted id (notification) and rejects empty batch []', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const nullIdRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: null,
      method: 'ping',
    });
    expect(nullIdRes).toEqual({ jsonrpc: '2.0', id: null, result: {} });

    const emptyBatchRes: any = await engine.handleMessage([]);
    expect(emptyBatchRes.error.code).toBe(-32600);
  });

  test('executes gt_list_nodes (filtering offline by default) and gt_exec with name resolution', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter);

    const listOnline: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gt_list_nodes', arguments: {} },
    });
    const parsedOnline = JSON.parse(listOnline.result.content[0].text);
    expect(parsedOnline.nodes).toHaveLength(1);
    expect(parsedOnline.nodes[0].id).toBe('node-1');

    const execCall: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'gt_exec',
        arguments: { node: 'web-prod', command: 'echo hi', detach: true },
      },
    });
    expect(adapter.startExec).toHaveBeenCalledWith(
      'node-1',
      expect.objectContaining({ command: 'echo hi', waitMs: 0 })
    );
    expect(execCall.result.isError).toBe(false);
  });

  test('handles gt_read_file slicing, binary file rejection, and output truncation', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter, { maxOutputChars: 8 });

    const sliceRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'gt_read_file',
        arguments: { node: 'node-1', path: '/tmp/a.txt', offset: 2, limit: 12 },
      },
    });
    const body = JSON.parse(sliceRes.result.content[0].text);
    expect(body.truncated).toBe(true);
    expect(body.nextOffset).toBe(10);
    expect(body.content).toContain('23456789');

    adapter.readFileContent.mockResolvedValueOnce({
      success: true,
      path: '/tmp/bin',
      size: 100,
      isBinary: true,
    });
    const binRes: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'gt_read_file', arguments: { node: 'node-1', path: '/tmp/bin' } },
    });
    expect(binRes.result.isError).toBe(true);
    expect(binRes.result.content[0].text).toContain('Cannot read binary file as text');
  });

  test('enforces readOnly and allowedNodes guardrails in tools/call', async () => {
    const adapter = createMockAdapter();
    const engine = new McpEngine(adapter, { readOnly: true, allowedNodes: ['web-prod'] });

    const roBlock: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'gt_write_file', arguments: { node: 'web-prod', path: '/a', content: 'x' } },
    });
    expect(roBlock.result.isError).toBe(true);
    expect(roBlock.result.content[0].text).toContain('disabled in read-only mode');

    const nodeBlock: any = await engine.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'gt_list_files', arguments: { node: 'db-offline' } },
    });
    expect(nodeBlock.result.isError).toBe(true);
    expect(nodeBlock.result.content[0].text).toContain('not in the allowed nodes list');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp-engine.test.ts`
Expected: FAIL with `Cannot find module '../src/shared/mcp/server'`

- [x] **Step 3: Implement `McpEngine` in `src/shared/mcp/server.ts`**

Implement `McpEngine` supporting `initialize`, `ping`, `tools/list`, `tools/call` across all 17 tools, batch requests, notification suppression (`id === undefined`), `gt_read_file` offset/limit slicing + binary check, and `truncateText` on `gt_exec`, `gt_task_status`, `gt_read_file`, and `gt_cron_logs`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/mcp-engine.test.ts`
Expected: PASS (5 passed)

---

### Task 3: Server-Side `DirectServiceAdapter` & Express `/api/terminal/mcp` Route

**Files:**
- Create: `src/terminal/adapters/mcpDirectAdapter.ts`
- Create: `src/terminal/controllers/terminalMcpController.ts`
- Modify: `src/terminal/routes/terminalRoutes.ts`
- Test: `tests/mcp-http.test.ts`

**Interfaces:**
- Consumes: `src/shared/mcp/server.ts`, `src/terminal/services/terminalHostManager.ts`, `src/terminal/services/terminalExecService.ts`, `src/terminal/services/terminalFileService.ts`, `src/terminal/services/terminalCronService.ts`
- Produces:
  - `src/terminal/adapters/mcpDirectAdapter.ts`: `export class DirectServiceAdapter implements McpBackendAdapter`, `export const mcpDirectAdapter: DirectServiceAdapter`
  - `src/terminal/controllers/terminalMcpController.ts`: `export class TerminalMcpController`, `handlePost(req: Request, res: Response)`, `handleGet(req: Request, res: Response)`, `extractMcpPolicy(req: Request): McpSecurityPolicy`
  - `src/terminal/routes/terminalRoutes.ts`: `GET /api/terminal/mcp`, `POST /api/terminal/mcp`

- [x] **Step 1: Write the failing test in `tests/mcp-http.test.ts`**

```typescript
import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('HTTP MCP Endpoint (/api/terminal/mcp)', () => {
  const adminKey = config.adminAuthKey;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rejects unauthenticated requests with 401/403 and serves discovery metadata on GET', async () => {
    const unauth = await request(app).get('/api/terminal/mcp');
    expect([401, 403]).toContain(unauth.status);

    const res = await request(app)
      .get('/api/terminal/mcp')
      .set('x-admin-key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      name: 'gt-mcp',
      protocol: 'mcp-jsonrpc-2.0',
    });
  });

  test('handles initialize, notification (202), and tools/list with x-mcp-readonly header', async () => {
    const notifRes = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notifRes.status).toBe(202);

    const listRoRes = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .set('x-mcp-readonly', 'true')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listRoRes.status).toBe(200);
    expect(listRoRes.body.result.tools).toHaveLength(7);
  });

  test('executes gt_list_nodes with x-mcp-nodes allowlist header via DirectServiceAdapter', async () => {
    jest.spyOn(terminalHostManager, 'getHosts').mockReturnValue([
      {
        id: 'h-1',
        name: 'allowed-host',
        hostname: 'h1',
        ip: '10.0.0.1',
        platform: 'linux',
        status: 'online',
        lastSeen: Date.now(),
        type: 'agent',
      },
      {
        id: 'h-2',
        name: 'secret-host',
        hostname: 'h2',
        ip: '10.0.0.2',
        platform: 'linux',
        status: 'online',
        lastSeen: Date.now(),
        type: 'agent',
      },
    ]);

    const res = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .set('x-mcp-nodes', 'allowed-host')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'gt_list_nodes', arguments: { all: true } },
      });

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].name).toBe('allowed-host');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp-http.test.ts`
Expected: FAIL with 404 Not Found on `/api/terminal/mcp`

- [x] **Step 3: Implement `DirectServiceAdapter`, `TerminalMcpController`, and mount `/mcp` in `terminalRoutes.ts`**

Create `src/terminal/adapters/mcpDirectAdapter.ts` delegating to `terminalHostManager`, `terminalExecService`, `terminalFileService`, and `terminalCronService`.
Create `src/terminal/controllers/terminalMcpController.ts` parsing `x-mcp-readonly`, `x-mcp-nodes`, and `x-mcp-max-output` headers/query params and invoking `new McpEngine(mcpDirectAdapter, policy)`.
Register `router.get('/mcp', ...)` and `router.post('/mcp', ...)` in `src/terminal/routes/terminalRoutes.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/mcp-http.test.ts`
Expected: PASS (3 passed)

---

### Task 4: CLI `RestApiClientAdapter` & `gt mcp` Stdio Command

**Files:**
- Create: `src/client/commands/mcp.ts`
- Modify: `src/client/index.ts`
- Test: `tests/mcp-cli.test.ts`

**Interfaces:**
- Consumes: `src/shared/mcp/server.ts`, `src/client/utils/terminalUI.ts` (`makeRequest`)
- Produces:
  - `src/client/commands/mcp.ts`:
    - `export class RestApiClientAdapter implements McpBackendAdapter`
    - `export function attachMcpStdioTransport(engine: McpEngine, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>`
    - `export async function handleMcpCommand(opts: { server: string; key: string; readOnly?: boolean; nodes?: string[]; maxOutputChars?: number; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<void>`
  - `src/client/index.ts`: registers `gt mcp` command with `--read-only`, `--nodes <nodes>`, `--max-output <chars>`, `-s, --server <url>`, `-k, --key <secret>`, `-c, --context <name>`

- [x] **Step 1: Write the failing test in `tests/mcp-cli.test.ts`**

```typescript
import { PassThrough } from 'stream';
import http from 'http';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { handleMcpCommand } from '../src/client/commands/mcp';
import { createProgram } from '../src/client/index';

describe('CLI gt mcp Stdio & RestApiClientAdapter', () => {
  let server: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  test('createProgram registers mcp command with expected flags', () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === 'mcp');
    expect(mcpCmd).toBeDefined();
    const optionFlags = mcpCmd!.options.map((o) => o.long);
    expect(optionFlags).toEqual(
      expect.arrayContaining(['--read-only', '--nodes', '--max-output', '--server', '--key', '--context'])
    );
  });

  test('processes newline-delimited JSON-RPC over stdio, ignores blank lines, and handles parse errors without crashing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputLines: string[] = [];

    output.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) outputLines.push(line.trim());
      }
    });

    const sessionPromise = handleMcpCommand({
      server: serverUrl,
      key: config.adminAuthKey,
      readOnly: true,
      input,
      output,
    });

    // 1. Blank line (should be ignored)
    input.write('\n   \n');
    // 2. Malformed JSON (should emit -32700 parse error and continue)
    input.write('{bad json\n');
    // 3. Notification (should produce no output)
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    // 4. Call gt_list_nodes over RestApiClientAdapter
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'gt_list_nodes', arguments: { all: true } },
      }) + '\n'
    );
    input.end();

    await sessionPromise;

    expect(outputLines).toHaveLength(2);
    const errFrame = JSON.parse(outputLines[0]);
    expect(errFrame.error.code).toBe(-32700);

    const nodesFrame = JSON.parse(outputLines[1]);
    expect(nodesFrame.id).toBe(42);
    expect(nodesFrame.result.isError).toBe(false);
    const parsedContent = JSON.parse(nodesFrame.result.content[0].text);
    expect(parsedContent.success).toBe(true);
    expect(Array.isArray(parsedContent.nodes)).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp-cli.test.ts`
Expected: FAIL with `Cannot find module '../src/client/commands/mcp'`

- [x] **Step 3: Implement `src/client/commands/mcp.ts` and register `gt mcp` in `src/client/index.ts`**

Create `src/client/commands/mcp.ts` with `RestApiClientAdapter` (calling `/api/terminal/*` via `makeRequest`), `attachMcpStdioTransport` (using `readline.createInterface` over `input`, ignoring blank lines, writing responses + `\n` to `output`), and `handleMcpCommand` (redirecting `console.log`/`info`/`warn` to `process.stderr` when using default `process.stdout`).
Register `program.command('mcp')` in `src/client/index.ts` and export `handleMcpCommand` and `RestApiClientAdapter`.

- [x] **Step 4: Run test and build CLI bundle to verify everything passes**

Run: `npm run build:gt && npm test -- tests/mcp-guard.test.ts tests/mcp-engine.test.ts tests/mcp-http.test.ts tests/mcp-cli.test.ts`
Expected: PASS (all 4 test suites pass and `dist/gt.js` bundles cleanly)
