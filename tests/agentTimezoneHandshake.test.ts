import http from 'http';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocket } from 'ws';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager, TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { terminalCronService, TerminalCronService } from '../src/terminal/services/terminalCronService';
import { getNextCronTime } from '../src/shared/utils/cronParser';
import config from '../config/default';

describe('Scheme 4: Agent Timezone Handshake & Hub Cron Sync', () => {
  describe('TerminalHostManager Timezone Tracking', () => {
    let hostManager: TerminalHostManager;

    beforeEach(() => {
      hostManager = new TerminalHostManager();
    });

    it('records agent timezone upon registration', () => {
      const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
      const res = hostManager.registerAgent({
        hostId: 'node-tokyo',
        name: 'tokyo-worker',
        hostname: 'worker-box',
        ip: '10.0.0.1',
        platform: 'linux',
        machineId: 'machine-tokyo',
        version: '1.2.3',
        timezone: 'Asia/Tokyo',
        agentWs: mockWs,
      });

      expect(res.success).toBe(true);
      expect(res.host).toBeDefined();
      expect(res.host?.timezone).toBe('Asia/Tokyo');

      const host = hostManager.getHost('node-tokyo');
      expect(host?.timezone).toBe('Asia/Tokyo');
      expect(hostManager.getNodeTimezone('node-tokyo')).toBe('Asia/Tokyo');

      const hosts = hostManager.getHosts();
      const stored = hosts.find(h => h.id === 'node-tokyo');
      expect(stored?.timezone).toBe('Asia/Tokyo');
    });

    it('updates agent timezone during touchAgent', () => {
      const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
      hostManager.registerAgent({
        hostId: 'node-dynamic',
        name: 'dynamic-worker',
        agentWs: mockWs,
      });

      expect(hostManager.getHost('node-dynamic')?.timezone).toBeUndefined();

      hostManager.touchAgent('node-dynamic', mockWs, { timezone: 'Europe/London' });
      expect(hostManager.getHost('node-dynamic')?.timezone).toBe('Europe/London');
      expect(hostManager.getNodeTimezone('node-dynamic')).toBe('Europe/London');
    });
  });

  describe('Hub WebSocket Handshake & Cron nextRunTime in Node Timezone', () => {
    let app: express.Express;
    let server: http.Server;
    let baseUrl: string;
    let wsUrl: string;
    let tempStorageDir: string;
    let activeSockets: WebSocket[] = [];
    const adminKey = 'test-tz-admin-key';
    const nodeId = 'tz-agent-tokyo';

    beforeEach((done) => {
      activeSockets = [];
      tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hub-tz-cron-test-'));
      terminalCronService.setStorageDir(tempStorageDir);
      config.adminSecretKey = adminKey;

      app = express();
      app.use(express.json());
      app.use('/api/terminal', terminalRoutes);

      server = http.createServer(app);
      setupTerminalWebSocket(server);

      server.listen(0, () => {
        const port = (server.address() as any).port;
        baseUrl = `http://127.0.0.1:${port}`;
        wsUrl = `ws://127.0.0.1:${port}`;
        done();
      });
    });

    afterEach((done) => {
      for (const ws of activeSockets) {
        try { ws.terminate(); } catch {}
      }
      activeSockets = [];
      try {
        fs.rmSync(tempStorageDir, { recursive: true, force: true });
      } catch {}
      server.close(done);
    });

    it('receives timezone parameter during WebSocket agent handshake and stores it', async () => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(ws);

        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // Verify node has timezone Asia/Tokyo in terminalHostManager
      const host = terminalHostManager.getHost(nodeId);
      expect(host).toBeDefined();
      expect(host?.timezone).toBe('Asia/Tokyo');

      // Verify /api/terminal/hosts lists timezone
      const hostsRes = await request(app)
        .get('/api/terminal/hosts')
        .set('x-admin-key', adminKey);
      expect(hostsRes.status).toBe(200);
      const foundHost = hostsRes.body.hosts.find((h: any) => h.id === nodeId);
      expect(foundHost).toBeDefined();
      expect(foundHost.timezone).toBe('Asia/Tokyo');
    });

    it('calculates job nextRunTime based on node reported timezone when job.timezone is not specified', async () => {
      // 1. Register agent with Asia/Tokyo timezone
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(ws);

        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // 2. Add cron job without timezone (default node local)
      const addRes = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'daily-report',
          cron: '0 9 * * *',
          command: 'echo "hello"',
        });
      expect(addRes.status).toBe(201);
      expect(addRes.body.data.timezone).toBeUndefined();

      // 3. Fetch jobs from Hub
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe('Asia/Tokyo');

      const jobSummary = getRes.body.data[0];
      expect(jobSummary).toBeDefined();
      expect(jobSummary.timezone).toBeUndefined();

      // The nextRunTime calculated by Hub must match getNextCronTime with 'Asia/Tokyo'!
      const expectedNextRunTime = getNextCronTime('0 9 * * *', undefined, 'Asia/Tokyo').getTime();
      expect(jobSummary.nextRunTime).toBe(expectedNextRunTime);
    });

    it('allows job explicit timezone to override node reported timezone', async () => {
      // Register node with Asia/Tokyo
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(ws);
        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // Add cron job with explicit America/New_York timezone
      const addRes = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'ny-report',
          cron: '0 9 * * *',
          command: 'echo "ny"',
          timezone: 'America/New_York',
        });
      expect(addRes.status).toBe(201);

      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);

      const jobSummary = getRes.body.data.find((j: any) => j.name === 'ny-report');
      const expectedNYTime = getNextCronTime('0 9 * * *', undefined, 'America/New_York').getTime();
      expect(jobSummary.nextRunTime).toBe(expectedNYTime);
    });

    it('persists node timezone across node disconnections so offline job listing still calculates correct nextRunTime', async () => {
      // 1. Connect node
      let agentWs: WebSocket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        agentWs = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(agentWs);
        agentWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // 2. Add job
      await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'persist-job',
          cron: '0 12 * * *',
          command: 'echo "offline"',
        });

      // 3. Disconnect agent and prune host from in-memory manager
      agentWs!.terminate();
      terminalHostManager.unregisterAgent(nodeId);
      expect(terminalHostManager.getHost(nodeId)?.status).toBe('offline');

      // 4. Query cron jobs while node is disconnected
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe('Asia/Tokyo');

      const expectedTime = getNextCronTime('0 12 * * *', undefined, 'Asia/Tokyo').getTime();
      expect(getRes.body.data[0].nextRunTime).toBe(expectedTime);
    });

    it('ignores invalid timezone strings in handshake and does not set invalid timezone', async () => {
      const invalidNodeId = 'tz-invalid-node';
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${invalidNodeId}&name=${invalidNodeId}&timezone=Not_A_Real_Timezone&key=${adminKey}`);
        activeSockets.push(ws);
        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      const host = terminalHostManager.getHost(invalidNodeId);
      expect(host).toBeDefined();
      expect(host?.timezone).toBeUndefined();
      expect(terminalHostManager.getNodeTimezone(invalidNodeId)).toBeUndefined();
      expect(terminalCronService.getNodeTimezone(invalidNodeId)).toBeUndefined();
    });

    it('dynamically updates timezone via meta message and persists to cron disk data', async () => {
      let agentWs: WebSocket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        agentWs = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(agentWs);
        agentWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // Add a cron job
      await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'meta-tz-job',
          cron: '0 8 * * *',
          command: 'echo "meta"',
        });

      // Send meta message updating timezone to Europe/Paris
      agentWs!.send(`JSON:${JSON.stringify({
        type: 'meta',
        name: nodeId,
        timezone: 'Europe/Paris',
      })}`);

      // Allow event loop to process meta message
      await new Promise(r => setTimeout(r, 100));

      expect(terminalHostManager.getHost(nodeId)?.timezone).toBe('Europe/Paris');
      expect(terminalCronService.getNodeTimezone(nodeId)).toBe('Europe/Paris');

      // Verify getJobs uses new Europe/Paris timezone
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe('Europe/Paris');

      const expectedParisTime = getNextCronTime('0 8 * * *', undefined, 'Europe/Paris').getTime();
      expect(getRes.body.data[0].nextRunTime).toBe(expectedParisTime);

      // Verify persistence after disconnect
      agentWs!.terminate();
      terminalHostManager.unregisterAgent(nodeId);

      const getResOffline = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getResOffline.status).toBe(200);
      expect(getResOffline.body.timezone).toBe('Europe/Paris');
      expect(getResOffline.body.data[0].nextRunTime).toBe(expectedParisTime);
    });

    it('automatically updates persisted timezone when node reconnects with changed timezone', async () => {
      // 1. Initial connect with Asia/Tokyo
      let agentWs1: WebSocket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        agentWs1 = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=Asia/Tokyo&key=${adminKey}`);
        activeSockets.push(agentWs1);
        agentWs1.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'travel-job',
          cron: '0 10 * * *',
          command: 'echo "travel"',
        });

      // Disconnect
      agentWs1!.terminate();

      // 2. Reconnect with new timezone (e.g. America/Chicago)
      let agentWs2: WebSocket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        agentWs2 = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&timezone=America/Chicago&key=${adminKey}`);
        activeSockets.push(agentWs2);
        agentWs2.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'registered') {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      expect(terminalHostManager.getHost(nodeId)?.timezone).toBe('America/Chicago');
      expect(terminalCronService.getNodeTimezone(nodeId)).toBe('America/Chicago');

      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe('America/Chicago');

      const expectedChicagoTime = getNextCronTime('0 10 * * *', undefined, 'America/Chicago').getTime();
      expect(getRes.body.data[0].nextRunTime).toBe(expectedChicagoTime);
    });
  });
});
