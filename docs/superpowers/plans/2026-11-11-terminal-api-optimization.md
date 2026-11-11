# Terminal Control API Standardization & Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize `gt-hub` terminal control APIs by unifying `hostId`/`nodeId` parameter extraction and `/files/:hostId/*` routes, mapping RPC errors to semantic HTTP status codes (`400`/`403`/`404`/`503`/`504`), adding `BIN_MSG_TYPE.CONTROL_JSON (0x08)` binary control frames while decoupling `RpcDispatcher` from `session.write()`, adding `waitMs` hybrid sync/async execution and `scriptName` support to `POST /api/terminal/exec/:hostId`, and standardizing `success: boolean` response envelopes.

**Architecture:** Introduce lightweight utility modules (`requestParams.ts`, `httpErrorMapper.ts`) consumed across all terminal controllers; extend `binaryProtocol.ts` with `CONTROL_JSON: 0x08` and strict `isValidControlPayload` whitelisting so arbitrary terminal text starting with `JSON:` is never swallowed and disconnected sessions never buffer RPC frames into `pendingInputBuffer`; and add an event-driven `taskWaiters` map in `TerminalExecService` that resolves within `waitMs` (`200 OK`) or falls back to `202 Accepted` + webhook callback.

**Tech Stack:** TypeScript, Node.js, Express, `ws`, Jest (`supertest`).

**Spec:** `docs/superpowers/specs/2026-11-11-terminal-api-optimization-design.md`

## Global Constraints

- Targeted test execution during iterative development: `npm test -- tests/terminalApiOptimization.test.ts`
- Rebuild CLI bundle when `src/agent/` or `src/shared/` changes: `npm run build:gt`
- Maintain 100% backward compatibility with all existing routes, flat response fields (`hosts`, `logs`, `version`, `ports`), and existing test suites.
- `extractHostId(req)` checks `req.params.hostId`, `req.params.nodeId`, `req.query.hostId`, `req.query.nodeId`, `req.body?.hostId`, `req.body?.nodeId` in that exact priority order.
- `mapRpcErrorToHttpStatus(errorMsg, fallbackStatus)` maps offline/disconnected errors to `503`, timeouts to `504`, permission/sandbox/traversal errors to `403`, not-found errors to `404`, and validation errors to `400`.
- `BIN_MSG_TYPE.CONTROL_JSON` is `0x08`. Both Hub and Agent accept `0x08` binary control packets as well as `JSON:` text frames whose parsed object passes `isValidControlPayload`.
- When `waitMs > 0` and a task completes within `waitMs`, `POST /api/terminal/exec/:hostId` returns `200 OK` (`completed: true`) and skips any registered `callback` (`callbackRegistered: false, callbackSkippedReason: 'completed_within_wait'`).

## Review Focus

1. **Fast task finishes before `executeCmdRpc` start reply returns (`Task 3`)**: When `waitMs > 0`, a fast command on the Agent can emit `cmd_task_finished` before or right as `cmd_exec_res` arrives. `taskWaiters` must be registered with `taskId` **before** calling `executeCmdRpc` (and cleaned up in `finally`/error paths) so the completion event is never missed.
2. **Terminal user input or output starting with `JSON:` (`Task 2`)**: If a user types `JSON: hello` or a program prints `JSON:{"notAValidControl":1}`, `isValidControlPayload` must return `false` and the frame must pass through as normal terminal data rather than being silently dropped.
3. **Disconnected session RPC pollution (`Task 2`)**: Calling `rpcDispatcher.executeCmdRpc` or `executeFileRpc` when `session.getAgentWs()` is null or closed must immediately return `{ success: false, error: ... }` without calling `session.write()`, leaving `session.pendingInputBuffer` untouched.
4. **Script execution with custom `stdin` and special characters in `scriptArgs` (`Task 3`)**: When `scriptName` is executed with `scriptArgs` containing spaces/quotes AND a custom `stdin` payload, `sh -c <quotedScriptContent> <quotedScriptName> <quotedArgs...>` must preserve both positional arguments (`$1`, `$2`) and standard input.
5. **Existing mock tests in `tests/terminalExecController.test.ts` (`Task 1 & Task 3`)**: `tests/terminalExecController.test.ts` mocks `terminalExecService.startExecution` to return `{ success: true, taskId: 'task-123', status: 'running', command: 'echo 1' }`. The controller must still call `terminalExecService.startExecution(hostId, ...)` with backward-compatible arguments when `waitMs` and `scriptName` are omitted, returning `202` unless `result.completed === true`.

