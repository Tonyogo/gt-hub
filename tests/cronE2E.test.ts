import http from 'http';
import express from 'express';
import { execFile } from 'child_process';
import { WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalCronService } from '../src/terminal/services/terminalCronService';
import { AgentCronScheduler } from '../src/agent/cron/cronScheduler';
import { handleCronControl } from '../src/agent/handlers/cronHandler';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';
import config from '../config/default';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

function runGt(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [gtPath, ...args], {
      timeout: 10000,
    }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({
        status,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

describe('End-to-End Cron Scheduling Flow', () => {
  let server: http.Server;
  let baseUrl: string;
  let wsUrl: string;
  let hubTempDir: string;
  let agentTempDir: string;
  let scheduler: AgentCronScheduler;
  let agentWs: WebSocket;
  const adminKey = 'test-e2e-cron-key';
  const nodeId = 'e2e-cron-node';

  beforeAll((done) => {
    hubTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-hub-'));
    agentTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-agent-'));

    terminalCronService.setStorageDir(hubTempDir);
    config.adminSecretKey = adminKey;

    const app = express();
    app.use(express.json());
    app.use('/api/terminal', terminalRoutes);

    server = http.createServer(app);
    setupTerminalWebSocket(server);

    server.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}`;

      // Initialize Agent Scheduler
      scheduler = new AgentCronScheduler({
        storageFile: path.join(agentTempDir, 'cron.json'),
        cacheDir: path.join(agentTempDir, 'cache'),
      });
      scheduler.start();

      // Connect Agent WebSocket tunnel
      agentWs = new WebSocket(`${wsUrl}/api/terminal/agent-ws?hostId=${nodeId}&name=${nodeId}&key=${adminKey}`);

      scheduler.onReport((record) => {
        if (agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(`JSON:${JSON.stringify({ type: 'cron_report', record })}`);
        }
      });

      agentWs.on('message', async (data) => {
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const control = JSON.parse(str.slice(5));
          if (control.type === 'cmd_exec') {
            handleCmdExec(control, agentWs);
            return;
          }
          await handleCronControl(control, scheduler, agentWs);
        }
      });

      agentWs.on('open', () => {
        done();
      });
    });
  });

  afterAll((done) => {
    try {
      scheduler.stop();
    } catch {}
    try {
      agentWs.terminate();
    } catch {}
    try {
      fs.rmSync(hubTempDir, { recursive: true, force: true });
      fs.rmSync(agentTempDir, { recursive: true, force: true });
    } catch {}
    server.close(done);
  });

  it('performs complete end-to-end cron workflow: add, sync, trigger, report, logs, pause, resume, rm', async () => {
    // 1. Add cron job via CLI
    const addRes = await runGt([
      'cron', 'add', nodeId,
      '--name', 'e2e-echo',
      '--cron', '* * * * *',
      '--cmd', 'echo "cron works"',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(addRes.status).toBe(0);
    expect(addRes.stdout).toContain('e2e-echo');

    // Wait for WebSocket cron_sync to propagate to Agent
    let synced = false;
    for (let i = 0; i < 20; i++) {
      if (scheduler.getJobs().length > 0) {
        synced = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(synced).toBe(true);
    const agentJob = scheduler.getJobs()[0];
    expect(agentJob.name).toBe('e2e-echo');

    // 2. Trigger execution immediately via CLI gt cron run
    const runRes = await runGt([
      'cron', 'run', nodeId, agentJob.id,
      '--server', baseUrl,
      '--key', adminKey,
    ]);
    expect(runRes.status).toBe(0);
    expect(runRes.stdout).toContain('Triggered execution');

    // 3. Wait for execution report to reach Hub
    let executed = false;
    for (let i = 0; i < 30; i++) {
      const summaries = await terminalCronService.getJobs(nodeId);
      if (summaries[0]?.lastExecution?.status === 'completed') {
        executed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(executed).toBe(true);

    // 4. View logs via CLI gt cron logs
    const logsRes = await runGt([
      'cron', 'logs', nodeId, agentJob.id,
      '--server', baseUrl,
      '--key', adminKey,
    ]);
    expect(logsRes.status).toBe(0);
    expect(logsRes.stdout).toContain('cron works');

    // 5. Pause job via CLI
    const pauseRes = await runGt([
      'cron', 'pause', nodeId, agentJob.id,
      '--server', baseUrl,
      '--key', adminKey,
    ]);
    expect(pauseRes.status).toBe(0);
    expect(pauseRes.stdout).toContain('paused');

    // Wait for sync to Agent
    for (let i = 0; i < 20; i++) {
      if (scheduler.getJobs()[0]?.status === 'paused') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(scheduler.getJobs()[0].status).toBe('paused');

    // 6. Resume job via CLI
    const resumeRes = await runGt([
      'cron', 'resume', nodeId, agentJob.id,
      '--server', baseUrl,
      '--key', adminKey,
    ]);
    expect(resumeRes.status).toBe(0);
    expect(resumeRes.stdout).toContain('resumed');

    for (let i = 0; i < 20; i++) {
      if (scheduler.getJobs()[0]?.status === 'active') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(scheduler.getJobs()[0].status).toBe('active');

    // 7. Delete job via CLI
    const rmRes = await runGt([
      'cron', 'rm', nodeId, agentJob.id,
      '--server', baseUrl,
      '--key', adminKey,
    ]);
    expect(rmRes.status).toBe(0);
    expect(rmRes.stdout).toContain('removed');

    for (let i = 0; i < 20; i++) {
      if (scheduler.getJobs().length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(scheduler.getJobs().length).toBe(0);
  });
});
