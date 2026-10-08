import request from 'supertest';
import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import adminRoutes from '../src/admin/routes/adminRoutes';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import config from '../config/default';
const { handleCmdExec } = require('../scripts/gt.js');

describe('Terminal Agent Command Execution End-to-End', () => {
  let server: http.Server;
  let baseUrl: string;
  let wsUrl: string;
  let agentWs: WebSocket;
  let originalKey: string;
  const adminKey = 'test-agent-exec-key';
  const hostId = 'test-exec-agent-node';

  beforeAll((done) => {
    originalKey = config.adminSecretKey;
    config.adminSecretKey = adminKey;

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);

    server = http.createServer(app);
    setupTerminalWebSocket(server);

    server.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${hostId}&name=TestNode&key=${adminKey}`;

      agentWs = new WebSocket(wsUrl);

      // Real agent message handler
      agentWs.on('message', (data) => {
        const msg = data.toString();
        if (msg.startsWith('JSON:')) {
          try {
            const control = JSON.parse(msg.slice(5));
            if (control.type === 'cmd_exec') {
              handleCmdExec(control, agentWs);
            }
          } catch {}
        }
      });

      agentWs.on('open', () => done());
    });
  });

  afterAll((done) => {
    config.adminSecretKey = originalKey;
    if (agentWs) {
      try {
        agentWs.terminate();
      } catch {}
    }
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    server.close(done);
  });

  it('runs command through agent, polls output incrementally, and completes', async () => {
    const startRes = await request(baseUrl)
      .post(`/api/admin/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({ command: 'echo "deployment finished"' });

    expect(startRes.status).toBe(202);
    expect(startRes.body.success).toBe(true);
    const taskId = startRes.body.taskId;
    expect(taskId).toBeDefined();

    // Poll until completed
    let pollRes: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pollRes = await request(baseUrl)
        .get(`/api/admin/terminal/exec/${hostId}/${taskId}?offset=0`)
        .set('x-admin-key', adminKey);

      if (pollRes.body.status === 'completed') break;
    }

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('completed');
    expect(pollRes.body.exitCode).toBe(0);
    expect(pollRes.body.stdout).toContain('deployment finished');
  });

  it('handles command failure with non-zero exit code', async () => {
    const startRes = await request(baseUrl)
      .post(`/api/admin/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({ command: 'exit 42' });

    expect(startRes.status).toBe(202);
    const taskId = startRes.body.taskId;

    let pollRes: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pollRes = await request(baseUrl)
        .get(`/api/admin/terminal/exec/${hostId}/${taskId}`)
        .set('x-admin-key', adminKey);

      if (pollRes.body.status === 'failed') break;
    }

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('failed');
    expect(pollRes.body.exitCode).toBe(42);
  });

  it('kills a running command via kill endpoint', async () => {
    const startRes = await request(baseUrl)
      .post(`/api/admin/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({ command: 'sleep 30' });

    expect(startRes.status).toBe(202);
    const taskId = startRes.body.taskId;

    const killRes = await request(baseUrl)
      .post(`/api/admin/terminal/exec/${hostId}/${taskId}/kill`)
      .set('x-admin-key', adminKey)
      .send({ signal: 'SIGTERM' });

    expect(killRes.status).toBe(200);
    expect(killRes.body.status).toBe('killed');

    await new Promise((r) => setTimeout(r, 200));

    const pollRes = await request(baseUrl)
      .get(`/api/admin/terminal/exec/${hostId}/${taskId}`)
      .set('x-admin-key', adminKey);

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('killed');
  });

  it('handles command timeout', async () => {
    const startRes = await request(baseUrl)
      .post(`/api/admin/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({ command: 'sleep 30', timeoutMs: 300 });

    expect(startRes.status).toBe(202);
    const taskId = startRes.body.taskId;

    let pollRes: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pollRes = await request(baseUrl)
        .get(`/api/admin/terminal/exec/${hostId}/${taskId}`)
        .set('x-admin-key', adminKey);

      if (pollRes.body.status === 'timeout') break;
    }

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('timeout');
    expect(pollRes.body.stderr).toContain('timed out');
  });

  it('lists tasks for the host', async () => {
    const listRes = await request(baseUrl)
      .get(`/api/admin/terminal/exec/${hostId}?limit=10`)
      .set('x-admin-key', adminKey);

    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(Array.isArray(listRes.body.tasks)).toBe(true);
    expect(listRes.body.tasks.length).toBeGreaterThanOrEqual(1);
  });
});
