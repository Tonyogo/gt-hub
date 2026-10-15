import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AgentCronScheduler } from '../src/agent/cron/cronScheduler';
import { handleCronControl } from '../src/agent/handlers/cronHandler';
import { CronJobConfig } from '../src/shared/types/cron';

describe('Agent Cron Daemon WebSocket Integration', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let tempDir: string;
  let scheduler: AgentCronScheduler;
  let activeSockets: WebSocket[] = [];

  beforeEach((done) => {
    activeSockets = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-agent-cron-'));
    scheduler = new AgentCronScheduler({
      storageFile: path.join(tempDir, 'cron.json'),
      cacheDir: path.join(tempDir, 'cache'),
    });

    server = http.createServer();
    wss = new WebSocketServer({ server });
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    scheduler.stop();
    for (const ws of activeSockets) {
      try { ws.terminate(); } catch {}
    }
    activeSockets = [];
    wss.clients.forEach((c) => {
      try { c.terminate(); } catch {}
    });
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    wss.close(() => {
      server.close(done);
    });
  });

  it('synchronizes jobs upon receiving cron_sync and responds with cron_sync_res', async () => {
    let hubReceived: any = null;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for cron_sync_res')), 5000);

      wss.once('connection', (hubWs) => {
        hubWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            hubReceived = JSON.parse(str.slice(5));
            clearTimeout(timeout);
            resolve();
          }
        });

        // Hub sends cron_sync to agent
        const jobs: CronJobConfig[] = [
          {
            id: 'job-sync-1',
            name: 'Sync Test',
            cron: '0 2 * * *',
            source: 'command',
            command: 'echo "synced"',
            concurrency: 'forbid',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ];
        hubWs.send(`JSON:${JSON.stringify({ type: 'cron_sync', jobs })}`);
      });

      const agentWs = new WebSocket(`ws://127.0.0.1:${port}`);
      activeSockets.push(agentWs);
      agentWs.on('message', async (data) => {
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const control = JSON.parse(str.slice(5));
          await handleCronControl(control, scheduler, agentWs);
        }
      });
    });

    expect(hubReceived).toBeDefined();
    expect(hubReceived.type).toBe('cron_sync_res');
    expect(hubReceived.success).toBe(true);
    expect(scheduler.getJobs().length).toBe(1);
    expect(scheduler.getJobs()[0].id).toBe('job-sync-1');
  });

  it('triggers job upon receiving cron_trigger and reports execution via cron_report', async () => {
    const reports: any[] = [];

    // Pre-populate scheduler with a job
    scheduler.syncJobs([
      {
        id: 'job-trigger-1',
        name: 'Trigger Test',
        cron: '* * * * *',
        source: 'command',
        command: 'echo "hello from cron trigger"',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for cron_report')), 5000);

      wss.once('connection', (hubWs) => {
        hubWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const control = JSON.parse(str.slice(5));
            if (control.type === 'cron_report') {
              reports.push(control);
              clearTimeout(timeout);
              resolve();
            }
          }
        });

        // Send cron_trigger
        hubWs.send(`JSON:${JSON.stringify({ type: 'cron_trigger', jobId: 'job-trigger-1', requestId: 'req-1' })}`);
      });

      const agentWs = new WebSocket(`ws://127.0.0.1:${port}`);
      activeSockets.push(agentWs);
      agentWs.on('open', () => {
        scheduler.onReport((record) => {
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.send(`JSON:${JSON.stringify({ type: 'cron_report', record })}`);
          }
        });
      });
      agentWs.on('message', async (data) => {
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const control = JSON.parse(str.slice(5));
          await handleCronControl(control, scheduler, agentWs);
        }
      });
    });

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].record.jobId).toBe('job-trigger-1');
    expect(reports[0].record.status).toBe('completed');
  });

  it('responds to cron_list with job summaries', async () => {
    scheduler.syncJobs([
      {
        id: 'job-list-1',
        name: 'List Test',
        cron: '*/10 * * * *',
        source: 'command',
        command: 'echo "listed"',
        concurrency: 'forbid',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    let listRes: any = null;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for cron_list_res')), 5000);

      wss.once('connection', (hubWs) => {
        hubWs.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const control = JSON.parse(str.slice(5));
            if (control.type === 'cron_list_res') {
              listRes = control;
              clearTimeout(timeout);
              resolve();
            }
          }
        });

        hubWs.send(`JSON:${JSON.stringify({ type: 'cron_list', requestId: 'list-req-1' })}`);
      });

      const agentWs = new WebSocket(`ws://127.0.0.1:${port}`);
      activeSockets.push(agentWs);
      agentWs.on('message', async (data) => {
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const control = JSON.parse(str.slice(5));
          await handleCronControl(control, scheduler, agentWs);
        }
      });
    });

    expect(listRes).toBeDefined();
    expect(listRes.requestId).toBe('list-req-1');
    expect(Array.isArray(listRes.summaries)).toBe(true);
    expect(listRes.summaries.length).toBe(1);
    expect(listRes.summaries[0].id).toBe('job-list-1');
  });
});