---

### Task 1: Unified Parameter Extraction, HTTP Error Status Mapper & JSON Response Envelopes

**Files:**
- Create: `src/terminal/utils/requestParams.ts`
- Create: `src/terminal/utils/httpErrorMapper.ts`
- Modify: `src/terminal/routes/terminalRoutes.ts`
- Modify: `src/terminal/controllers/terminalFileController.ts`
- Modify: `src/terminal/controllers/terminalExecController.ts`
- Modify: `src/terminal/controllers/terminalCronController.ts`
- Modify: `src/terminal/controllers/terminalHostController.ts`
- Modify: `src/terminal/controllers/terminalLogController.ts`
- Modify: `src/terminal/routes/proxyRoutes.ts`
- Test: `tests/terminalApiOptimization.test.ts`

**Interfaces:**
- Produces in `src/terminal/utils/requestParams.ts`:
  ```ts
  import { Request } from 'express';
  export function extractHostId(req: Request): string;
  ```
- Produces in `src/terminal/utils/httpErrorMapper.ts`:
  ```ts
  export function mapRpcErrorToHttpStatus(errorMsg?: string | null, fallbackStatus?: number): number;
  ```

- [x] **Step 1: Write failing tests for Task 1 in `tests/terminalApiOptimization.test.ts`**

