import http from 'http';
import { WebSocketServer } from 'ws';
import { execFile } from 'child_process';
import path from 'path';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

function runGt(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [gtPath, ...args],
      {
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      }
    );
  });
}

describe('gt exec WebSocket Streaming Integration', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let serverPort: number;
  let wsConnectionCount = 0;
  let lastWsStartPayload: any = null;

  let receivedBinaryMessages: Buffer[] = [];

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/api/terminal/hosts') {
        res.statusCode = 200;
        res.end(JSON.stringify({ hosts: [{ id: 'node-ws-1', name: 'node-ws-1', status: 'online' }] }));
        return;
      }

      // Detached and Polled execution endpoints
      if (req.method === 'POST' && url.pathname === '/api/terminal/exec/node-ws-1') {
        res.statusCode = 202;
        res.end(JSON.stringify({ success: true, taskId: 'task-poll-99' }));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/terminal/exec/node-ws-1/task-poll-99')) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          status: 'completed',
          exitCode: 0,
          stdout: 'polled output line\n',
          offset: 19,
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      if (url.pathname === '/api/terminal/exec-ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws, req) => {
      wsConnectionCount++;
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const hostId = url.searchParams.get('hostId');

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          receivedBinaryMessages.push(Buffer.from(data as any));
          return;
        }
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'exec_start') {
            lastWsStartPayload = msg;
            ws.send(JSON.stringify({ type: 'exec_started', taskId: 'ws-task-1' }));

            if (msg.command === 'exit 42') {
              ws.send(Buffer.from('execution failed\n'));
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 42 }));
              return;
            }

            if (msg.command === 'cat') {
              setTimeout(() => {
                const combined = Buffer.concat(receivedBinaryMessages);
                const hasEof = combined.includes(0x04);
                ws.send(Buffer.from(`cat received: ${combined.toString('utf-8').replace(/\x04/g, '')}, eof: ${hasEof}\n`));
                ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
              }, 120);
              return;
            }

            ws.send(Buffer.from('streamed line 1\n'));
            ws.send(Buffer.from('streamed line 2\n'));
            ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
          }
        } catch {}
      });
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
    wss.close(() => {
      server.close(done);
    });
  });

  beforeEach(() => {
    wsConnectionCount = 0;
    lastWsStartPayload = null;
    receivedBinaryMessages = [];
  });

  it('connects to /api/terminal/exec-ws and streams output over WebSocket without polling', async () => {
    const res = await runGt(['exec', 'node-ws-1', 'echo', 'hello'], {
      GT_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('streamed line 1\n');
    expect(res.stdout).toContain('streamed line 2\n');
    expect(wsConnectionCount).toBe(1);
    expect(lastWsStartPayload).toBeTruthy();
    expect(lastWsStartPayload.type).toBe('exec_start');
    expect(lastWsStartPayload.tty).toBe(false);
    expect(lastWsStartPayload.interactive).toBe(false);
  });

  it('forwards non-zero exit code over WebSocket stream', async () => {
    const res = await runGt(['exec', 'node-ws-1', 'exit 42'], {
      GT_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(42);
    expect(res.stdout).toContain('execution failed\n');
    expect(wsConnectionCount).toBe(1);
  });

  it('streams stdin data and terminates with EOF 0x04 over WebSocket', async () => {
    const child = execFile(
      'node',
      [gtPath, 'exec', '-i', 'node-ws-1', 'cat'],
      { env: { ...process.env, GT_SERVER: `http://localhost:${serverPort}` } },
      () => {}
    );
    child.stdin?.write('test stdin content');
    child.stdin?.end();

    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      let out = '';
      child.stdout?.on('data', (d) => {
        out += d;
      });
      child.on('close', (code) => resolve({ code: code || 0, stdout: out }));
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cat received: test stdin content');
    expect(result.stdout).toContain('eof: true');
    expect(wsConnectionCount).toBe(1);
  });

  it('preserves detached mode (-d) via HTTP POST without initiating WebSocket connection', async () => {
    const res = await runGt(['exec', '-d', 'node-ws-1', 'echo', 'background'], {
      GT_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('task-poll-99');
    expect(wsConnectionCount).toBe(0);
  });

  it('supports --poll flag using HTTP polling without initiating WebSocket connection', async () => {
    const res = await runGt(['exec', '--poll', 'node-ws-1', 'echo', 'via-poll'], {
      GT_SERVER: `http://localhost:${serverPort}`,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('polled output line');
    expect(wsConnectionCount).toBe(0);
  });
});
