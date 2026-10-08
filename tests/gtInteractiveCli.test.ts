import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import path from 'path';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt exec -it CLI runner', () => {
  let server: http.Server;
  let execWss: WebSocketServer;
  let port: number;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/api/terminal/hosts')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts: [{ id: 'node-1', name: 'node-1', status: 'online' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    execWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      execWss.handleUpgrade(req, socket, head, (ws) => {
        execWss.emit('connection', ws, req);
      });
    });

    execWss.on('connection', (ws, req) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const str = data.toString();
          if (str.includes('exec_start')) {
            ws.send(JSON.stringify({ type: 'exec_started', taskId: 'mock-task-1' }));
            // Send mock output
            setTimeout(() => {
              ws.send(Buffer.from('INTERACTIVE_OK\n'));
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
            }, 100);
          }
        }
      });
    });

    server.listen(0, () => {
      const addr = server.address() as any;
      port = addr.port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('runs interactive exec and pipes output to stdout, exiting with remote code', (done) => {
    const child = spawn('node', [gtPath, 'exec', '-it', `--server=http://localhost:${port}`, 'node-1', 'bash'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', chunk => stdout += chunk);

    child.on('close', (code) => {
      expect(stdout).toContain('INTERACTIVE_OK');
      expect(code).toBe(0);
      done();
    });
  });
});