```ts
import request from 'supertest';
import express from 'express';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import proxyRoutes from '../src/terminal/routes/proxyRoutes';
import { extractHostId } from '../src/terminal/utils/requestParams';
import { mapRpcErrorToHttpStatus } from '../src/terminal/utils/httpErrorMapper';
import terminalFileService from '../src/terminal/services/terminalFileService';
import terminalExecService from '../src/terminal/services/terminalExecService';
import config from '../config/default';

describe('Task 1: Unified Params, HTTP Error Mapping & Response Envelopes', () => {
  const adminKey = 'test-opt-key';
  const originalKey = config.adminSecretKey;
  let app: express.Express;

  beforeAll(() => {
    config.adminSecretKey = adminKey;
    app = express();
    app.use('/api/proxy', proxyRoutes);
    app.use(express.json());
    app.use('/api/terminal', terminalRoutes);
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
    jest.restoreAllMocks();
  });

  test('extractHostId resolves hostId/nodeId across params, query, and body by priority', () => {
    expect(
      extractHostId({
        params: { hostId: 'from-param' },
        query: { hostId: 'from-query' },
        body: { hostId: 'from-body' },
      } as any)
    ).toBe('from-param');

    expect(
      extractHostId({
        params: {},
        query: { nodeId: 'from-query-node' },
        body: { hostId: 'from-body' },
      } as any)
    ).toBe('from-query-node');

    expect(
      extractHostId({
        params: {},
        query: {},
        body: { hostId: '  from-body-trimmed  ' },
      } as any)
    ).toBe('from-body-trimmed');
  });

  test('mapRpcErrorToHttpStatus maps offline, timeout, permission, not-found, and validation errors', () => {
    expect(mapRpcErrorToHttpStatus('Agent "node-1" is offline or unavailable')).toBe(503);
    expect(mapRpcErrorToHttpStatus('Node "node-1" is offline')).toBe(503);
    expect(mapRpcErrorToHttpStatus('Agent command RPC request timed out (30s)')).toBe(504);
    expect(mapRpcErrorToHttpStatus('EACCES: permission denied, open /etc/shadow')).toBe(403);
    expect(mapRpcErrorToHttpStatus('Access denied: Path is outside agent workspace')).toBe(403);
    expect(mapRpcErrorToHttpStatus('No such file or directory')).toBe(404);
    expect(mapRpcErrorToHttpStatus('No such task: task-1')).toBe(404);
    expect(mapRpcErrorToHttpStatus('Invalid cron expression: "bad"')).toBe(400);
    expect(mapRpcErrorToHttpStatus('Unexpected internal failure', 500)).toBe(500);
  });

  test('file endpoints accept hostId in path (/files/:hostId/*), query, or body and map offline/permission errors', async () => {
    const listSpy = jest.spyOn(terminalFileService, 'listFiles').mockResolvedValueOnce({
      success: true,
      files: [],
      currentPath: '/tmp',
    } as any);

    const pathRes = await request(app)
      .get('/api/terminal/files/node-path-1/list?path=/tmp')
      .set('x-admin-key', adminKey);
    expect(pathRes.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith('node-path-1', '/tmp');

    const saveSpy = jest.spyOn(terminalFileService, 'saveFileContent').mockResolvedValueOnce({
      success: false,
      error: 'EACCES: permission denied',
    } as any);

    // Passing hostId via query to POST /files/save (previously failed with 400)
    const saveRes = await request(app)
      .post('/api/terminal/files/save?hostId=node-query-1')
      .set('x-admin-key', adminKey)
      .send({ path: '/etc/hosts', content: 'test' });
    expect(saveRes.status).toBe(403);
    expect(saveSpy).toHaveBeenCalledWith('node-query-1', '/etc/hosts', 'test');

    listSpy.mockRestore();
    saveSpy.mockRestore();
  });

  test('exec status, kill, list, and cron trigger return 503 when node is offline', async () => {
    const statusRes = await request(app)
      .get('/api/terminal/exec/offline-node-xyz/task-1')
      .set('x-admin-key', adminKey);
    expect(statusRes.status).toBe(503);

    const killRes = await request(app)
      .post('/api/terminal/exec/offline-node-xyz/task-1/kill')
      .set('x-admin-key', adminKey);
    expect(killRes.status).toBe(503);

    const listRes = await request(app)
      .get('/api/terminal/exec/offline-node-xyz')
      .set('x-admin-key', adminKey);
    expect(listRes.status).toBe(503);
  });

  test('hosts, version, logs, and proxy endpoints include top-level success boolean', async () => {
    const hostsRes = await request(app).get('/api/terminal/hosts').set('x-admin-key', adminKey);
    expect(hostsRes.status).toBe(200);
    expect(hostsRes.body.success).toBe(true);
    expect(Array.isArray(hostsRes.body.hosts)).toBe(true);

    const verRes = await request(app).get('/api/terminal/version').set('x-admin-key', adminKey);
    expect(verRes.status).toBe(200);
    expect(verRes.body.success).toBe(true);
    expect(verRes.body.version).toBeDefined();

    const logsRes = await request(app).get('/api/terminal/logs').set('x-admin-key', adminKey);
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.success).toBe(true);
    expect(Array.isArray(logsRes.body.logs)).toBe(true);

    const proxyUnauth = await request(app).get('/api/proxy/node-1/ports');
    expect(proxyUnauth.status).toBe(401);
    expect(proxyUnauth.body.success).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalApiOptimization.test.ts`
Expected: FAIL (`Cannot find module '../src/terminal/utils/requestParams'`)

- [x] **Step 3: Implement `requestParams.ts`, `httpErrorMapper.ts`, route aliases, error mappings, and response envelopes**

