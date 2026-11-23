import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { terminalExecBridge } from '../src/terminal/services/terminalExecBridge';

describe('Batch B: Task 7 - terminalExecBridge handleAgentDisconnected close code', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let clientWs: WebSocket | null = null;
  let serverWs: WebSocket | null = null;

  beforeEach((done) => {
    server = http.createServer();
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      serverWs = ws;
    });

    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }
      done();
    });
  });

  afterEach(async () => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.terminate(); } catch {}
    }
    if (serverWs && serverWs.readyState === WebSocket.OPEN) {
      try { serverWs.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  });

  it('notifies CLI with [Agent Disconnected] and closes client with valid RFC 6455 code 1012', (done) => {
    clientWs = new WebSocket(`ws://localhost:${port}`);

    clientWs.on('open', () => {
      expect(serverWs).toBeTruthy();

      const hostId = 'test-host-disconnect';
      const taskId = 'exec-test-task-1';

      // Register session in bridge
      (terminalExecBridge as any).activeSessions.set(taskId, {
        taskId,
        hostId,
        cliWs: serverWs,
        createdAt: Date.now(),
      });
      if (!(terminalExecBridge as any).hostToTasks.has(hostId)) {
        (terminalExecBridge as any).hostToTasks.set(hostId, new Set());
      }
      (terminalExecBridge as any).hostToTasks.get(hostId).add(taskId);

      let receivedDisconnectMessage = false;

      clientWs!.on('message', (data) => {
        const msg = data.toString();
        if (msg.includes('[Agent Disconnected]')) {
          receivedDisconnectMessage = true;
        }
      });

      // Must receive close event with code 1012 within 1000ms
      const timeout = setTimeout(() => {
        done(new Error('Timed out waiting for cliWs close event (likely RangeError on invalid close code 1006)'));
      }, 1000);

      clientWs!.on('close', (code, reason) => {
        clearTimeout(timeout);
        expect(receivedDisconnectMessage).toBe(true);
        expect(code).toBe(1012);
        done();
      });

      // Trigger agent disconnect
      terminalExecBridge.handleAgentDisconnected(hostId);
    });
  });
});
