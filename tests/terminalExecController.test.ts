import request from 'supertest';
import express from 'express';
import adminRoutes from '../src/admin/routes/adminRoutes';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import { terminalExecService } from '../src/terminal/services/terminalExecService';
import config from '../config/default';

jest.mock('../src/terminal/services/terminalExecService');

describe('TerminalExecController API', () => {
  let app: express.Express;
  const adminKey = 'test-admin-key';
  let originalKey: string;

  beforeAll(() => {
    originalKey = config.adminSecretKey;
    config.adminSecretKey = adminKey;
    app = express();
    app.use(express.json());
    app.use('/api/terminal', terminalRoutes);
    app.use('/api/admin', adminRoutes);
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated request without admin key', async () => {
    const resNew = await request(app)
      .post('/api/terminal/exec/node-1')
      .send({ command: 'echo 1' });
    expect(resNew.status).toBe(401);

    const resLegacy = await request(app)
      .post('/api/admin/terminal/exec/node-1')
      .send({ command: 'echo 1' });
    expect(resLegacy.status).toBe(401);
  });

  it('starts command execution with 202 Accepted on both routes', async () => {
    (terminalExecService.startExecution as jest.Mock).mockResolvedValue({
      success: true,
      taskId: 'task-123',
      status: 'running',
      command: 'echo 1',
    });

    const resNew = await request(app)
      .post('/api/terminal/exec/node-1')
      .set('x-admin-key', adminKey)
      .send({ command: 'echo 1' });

    expect(resNew.status).toBe(202);
    expect(resNew.body.taskId).toBe('task-123');
    expect(resNew.body.status).toBe('running');

    const resLegacy = await request(app)
      .post('/api/admin/terminal/exec/node-1')
      .set('x-admin-key', adminKey)
      .send({ command: 'echo 1' });

    expect(resLegacy.status).toBe(202);
    expect(resLegacy.body.taskId).toBe('task-123');
  });

  it('returns 400 when command is missing', async () => {
    const res = await request(app)
      .post('/api/terminal/exec/node-1')
      .set('x-admin-key', adminKey)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('command');
  });

  it('returns 503 when target host is offline', async () => {
    (terminalExecService.startExecution as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Agent "node-1" is offline or unavailable',
    });

    const res = await request(app)
      .post('/api/terminal/exec/node-1')
      .set('x-admin-key', adminKey)
      .send({ command: 'echo 1' });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('offline');
  });

  it('polls task status with 200 OK on both routes', async () => {
    (terminalExecService.getExecutionStatus as jest.Mock).mockResolvedValue({
      success: true,
      taskId: 'task-123',
      status: 'completed',
      exitCode: 0,
      stdout: 'done\n',
    });

    const resNew = await request(app)
      .get('/api/terminal/exec/node-1/task-123?offset=0')
      .set('x-admin-key', adminKey);

    expect(resNew.status).toBe(200);
    expect(resNew.body.status).toBe('completed');
    expect(resNew.body.exitCode).toBe(0);

    const resLegacy = await request(app)
      .get('/api/admin/terminal/exec/node-1/task-123?offset=0')
      .set('x-admin-key', adminKey);

    expect(resLegacy.status).toBe(200);
    expect(resLegacy.body.status).toBe('completed');
  });

  it('returns 404 when polling non-existent task', async () => {
    (terminalExecService.getExecutionStatus as jest.Mock).mockResolvedValue({
      success: false,
      error: 'No such task: task-999',
    });

    const res = await request(app)
      .get('/api/terminal/exec/node-1/task-999')
      .set('x-admin-key', adminKey);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No such task');
  });

  it('kills task with 200 OK on both routes', async () => {
    (terminalExecService.killExecution as jest.Mock).mockResolvedValue({
      success: true,
      taskId: 'task-123',
      status: 'killed',
    });

    const resNew = await request(app)
      .post('/api/terminal/exec/node-1/task-123/kill')
      .set('x-admin-key', adminKey)
      .send({ signal: 'SIGKILL' });

    expect(resNew.status).toBe(200);
    expect(resNew.body.status).toBe('killed');

    const resLegacy = await request(app)
      .post('/api/admin/terminal/exec/node-1/task-123/kill')
      .set('x-admin-key', adminKey)
      .send({ signal: 'SIGKILL' });

    expect(resLegacy.status).toBe(200);
    expect(resLegacy.body.status).toBe('killed');
  });

  it('lists tasks with 200 OK on both routes', async () => {
    (terminalExecService.listExecutions as jest.Mock).mockResolvedValue({
      success: true,
      tasks: [{ taskId: 'task-123', command: 'ls', status: 'completed' }],
    });

    const resNew = await request(app)
      .get('/api/terminal/exec/node-1?limit=10')
      .set('x-admin-key', adminKey);

    expect(resNew.status).toBe(200);
    expect(resNew.body.tasks).toHaveLength(1);

    const resLegacy = await request(app)
      .get('/api/admin/terminal/exec/node-1?limit=10')
      .set('x-admin-key', adminKey);

    expect(resLegacy.status).toBe(200);
    expect(resLegacy.body.tasks).toHaveLength(1);
  });
});