- Create `src/terminal/utils/requestParams.ts` with `extractHostId(req: Request): string`.
- Create `src/terminal/utils/httpErrorMapper.ts` with `mapRpcErrorToHttpStatus(errorMsg?: string | null, fallbackStatus: number = 500): number`.
- In `src/terminal/routes/terminalRoutes.ts`: add `/files/:hostId/list`, `/files/:hostId/content`, `/files/:hostId/save`, `/files/:hostId/mkdir`, `/files/:hostId/rename`, `/files/:hostId/delete`, `/files/:hostId/download`, `/files/:hostId/upload`.
- Update `terminalFileController.ts`, `terminalExecController.ts`, and `terminalCronController.ts` to use `extractHostId(req)` and `mapRpcErrorToHttpStatus`.
- Update `terminalHostController.ts`, `terminalLogController.ts`, and `proxyRoutes.ts` to include `success: true` / `success: false` in JSON responses.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalApiOptimization.test.ts`
Expected: PASS (5 tests passing)

---

### Task 2: Binary Control Frames (`BIN_MSG_TYPE.CONTROL_JSON = 0x08`), Strict `JSON:` Validation & `RpcDispatcher` Decoupling

**Files:**
- Modify: `src/shared/protocol/binaryProtocol.ts`
- Modify: `src/terminal/services/rpcDispatcher.ts`
- Modify: `src/terminal/services/terminalHostManager.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Modify: `src/agent/daemon.ts`
- Modify: `src/client/utils/terminalUI.ts`
- Test: `tests/terminalApiOptimization.test.ts`

**Interfaces:**
- Produces in `src/shared/protocol/binaryProtocol.ts`:
  ```ts
  export const BIN_MSG_TYPE = {
    STREAM_INPUT: 0x01,
    STREAM_OUTPUT: 0x02,
    TERMINAL_RAW: 0x03,
    HISTORY_SYNC: 0x04,
    PROXY_HTTP_REQ_BODY: 0x05,
    PROXY_HTTP_RES_BODY: 0x06,
    PROXY_TCP_DATA: 0x07,
    CONTROL_JSON: 0x08,
  } as const;

  export function isValidControlPayload(obj: unknown): obj is Record<string, any>;
  export function encodeControlJsonPacket(control: Record<string, any>, id?: string): Buffer;
  export function decodeControlJsonPacket(buf: Buffer | Uint8Array): Record<string, any> | null;
  export function sendControlFrame(ws: any, payload: Record<string, any>, id?: string): boolean;
  ```
- Updates `RpcDispatcher.executeCmdRpc(session, canonicalId, payload, timeoutMs = 30000)` in `src/terminal/services/rpcDispatcher.ts`.

- [x] **Step 1: Add Task 2 tests to `tests/terminalApiOptimization.test.ts`**

```ts
import {
  BIN_MSG_TYPE,
  encodeControlJsonPacket,
  decodeControlJsonPacket,
  isValidControlPayload,
} from '../src/shared/protocol/binaryProtocol';
import { RpcDispatcher } from '../src/terminal/services/rpcDispatcher';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('Task 2: Binary CONTROL_JSON (0x08), JSON: Whitelist & RpcDispatcher Decoupling', () => {
  test('encodes and decodes BIN_MSG_TYPE.CONTROL_JSON (0x08) packets and validates control payloads', () => {
    expect(BIN_MSG_TYPE.CONTROL_JSON).toBe(0x08);

    const pkt = encodeControlJsonPacket({ type: 'cmd_exec', reqId: 'r1', action: 'list' }, 'node-1');
    expect(pkt[0]).toBe(0x08);

    const decoded = decodeControlJsonPacket(pkt);
    expect(decoded).toEqual({ type: 'cmd_exec', reqId: 'r1', action: 'list' });

    expect(isValidControlPayload({ type: 'ping' })).toBe(true);
    expect(isValidControlPayload({ type: 'cmd_task_finished', taskId: 't1' })).toBe(true);
    expect(isValidControlPayload({ type: 'proxy_http_res_headers' })).toBe(true);
    expect(isValidControlPayload({ type: 'unknown_random_user_field' })).toBe(false);
    expect(isValidControlPayload('not-an-object')).toBe(false);
    expect(isValidControlPayload(null)).toBe(false);
  });

  test('RemoteAgentTerminalSession.handleData does not swallow terminal output starting with JSON: when not a valid control payload', () => {
    const session = new RemoteAgentTerminalSession('host-1', null, 'main');
    session.handleData('JSON: user log line that is not json\r\n');
    session.handleData('JSON:{"notAControlFrame":true}\r\n');
    session.handleData('JSON:{"type":"ping"}'); // Valid control frame should still be ignored by terminal history

    const history = session.getHistory();
    expect(history).toContain('JSON: user log line that is not json');
    expect(history).toContain('JSON:{"notAControlFrame":true}');
    expect(history).not.toContain('"type":"ping"');
    session.destroy();
  });

  test('RpcDispatcher sends directly via agentWs without polluting session.pendingInputBuffer when disconnected', async () => {
    const dispatcher = new RpcDispatcher();
    const session = new RemoteAgentTerminalSession('host-offline', null, 'main');
    const writeSpy = jest.spyOn(session, 'write');

    const cmdRes = await dispatcher.executeCmdRpc(session, 'host-offline', { action: 'list' }, 500);
    expect(cmdRes.success).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();

    const fileRes = await dispatcher.executeFileRpc(session, 'host-offline', { action: 'list', path: '/' }, 500);
    expect(fileRes.success).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    session.destroy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalApiOptimization.test.ts`
