import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import pkg from '../package.json';

describe('Hub Server Version Endpoints', () => {
  it('GET /health returns status ok with version', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version.startsWith(pkg.version)).toBe(true);
  });

  it('GET /api/terminal/version rejects unauthorized requests when key is set', async () => {
    const origKey = config.adminSecretKey;
    config.adminSecretKey = 'test-secret-key';
    try {
      const res = await request(app).get('/api/terminal/version');
      expect(res.status).toBe(401);
    } finally {
      config.adminSecretKey = origKey;
    }
  });

  it('GET /api/terminal/version returns VersionInfo with valid key', async () => {
    const origKey = config.adminSecretKey;
    config.adminSecretKey = 'test-secret-key';
    try {
      const res = await request(app)
        .get('/api/terminal/version')
        .set('x-admin-key', 'test-secret-key');
      expect(res.status).toBe(200);
      expect(res.body.version.startsWith(pkg.version)).toBe(true);
      expect(res.body.gitCommit).toBeDefined();
      expect(res.body.buildTime).toBeDefined();
      expect(res.body.platform).toBeDefined();
    } finally {
      config.adminSecretKey = origKey;
    }
  });
});
