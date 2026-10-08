import http from 'http';
import { execFile } from 'child_process';
import path from 'path';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

function runGt(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [gtPath, ...args], {
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

describe('gt exec pure stream output', () => {
  let server: http.Server;
  let serverPort: number;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/api/terminal/hosts') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          hosts: [{ id: 'node-1', name: 'srv-1', status: 'online' }]
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-1') {
        res.statusCode = 202;
        res.end(JSON.stringify({ success: true, taskId: 'task-mock-1', hostId: 'node-1' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1/task-mock-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          taskId: 'task-mock-1',
          status: 'completed',
          exitCode: 0,
          stdout: 'pure output line\n',
          stderr: '',
          offset: 17,
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
      }
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('outputs pure stdout with NO >>> or <<< banners by default', async () => {
    const res = await runGt(['exec', 'node-1', 'echo', 'hi'], {
      TERMINAL_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toBe('pure output line\n');
    expect(res.stderr).not.toContain('>>>');
    expect(res.stderr).not.toContain('<<<');
  });

  it('outputs >>> and <<< banners when --verbose is specified', async () => {
    const res = await runGt(['exec', '--verbose', 'node-1', 'echo', 'hi'], {
      TERMINAL_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toBe('pure output line\n');
    expect(res.stderr).toContain('>>> [node-1] $ echo hi');
    expect(res.stderr).toContain('<<< [node-1] Command completed with code 0');
  });
});
