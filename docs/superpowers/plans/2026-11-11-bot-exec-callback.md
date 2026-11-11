# Bot Command Execution & Webhook Callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `POST /api/terminal/exec/:hostId` with an optional `callback` webhook configuration so remote command executions automatically push standardized completion payloads to external bot services without polling.

**Architecture:** When an execution task enters a terminal state (`completed`, `failed`, `timeout`, or `killed`) on the Agent, `TaskManager` emits a single completion event that `handleCmdExec` forwards over the reverse WebSocket tunnel as a `cmd_task_finished` control frame. On the Hub, `TerminalExecCallbackService` matches the `taskId`, applies UTF-8 safe tail truncation to `stdout`/`stderr`/`output`, signs the payload with HMAC-SHA256 when `secret` is provided, and delivers the webhook with exponential backoff retries.

**Tech Stack:** TypeScript, Node.js (`http`, `https`, `crypto`, `child_process`), Express, `ws`, Jest (`supertest`).

**Spec:** `docs/superpowers/specs/2026-11-11-bot-exec-callback-design.md`

## Global Constraints

- Targeted test execution during iterative development: `npm test -- tests/botExecCallback.test.ts`
- Rebuild CLI bundle when `src/agent/` changes if tests import `scripts/gt.js`: `npm run build:gt`
- `callback.url` must be a valid `http://` or `https://` URL; invalid URLs return `400 Bad Request` synchronously and never register a callback.
- `callback.method` defaults to `'POST'`, accepts `'POST' | 'PUT'` (case-insensitive), and rejects other HTTP methods with `400 Bad Request`.
- Clamp ranges: `callback.timeoutMs` in `[1000, 30000]` (default `10000`), `callback.maxRetries` in `[0, 5]` (default `3`), `callback.maxOutputBytes` in `[1024, 1048576]` (default `65536`).
- System headers (`Content-Type`, `User-Agent`, `X-GT-Event`, `X-GT-Task-Id`, `X-GT-Timestamp`, `X-GT-Delivery-Attempt`, `X-GT-Signature-256`) take precedence over any case-variant keys in `callback.headers`.
- HMAC-SHA256 signature header `X-GT-Signature-256: sha256=<hex>` is computed over `${timestamp}.${rawJsonBody}` when `callback.secret` is a non-empty string.

## Review Focus

1. **Duplicate finish emission on timeout or kill (`Task 1`)**: When a task times out or is killed, `killProcessTree` terminates the child process which subsequently fires `close`. `TaskManager` must emit the completion event exactly once after final streams flush on `close` (with `notifiedFinish` guard), never twice.
2. **Duplicate `startTask` with existing `taskId` (`Task 1`)**: If `startTask` is called with a `taskId` that already exists and has already finished, or is still running, `onFinish` must not double-register or miss completion.
3. **Case-insensitive header collision in `callback.headers` (`Task 2`)**: If a caller passes `{"content-type": "text/plain", "x-gt-signature-256": "fake"}` in `callback.headers`, those keys must not override or duplicate the Hub's authoritative `Content-Type` and `X-GT-*` headers.
4. **Multi-byte UTF-8 boundary during tail truncation (`Task 2`)**: When `stdout`/`stderr`/`output` exceeds `maxOutputBytes` and the tail slice lands inside a 3-byte Chinese character or 4-byte emoji, `truncateUtf8Tail` must advance to the next valid UTF-8 leading byte so no `U+FFFD` (`�`) replacement character appears.
5. **Agent offline when `cmd_task_finished` arrives (`Task 3`)**: If the agent disconnects immediately after sending `cmd_task_finished`, `TerminalExecCallbackService` must still deliver the webhook using the host metadata snapshot captured when `registerCallback` was called.

---

### Task 1: Agent Task Completion Push (`TaskManager` & `handleCmdExec`)

**Files:**
- Modify: `src/agent/tasks/taskManager.ts`
- Modify: `src/agent/handlers/cmdExecHandler.ts`
- Test: `tests/botExecCallback.test.ts`

