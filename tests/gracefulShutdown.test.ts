import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { gracefulShutdown } from '../src/server/index';
import config from '../config/default';

describe('Server Graceful Shutdown & WebSocket Clean Disconnect', () => {
  let server: http.Server;
  let port: number;
  let wss: any;
  const authQuery = config.adminSecretKey ? `&key=${encodeURIComponent(config.adminSecretKey)}` : '';

  beforeEach((done) => {
    const app = express();
    app.get('/health', (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    wss = setupTerminalWebSocket(server);

    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    if (wss) {
      try {
        wss.close();
      } catch {}
    }
    server.close(() => done());
  });

  it('notifies all connected WebSocket clients with 1001 code when closing', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=test-shutdown-agent${authQuery}`);

    await new Promise<void>((resolve) => {
      client.on('open', () => resolve());
    });

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      client.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    // Call closeAllClients
    expect(typeof wss.closeAllClients).toBe('function');
    wss.closeAllClients(1001, 'Server shutting down');

    const result = await closePromise;
    expect(result.code).toBe(1001);
    expect(result.reason).toBe('Server shutting down');
  });

  it('gracefully shuts down server instance without throwing', async () => {
    await expect(gracefulShutdown('SIGTERM', 2000)).resolves.toBeUndefined();
  });

  it('configures 0.0.0.0 host binding in ecosystem.config.js and default config', () => {
    const ecosystem = require('../ecosystem.config.js');
    expect(ecosystem.apps[0].env.HOST).toBe('0.0.0.0');
    expect(config.host).toBe('0.0.0.0');
  });
});
