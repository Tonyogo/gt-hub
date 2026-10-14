import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { ticketManager } from '../src/server/modules/auth/ticketManager';

describe('POST /api/auth/ticket', () => {
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    ticketManager.reset();
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  it('returns 401 when x-admin-key is missing and auth is required', async () => {
    config.adminSecretKey = 'test-secret-key';
    const res = await request(app).post('/api/auth/ticket');
    expect(res.status).toBe(401);
  });

  it('issues ticket when valid x-admin-key header is provided', async () => {
    config.adminSecretKey = 'test-secret-key';
    const res = await request(app)
      .post('/api/auth/ticket')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.ticket.length).toBe(48);
    expect(res.body.expiresIn).toBe(30);

    // Can be consumed by ticketManager
    expect(ticketManager.consumeTicket(res.body.ticket)).toBe(true);
  });
});