**Interfaces:**
- Produces in `src/agent/tasks/taskManager.ts`:
  ```ts
  export interface TaskFinishedEvent {
    taskId: string;
    command: string;
    cwd: string;
    status: 'completed' | 'failed' | 'timeout' | 'killed';
    exitCode: number | null;
    startTime: number;
    endTime: number;
    durationMs: number;
    stdout: string;
    stderr: string;
    output: string;
    totalBytes: number;
  }
  ```
  - `TaskManager.onTaskFinished(listener: (event: TaskFinishedEvent) => void): () => void`
  - `TaskManager.startTask(opts: { taskId: string; command: string; cwd?: string | null; timeoutMs?: number; env?: Record<string, any>; stdin?: string | null; onFinish?: (event: TaskFinishedEvent) => void }): any`
- Produces in `src/agent/handlers/cmdExecHandler.ts`:
  - When `action === 'start'`, passes `onFinish` to `taskManager.startTask` which sends `JSON:${JSON.stringify({ type: 'cmd_task_finished', ...event })}` over `targetWs` if `targetWs` is open.

- [x] **Step 1: Write the failing Task 1 tests in `tests/botExecCallback.test.ts`**

```ts
import { TaskManager } from '../src/agent/tasks/taskManager';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';

describe('Task 1: Agent TaskManager & handleCmdExec finish push', () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = new TaskManager({ persist: false });
  });

  afterEach(() => {
    for (const task of tm.tasks.values()) {
      if (task.child && task.status === 'running') {
        try { task.child.kill('SIGKILL'); } catch {}
      }
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      if (task.killTimer) clearTimeout(task.killTimer);
    }
  });

  test('emits onTaskFinished and per-task onFinish exactly once on completion', async () => {
    const globalEvents: any[] = [];
    const taskEvents: any[] = [];
    const unsub = tm.onTaskFinished((ev) => globalEvents.push(ev));

    tm.startTask({
      taskId: 'finish-1',
      command: 'echo "hello bot"',
      onFinish: (ev) => taskEvents.push(ev),
    });

    for (let i = 0; i < 30 && taskEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsub();

    expect(taskEvents).toHaveLength(1);
    expect(globalEvents).toHaveLength(1);
    expect(taskEvents[0]).toMatchObject({
      taskId: 'finish-1',
      status: 'completed',
      exitCode: 0,
    });
    expect(taskEvents[0].stdout).toContain('hello bot');
    expect(taskEvents[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('emits finish event exactly once when task times out or is killed', async () => {
    const timeoutEvents: any[] = [];
    tm.startTask({
      taskId: 'finish-timeout',
      command: 'sleep 10',
      timeoutMs: 150,
      onFinish: (ev) => timeoutEvents.push(ev),
    });

    for (let i = 0; i < 40 && timeoutEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0].status).toBe('timeout');

    const killEvents: any[] = [];
    tm.startTask({
      taskId: 'finish-kill',
      command: 'sleep 10',
      onFinish: (ev) => killEvents.push(ev),
    });
    await new Promise((r) => setTimeout(r, 100));
    tm.killTask('finish-kill', 'SIGTERM');

    for (let i = 0; i < 40 && killEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(killEvents).toHaveLength(1);
    expect(killEvents[0].status).toBe('killed');
  });

  test('handleCmdExec pushes cmd_task_finished frame over targetWs when task completes', async () => {
    const sentFrames: any[] = [];
    const mockWs = {
      readyState: 1,
      send: (raw: string) => {
        if (raw.startsWith('JSON:')) {
          sentFrames.push(JSON.parse(raw.slice(5)));
        }
      },
    };

    handleCmdExec(
      {
        reqId: 'req-1',
        action: 'start',
        taskId: 'cmd-push-1',
        command: 'echo "done-via-ws"',
      },
      mockWs
    );

    for (let i = 0; i < 40 && !sentFrames.some((f) => f.type === 'cmd_task_finished'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const startReply = sentFrames.find((f) => f.type === 'cmd_exec_res' && f.reqId === 'req-1');
    expect(startReply).toBeDefined();
    expect(startReply.success).toBe(true);

    const finishedFrame = sentFrames.find((f) => f.type === 'cmd_task_finished' && f.taskId === 'cmd-push-1');
    expect(finishedFrame).toBeDefined();
    expect(finishedFrame.status).toBe('completed');
    expect(finishedFrame.exitCode).toBe(0);
    expect(finishedFrame.stdout).toContain('done-via-ws');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/botExecCallback.test.ts`
