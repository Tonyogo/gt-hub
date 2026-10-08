import request from 'supertest';
import app from '../src/app';
import config from '../config/default';
import { terminalFileService } from '../src/terminal/services/terminalFileService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('Terminal File Manager Pure RPC Integration Tests', () => {
  const secretKey = config.adminSecretKey || 'test-admin-key';
  const testHostId = 'agent-file-test-node';

  let mockAgentWs: any;

  beforeAll(() => {
    config.adminSecretKey = secretKey;
    mockAgentWs = {
      readyState: 1,
      send: jest.fn((msg: string) => {
        if (msg.startsWith('JSON:')) {
          const parsed = JSON.parse(msg.slice(5));
          if (parsed.type === 'file_rpc') {
            const { reqId, action, path: targetPath, params } = parsed;
            if (action === 'list') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
                data: {
                  currentPath: targetPath || '/home/user',
                  parentPath: '/home',
                  separator: '/',
                  files: [
                    {
                      name: 'file1.txt',
                      path: `${targetPath || '/home/user'}/file1.txt`,
                      isDirectory: false,
                      size: 100,
                      updatedAt: Date.now(),
                      extension: 'txt',
                    },
                    {
                      name: 'folderA',
                      path: `${targetPath || '/home/user'}/folderA`,
                      isDirectory: true,
                      size: 0,
                      updatedAt: Date.now(),
                      extension: '',
                    },
                  ],
                },
              });
            } else if (action === 'read') {
              if (targetPath.includes('notfound')) {
                terminalHostManager.handleAgentRpcResponse({
                  reqId,
                  success: false,
                  error: 'File not found',
                });
              } else {
                terminalHostManager.handleAgentRpcResponse({
                  reqId,
                  success: true,
                  data: {
                    path: targetPath,
                    size: 24,
                    isBinary: false,
                    content: 'mock remote file content',
                  },
                });
              }
            } else if (action === 'write') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
              });
            } else if (action === 'mkdir') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
              });
            } else if (action === 'rename') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
              });
            } else if (action === 'delete') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
              });
            } else if (action === 'stat') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
                data: {
                  size: 21,
                  mtime: Date.now(),
                  isDirectory: false,
                },
              });
            } else if (action === 'download_chunk') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
                data: Buffer.from('mock download content').toString('base64'),
              });
            } else if (action === 'upload_chunk') {
              terminalHostManager.handleAgentRpcResponse({
                reqId,
                success: true,
              });
            }
          }
        }
      }),
    };

    terminalHostManager.registerAgent({
      hostId: testHostId,
      name: 'File-Test-Agent',
      agentWs: mockAgentWs,
    });
  });

  afterAll(() => {
    terminalHostManager.unregisterAgent(testHostId);
  });

  test('returns error when hostId is not connected in service', async () => {
    const res = await terminalFileService.listFiles('offline-host', '/tmp');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/offline|not found|unavailable/i);
  });

  test('routes listFiles via RPC when agent is connected', async () => {
    const res = await terminalFileService.listFiles(testHostId, '/var/log');
    expect(res.success).toBe(true);
    expect(res.files.length).toBe(2);
    expect(res.files[0].name).toBe('file1.txt');
  });

  test('rejects request without admin key', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/list')
      .query({ hostId: testHostId, path: '/var/log' });
    expect(res.status).toBe(401);
  });

  test('rejects request without hostId with 400 Bad Request', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/list')
      .set('x-admin-key', secretKey)
      .query({ path: '/var/log' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/hostId is required/i);
  });

  test('lists files via API endpoint', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/list')
      .set('x-admin-key', secretKey)
      .query({ hostId: testHostId, path: '/var/log' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.files).toHaveLength(2);
  });

  test('reads file content via API endpoint', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/content')
      .set('x-admin-key', secretKey)
      .query({ hostId: testHostId, path: '/var/log/app.log' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.content).toBe('mock remote file content');
  });

  test('returns 404 when file is not found', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/content')
      .set('x-admin-key', secretKey)
      .query({ hostId: testHostId, path: '/var/log/notfound.log' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('saves file content via API endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/terminal/files/save')
      .set('x-admin-key', secretKey)
      .send({ hostId: testHostId, path: '/var/log/app.log', content: 'new content' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('creates directory via API endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/terminal/files/mkdir')
      .set('x-admin-key', secretKey)
      .send({ hostId: testHostId, path: '/var/log', dirName: 'test-dir' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('renames file via API endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/terminal/files/rename')
      .set('x-admin-key', secretKey)
      .send({ hostId: testHostId, oldPath: '/var/log/old.log', newPath: '/var/log/new.log' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('downloads file via API endpoint', async () => {
    const res = await request(app)
      .get('/api/admin/terminal/files/download')
      .set('x-admin-key', secretKey)
      .query({ hostId: testHostId, path: '/var/log/download.txt' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('mock download content');
  });

  test('uploads file via API endpoint', async () => {
    const res = await request(app)
      .post('/api/admin/terminal/files/upload')
      .set('x-admin-key', secretKey)
      .set('x-filename', 'test-upload.txt')
      .query({ hostId: testHostId, path: '/var/log' })
      .send(Buffer.from('binary-data'));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('deletes file via API endpoint', async () => {
    const res = await request(app)
      .delete('/api/admin/terminal/files/delete')
      .set('x-admin-key', secretKey)
      .query({ hostId: testHostId, path: '/var/log/delete.txt' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
