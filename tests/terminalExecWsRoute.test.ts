import http from 'http';
import { WebSocket } from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import config from '../config/default';

describe('Exec WebSocket Route Upgrade', () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    config.adminSecretKey = 'test-secret-key';
    const app = express();
    server = http.createServer(app);
    setupTerminalWebSocket(server);

    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }
      done();
    });
  });

  afterAll((done) => {
    config.adminSecretKey = '';
    server.close(done);
  });

  it('rejects unauthorized connections without x-admin-key', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/exec-ws?hostId=srv-1`);
    ws.on('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(401);
      done();
    });
    ws.on('error', () => {
      // Expected on 401 upgrade reject
    });
  });

  it('accepts authorized connections with x-admin-key header', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/exec-ws?hostId=srv-1`, {
      headers: { 'x-admin-key': 'test-secret-key' },
    });
    ws.on('open', () => {
      ws.close();
      done();
    });
    ws.on('error', (err) => {
      done(err);
    });
  });
});
