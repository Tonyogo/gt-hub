import http from 'http';
import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('GET /api/terminal/logs Ticket Auth', () => {
  let server: http.Server;
  let port: number;
  const originalKey = config.adminSecretKey;

  beforeAll((done) => {
    server = http.createServer(app);
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
    config.adminSecretKey = 'hub-secret-test';
    ticketManager.reset();
  });

  it('accepts SSE request with valid ticket', (done) => {
    const ticket = ticketManager.createTicket();
    const req = http.get(`http://localhost:${port}/api/terminal/logs?stream=true&ticket=${ticket}`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(ticketManager.consumeTicket(ticket)).toBe(false);
      res.destroy();
      done();
    });

    req.on('error', (err) => {
      done(err);
    });
  });

  it('rejects SSE request with invalid ticket when admin key is set', async () => {
    const res = await request(app)
      .get('/api/terminal/logs?stream=true&ticket=invalid-ticket');

    expect(res.status).toBe(401);
  });
});
