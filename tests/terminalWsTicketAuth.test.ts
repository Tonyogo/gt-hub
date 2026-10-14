import http from 'http';
import WebSocket from 'ws';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('Terminal WebSocket Ticket Auth', () => {
  let server: http.Server;
  let port: number;
  const originalKey = config.adminSecretKey;

  beforeAll((done) => {
    config.adminSecretKey = 'hub-secret-test';
    server = http.createServer(app);
    setupTerminalWebSocket(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    config.adminSecretKey = originalKey;
    server.close(done);
  });

  beforeEach(() => {
    ticketManager.reset();
  });

  it('accepts connection with valid one-time ticket and consumes it', (done) => {
    const ticket = ticketManager.createTicket();
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?ticket=${ticket}&hostId=test-node`);

    ws.on('open', () => {
      ws.close();
      // Ticket should be consumed now
      expect(ticketManager.consumeTicket(ticket)).toBe(false);
      done();
    });

    ws.on('error', (err) => {
      done(err);
    });
  });

  it('rejects connection with invalid or already consumed ticket', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?ticket=invalid-ticket-123&hostId=test-node`);

    ws.on('open', () => {
      ws.close();
      done(new Error('Should have been rejected'));
    });

    ws.on('error', () => {
      // Expected rejection
      done();
    });
  });

  it('still accepts connection with valid x-admin-key header (CLI compatibility)', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?hostId=test-node`, {
      headers: { 'x-admin-key': 'hub-secret-test' },
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
