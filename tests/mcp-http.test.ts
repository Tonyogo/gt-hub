import request from 'supertest';
import app from '../src/server/app';
import config from '../src/server/config/default';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('HTTP MCP Endpoint (/api/terminal/mcp)', () => {
  const adminKey = config.adminSecretKey;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rejects unauthenticated requests with 401/403 and serves discovery metadata on GET', async () => {
    const unauth = await request(app).get('/api/terminal/mcp');
    expect([401, 403]).toContain(unauth.status);

    const res = await request(app)
      .get('/api/terminal/mcp')
      .set('x-admin-key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      name: 'gt-mcp',
      protocol: 'mcp-jsonrpc-2.0',
    });
  });

  test('handles initialize, notification (202), and tools/list with x-mcp-readonly header', async () => {
    const notifRes = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notifRes.status).toBe(202);

    const listRoRes = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .set('x-mcp-readonly', 'true')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listRoRes.status).toBe(200);
    expect(listRoRes.body.result.tools).toHaveLength(7);
  });

  test('executes gt_list_nodes with x-mcp-nodes allowlist header via DirectServiceAdapter', async () => {
    jest.spyOn(terminalHostManager, 'getHosts').mockReturnValue([
      {
        id: 'h-1',
        name: 'allowed-host',
        hostname: 'h1',
        ip: '10.0.0.1',
        platform: 'linux',
        status: 'online',
        lastSeen: Date.now(),
        type: 'agent',
      },
      {
        id: 'h-2',
        name: 'secret-host',
        hostname: 'h2',
        ip: '10.0.0.2',
        platform: 'linux',
        status: 'online',
        lastSeen: Date.now(),
        type: 'agent',
      },
    ]);

    const res = await request(app)
      .post('/api/terminal/mcp')
      .set('x-admin-key', adminKey)
      .set('x-mcp-nodes', 'allowed-host')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'gt_list_nodes', arguments: { all: true } },
      });

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].name).toBe('allowed-host');
  });
});