Expected: FAIL (`BIN_MSG_TYPE.CONTROL_JSON` is `undefined`)

- [x] **Step 3: Implement `CONTROL_JSON`, `isValidControlPayload`, WebSocket dual-stack handling, and `RpcDispatcher` decoupling**

- In `src/shared/protocol/binaryProtocol.ts`:
  - Add `CONTROL_JSON: 0x08` to `BIN_MSG_TYPE`.
  - Implement `isValidControlPayload`, `encodeControlJsonPacket`, `decodeControlJsonPacket`, and `sendControlFrame`.
- In `src/terminal/services/terminalHostManager.ts`:
  - In `RemoteAgentTerminalSession.handleData`: only ignore strings starting with `'JSON:'` when `try { isValidControlPayload(JSON.parse(data.slice(5))) }` is `true`.
- In `src/terminal/services/rpcDispatcher.ts`:
  - Add `timeoutMs: number = 30000` parameter to `executeCmdRpc`.
  - Call `if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()` on both `timeoutTimer` instances.
  - When `typeof session?.getAgentWs === 'function'`, send directly via `sendControlFrame(agentWs, ...)` instead of `session.write(rpcMsg)`.
- In `src/terminal/routes/terminalWs.ts` and `src/agent/daemon.ts` (and `src/client/utils/terminalUI.ts` `parseControlMessage`):
  - Support `decoded.msgType === BIN_MSG_TYPE.CONTROL_JSON` in binary frame handlers.
  - Validate `'JSON:'` text frames with `isValidControlPayload`; if invalid, forward as raw terminal data instead of consuming/dropping.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalApiOptimization.test.ts`
Expected: PASS (8 tests passing)

---

### Task 3: `POST /api/terminal/exec/:hostId` Enhancements (`waitMs` Hybrid Sync/Async & `scriptName` Execution)

**Files:**
- Modify: `src/terminal/services/terminalExecService.ts`
- Modify: `src/terminal/controllers/terminalExecController.ts`
- Test: `tests/terminalApiOptimization.test.ts`

**Interfaces:**
- Consumes: `scriptService` from `src/server/modules/scripts/scriptService.ts`, `quoteShellArg` from `src/shared/utils/shell.ts`.
- Produces in `src/terminal/services/terminalExecService.ts`:
  ```ts
  export interface StartExecutionOptions {
    command?: string;
    scriptName?: string;
    scriptArgs?: string[];
    cwd?: string;
    timeoutMs?: number;
    waitMs?: number;
    env?: Record<string, string>;
    stdin?: string;
    callback?: ExecCallbackConfig;
  }
  ```

- [x] **Step 1: Add Task 3 end-to-end tests in `tests/terminalApiOptimization.test.ts`**

```ts
import http from 'http';
import WebSocket from 'ws';
import app from '../src/server/app';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';
import { scriptService } from '../src/server/modules/scripts/scriptService';
import { encodeControlJsonPacket } from '../src/shared/protocol/binaryProtocol';

