import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('GET /api/terminal/logs Ticket Auth', () => {
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    config.adminSecretKey = 'hub-secret-test';
    ticketManager.reset();
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  it('accepts SSE request with valid ticket', async () => {
    const ticket = ticketManager.createTicket();
    const res = await request(app)
      .get(`/api/terminal/logs?stream=true&ticket=${ticket}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(ticketManager.consumeTicket(ticket)).toBe(false);
  });

  it('rejects SSE request with invalid ticket when admin key is set', async () => {
    const res = await request(app)
      .get('/api/terminal/logs?stream=true&ticket=invalid-ticket');

    expect(res.status).toBe(401);
  });
});
