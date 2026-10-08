import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('Agent StreamSessionManager', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let agentWs: WebSocket | null = null;
  let agentProcess: any = null;

  beforeAll((done) => {
    server = http.createServer();
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      agentWs = ws;
    });

    server.listen(0, () => {
      const addr = server.address() as any;
      port = addr.port;

      // Start agent process connecting to mock server
      agentProcess = spawn('node', [gtPath, 'agent', '--name=stream-test-agent', '--id=agent-stream-1'], {
        env: {
          ...process.env,
          TERMINAL_SERVER: `http://localhost:${port}`,
          ADMIN_SECRET_KEY: 'test-stream-secret',
        },
        stdio: 'pipe',
      });

      // Wait for agent registration
      const checkInterval = setInterval(() => {
        if (agentWs) {
          clearInterval(checkInterval);
          done();
        }
      }, 50);
    });
  });

  afterAll((done) => {
    if (agentProcess) {
      agentProcess.kill('SIGKILL');
    }
    server.close(done);
  });

  it('handles start_stream and emits cmd_stream_data and cmd_stream_exit', (done) => {
    let receivedData = '';
    const taskId = 'test-stream-echo';

    agentWs!.on('message', (raw) => {
      const str = raw.toString();
      if (!str.startsWith('JSON:')) return;
      const msg = JSON.parse(str.slice(5));

      if (msg.taskId === taskId && msg.type === 'cmd_stream_data') {
        receivedData += Buffer.from(msg.data, 'base64').toString('utf-8');
      }

      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        expect(receivedData).toContain('STREAM_WORKS');
        expect(msg.exitCode).toBe(0);
        done();
      }
    });

    // Send start_stream to agent
    agentWs!.send(`JSON:${JSON.stringify({
      type: 'cmd_exec',
      action: 'start_stream',
      taskId,
      command: 'echo STREAM_WORKS',
      tty: true,
    })}`);
  });
});
