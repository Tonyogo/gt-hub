import { execFile } from 'child_process';
import path from 'path';
import http from 'http';

const cliPath = path.resolve(__dirname, '../scripts/gt.js');

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [cliPath, ...args], {
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString()
      });
    });
  });
}

describe('Terminal Exec CLI via gt', () => {
  it('shows help information with --help', async () => {
    const res = await runCli(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('exec');
  });

  it('fails with code 1 if host is missing', async () => {
    const res = await runCli(['exec']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Missing target host');
  });
});

describe('Terminal Exec CLI Integration', () => {
  let server: http.Server;
  let serverPort: number;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-1') {
        res.statusCode = 202;
        res.end(JSON.stringify({ success: true, taskId: 'task-123' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-fail') {
        res.statusCode = 202;
        res.end(JSON.stringify({ success: true, taskId: 'task-fail-42' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-fail/task-fail-42') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          taskId: 'task-fail-42',
          hostId: 'node-fail',
          status: 'failed',
          exitCode: 42,
          stdout: '',
          stderr: 'Command failed\n',
          outputOffset: 15,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1/task-123') {
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        if (offset === 0) {
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            taskId: 'task-123',
            hostId: 'node-1',
            status: 'completed',
            exitCode: 0,
            stdout: 'Hello World\n',
            stderr: '',
            output: 'Hello World\n',
            outputOffset: 12,
          }));
        } else {
          res.statusCode = 200;
          res.end(JSON.stringify({
            success: true,
            taskId: 'task-123',
            hostId: 'node-1',
            status: 'completed',
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: 'Hello World\n',
            outputOffset: 12,
          }));
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          tasks: [{ taskId: 'task-123', status: 'completed', exitCode: 0, command: 'ls', startTime: Date.now() }]
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-1/task-123/kill') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
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

  it('runs command in streaming mode, prints stdout, and exits with 0', async () => {
    const res = await runCli(['exec', `--server=http://localhost:${serverPort}`, 'node-1', 'echo test']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Hello World');
  });

  it('forwards non-zero exit code from remote process', async () => {
    const res = await runCli(['exec', `--server=http://localhost:${serverPort}`, 'node-fail', 'exit 42']);
    expect(res.code).toBe(42);
    expect(res.stderr).toContain('Command failed');
  });

  it('submits task in async mode without polling', async () => {
    const res = await runCli(['exec', '-d', `--server=http://localhost:${serverPort}`, 'node-1', 'echo test']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-123');
  });

  it('inspects task with status subcommand', async () => {
    const res = await runCli(['task', 'logs', `--server=http://localhost:${serverPort}`, 'node-1', 'task-123']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Task:');
    expect(res.stdout).toContain('task-123');
  });

  it('lists tasks with list subcommand', async () => {
    const res = await runCli(['task', 'ls', `--server=http://localhost:${serverPort}`, 'node-1']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-123');
  });

  it('kills task with kill subcommand', async () => {
    const res = await runCli(['task', 'kill', `--server=http://localhost:${serverPort}`, 'node-1', 'task-123']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Kill signal sent');
  });
});
