import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { TerminalHostManager } from '../src/server/modules/terminal/services/hostManager';
import { setupTerminalWebSocket } from '../src/server/modules/terminal/ws/terminalWs';

describe('Server-side Single Agent per Machine Enforcement', () => {
  let server: http.Server;
  let port: number;
  let hostManager: TerminalHostManager;

  beforeAll((done) => {
    const app = express();
    server = http.createServer(app);
    hostManager = new TerminalHostManager();
    setupTerminalWebSocket(server, hostManager);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('rejects second active agent connecting with the same machineId', (done) => {
    const ws1 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-1&name=node-1&machineId=machine-xyz`);

    ws1.on('open', () => {
      // Connect second agent with same machineId but different hostId & name
      const ws2 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-2&name=node-2&machineId=machine-xyz`);

      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString().replace(/^JSON:/, ''));
        if (msg.type === 'rejected') {
          expect(msg.code).toBe(4009);
          expect(msg.reason).toContain('Conflict: Machine (machine-xyz) already has an active agent');
          ws1.close();
          ws2.close();
          done();
        }
      });
    });
  });

  it('allows new agent with same machineId to connect after old agent goes offline', (done) => {
    const ws1 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-old&name=node-old&machineId=machine-takeover`);

    ws1.on('open', () => {
      ws1.close(); // Disconnect agent 1 (becomes offline)
    });

    ws1.on('close', () => {
      setTimeout(() => {
        const ws2 = new WebSocket(`ws://localhost:${port}/api/terminal/agent-ws?hostId=agent-new&name=node-new&machineId=machine-takeover`);
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString().replace(/^JSON:/, ''));
          if (msg.type === 'registered') {
            expect(msg.status).toBe('online');
            ws2.close();
            done();
          }
        });
      }, 50);
    });
  });
});
