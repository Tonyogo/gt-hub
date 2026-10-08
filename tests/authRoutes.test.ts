import request from 'supertest';
import express from 'express';
import authRoutes from '../src/auth/routes/authRoutes';
import config from '../config/default';

describe('Auth Routes (/api/auth)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const originalKey = config.adminSecretKey;

  afterEach(() => {
    config.adminSecretKey = originalKey;
  });

  describe('GET /api/auth/status', () => {
    it('returns authRequired: false and authenticated: true when no adminSecretKey is set', async () => {
      config.adminSecretKey = '';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: false, authenticated: true });
    });

    it('returns authRequired: true and authenticated: false when key is required but none provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false });
    });

    it('returns authenticated: true when valid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'correct-secret-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: true });
    });

    it('returns authenticated: false when invalid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'wrong-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false });
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 200 success when server requires no key', async () => {
      config.adminSecretKey = '';
      const res = await request(app).post('/api/auth/login').send({ key: 'any-key' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 200 success when matching key is provided', async () => {
      config.adminSecretKey = 'my-secret-token';
      const res = await request(app).post('/api/auth/login').send({ key: 'my-secret-token' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 401 when wrong key is provided', async () => {
      config.adminSecretKey = 'my-secret-token';
      const res = await request(app).post('/api/auth/login').send({ key: 'bad-token' });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });
  });
});
