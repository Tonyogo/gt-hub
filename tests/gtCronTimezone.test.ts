import http from 'http';
import express from 'express';
import { execFile } from 'child_process';
import path from 'path';

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

describe('gt cron CLI Timezone Support', () => {
  let server: http.Server;
  let baseUrl: string;
  const adminKey = 'test-cli-cron-key';
  const nodeId = 'cli-test-node';

  beforeAll((done) => {
    const app = express();
    app.use(express.json());

    // Mock cron listing endpoint
    app.get(`/api/terminal/cron/${nodeId}`, (req, res) => {
      res.json({
        success: true,
        data: [
          {
            id: 'cron_tz_1',
            name: 'shanghai-job',
            cron: '0 9 * * *',
            timezone: 'Asia/Shanghai',
            status: 'active',
            nextRunTime: Date.now() + 3600000,
            lastExecution: null,
          },
          {
            id: 'cron_local_2',
            name: 'local-job',
            cron: '0 2 * * *',
            status: 'active',
            nextRunTime: Date.now() + 7200000,
            lastExecution: null,
          },
        ],
      });
    });

    server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('displays --tz, --timezone option in gt cron add --help', async () => {
    const res = await runGt(['cron', 'add', '--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/--tz,\s+--timezone/);
  });

  it('rejects invalid timezone in gt cron add immediately', async () => {
    const res = await runGt([
      'cron', 'add', nodeId,
      '--name', 'invalid-tz-job',
      '--cron', '0 2 * * *',
      '--cmd', 'echo 1',
      '--tz', 'Invalid/Timezone',
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(res.status).not.toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toMatch(/invalid timezone/i);
  });

  it('displays timezone tag in gt cron ls table output for jobs with custom timezone', async () => {
    const res = await runGt([
      'cron', 'ls', nodeId,
      '--server', baseUrl,
      '--key', adminKey,
    ]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('0 9 * * * (Asia/Shanghai)');
    expect(res.stdout).toContain('0 2 * * *');
    expect(res.stdout).not.toContain('0 2 * * * (');
  });
});
