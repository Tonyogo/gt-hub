import { execFile } from 'child_process';
import path from 'path';
import http from 'http';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

function runGt(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [gtPath, ...args], {
      env: { TERMINAL_SERVER: 'http://127.0.0.1:59999', ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString()
      });
    });
  });
}

describe('gt (Gemini Terminal) CLI', () => {
  it('displays help information with --help', async () => {
    const res = await runGt(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('gt [GLOBAL_OPTIONS] COMMAND [ARGS...]');
    expect(res.stdout).toContain('ps');
    expect(res.stdout).toContain('exec');
    expect(res.stdout).toContain('task ls');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('kill');
    expect(res.stdout).toContain('agent');
  });

  it('displays version information with --version', async () => {
    const res = await runGt(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/gt version \d+\.\d+\.\d+/);
  });

  it('rejects unknown commands with helpful error', async () => {
    const res = await runGt(['unknown-cmd']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown command: unknown-cmd');
  });

  it('parses -it, -ti, -i, -t, and --tty flags correctly for exec', async () => {
    const res = await runGt(['exec', '-it', 'srv-1', 'bash']);
    expect(res.stderr).not.toContain('requires at least 2 arguments');
    expect(res.stderr).not.toContain('Unknown option');
  });

  it('strictly requires both host and command for exec', async () => {
    const resNoArgs = await runGt(['exec']);
    expect(resNoArgs.code).toBe(1);
    expect(resNoArgs.stderr).toContain('"gt exec" requires at least 2 arguments');

    const resNoCmd = await runGt(['exec', 'srv-1']);
    expect(resNoCmd.code).toBe(1);
    expect(resNoCmd.stderr).toContain('"gt exec" requires at least 2 arguments');

    const resWithFlagsNoCmd = await runGt(['exec', '-it', 'srv-1']);
    expect(resWithFlagsNoCmd.code).toBe(1);
    expect(resWithFlagsNoCmd.stderr).toContain('"gt exec" requires at least 2 arguments');
  });
});

describe('gt CLI Mock Server Integration', () => {
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
            { id: 'node-1', name: 'prod-srv', status: 'online', platform: 'linux', ip: '10.0.0.1', lastSeen: Date.now() - 5000 },
            { id: 'node-2', name: 'dev-box', status: 'offline', platform: 'darwin', ip: '192.168.1.2', lastSeen: Date.now() - 600000 }
          ]
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-1') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.command.includes('fail-command')) {
            res.statusCode = 202;
            res.end(JSON.stringify({ success: true, taskId: 'task-fail' }));
          } else {
            res.statusCode = 202;
            res.end(JSON.stringify({ success: true, taskId: 'task-ok' }));
          }
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1/task-ok') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          status: 'completed',
          exitCode: 0,
          stdout: 'Hello From Remote\n',
          stderr: '',
          outputOffset: 18,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1/task-fail') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          status: 'failed',
          exitCode: 42,
          stdout: '',
          stderr: 'Something went wrong\n',
          outputOffset: 21,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/terminal/exec/node-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          tasks: [{ taskId: 'task-ok', status: 'completed', exitCode: 0, startTime: Date.now() - 10000, command: 'echo hi' }]
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-1/task-ok/kill') {
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

  it('queries and prints formatted hosts table', async () => {
    const res = await runGt(['host', 'ls', '-a', `--server=http://localhost:${serverPort}`]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('node-1');
    expect(res.stdout).toContain('online');
    expect(res.stdout).toContain('node-2');
  });

  it('queries hosts in JSON format with --json', async () => {
    const res = await runGt(['host', 'ls', '--json', `--server=http://localhost:${serverPort}`]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed.hosts)).toBe(true);
    expect(parsed.hosts[0].id).toBe('node-1');
  });

  it('runs command in streaming mode, prints banners to stderr with --verbose, and stdout to stdout', async () => {
    const res = await runGt(['exec', '--verbose', `--server=http://localhost:${serverPort}`, 'node-1', 'echo hi']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('Hello From Remote\n');
    expect(res.stderr).toContain('>>> [node-1] $ echo hi');
    expect(res.stderr).toContain('<<< [node-1] Command completed with code 0');
  });

  it('outputs pure stdout with zero banners by default or with -q / --quiet', async () => {
    const res = await runGt(['exec', `--server=http://localhost:${serverPort}`, 'node-1', 'echo hi']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('Hello From Remote\n');
    expect(res.stderr).toBe('');

    const resQuiet = await runGt(['exec', '-q', `--server=http://localhost:${serverPort}`, 'node-1', 'echo hi']);
    expect(resQuiet.code).toBe(0);
    expect(resQuiet.stdout).toBe('Hello From Remote\n');
    expect(resQuiet.stderr).toBe('');
  });

  it('supports -- separator to pass flags safely to remote command without collision', async () => {
    const res = await runGt(['exec', '--verbose', `--server=http://localhost:${serverPort}`, 'node-1', '--', 'curl', '-s', '-a']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('>>> [node-1] $ curl -s -a');
  });

  it('forwards non-zero remote exit code', async () => {
    const res = await runGt(['exec', '--verbose', `--server=http://localhost:${serverPort}`, 'node-1', 'fail-command']);
    expect(res.code).toBe(42);
    expect(res.stderr).toContain('Command failed with code 42');
  });

  it('supports detached mode with -d', async () => {
    const res = await runGt(['exec', '-d', `--server=http://localhost:${serverPort}`, 'node-1', 'sleep 10']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-ok');
    expect(res.stdout).toContain("Run 'gt task logs -f node-1 task-ok' to follow logs.");
  });

  it('lists tasks with gt task ls', async () => {
    const res = await runGt(['task', 'ls', `--server=http://localhost:${serverPort}`, 'node-1']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-ok');
  });

  it('views task logs with gt task logs', async () => {
    const res = await runGt(['task', 'logs', `--server=http://localhost:${serverPort}`, 'node-1', 'task-ok']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Hello From Remote');
  });

  it('supports follow mode with -f flag on logs', async () => {
    const res = await runGt(['task', 'logs', '--server', `http://127.0.0.1:${serverPort}`, 'node-1', 'task-ok', '-f']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Hello From Remote');
    expect(res.stdout).not.toContain('--- Output ---');
  });

  it('terminates task with gt task kill', async () => {
    const res = await runGt(['task', 'kill', `--server=http://localhost:${serverPort}`, 'node-1', 'task-ok']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Kill signal sent to task');
  });

  it('does not absorb remote flags like -t or -w after host is specified', async () => {
    const res = await runGt(['exec', '--verbose', '--server', `http://127.0.0.1:${serverPort}`, 'node-1', 'curl', '-t', '10', 'http://example.com']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('curl -t 10 http://example.com');
  });

  it('preserves spaces and quotes in arguments safely', async () => {
    const res = await runGt(['exec', '--verbose', '--server', `http://127.0.0.1:${serverPort}`, 'node-1', 'grep', 'hello world', 'app.log']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("grep 'hello world' app.log");
  });

  it('treats -t as --tty, not as timeout', async () => {
    const res = await runGt(['exec', '--timeout', '60000', '-t', 'node-1', 'echo hi'], {
      TERMINAL_SERVER: `http://localhost:${serverPort}`,
    });
    expect(res.stderr).not.toContain('Unknown option');
  });
});

describe('gt agent embedded runtime exports', () => {
  const { TaskManager, parseControlMessage, resolveWebSocketUrl, quoteShellArg, parseExecArgs } = require('../scripts/gt.js');

  it('exports TaskManager with startTask and getTask', () => {
    const tm = new TaskManager();
    expect(typeof tm.startTask).toBe('function');
    expect(typeof tm.getTask).toBe('function');
  });

  it('exports parseControlMessage and resolveWebSocketUrl', () => {
    expect(typeof parseControlMessage).toBe('function');
    expect(typeof resolveWebSocketUrl).toBe('function');
  });

  it('does not parse bare JSON without JSON: prefix', () => {
    expect(parseControlMessage('{"type":"ping"}')).toBeNull();
    expect(parseControlMessage('{"type":"reset"}')).toBeNull();
    expect(parseControlMessage('JSON:{"type":"ping"}')).toEqual({ type: 'ping' });
  });

  it('ensures resolveWebSocketUrl omits secret keys from query string', () => {
    const wsUrl = resolveWebSocketUrl('http://localhost:3000', {
      hostId: 'host-1',
      name: 'node-1',
      key: 'super-secret',
    });
    expect(wsUrl).toContain('hostId=host-1');
    expect(wsUrl).toContain('name=node-1');
    expect(wsUrl).not.toContain('super-secret');
    expect(wsUrl).not.toContain('key=');
  });

  it('quotes shell arguments properly', () => {
    expect(quoteShellArg('simple')).toBe('simple');
    expect(quoteShellArg('with space')).toBe("'with space'");
    expect(quoteShellArg("don't")).toBe("'don'\\''t'");
    expect(quoteShellArg('')).toBe("''");
  });

  it('parses exec arguments accurately across phases', () => {
    const parsed = parseExecArgs(['-d', '-w', '/var/log', '--timeout', '60000', 'srv-1', 'grep', 'error msg', 'server.log']);
    expect(parsed.host).toBe('srv-1');
    expect(parsed.options.detach).toBe(true);
    expect(parsed.options.workdir).toBe('/var/log');
    expect(parsed.options.timeoutMs).toBe(60000);
    expect(parsed.fullCommand).toBe("grep 'error msg' server.log");
  });
});

