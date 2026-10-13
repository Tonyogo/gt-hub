import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createScriptRouter } from '../src/server/modules/scripts/scriptRoutes';
import { ScriptService } from '../src/server/modules/scripts/scriptService';
import config from '../config/default';

describe('Script Routes (/api/admin/scripts)', () => {
  let tempDir: string;
  let service: ScriptService;
  let app: express.Express;
  const originalKey = config.adminSecretKey;

  beforeEach(() => {
    config.adminSecretKey = 'test-secret-key';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-routes-test-'));
    service = new ScriptService(tempDir);
    app = express();
    app.use(express.json());
    app.use('/api/admin/scripts', createScriptRouter(service));
  });

  afterEach(() => {
    config.adminSecretKey = originalKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unauthorized requests when adminSecretKey is set', async () => {
    const res = await request(app).get('/api/admin/scripts');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/scripts returns script list when authorized', async () => {
    await service.saveScript('test.sh', '# @title: Test\necho 1');
    const res = await request(app)
      .get('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('test.sh');
  });

  it('POST /api/admin/scripts creates a new script', async () => {
    const res = await request(app)
      .post('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key')
      .send({
        name: 'hello.sh',
        content: '#!/usr/bin/env bash\necho "hello"',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('hello.sh');
  });

  it('GET /api/admin/scripts/:name returns script detail and content', async () => {
    await service.saveScript('run.sh', 'echo "run"');
    const res = await request(app)
      .get('/api/admin/scripts/run.sh')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.content).toBe('echo "run"');
  });

  it('PUT /api/admin/scripts/:name updates existing script', async () => {
    await service.saveScript('update.sh', 'echo "old"');
    const res = await request(app)
      .put('/api/admin/scripts/update.sh')
      .set('x-admin-key', 'test-secret-key')
      .send({ content: 'echo "new"' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const detail = await service.getScript('update.sh');
    expect(detail.content).toBe('echo "new"');
  });

  it('DELETE /api/admin/scripts/:name removes script', async () => {
    await service.saveScript('del.sh', 'echo "del"');
    const res = await request(app)
      .delete('/api/admin/scripts/del.sh')
      .set('x-admin-key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await service.listScripts()).toHaveLength(0);
  });

  it('returns 400 when invalid name or path traversal attempted', async () => {
    const res = await request(app)
      .post('/api/admin/scripts')
      .set('x-admin-key', 'test-secret-key')
      .send({ name: '../bad.sh', content: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