Expected: FAIL (`tm.onTaskFinished is not a function`)

- [x] **Step 3: Implement `onTaskFinished`, `emitTaskFinished`, and `onFinish` in `src/agent/tasks/taskManager.ts` and `src/agent/handlers/cmdExecHandler.ts`**

In `src/agent/tasks/taskManager.ts`:
- Add `notifiedFinish?: boolean` and `onFinishCallbacks?: Array<(event: TaskFinishedEvent) => void>` to `TaskRecord`.
- Add `private finishListeners: Set<(event: TaskFinishedEvent) => void> = new Set()` and `onTaskFinished(listener): () => void` to `TaskManager`.
- Add private `emitTaskFinished(record: TaskRecord): void` that checks `if (record.notifiedFinish || record.status === 'running') return; record.notifiedFinish = true;`, constructs `TaskFinishedEvent` (`durationMs: Math.max(0, (record.endTime || Date.now()) - record.startTime)`), and invokes `record.onFinishCallbacks` and `this.finishListeners` inside `try/catch`.
- Call `this.emitTaskFinished(taskRecord)` at the end of `child.on('close')`, in `child.on('error')` (only if `!taskRecord.child?.pid`), and in `watchRunningProcess` when `!alive`.
- If `startTask` is called for an already-existing `taskId` and `onFinish` is provided: if `existing.status === 'running'`, push `onFinish` to `existing.onFinishCallbacks`; otherwise invoke `onFinish` asynchronously via `queueMicrotask`.

In `src/agent/handlers/cmdExecHandler.ts`:
- In `action === 'start'`, pass `onFinish: (event) => { if (isOpen()) targetWs.send('JSON:' + JSON.stringify({ type: 'cmd_task_finished', ...event })); }` into `taskManager.startTask`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/botExecCallback.test.ts`
Expected: PASS (3 tests passing)

---

### Task 2: Hub Webhook Callback Service (`TerminalExecCallbackService`)

**Files:**
- Create: `src/terminal/services/terminalExecCallbackService.ts`
- Modify: `tests/botExecCallback.test.ts`

**Interfaces:**
- Consumes: `sliceBufferUtf8Safe` from `src/agent/tasks/taskManager.ts`, `terminalHostManager` from `src/terminal/services/terminalHostManager.ts`, `terminalLogService` from `src/terminal/services/terminalLogService.ts`.
- Produces in `src/terminal/services/terminalExecCallbackService.ts`:
  ```ts
  export interface ExecCallbackConfig {
    url: string;
    method: 'POST' | 'PUT';
    headers: Record<string, string>;
    secret?: string;
    timeoutMs: number;
    maxRetries: number;
    maxOutputBytes: number;
    context: any;
  }

  export interface HostSnapshot {
    id: string;
    name: string;
    hostname: string;
    ip: string;
    platform: string;
  }

  export interface ExecCallbackPayload {
    event: 'exec.finished';
    timestamp: number;
    taskId: string;
    host: HostSnapshot;
    execution: {
      command: string;
      cwd: string;
      status: 'completed' | 'failed' | 'timeout' | 'killed';
      success: boolean;
      exitCode: number | null;
      startTime: number;
      endTime: number;
      durationMs: number;
      stdout: string;
      stderr: string;
      output: string;
      totalBytes: number;
      truncated: boolean;
    };
    context: any;
  }

  export function validateCallbackConfig(raw: unknown): {
    valid: boolean;
    config?: ExecCallbackConfig;
    error?: string;
  };

  export function truncateUtf8Tail(text: string, maxBytes: number): {
    text: string;
    truncated: boolean;
  };

  export class TerminalExecCallbackService {
    constructor(options?: { retryDelaysMs?: number[] });
    public registerCallback(params: {
      taskId: string;
      hostId: string;
      command: string;
      cwd?: string;
      startTime?: number;
      taskTimeoutMs?: number;
      callback: ExecCallbackConfig;
    }): void;
    public hasPendingCallback(taskId: string): boolean;
    public handleTaskFinished(hostId: string, event: any): Promise<boolean>;
    public clearAll(): void;
  }
  export const terminalExecCallbackService: TerminalExecCallbackService;
  ```

- [x] **Step 1: Add unit tests for validation, UTF-8 tail truncation, HMAC signing, header precedence, and retry behavior in `tests/botExecCallback.test.ts`**

```ts
import http from 'http';
import crypto from 'crypto';
import {
  validateCallbackConfig,
  truncateUtf8Tail,
  TerminalExecCallbackService,
} from '../src/terminal/services/terminalExecCallbackService';

