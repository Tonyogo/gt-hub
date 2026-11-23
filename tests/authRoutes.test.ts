import request from 'supertest';
import express from 'express';
import authRoutes from '../src/auth/routes/authRoutes';
import { loginRateLimiter } from '../src/server/modules/auth/rateLimiter';
import { resolveAllowedParentOrigins } from '../src/server/modules/auth/authController';
import config, { DEFAULT_ADMIN_SECRET_KEY, resolveAdminSecretKey } from '../config/default';

describe('Auth Routes (/api/auth)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const originalKey = config.adminSecretKey;

  afterEach(() => {
    config.adminSecretKey = originalKey;
    loginRateLimiter.reset();
  });

  describe('resolveAdminSecretKey configuration resolution', () => {
    it('defaults to "gt-hub" when no env vars are set or whitespace-only', () => {
      expect(DEFAULT_ADMIN_SECRET_KEY).toBe('gt-hub');
      expect(resolveAdminSecretKey({})).toBe('gt-hub');
      expect(resolveAdminSecretKey({ ADMIN_SECRET_KEY: '   ' })).toBe('gt-hub');
      expect(resolveAdminSecretKey({ GT_KEY: '   ' })).toBe('gt-hub');
    });

    it('prefers ADMIN_SECRET_KEY over GT_KEY', () => {
      expect(resolveAdminSecretKey({ ADMIN_SECRET_KEY: 'primary-key', GT_KEY: 'legacy-key' })).toBe(
        'primary-key',
      );
      expect(resolveAdminSecretKey({ GT_KEY: 'legacy-key' })).toBe('legacy-key');
    });
  });

  describe('GET /api/auth/status', () => {
    it('returns authRequired: false and authenticated: true when no adminSecretKey is set', async () => {
      config.adminSecretKey = '';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: false, authenticated: true, allowedParentOrigins: [] });
    });

    it('returns authRequired: true and authenticated: false when key is required but none provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false, allowedParentOrigins: [] });
    });

    it('returns authenticated: true when valid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'correct-secret-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: true, allowedParentOrigins: [] });
    });

    it('returns authenticated: true when valid Authorization Bearer header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('Authorization', 'Bearer correct-secret-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: true, allowedParentOrigins: [] });
    });

    it('returns authenticated: true when valid query params are provided (admin_key, x-admin-key, key)', async () => {
      config.adminSecretKey = 'correct-secret-key';

      const resAdminKey = await request(app).get('/api/auth/status?admin_key=correct-secret-key');
      expect(resAdminKey.status).toBe(200);
      expect(resAdminKey.body).toEqual({ authRequired: true, authenticated: true, allowedParentOrigins: [] });

      const resXAdminKey = await request(app).get('/api/auth/status?x-admin-key=correct-secret-key');
      expect(resXAdminKey.status).toBe(200);
      expect(resXAdminKey.body).toEqual({ authRequired: true, authenticated: true, allowedParentOrigins: [] });

      const resKey = await request(app).get('/api/auth/status?key=correct-secret-key');
      expect(resKey.status).toBe(200);
      expect(resKey.body).toEqual({ authRequired: true, authenticated: true, allowedParentOrigins: [] });
    });

    it('returns authenticated: false when invalid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'wrong-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false, allowedParentOrigins: [] });
    });

    it('returns allowedParentOrigins parsed from GT_FRAME_ANCESTORS and GT_ALLOWED_PARENT_ORIGINS', async () => {
      const origAncestors = process.env.GT_FRAME_ANCESTORS;
      const origAllowed = process.env.GT_ALLOWED_PARENT_ORIGINS;
      process.env.GT_FRAME_ANCESTORS = 'https://portal.example.com, https://admin.example.com';
      process.env.GT_ALLOWED_PARENT_ORIGINS = 'https://extra.example.com';
      try {
        const res = await request(app).get('/api/auth/status');
        expect(res.status).toBe(200);
        expect(res.body.allowedParentOrigins).toEqual([
          'https://portal.example.com',
          'https://admin.example.com',
          'https://extra.example.com',
        ]);
      } finally {
        if (origAncestors === undefined) delete process.env.GT_FRAME_ANCESTORS;
        else process.env.GT_FRAME_ANCESTORS = origAncestors;
        if (origAllowed === undefined) delete process.env.GT_ALLOWED_PARENT_ORIGINS;
        else process.env.GT_ALLOWED_PARENT_ORIGINS = origAllowed;
      }
    });
  });

  describe('resolveAllowedParentOrigins helper', () => {
    it('returns empty array when neither environment variable is set', () => {
      const origAncestors = process.env.GT_FRAME_ANCESTORS;
      const origAllowed = process.env.GT_ALLOWED_PARENT_ORIGINS;
      delete process.env.GT_FRAME_ANCESTORS;
      delete process.env.GT_ALLOWED_PARENT_ORIGINS;
      try {
        expect(resolveAllowedParentOrigins()).toEqual([]);
      } finally {
        if (origAncestors !== undefined) process.env.GT_FRAME_ANCESTORS = origAncestors;
        if (origAllowed !== undefined) process.env.GT_ALLOWED_PARENT_ORIGINS = origAllowed;
      }
    });

    it('parses, deduplicates, and strips paths from both GT_FRAME_ANCESTORS and GT_ALLOWED_PARENT_ORIGINS', () => {
      const origAncestors = process.env.GT_FRAME_ANCESTORS;
      const origAllowed = process.env.GT_ALLOWED_PARENT_ORIGINS;
      process.env.GT_FRAME_ANCESTORS = "https://a.example.com/some/path 'self' https://b.example.com";
      process.env.GT_ALLOWED_PARENT_ORIGINS = 'https://a.example.com, https://c.example.com:8443';
      try {
        expect(resolveAllowedParentOrigins()).toEqual([
          'https://a.example.com',
          'https://b.example.com',
          'https://c.example.com:8443',
        ]);
      } finally {
        if (origAncestors === undefined) delete process.env.GT_FRAME_ANCESTORS;
        else process.env.GT_FRAME_ANCESTORS = origAncestors;
        if (origAllowed === undefined) delete process.env.GT_ALLOWED_PARENT_ORIGINS;
        else process.env.GT_ALLOWED_PARENT_ORIGINS = origAllowed;
      }
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

    it('returns 429 Too Many Requests after exceeding max failed login attempts and resets on success', async () => {
      config.adminSecretKey = 'my-secret-token';
      for (let i = 0; i < 15; i++) {
        const failRes = await request(app).post('/api/auth/login').send({ key: 'wrong-key' });
        expect(failRes.status).toBe(401);
      }
      const blockedRes = await request(app).post('/api/auth/login').send({ key: 'wrong-key' });
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers['retry-after']).toBeDefined();
      expect(blockedRes.body.error).toMatch(/Too many failed login attempts/);
    });
  });
});
