import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Native RFC 6455 Ping/Pong Control Frames', () => {
  let server: http.Server;
  let port: number;
  let testWs: WebSocket | null = null;

  beforeAll((done) => {
    const app = express();
    server = http.createServer(app);
    setupTerminalWebSocket(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    if (testWs) {
      try { testWs.terminate(); } catch {}
      testWs = null;
    }
    terminalHostManager.unregisterAgent('ping-node-test');
    server.close(done);
  });

  it('updates host lastSeen on receiving native WebSocket ping control frame', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=ping-node-test&name=ping-node`);
    testWs = ws;

    ws.on('open', () => {
      setTimeout(() => {
        const hostBefore = terminalHostManager.getHost('ping-node-test');
        expect(hostBefore).toBeDefined();
        const initialSeen = hostBefore!.lastSeen;

        // Wait 10ms to ensure timestamp difference
        setTimeout(() => {
          // Send native WS ping
          ws.ping();

          ws.on('pong', () => {
            setTimeout(() => {
              const hostAfter = terminalHostManager.getHost('ping-node-test');
              expect(hostAfter!.lastSeen).toBeGreaterThan(initialSeen);
              ws.close();
              done();
            }, 50);
          });
        }, 10);
      }, 50);
    });

    ws.on('error', (err) => {
      done(err);
    });
  });
});