describe('Task 3: POST /api/terminal/exec/:hostId with waitMs, scriptName & binary CONTROL_JSON', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let wss: any;
  let agentWs: WebSocket;
  const adminKey = 'test-opt-e2e-key';
  const originalKey = config.adminSecretKey;
  const hostId = 'opt-e2e-node';

  beforeAll(async () => {
    config.adminSecretKey = adminKey;
    await scriptService.saveScript('hello_args.sh', '#!/bin/sh\nread input_line\necho "script:$1:$2:$input_line"');

    hubServer = http.createServer(app);
    wss = setupTerminalWebSocket(hubServer, terminalHostManager);
    await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
    hubPort = (hubServer.address() as any).port;

    agentWs = new WebSocket(
      `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${hostId}&name=opt-node&binaryControl=1`,
      { headers: { 'x-admin-key': adminKey } }
    );

    await new Promise<void>((resolve, reject) => {
      agentWs.on('message', (data, isBinary) => {
        let ctrl: any = null;
        if (isBinary) {
          ctrl = decodeControlJsonPacket(data as Buffer);
        } else {
          const str = data.toString();
          if (str.startsWith('JSON:')) ctrl = JSON.parse(str.slice(5));
        }
        if (ctrl) {
          if (ctrl.type === 'registered') resolve();
          if (ctrl.type === 'cmd_exec') {
            handleCmdExec(ctrl, {
              readyState: 1,
              send: (msg: string) => {
                if (msg.startsWith('JSON:')) {
                  agentWs.send(encodeControlJsonPacket(JSON.parse(msg.slice(5)), hostId));
                } else {
                  agentWs.send(msg);
                }
              },
            });
          }
        }
      });
      agentWs.on('error', reject);
    });
  });

  afterAll(async () => {
    config.adminSecretKey = originalKey;
    try { await scriptService.deleteScript('hello_args.sh'); } catch {}
    if (agentWs && agentWs.readyState === WebSocket.OPEN) agentWs.close();
    if (wss && wss.closeAllClients) wss.closeAllClients();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
  });

  test('completes synchronously with 200 OK within waitMs and skips webhook callback', async () => {
    let webhookCalled = false;
    const receiver = http.createServer((_req, res) => {
      webhookCalled = true;
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const res = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'echo "sync-fast-ok"',
        waitMs: 3000,
        callback: {
          url: `http://127.0.0.1:${receiverPort}/hook`,
        },
      });

    await new Promise((r) => setTimeout(r, 150));
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.completed).toBe(true);
    expect(res.body.status).toBe('completed');
    expect(res.body.exitCode).toBe(0);
    expect(res.body.stdout).toContain('sync-fast-ok');
    expect(res.body.callbackRegistered).toBe(false);
    expect(res.body.callbackSkippedReason).toBe('completed_within_wait');
    expect(webhookCalled).toBe(false);
  });

  test('falls back to 202 Accepted and delivers webhook when task exceeds waitMs', async () => {
    let receivedPayload: any = null;
    let webhookResolve!: () => void;
    const webhookPromise = new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });

    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedPayload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200);
        res.end('ok');
        webhookResolve();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const res = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'sleep 0.3 && echo "slow-finished"',
        waitMs: 50,
        callback: {
          url: `http://127.0.0.1:${receiverPort}/hook`,
          context: { mode: 'fallback' },
        },
      });

    expect(res.status).toBe(202);
    expect(res.body.completed).toBe(false);
    expect(res.body.status).toBe('running');
    expect(res.body.callbackRegistered).toBe(true);

    await webhookPromise;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(receivedPayload.taskId).toBe(res.body.taskId);
    expect(receivedPayload.execution.stdout).toContain('slow-finished');
    expect(receivedPayload.context).toEqual({ mode: 'fallback' });
  });

  test('executes Hub script via scriptName + scriptArgs + stdin and returns 404 for unknown script', async () => {
    const res = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        scriptName: 'hello_args.sh',
        scriptArgs: ['arg one', 'arg2'],
        stdin: 'from-stdin\n',
        waitMs: 3000,
      });

    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.stdout.trim()).toBe('script:arg one:arg2:from-stdin');

    const notFoundRes = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        scriptName: 'non_existent_script.sh',
      });
    expect(notFoundRes.status).toBe(404);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalApiOptimization.test.ts`
Expected: FAIL (`res.status` is `202` instead of `200`, and `scriptName` returns `400 Field "command" is required`)

- [x] **Step 3: Implement `waitMs` and `scriptName` in `terminalExecService.ts` and `terminalExecController.ts`**

- In `src/terminal/controllers/terminalExecController.ts`:
  - Extract `{ command, scriptName, scriptArgs, cwd, timeoutMs, waitMs, env, stdin, callback }` from `req.body || {}`.
  - Validate that either `command` (non-empty string) or `scriptName` (non-empty string) is supplied; otherwise return `400` (`Field "command" or "scriptName" is required`).
  - If `scriptArgs !== undefined`, verify `Array.isArray(scriptArgs)` or return `400`.
  - Only pass extra fields (`scriptName`, `scriptArgs`, `waitMs`, `callback`) into `terminalExecService.startExecution` when they are defined so existing unit test spy assertions on `startExecution` remain 100% compatible.
  - Return `res.status(result.completed ? 200 : 202).json(result)` on success.
- In `src/terminal/services/terminalExecService.ts`:
  - If `options.scriptName` is provided without `options.command`, load the script via `await scriptService.getScript(options.scriptName.trim())` (catching errors and returning `{ success: false, error: err.message }`), and build the command using `quoteShellArg`:
    ```ts
    const argsPart = (options.scriptArgs || []).map((a) => quoteShellArg(String(a))).join(' ');
    resolvedCommand = `sh -c ${quoteShellArg(script.content)} ${quoteShellArg(script.name)}${argsPart ? ' ' + argsPart : ''}`;
    ```
  - For `waitMs > 0` (clamped to `[0, 60000]`):
    - Register a waiter in `private taskWaiters: Map<string, (data: any) => void>` keyed by `taskId` **before** calling `terminalHostManager.executeCmdRpc`.
    - If `executeCmdRpc` fails, delete the waiter and return the error.
    - Race the waiter promise against a `waitMs` timeout:
      - If resolved within `waitMs`, return `{ success: true, completed: true, taskId: effectiveTaskId, hostId: trimmedHost, command: trimmedCmd, cwd: finishedData.cwd || options.cwd, status: finishedData.status, exitCode: finishedData.exitCode, stdout: finishedData.stdout || '', stderr: finishedData.stderr || '', output: finishedData.output || '', totalBytes: finishedData.totalBytes || 0, durationMs: finishedData.durationMs ?? 0, startTime: finishedData.startTime || res.data.startTime, endTime: finishedData.endTime || Date.now(), ...(options.callback ? { callbackRegistered: false, callbackSkippedReason: 'completed_within_wait' } : {}) }`.
      - If timed out, delete the waiter from `this.taskWaiters`, register `options.callback` with `terminalExecCallbackService.registerCallback` if present, and return `{ success: true, completed: false, taskId: effectiveTaskId, hostId: trimmedHost, ...res.data, ...(options.callback ? { callbackRegistered: true } : {}) }`.

- [x] **Step 4: Rebuild CLI bundle and run targeted + regression test suites**

Run: `npm run build:gt && npm test -- tests/terminalApiOptimization.test.ts tests/terminalExecController.test.ts tests/botExecCallback.test.ts tests/terminalCronApi.test.ts tests/terminalHostsApi.test.ts`
Expected: PASS (all suites green)
