import http from 'http';
import express from 'express';
import { execFile } from 'child_process';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import { terminalCronService } from '../src/terminal/services/terminalCronService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import config from '../config/default';
import os from 'os';
import path from 'path';
import fs from 'fs';

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

describe('gt cron CLI command suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let tempDir: string;
  const adminKey = 'test-cli-cron-key';
  const nodeId = 'cli-test-node';

  beforeEach((done) => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cli-cron-'));
    terminalCronService.setStorageDir(tempDir);
    config.adminSecretKey = adminKey;

    // Register a mock host in terminalHostManager
    terminalHostManager.registerHost({
      id: nodeId,
      name: nodeId,
      hostname: 'testhost',
    });

    const app = express();
    app.use(express.json());
    app.use('/api/terminal', terminalRoutes);

    server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterEach((done) => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    server.close(done);
  });

  it('includes cron subcommands in program help', async () => {
    const res = await runGt(['cron', '--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ls');
    expect(res.stdout).toContain('add');
    expect(res.stdout).toContain('rm');
    expect(res.stdout).toContain('pause');
    expect(res.stdout).toContain('resume');
    expect(res.stdout).toContain('run');
    expect(res.stdout).toContain('logs');
  });

  it('handles gt cron add, ls, pause, resume, and rm via CLI actions', async () => {
    // 1. Add job
    const addRes = await runGt([
      'cron', 'add', nodeId,
      '--name', 'daily-clean',
      '--cron', '0 3 * * *',
      '--cmd', 'rm -rf /tmp/cache',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(addRes.status).toBe(0);
    expect(addRes.stdout).toContain('daily-clean');
    expect(addRes.stdout).toContain('created successfully');

    // 2. List jobs (table mode)
    const lsRes = await runGt([
      'cron', 'ls', nodeId,
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(lsRes.status).toBe(0);
    expect(lsRes.stdout).toContain('daily-clean');
    expect(lsRes.stdout).toContain('0 3 * * *');

    // 3. List jobs (--json mode)
    const jsonRes = await runGt([
      'cron', 'ls', nodeId,
      '--json',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(jsonRes.status).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('daily-clean');
    const jobId = parsed[0].id;

    // 4. Pause job
    const pauseRes = await runGt([
      'cron', 'pause', nodeId, jobId,
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(pauseRes.status).toBe(0);
    expect(pauseRes.stdout).toContain('paused');

    // 5. Resume job
    const resumeRes = await runGt([
      'cron', 'resume', nodeId, jobId,
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(resumeRes.status).toBe(0);
    expect(resumeRes.stdout).toContain('resumed');

    // 6. Delete job
    const rmRes = await runGt([
      'cron', 'rm', nodeId, jobId,
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(rmRes.status).toBe(0);
    expect(rmRes.stdout).toContain('removed');
  });

  it('rejects cron add with invalid arguments', async () => {
    // Invalid cron
    const res = await runGt([
      'cron', 'add', nodeId,
      '--name', 'invalid-cron',
      '--cron', 'invalid',
      '--cmd', 'echo 1',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Invalid cron expression');

    // Missing cmd or script
    const resNoCmd = await runGt([
      'cron', 'add', nodeId,
      '--name', 'no-cmd',
      '--cron', '0 3 * * *',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(resNoCmd.status).not.toBe(0);
    expect(resNoCmd.stderr).toContain('--cmd');
  });
});
