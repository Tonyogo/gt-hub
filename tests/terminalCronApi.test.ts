import http from 'http';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { terminalCronService } from '../src/terminal/services/terminalCronService';
import config from '../config/default';

describe('Hub Terminal Cron REST API & Service', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let tempStorageDir: string;
  const adminKey = 'test-cron-admin-key';
  const nodeId = 'cron-test-node-1';

  beforeEach((done) => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hub-cron-test-'));
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
      done();
    });
  });

  afterEach((done) => {
    try {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {}
    server.close(done);
  });

  describe('REST Endpoints: /api/terminal/cron/:nodeId', () => {
    it('returns empty job list initially', async () => {
      const res = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('rejects adding job with invalid cron or missing required fields', async () => {
      // Missing name
      const res1 = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({ cron: '*/5 * * * *', command: 'echo 1' });
      expect(res1.status).toBe(400);

      // Invalid cron
      const res2 = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({ name: 'bad-cron', cron: '60 * * * *', command: 'echo 1' });
      expect(res2.status).toBe(400);

      // Missing command for command source
      const res3 = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({ name: 'no-cmd', cron: '*/5 * * * *', source: 'command' });
      expect(res3.status).toBe(400);

      // Invalid timezone
      const res4 = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({ name: 'bad-tz', cron: '0 2 * * *', command: 'echo 1', timezone: 'Invalid/Timezone' });
      expect(res4.status).toBe(400);
      expect(res4.body.error).toMatch(/timezone/i);
    });

    it('creates and returns job with valid custom timezone', async () => {
      const res = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'tz-job',
          cron: '0 9 * * *',
          command: 'echo "tz test"',
          timezone: 'Asia/Shanghai',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.timezone).toBe('Asia/Shanghai');

      const jobId = res.body.data.id;

      // Retrieve via GET
      const getRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data[0].timezone).toBe('Asia/Shanghai');
      expect(getRes.body.data[0].nextRunTime).toBeGreaterThan(Date.now());

      // Update with invalid timezone should fail
      const badPatch = await request(app)
        .patch(`/api/terminal/cron/${nodeId}/${jobId}`)
        .set('x-admin-key', adminKey)
        .send({ timezone: 'Not/A_Real_Zone' });
      expect(badPatch.status).toBe(400);

      // Update with valid timezone should succeed
      const goodPatch = await request(app)
        .patch(`/api/terminal/cron/${nodeId}/${jobId}`)
        .set('x-admin-key', adminKey)
        .send({ timezone: 'UTC' });
      expect(goodPatch.status).toBe(200);
      expect(goodPatch.body.data.timezone).toBe('UTC');
    });

    it('creates, retrieves, pauses, resumes, and deletes a cron job', async () => {
      // 1. Create job
      const createRes = await request(app)
        .post(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey)
        .send({
          name: 'backup-db',
          cron: '0 2 * * *',
          command: 'tar -czf backup.tar.gz /data',
          concurrency: 'forbid',
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);
      const createdJob = createRes.body.data;
      expect(createdJob.id).toBeDefined();
      expect(createdJob.status).toBe('active');
      expect(createdJob.name).toBe('backup-db');

      const jobId = createdJob.id;

      // 2. Retrieve job list
      const listRes = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(1);
      expect(listRes.body.data[0].id).toBe(jobId);
      expect(listRes.body.data[0].nextRunTime).toBeGreaterThan(Date.now());

      // 3. Pause job
      const pauseRes = await request(app)
        .patch(`/api/terminal/cron/${nodeId}/${jobId}`)
        .set('x-admin-key', adminKey)
        .send({ status: 'paused' });
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.status).toBe('paused');

      const listAfterPause = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(listAfterPause.body.data[0].nextRunTime).toBeNull();

      // 4. Resume job
      const resumeRes = await request(app)
        .patch(`/api/terminal/cron/${nodeId}/${jobId}`)
        .set('x-admin-key', adminKey)
        .send({ status: 'active' });
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.status).toBe('active');

      // 5. Delete job
      const delRes = await request(app)
        .delete(`/api/terminal/cron/${nodeId}/${jobId}`)
        .set('x-admin-key', adminKey);
      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      const listAfterDel = await request(app)
        .get(`/api/terminal/cron/${nodeId}`)
        .set('x-admin-key', adminKey);
      expect(listAfterDel.body.data).toEqual([]);
    });

    it('syncs jobs to agent via WebSocket when agent is online', async () => {
      let syncReceived: any = null;
      let agentWs: WebSocket | null = null;

      try {
        await new Promise<void>((resolve) => {
          const port = (server.address() as any).port;
          const wsUrl = `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&key=${adminKey}`;
          agentWs = new WebSocket(wsUrl);

          agentWs.on('message', (data) => {
            const str = data.toString();
            if (str.startsWith('JSON:')) {
              const control = JSON.parse(str.slice(5));
              if (control.type === 'cron_sync') {
                syncReceived = control;
                resolve();
              }
            }
          });

          agentWs.on('open', async () => {
            // Give server a moment to register agent
            await new Promise((r) => setTimeout(r, 100));

            // Add a job via REST API
            await request(app)
              .post(`/api/terminal/cron/${nodeId}`)
              .set('x-admin-key', adminKey)
              .send({
                name: 'live-sync-job',
                cron: '*/15 * * * *',
                command: 'echo "synced live"',
              });
          });
        });

        expect(syncReceived).toBeDefined();
        expect(syncReceived.type).toBe('cron_sync');
        expect(syncReceived.jobs.length).toBe(1);
        expect(syncReceived.jobs[0].name).toBe('live-sync-job');
      } finally {
        if (agentWs) {
          try { (agentWs as WebSocket).terminate(); } catch {}
        }
      }
    });

    it('triggers job immediately via POST /api/terminal/cron/:nodeId/:jobId/run', async () => {
      let triggerReceived: any = null;
      let agentWs: WebSocket | null = null;

      try {
        // Pre-create job
        const createRes = await request(app)
          .post(`/api/terminal/cron/${nodeId}`)
          .set('x-admin-key', adminKey)
          .send({
            name: 'run-job',
            cron: '0 0 1 1 *',
            command: 'echo "run now"',
          });
        const jobId = createRes.body.data.id;

        await new Promise<void>((resolve) => {
          const port = (server.address() as any).port;
          const wsUrl = `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&key=${adminKey}`;
          agentWs = new WebSocket(wsUrl);

          agentWs.on('message', (data) => {
            const str = data.toString();
            if (str.startsWith('JSON:')) {
              const control = JSON.parse(str.slice(5));
              if (control.type === 'cron_trigger') {
                triggerReceived = control;
                resolve();
              }
            }
          });

          agentWs.on('open', async () => {
            await new Promise((r) => setTimeout(r, 100));

            await request(app)
              .post(`/api/terminal/cron/${nodeId}/${jobId}/run`)
              .set('x-admin-key', adminKey);
          });
        });

        expect(triggerReceived).toBeDefined();
        expect(triggerReceived.type).toBe('cron_trigger');
        expect(triggerReceived.jobId).toBe(jobId);
      } finally {
        if (agentWs) {
          try { (agentWs as WebSocket).terminate(); } catch {}
        }
      }
    });
  });
});
