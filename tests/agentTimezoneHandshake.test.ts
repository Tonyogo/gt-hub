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
import { terminalCronService } from '../src/terminal/services/terminalCronService';
import { getNextCronTime } from '../src/shared/utils/cronParser';
import config from '../config/default';

describe('Server Authoritative Timezone & Hub Cron Sync', () => {
  describe('TerminalHostManager Metadata Cleanup', () => {
    let hostManager: TerminalHostManager;

    beforeEach(() => {
      hostManager = new TerminalHostManager();
    });

    it('registers agent without per-host timezone metadata', () => {
      const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
      const res = hostManager.registerAgent({
        hostId: 'node-tokyo',
        name: 'tokyo-worker',
        hostname: 'worker-box',
        ip: '10.0.0.1',
        platform: 'linux',
        machineId: 'machine-tokyo',
        version: '1.2.3',
        agentWs: mockWs,
      });

      expect(res.success).toBe(true);
      expect(res.host).toBeDefined();
      expect((res.host as any)?.timezone).toBeUndefined();

      const host = hostManager.getHost('node-tokyo');
      expect((host as any)?.timezone).toBeUndefined();

      const hosts = hostManager.getHosts();
      const stored = hosts.find(h => h.id === 'node-tokyo');
      expect((stored as any)?.timezone).toBeUndefined();
    });

    it('maintains agent status without timezone during touchAgent', () => {
      const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
      hostManager.registerAgent({
        hostId: 'node-dynamic',
        name: 'dynamic-worker',
        agentWs: mockWs,
      });

      expect((hostManager.getHost('node-dynamic') as any)?.timezone).toBeUndefined();

      hostManager.touchAgent('node-dynamic', mockWs, { name: 'dynamic-worker' });
      expect((hostManager.getHost('node-dynamic') as any)?.timezone).toBeUndefined();
    });
  });

  describe('Hub WebSocket Handshake & Cron nextRunTime in Server Timezone', () => {
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

    it('ignores any timezone parameter in WebSocket agent handshake and leaves host timezone empty', async () => {
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

      // Verify node has no timezone in terminalHostManager
      const host = terminalHostManager.getHost(nodeId);
      expect(host).toBeDefined();
      expect((host as any)?.timezone).toBeUndefined();

      // Verify /api/terminal/hosts does not list timezone
      const hostsRes = await request(app)
        .get('/api/terminal/hosts')
        .set('x-admin-key', adminKey);
      expect(hostsRes.status).toBe(200);
      const foundHost = hostsRes.body.hosts.find((h: any) => h.id === nodeId);
      expect(foundHost).toBeDefined();
      expect(foundHost.timezone).toBeUndefined();
    });

    it('calculates job nextRunTime based on server timezone and normalizes job.timezone', async () => {
      // 1. Register agent
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&key=${adminKey}`);
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

      // 2. Add cron job
      const addRes = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'daily-report',
          cron: '0 9 * * *',
          command: 'echo "hello"',
        });
      expect(addRes.status).toBe(201);
      expect(addRes.body.data.timezone).toBe(config.timeZone);

      // 3. Fetch jobs from Hub
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe(config.timeZone);

      const jobSummary = getRes.body.data[0];
      expect(jobSummary).toBeDefined();
      expect(jobSummary.timezone).toBe(config.timeZone);

      // The nextRunTime calculated by Hub must strictly use config.timeZone
      const expectedNextRunTime = getNextCronTime('0 9 * * *', undefined, config.timeZone).getTime();
      expect(jobSummary.nextRunTime).toBe(expectedNextRunTime);
    });

    it('sends serverTimezone in cron_sync to connected agent', async () => {
      let syncMessage: any = null;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&key=${adminKey}`);
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

      // Listen for cron_sync when job is added
      const agentWs = activeSockets[0];
      const syncPromise = new Promise<void>((resolve) => {
        agentWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'cron_sync' && msg.jobs && msg.jobs.some((j: any) => j.name === 'sync-test-job')) {
              syncMessage = msg;
              resolve();
            }
          }
        });
      });

      await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'sync-test-job',
          cron: '0 12 * * *',
          command: 'echo "sync"',
        });

      await syncPromise;
      expect(syncMessage).toBeDefined();
      expect(syncMessage.type).toBe('cron_sync');
      expect(syncMessage.serverTimezone).toBe(config.timeZone);
      expect(syncMessage.jobs.length).toBe(1);
    });

    it('sends serverTimezone in cron_sync on connect when node has existing jobs', async () => {
      const reconnectNodeId = `${nodeId}-reconnect`;
      const canonicalId = terminalHostManager.resolveCanonicalHostId(reconnectNodeId) || reconnectNodeId;
      const file = path.join(tempStorageDir, `${canonicalId}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          nodeId: canonicalId,
          timezone: config.timeZone,
          jobs: [
            {
              id: 'reconnect-job-1',
              name: 'reconnect-job',
              cron: '0 8 * * *',
              timezone: config.timeZone,
              status: 'active',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          executions: [],
        }),
        'utf-8'
      );

      let syncMessage: any = null;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
        const ws = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${reconnectNodeId}&name=${reconnectNodeId}&key=${adminKey}`);
        activeSockets.push(ws);

        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const msg = JSON.parse(str.slice(5));
            if (msg.type === 'cron_sync') {
              syncMessage = msg;
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      expect(syncMessage).toBeDefined();
      expect(syncMessage.type).toBe('cron_sync');
      expect(syncMessage.serverTimezone).toBe(config.timeZone);
      expect(syncMessage.jobs.length).toBe(1);
      expect(syncMessage.jobs[0].id).toBe('reconnect-job-1');
    });

    it('auto-migrates legacy disk data with old timezone to config.timeZone', async () => {
      // Pre-populate disk with legacy timezone
      const canonicalId = terminalHostManager.resolveCanonicalHostId(nodeId) || nodeId;
      const legacyFile = path.join(tempStorageDir, `${canonicalId}.json`);
      fs.writeFileSync(
        legacyFile,
        JSON.stringify({
          nodeId: canonicalId,
          timezone: 'Europe/Paris',
          jobs: [
            {
              id: 'legacy-job-1',
              name: 'legacy-job',
              cron: '0 8 * * *',
              timezone: 'Europe/Paris',
              status: 'active',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          executions: [],
        }),
        'utf-8'
      );

      // Query jobs via API
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);

      expect(getRes.status).toBe(200);
      expect(getRes.body.timezone).toBe(config.timeZone);
      expect(getRes.body.data[0].timezone).toBe(config.timeZone);

      const expectedNext = getNextCronTime('0 8 * * *', undefined, config.timeZone).getTime();
      expect(getRes.body.data[0].nextRunTime).toBe(expectedNext);

      // Verify file on disk has been migrated to config.timeZone
      const updatedOnDisk = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
      expect(updatedOnDisk.timezone).toBe(config.timeZone);
      expect(updatedOnDisk.jobs[0].timezone).toBe(config.timeZone);
    });
  });
});
