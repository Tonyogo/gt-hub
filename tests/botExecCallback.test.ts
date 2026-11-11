import http from 'http';
import crypto from 'crypto';
import WebSocket from 'ws';
import request from 'supertest';
import app from '../src/server/app';
import config from '../config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { TaskManager } from '../src/agent/tasks/taskManager';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';
import {
  validateCallbackConfig,
  truncateUtf8Tail,
  TerminalExecCallbackService,
} from '../src/terminal/services/terminalExecCallbackService';

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

  test('startTask with existing taskId invokes onFinish for both running and finished states', async () => {
    const runningEvents1: any[] = [];
    const runningEvents2: any[] = [];
    const taskIdRunning = `dup-running-${Date.now()}`;

    tm.startTask({
      taskId: taskIdRunning,
      command: 'sleep 0.2',
      onFinish: (ev) => runningEvents1.push(ev),
    });

    // Call startTask again with same taskId while running
    const secondCall = tm.startTask({
      taskId: taskIdRunning,
      command: 'ignored command',
      onFinish: (ev) => runningEvents2.push(ev),
    });
    expect(secondCall.success).toBe(true);
    expect(secondCall.status).toBe('running');

    for (let i = 0; i < 40 && (runningEvents1.length === 0 || runningEvents2.length === 0); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(runningEvents1).toHaveLength(1);
    expect(runningEvents2).toHaveLength(1);
    expect(runningEvents1[0].taskId).toBe(taskIdRunning);
    expect(runningEvents2[0].taskId).toBe(taskIdRunning);

    // Now test calling startTask with an already finished taskId
    const finishedEvents: any[] = [];
    const thirdCall = tm.startTask({
      taskId: taskIdRunning,
      command: 'ignored command 2',
      onFinish: (ev) => finishedEvents.push(ev),
    });
    expect(thirdCall.success).toBe(true);
    expect(thirdCall.status).toBe('completed');

    for (let i = 0; i < 20 && finishedEvents.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].taskId).toBe(taskIdRunning);
    expect(finishedEvents[0].status).toBe('completed');
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

    const pushTaskId = `cmd-push-${Date.now()}`;
    handleCmdExec(
      {
        reqId: 'req-1',
        action: 'start',
        taskId: pushTaskId,
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

    const finishedFrame = sentFrames.find((f) => f.type === 'cmd_task_finished' && f.taskId === pushTaskId);
    expect(finishedFrame).toBeDefined();
    expect(finishedFrame.status).toBe('completed');
    expect(finishedFrame.exitCode).toBe(0);
    expect(finishedFrame.stdout).toContain('done-via-ws');
  });
});

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
      expect(res.text).not.toContain('\uFFFD');
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

  test('uses captured HostSnapshot when host disconnects before handleTaskFinished', async () => {
    let receivedPayload: any = null;
    const webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedPayload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const port = (webhookServer.address() as any).port;

    // Simulate host present in terminalHostManager during registration
    const tempHostId = 'snapshot-host-node';
    (terminalHostManager as any).hosts.set(tempHostId, {
      id: tempHostId,
      name: 'Snapshot Node',
      hostname: 'node-box-9',
      ip: '10.0.2.15',
      platform: 'linux',
      ws: null,
      lastSeen: Date.now(),
    });

    const service = new TerminalExecCallbackService({ retryDelaysMs: [10] });
    const { config } = validateCallbackConfig({
      url: `http://127.0.0.1:${port}/webhook`,
    });

    service.registerCallback({
      taskId: 'task-snapshot-1',
      hostId: tempHostId,
      command: 'echo snapshot',
      callback: config!,
    });

    // Now remove host to simulate disconnect
    (terminalHostManager as any).hosts.delete(tempHostId);

    const delivered = await service.handleTaskFinished(tempHostId, {
      taskId: 'task-snapshot-1',
      command: 'echo snapshot',
      cwd: '/home',
      status: 'completed',
      exitCode: 0,
      stdout: 'snapshot\n',
      stderr: '',
      output: 'snapshot\n',
      totalBytes: 9,
    });

    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));

    expect(delivered).toBe(true);
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload.host).toEqual({
      id: tempHostId,
      name: 'Snapshot Node',
      hostname: 'node-box-9',
      ip: '10.0.2.15',
      platform: 'linux',
    });
  });
});

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

  test('delivers webhook with failed status and success false when command exits non-zero', async () => {
    let receivedWebhook: any = null;
    let webhookResolve!: () => void;
    const webhookPromise = new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });

    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedWebhook = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        webhookResolve();
      });
    });

    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const execRes = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'sh -c "exit 7"',
        callback: {
          url: `http://127.0.0.1:${receiverPort}/bot/notify-fail`,
        },
      });

    expect(execRes.status).toBe(202);
    expect(execRes.body.success).toBe(true);
    const taskId = execRes.body.taskId;

    await webhookPromise;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(receivedWebhook).not.toBeNull();
    expect(receivedWebhook.taskId).toBe(taskId);
    expect(receivedWebhook.execution.status).toBe('failed');
    expect(receivedWebhook.execution.success).toBe(false);
    expect(receivedWebhook.execution.exitCode).toBe(7);
  });

  test('delivers webhook with timeout status when command exceeds timeoutMs', async () => {
    let receivedWebhook: any = null;
    let webhookResolve!: () => void;
    const webhookPromise = new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });

    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedWebhook = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        webhookResolve();
      });
    });

    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const execRes = await request(app)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'sleep 5',
        timeoutMs: 1000,
        callback: {
          url: `http://127.0.0.1:${receiverPort}/bot/notify-timeout`,
        },
      });

    expect(execRes.status).toBe(202);
    expect(execRes.body.success).toBe(true);
    const taskId = execRes.body.taskId;

    await webhookPromise;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(receivedWebhook).not.toBeNull();
    expect(receivedWebhook.taskId).toBe(taskId);
    expect(receivedWebhook.execution.status).toBe('timeout');
    expect(receivedWebhook.execution.success).toBe(false);
  });
});


