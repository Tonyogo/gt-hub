import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import config from '../config/default';

describe('Native RFC 6455 Ping/Pong Control Frames', () => {
  let server: http.Server;
  let port: number;
  let testWs: WebSocket | null = null;
  const authQuery = config.adminSecretKey ? `&key=${config.adminSecretKey}` : '';

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
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=ping-node-test&name=ping-node${authQuery}`);
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

  it('stores agent startTime passed in WebSocket query string', (done) => {
    const customStartTime = Date.now() - 7200000; // 2 hours ago
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=uptime-ws-test&name=uptime-ws-node&startTime=${customStartTime}${authQuery}`);

    ws.on('open', () => {
      setTimeout(() => {
        try {
          const host = terminalHostManager.getHost('uptime-ws-test');
          expect(host).toBeDefined();
          expect(host!.startTime).toBe(customStartTime);
          ws.close();
          terminalHostManager.unregisterAgent('uptime-ws-test');
          done();
        } catch (err) {
          ws.close();
          terminalHostManager.unregisterAgent('uptime-ws-test');
          done(err);
        }
      }, 50);
    });

    ws.on('error', (err) => {
      done(err);
    });
  });

  it('updates host lastSeen on receiving application-level JSON ping message and replies with pong', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=app-ping-node-test&name=app-ping-node${authQuery}`);

    ws.on('open', () => {
      setTimeout(() => {
        const hostBefore = terminalHostManager.getHost('app-ping-node-test');
        expect(hostBefore).toBeDefined();
        const initialSeen = hostBefore!.lastSeen;

        setTimeout(() => {
          ws.send('JSON:' + JSON.stringify({ type: 'ping' }));

          ws.on('message', (data) => {
            const str = data.toString();
            if (str.startsWith('JSON:')) {
              const msg = JSON.parse(str.slice(5));
              if (msg.type === 'pong') {
                setTimeout(() => {
                  try {
                    const hostAfter = terminalHostManager.getHost('app-ping-node-test');
                    expect(hostAfter!.lastSeen).toBeGreaterThan(initialSeen);
                    ws.close();
                    terminalHostManager.unregisterAgent('app-ping-node-test');
                    done();
                  } catch (err) {
                    ws.close();
                    terminalHostManager.unregisterAgent('app-ping-node-test');
                    done(err);
                  }
                }, 50);
              }
            }
          });
        }, 10);
      }, 50);
    });

    ws.on('error', (err) => {
      terminalHostManager.unregisterAgent('app-ping-node-test');
      done(err);
    });
  });
});