describe('Task 2: TerminalExecCallbackService validation, truncation & delivery', () => {
  test('validateCallbackConfig validates URL, method, headers, and clamps numeric bounds', () => {
    expect(validateCallbackConfig(null).valid).toBe(false);
    expect(validateCallbackConfig({ url: 'ftp://example.com/hook' }).valid).toBe(false);
    expect(validateCallbackConfig({ url: 'not-a-url' }).valid).toBe(false);
    expect(validateCallbackConfig({ url: 'https://example.com/hook', method: 'GET' }).valid).toBe(false);
    expect(validateCallbackConfig({ url: 'https://example.com/hook', headers: ['bad'] }).valid).toBe(false);

    const valid = validateCallbackConfig({
      url: 'https://example.com/hook',
      method: 'put',
      headers: { Authorization: 'Bearer xxx' },
      secret: 'my-secret',
      timeoutMs: 50,
      maxRetries: 99,
      maxOutputBytes: 100,
      context: { chatId: 'c1' },
    });
    expect(valid.valid).toBe(true);
    expect(valid.config).toEqual({
      url: 'https://example.com/hook',
      method: 'PUT',
      headers: { Authorization: 'Bearer xxx' },
      secret: 'my-secret',
      timeoutMs: 1000,
      maxRetries: 5,
      maxOutputBytes: 1024,
      context: { chatId: 'c1' },
    });
  });

  test('truncateUtf8Tail preserves multi-byte UTF-8 boundaries without replacement characters', () => {
    const text = '你好世界😀测试尾部截断内容';
    const fullBytes = Buffer.byteLength(text, 'utf-8');
    expect(truncateUtf8Tail(text, fullBytes + 10)).toEqual({ text, truncated: false });

    // Slice at every possible byte limit to ensure no U+FFFD is ever produced
    for (let limit = 4; limit < fullBytes; limit++) {
      const res = truncateUtf8Tail(text, limit);
      expect(res.truncated).toBe(true);
      expect(res.text).not.toContain('�');
      expect(text.endsWith(res.text)).toBe(true);
      expect(Buffer.byteLength(res.text, 'utf-8')).toBeLessThanOrEqual(limit);
    }
  });

  test('delivers signed webhook with retry on 5xx and prevents user headers from overriding system headers', async () => {
    const receivedRequests: Array<{ headers: http.IncomingHttpHeaders; rawBody: string; body: any }> = [];
    let attemptCount = 0;

    const webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        attemptCount++;
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        receivedRequests.push({
          headers: req.headers,
          rawBody,
          body: JSON.parse(rawBody),
        });
        if (attemptCount < 3) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad gateway' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const port = (webhookServer.address() as any).port;

    const service = new TerminalExecCallbackService({ retryDelaysMs: [20, 20, 20] });
    const { config } = validateCallbackConfig({
      url: `http://127.0.0.1:${port}/webhook`,
      headers: {
        Authorization: 'Bearer custom-token',
        'content-type': 'text/plain',
        'x-gt-event': 'spoofed.event',
      },
      secret: 'top-secret-key',
      maxRetries: 3,
      context: { sessionId: 'sess-42' },
    });

    service.registerCallback({
      taskId: 'task-retry-1',
      hostId: 'node-alpha',
      command: 'echo "hello"',
      cwd: '/tmp',
      startTime: 1000,
      callback: config!,
    });

    const delivered = await service.handleTaskFinished('node-alpha', {
      taskId: 'task-retry-1',
      command: 'echo "hello"',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0,
      startTime: 1000,
      endTime: 1250,
      durationMs: 250,
      stdout: 'hello\n',
      stderr: '',
      output: 'hello\n',
      totalBytes: 6,
    });

    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));

    expect(delivered).toBe(true);
    expect(receivedRequests).toHaveLength(3);

    const finalReq = receivedRequests[2];
    expect(finalReq.headers['authorization']).toBe('Bearer custom-token');
    expect(finalReq.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(finalReq.headers['x-gt-event']).toBe('exec.finished');
    expect(finalReq.headers['x-gt-delivery-attempt']).toBe('3');

    const ts = finalReq.headers['x-gt-timestamp'] as string;
    const expectedSig =
      'sha256=' +
      crypto.createHmac('sha256', 'top-secret-key').update(`${ts}.${finalReq.rawBody}`).digest('hex');
    expect(finalReq.headers['x-gt-signature-256']).toBe(expectedSig);
    expect(finalReq.body.context).toEqual({ sessionId: 'sess-42' });
    expect(finalReq.body.execution.success).toBe(true);
  });

  test('does not retry on 400 Bad Request from webhook receiver', async () => {
    let attempts = 0;
    const webhookServer = http.createServer((_req, res) => {
      attempts++;
      res.writeHead(400);
      res.end('bad request');
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const port = (webhookServer.address() as any).port;

    const service = new TerminalExecCallbackService({ retryDelaysMs: [10, 10, 10] });
    const { config } = validateCallbackConfig({
      url: `http://127.0.0.1:${port}/webhook`,
      maxRetries: 3,
    });

    service.registerCallback({
      taskId: 'task-400',
      hostId: 'node-alpha',
      command: 'exit 1',
      callback: config!,
    });

    const delivered = await service.handleTaskFinished('node-alpha', {
      taskId: 'task-400',
      command: 'exit 1',
      cwd: '/tmp',
      status: 'failed',
      exitCode: 1,
      startTime: 1000,
      endTime: 1100,
      durationMs: 100,
      stdout: '',
      stderr: 'error\n',
      output: 'error\n',
      totalBytes: 6,
    });

    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));

    expect(delivered).toBe(false);
    expect(attempts).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/botExecCallback.test.ts`
Expected: FAIL (`Cannot find module '../src/terminal/services/terminalExecCallbackService'`)

- [x] **Step 3: Implement `src/terminal/services/terminalExecCallbackService.ts`**

Implement `validateCallbackConfig`, `truncateUtf8Tail`, and `TerminalExecCallbackService`:
- `validateCallbackConfig`:
  - Verify `raw` is a non-null plain object (`!Array.isArray(raw)`).
  - Verify `raw.url` is a non-empty string and `new URL(raw.url)` has `protocol === 'http:' || protocol === 'https:'`.
  - Normalize `method = raw.method ? String(raw.method).toUpperCase().trim() : 'POST'`; reject if not `'POST'` or `'PUT'`.
  - Verify `raw.headers` (if defined) is a non-null plain object; strip any keys matching `/^(content-type|content-length|user-agent|host|connection|x-gt-.*)$/i` when building the sanitized headers map so system headers cannot be spoofed or duplicated.
- `truncateUtf8Tail(text: string, maxBytes: number)`:
  - Convert `text` to `Buffer.from(text || '', 'utf-8')`. If `buf.length <= maxBytes`, return `{ text: text || '', truncated: false }`.
  - Otherwise call `sliceBufferUtf8Safe(buf, buf.length - maxBytes)` and return `{ text: sliced, truncated: true }`.
- `TerminalExecCallbackService`:
  - `registerCallback` captures a `HostSnapshot` immediately via `terminalHostManager.getHost(hostId)` (falling back to `{ id: hostId, name: hostId, hostname: hostId, ip: '0.0.0.0', platform: 'unknown' }`) and sets an `.unref()` TTL timer (`(taskTimeoutMs || 300000) + 120000`).
  - `handleTaskFinished(hostId, event)` atomically pops the entry from `pendingCallbacks`, refreshes host metadata if `terminalHostManager.getHost(hostId)` is available (otherwise uses the captured snapshot), truncates `stdout`, `stderr`, and `output` via `truncateUtf8Tail(str, entry.callback.maxOutputBytes)`, and calls `deliverWithRetry`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/botExecCallback.test.ts`
Expected: PASS (7 tests passing)

---

### Task 3: Hub Exec Controller, Service & WebSocket Wiring

**Files:**
- Modify: `src/terminal/controllers/terminalExecController.ts`
- Modify: `src/terminal/services/terminalExecService.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Modify: `src/agent/daemon.ts`
- Test: `tests/botExecCallback.test.ts`

**Interfaces:**
- Consumes: `TerminalExecCallbackService`, `validateCallbackConfig`, `ExecCallbackConfig` from `src/terminal/services/terminalExecCallbackService.ts`.
- Produces:
  - `StartExecutionOptions.callback?: ExecCallbackConfig` in `src/terminal/services/terminalExecService.ts`
  - `TerminalExecService.handleAgentTaskFinished(hostId: string, data: any): Promise<void>` in `src/terminal/services/terminalExecService.ts`
  - `POST /api/terminal/exec/:hostId` in `src/terminal/controllers/terminalExecController.ts` validates `req.body.callback` via `validateCallbackConfig` and passes `callback` to `terminalExecService.startExecution`.
  - `terminalWs.ts` dispatches `control.type === 'cmd_task_finished'` to `terminalExecService.handleAgentTaskFinished(hostId, control)`.

- [x] **Step 1: Add end-to-end integration tests in `tests/botExecCallback.test.ts`**

```ts
import http from 'http';
import WebSocket from 'ws';
import request from 'supertest';
import app from '../src/server/app';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';
import config from '../config/default';

describe('Task 3: End-to-End POST /api/terminal/exec/:hostId with Webhook Callback', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let wss: any;
  let agentWs: WebSocket;
  const adminKey = 'test-e2e-bot-key';
  const originalKey = config.adminSecretKey;
  const hostId = 'bot-e2e-node';

  beforeAll(async () => {
    config.adminSecretKey = adminKey;
    hubServer = http.createServer(app);
    wss = setupTerminalWebSocket(hubServer, terminalHostManager);
    await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
    hubPort = (hubServer.address() as any).port;

    agentWs = new WebSocket(
      `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${hostId}&name=bot-node&hostname=bot-host&platform=linux`,
      { headers: { 'x-admin-key': adminKey } }
    );

    await new Promise<void>((resolve, reject) => {
      agentWs.on('message', (data) => {
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const ctrl = JSON.parse(str.slice(5));
          if (ctrl.type === 'registered') resolve();
          if (ctrl.type === 'cmd_exec') {
            handleCmdExec(ctrl, agentWs);
          }
        }
      });
      agentWs.on('error', reject);
    });
  });

  afterAll(async () => {
    config.adminSecretKey = originalKey;
    if (agentWs && agentWs.readyState === WebSocket.OPEN) {
      agentWs.close();
    }
    if (wss && wss.closeAllClients) wss.closeAllClients();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
  });

  test('rejects invalid callback config with 400 Bad Request before starting task', async () => {
    const res = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'echo "should not run"',
        callback: { url: 'invalid-url' },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/callback\.url/i);
  });

  test('executes command and automatically posts result to callback.url on completion', async () => {
    let receivedWebhook: any = null;
    let webhookResolve!: () => void;
    const webhookPromise = new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });

    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedWebhook = {
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
        webhookResolve();
      });
    });

    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const execRes = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'echo "bot-callback-e2e-ok"',
        callback: {
          url: `http://127.0.0.1:${receiverPort}/bot/notify`,
          headers: { 'X-Bot-Auth': 'secret-123' },
          context: { chatId: 'chat-888', msgId: 'msg-999' },
        },
      });

    expect(execRes.status).toBe(202);
    expect(execRes.body.success).toBe(true);
    expect(execRes.body.callbackRegistered).toBe(true);
    const taskId = execRes.body.taskId;

    await webhookPromise;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(receivedWebhook).not.toBeNull();
    expect(receivedWebhook.headers['x-bot-auth']).toBe('secret-123');
    expect(receivedWebhook.headers['x-gt-task-id']).toBe(taskId);
    expect(receivedWebhook.body).toMatchObject({
      event: 'exec.finished',
      taskId,
      host: {
        id: hostId,
        name: 'bot-node',
      },
      context: { chatId: 'chat-888', msgId: 'msg-999' },
    });
    expect(receivedWebhook.body.execution.status).toBe('completed');
    expect(receivedWebhook.body.execution.success).toBe(true);
    expect(receivedWebhook.body.execution.exitCode).toBe(0);
    expect(receivedWebhook.body.execution.stdout).toContain('bot-callback-e2e-ok');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/botExecCallback.test.ts`
Expected: FAIL (`expected 400 "Bad Request", got 202 "Accepted"`)

- [x] **Step 3: Wire controller, service, and WebSocket handler**

- In `src/terminal/controllers/terminalExecController.ts`:
  - Extract `callback` from `req.body || {}`.
  - If `callback !== undefined && callback !== null`, validate with `validateCallbackConfig(callback)`; if `!validation.valid`, return `res.status(400).json({ success: false, error: validation.error })`.
  - Pass `callback: validation.config` to `terminalExecService.startExecution`.
- In `src/terminal/services/terminalExecService.ts`:
  - Add `callback?: ExecCallbackConfig` to `StartExecutionOptions`.
  - In `startExecution`: if `res && res.success && res.data` and `options.callback`, call `terminalExecCallbackService.registerCallback({ taskId: effectiveTaskId, hostId: trimmedHost, command: trimmedCmd, cwd: res.data.cwd || options.cwd, startTime: res.data.startTime, taskTimeoutMs: timeoutMs, callback: options.callback })` and include `callbackRegistered: true` in the returned object.
  - Add `public async handleAgentTaskFinished(hostId: string, data: any): Promise<void>` that logs task completion (deduplicated via `this.loggedFinishedTasks`) and awaits `terminalExecCallbackService.handleTaskFinished(hostId, data)`.
- In `src/terminal/routes/terminalWs.ts`:
  - Inside `agentWss` message handler (`if (msgStr.startsWith('JSON:'))`), add:
    ```ts
    if (control.type === 'cmd_task_finished') {
      terminalExecService.handleAgentTaskFinished(hostId, control);
      return;
    }
    ```
- Rebuild CLI bundle (`npm run build:gt`) so `dist/gt.js` includes the updated `TaskManager` and `handleCmdExec`.

- [x] **Step 4: Run targeted and existing task tests to verify everything passes**

Run: `npm run build:gt && npm test -- tests/botExecCallback.test.ts tests/terminalTaskManager.test.ts tests/terminalTaskApi.test.ts`
Expected: PASS (all suites green)
