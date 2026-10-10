import { execFile } from 'child_process';
import path from 'path';
import http from 'http';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt logs smart default & gt kill', () => {
  let server: http.Server;
  let serverPort: number;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/api/terminal/hosts') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          hosts: [
            { id: 'srv-1', name: 'my-server', status: 'online' },
            { id: 'srv-empty', name: 'empty-server', status: 'online' },
          ]
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/srv-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          tasks: [
            { taskId: 'task-latest-999', status: 'completed', exitCode: 0, startTime: Date.now() - 1000 },
            { taskId: 'task-older-111', status: 'completed', exitCode: 0, startTime: Date.now() - 50000 },
          ]
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/srv-empty') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          tasks: []
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/srv-1/task-latest-999') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          taskId: 'task-latest-999',
          hostId: 'srv-1',
          status: 'completed',
          exitCode: 0,
          output: 'Hello latest task output!\n'
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/srv-1/task-latest-999/kill') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile('node', [gtPath, ...args], {
        env: { ...process.env, GT_SERVER: `http://127.0.0.1:${serverPort}`, GT_KEY: 'test-key' }
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      });
    });
  }

  it('automatically picks the latest task when taskId is omitted in "gt task logs <node>"', async () => {
    const res = await run(['task', 'logs', 'my-server']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-latest-999');
    expect(res.stdout).toContain('Hello latest task output!');
  });

  it('rejects removed top-level "gt logs <node>" with code 2', async () => {
    const res = await run(['logs', 'my-server']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  });

  it('handles empty task list gracefully with code 1 in "gt task logs <node>"', async () => {
    const res = await run(['task', 'logs', 'empty-server']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('No tasks found on node [srv-empty].');
  });

  it('kills a remote task with "gt task kill <node> <taskId>"', async () => {
    const res = await run(['task', 'kill', 'my-server', 'task-latest-999']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Kill signal sent to task [task-latest-999]');
  });

  it('rejects removed top-level "gt kill <node> <taskId>" with code 2', async () => {
    const res = await run(['kill', 'my-server', 'task-latest-999']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  });
});
