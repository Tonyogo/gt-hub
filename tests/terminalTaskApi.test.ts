import request from 'supertest';
import express from 'express';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import config from '../config/default';

describe('Terminal Task & Timezone API', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/terminal', terminalRoutes);

  const key = config.adminSecretKey || 'test-key';
  const originalKey = config.adminSecretKey;

  beforeAll(() => {
    config.adminSecretKey = key;
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  test('GET /api/terminal/hosts includes configured server timezone', async () => {
    const res = await request(app)
      .get('/api/terminal/hosts')
      .set('x-admin-key', key);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hosts');
    expect(res.body).toHaveProperty('timezone', config.timeZone);
  });

  test('GET /api/terminal/version includes server timezone', async () => {
    const res = await request(app)
      .get('/api/terminal/version')
      .set('x-admin-key', key);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('timezone', config.timeZone);
  });
});
