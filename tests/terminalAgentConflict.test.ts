import { WebSocketServer } from 'ws';
import http from 'http';
import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const agentScript = path.resolve(__dirname, '../scripts/gt.js');

describe('Node.js Terminal Agent - 12-Hex ID, Auto-Naming and Conflict Rejection', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let serverPort: number;
  let receivedQueryParams: Record<string, string> = {};
  let tempConfigDir: string;

  beforeAll((done) => {
    tempConfigDir = path.join(os.tmpdir(), `gt-test-conflict-${Date.now()}`);
    fs.mkdirSync(tempConfigDir, { recursive: true });

    server = http.createServer();
    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      url.searchParams.forEach((val, key) => {
        receivedQueryParams[key] = val;
      });

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (url.searchParams.get('name') === 'conflict-name') {
          // Simulate rejection
          ws.send(JSON.stringify({ type: 'rejected', reason: 'Name already taken', code: 4009 }));
          ws.close(4009, 'Name already taken');
        } else {
          ws.send(JSON.stringify({ type: 'registered', hostId: url.searchParams.get('hostId'), status: 'online' }));
        }
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
    try {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    } catch {}
    wss.close();
    server.close(done);
  });

  beforeEach(() => {
    receivedQueryParams = {};
  });

  it('generates 12-hex hostId and auto-derives name when not specified', (done) => {
    const child = execFile('node', [agentScript, 'agent'], {
      env: {
        ...process.env,
        GT_CONFIG_DIR: tempConfigDir,
        TERMINAL_SERVER: `http://localhost:${serverPort}`,
        ADMIN_SECRET_KEY: 'test-secret-key',
      },
    });

    const interval = setInterval(() => {
      if (receivedQueryParams.hostId) {
        clearInterval(interval);
        clearTimeout(timer);
        try {
          expect(receivedQueryParams.hostId).toMatch(/^[0-9a-f]{12}$/);
          expect(receivedQueryParams.name).toMatch(/^[a-z0-9-_]+$/);
        } finally {
          child.kill('SIGKILL');
          done();
        }
      }
    }, 50);

    const timer = setTimeout(() => {
      clearInterval(interval);
      try {
        expect(receivedQueryParams.hostId).toMatch(/^[0-9a-f]{12}$/);
        expect(receivedQueryParams.name).toMatch(/^[a-z0-9-_]+$/);
      } finally {
        child.kill('SIGKILL');
        done();
      }
    }, 2000);
  });

  it('exits with code 1 immediately without reconnect loops when rejected with 4009', (done) => {
    const child = execFile('node', [agentScript, 'agent', '--name=conflict-name'], {
      env: {
        ...process.env,
        GT_CONFIG_DIR: tempConfigDir,
        TERMINAL_SERVER: `http://localhost:${serverPort}`,
        ADMIN_SECRET_KEY: 'test-secret-key',
      },
    }, (error, stdout, stderr) => {
      expect(error?.code).toBe(1);
      expect(stderr).toContain('Registration rejected by server');
      done();
    });
  });
});
