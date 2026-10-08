import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import config from '../config/default';
import { terminalHostManager, TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';

describe('Terminal Agent Offline Race Condition & Heartbeat Auto-Heal Fix Tests', () => {
  const hostId = 'agent-race-test-node';
  const hostName = 'Race-Test-Node';

  afterEach(() => {
    terminalHostManager.unregisterAgent(hostId);
  });

  describe('Unit: TerminalHostManager Stale Socket Protection & Auto-Healing', () => {
    test('ignores unregister from stale WebSocket when new connection has already registered', () => {
      const mockWs1 = { readyState: 1, send: jest.fn(), close: jest.fn() };
      const mockWs2 = { readyState: 1, send: jest.fn(), close: jest.fn() };

      // 1. Initial connection
      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs1,
      });

      expect(terminalHostManager.getHost(hostId)?.status).toBe('online');
      expect(terminalHostManager.isCurrentAgentWs(hostId, mockWs1)).toBe(true);

      // 2. Reconnection arrives with new socket mockWs2
      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs2,
      });

      // Superseded mockWs1 should be closed cleanly
      expect(mockWs1.close).toHaveBeenCalledWith(1000, 'Superseded by new agent connection');
      expect(terminalHostManager.isCurrentAgentWs(hostId, mockWs1)).toBe(false);
      expect(terminalHostManager.isCurrentAgentWs(hostId, mockWs2)).toBe(true);

      // 3. Stale mockWs1 finally closes
      terminalHostManager.unregisterAgent(hostId, mockWs1);

      // CRITICAL: Host must REMAIN online because mockWs2 is the active socket!
      const host = terminalHostManager.getHost(hostId);
      expect(host?.status).toBe('online');
      const session = terminalHostManager.getSession(hostId);
      expect(session).not.toBeNull();
      expect(session?.getAgentWs()).toBe(mockWs2);

      // 4. When current mockWs2 closes, it must properly mark offline
      terminalHostManager.unregisterAgent(hostId, mockWs2);
      expect(terminalHostManager.getHost(hostId)?.status).toBe('offline');
      expect(session?.getAgentWs()).toBeNull();
    });

    test('stale socket message in touchAgent does not hijack active session socket', () => {
      const mockWs1 = { readyState: 1, send: jest.fn(), close: jest.fn() };
      const mockWs2 = { readyState: 1, send: jest.fn(), close: jest.fn() };

      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs1,
      });

      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs2,
      });

      expect(terminalHostManager.getSession(hostId)?.getAgentWs()).toBe(mockWs2);

      // Stale mockWs1 sends a trailing message
      terminalHostManager.touchAgent(hostId, mockWs1);

      // CRITICAL: Active socket must remain mockWs2, NOT be hijacked back to mockWs1!
      expect(terminalHostManager.getSession(hostId)?.getAgentWs()).toBe(mockWs2);
      expect(mockWs1.close).toHaveBeenCalledWith(1000, 'Superseded by newer connection');

      // Stale mockWs1 triggers close event -> host must stay online!
      terminalHostManager.unregisterAgent(hostId, mockWs1);
      expect(terminalHostManager.getHost(hostId)?.status).toBe('online');
      expect(terminalHostManager.getSession(hostId)?.getAgentWs()).toBe(mockWs2);
    });

    test('rapid successive reconnects with 5 sockets and out-of-order closures', () => {
      const sockets = [
        { readyState: 1, send: jest.fn(), close: jest.fn() },
        { readyState: 1, send: jest.fn(), close: jest.fn() },
        { readyState: 1, send: jest.fn(), close: jest.fn() },
        { readyState: 1, send: jest.fn(), close: jest.fn() },
        { readyState: 1, send: jest.fn(), close: jest.fn() },
      ];

      // 5 rapid reconnects
      for (const s of sockets) {
        terminalHostManager.registerAgent({
          hostId,
          name: hostName,
          agentWs: s,
        });
      }

      // Latest socket (sockets[4]) must be the active socket
      expect(terminalHostManager.getSession(hostId)?.getAgentWs()).toBe(sockets[4]);
      expect(terminalHostManager.isCurrentAgentWs(hostId, sockets[4])).toBe(true);

      // Superseded sockets 0..3 should all be closed
      for (let i = 0; i < 4; i++) {
        expect(sockets[i].close).toHaveBeenCalledWith(1000, 'Superseded by new agent connection');
      }

      // Stale sockets close in random out-of-order sequence
      const closeOrder = [2, 0, 3, 1];
      for (const idx of closeOrder) {
        terminalHostManager.unregisterAgent(hostId, sockets[idx]);
        // Host must REMAIN online throughout all stale closures
        expect(terminalHostManager.getHost(hostId)?.status).toBe('online');
        expect(terminalHostManager.getSession(hostId)?.getAgentWs()).toBe(sockets[4]);
      }

      // Heartbeat touch from active socket works
      terminalHostManager.touchAgent(hostId, sockets[4]);
      expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

      // Finally active socket closes -> host transitions to offline
      terminalHostManager.unregisterAgent(hostId, sockets[4]);
      expect(terminalHostManager.getHost(hostId)?.status).toBe('offline');
      expect(terminalHostManager.getSession(hostId)).toBeNull();
    });

    test('touchAgent updates lastSeen and restores offline status to online', () => {
      const mockWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs,
      });

      const initialLastSeen = Date.now() - 50000;
      const host = terminalHostManager.getHost(hostId)!;
      host.lastSeen = initialLastSeen;
      host.status = 'offline';

      // Agent sends heartbeat or data frame
      terminalHostManager.touchAgent(hostId, mockWs);

      expect(host.status).toBe('online');
      expect(host.lastSeen).toBeGreaterThan(initialLastSeen);
    });

    test('getHost, getHosts, and getSession auto-heal offline host if agent socket is actually connected', () => {
      const mockWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs,
      });

      const host = terminalHostManager.getHost(hostId)!;

      // 1. Simulate host mistakenly marked offline -> getHost should auto-heal
      host.status = 'offline';
      const healedHost = terminalHostManager.getHost(hostId);
      expect(healedHost?.status).toBe('online');

      // 2. Set offline again -> getSession should auto-heal to online and return session
      host.status = 'offline';
      const session = terminalHostManager.getSession(hostId);
      expect(session).not.toBeNull();
      expect(host.status).toBe('online');

      // 3. Set offline again -> getHosts should auto-heal to online
      host.status = 'offline';
      const hosts = terminalHostManager.getHosts();
      const found = hosts.find(h => h.id === hostId);
      expect(found).toBeDefined();
      expect(found?.status).toBe('online');
    });

    test('pruneOfflineHosts(0) never prunes a host if its agent socket is still open', () => {
      const mockWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
      terminalHostManager.registerAgent({
        hostId,
        name: hostName,
        agentWs: mockWs,
      });

      const host = terminalHostManager.getHost(hostId)!;
      host.status = 'offline';

      // Attempting to prune offline hosts must auto-heal, NOT delete
      const pruned = terminalHostManager.pruneOfflineHosts(0);
      expect(pruned).not.toContain(hostId);
      expect(terminalHostManager.getHost(hostId)?.status).toBe('online');
    });
  });

  describe('Integration: E2E WebSocket Connection & Reconnection Race', () => {
    let server: http.Server;
    let wss: WebSocketServer;
    let port: number;
    const originalKey = config.adminSecretKey;

    beforeAll((done) => {
      config.adminSecretKey = 'test-secret';
      server = http.createServer();
      wss = setupTerminalWebSocket(server);
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        done();
      });
    });

    afterAll((done) => {
      config.adminSecretKey = originalKey;
      wss.close(() => {
        server.close(done);
      });
    });

    test('keeps host online when old socket closes after new socket connects and pings', (done) => {
      const wsUrl = `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${hostId}&name=${hostName}&key=test-secret`;

      // 1. Connect socket 1
      const client1 = new WebSocket(wsUrl);

      client1.once('open', () => {
        expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

        // 2. Connect socket 2 (reconnect)
        const client2 = new WebSocket(wsUrl);

        client2.once('open', () => {
          expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

          // 3. Now close socket 1
          client1.close();

          setTimeout(() => {
            // CRITICAL: Host must remain online!
            expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

            // 4. Send ping on socket 2
            client2.send('JSON:{"type":"ping"}');

            client2.once('message', (msg) => {
              expect(msg.toString()).toBe('JSON:{"type":"pong"}');

              // Verify host remains online and lastSeen is fresh
              const currentHost = terminalHostManager.getHost(hostId);
              expect(currentHost?.status).toBe('online');

              client2.close();
              setTimeout(() => {
                // Once socket 2 closes, host is now offline
                expect(terminalHostManager.getHost(hostId)?.status).toBe('offline');
                done();
              }, 100);
            });
          }, 100);
        });
      });
    }, 10000);

    test('rapid successive reconnects keep host online with latest connection', (done) => {
      const wsUrl = `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${hostId}&name=${hostName}&key=test-secret`;

      // Connect socket A
      const clientA = new WebSocket(wsUrl);
      clientA.once('open', () => {
        // Connect socket B
        const clientB = new WebSocket(wsUrl);
        clientB.once('open', () => {
          // Connect socket C
          const clientC = new WebSocket(wsUrl);
          clientC.once('open', () => {
            // Close A and B
            clientA.close();
            clientB.close();

            setTimeout(() => {
              // Host must remain online with socket C
              expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

              // Ping on C
              clientC.send('JSON:{"type":"ping"}');
              clientC.once('message', (msg) => {
                expect(msg.toString()).toBe('JSON:{"type":"pong"}');
                expect(terminalHostManager.getHost(hostId)?.status).toBe('online');

                clientC.close();
                setTimeout(() => {
                  expect(terminalHostManager.getHost(hostId)?.status).toBe('offline');
                  done();
                }, 100);
              });
            }, 100);
          });
        });
      });
    }, 10000);
  });
});
