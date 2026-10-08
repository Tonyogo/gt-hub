import http from 'http';
const { resolveTaskId, resolveHost } = require('../scripts/gt.js');

describe('gt resolveTaskId', () => {
  const sampleTasks = [
    { taskId: 'task-1726800-abc111' },
    { taskId: 'task-1726800-abc222' },
    { taskId: 'task-1726800-def333' },
  ];

  it('resolves exact taskId match', () => {
    const id = resolveTaskId(sampleTasks, 'task-1726800-abc111');
    expect(id).toBe('task-1726800-abc111');
  });

  it('resolves unique prefix match', () => {
    const id = resolveTaskId(sampleTasks, 'def');
    expect(id).toBe('task-1726800-def333');
  });

  it('throws descriptive error on ambiguous prefix match', () => {
    expect(() => resolveTaskId(sampleTasks, 'abc')).toThrow(/ambiguous task identifier 'abc'/i);
  });

  it('throws descriptive error when no task matches', () => {
    expect(() => resolveTaskId(sampleTasks, 'nonexistent')).toThrow(/no such task/i);
  });
});

describe('gt resolveHost', () => {
  let server: http.Server;
  let serverUrl: string;
  const mockHosts = [
    { id: 'node-abc-111', name: 'web-prod' },
    { id: 'node-abc-222', name: 'worker-staging' },
    { id: 'node-xyz-999', name: 'db-main' },
  ];

  beforeAll((done) => {
    server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url && req.url.startsWith('/api/terminal/hosts')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts: mockHosts }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('resolves exact host id', async () => {
    const host = await resolveHost(serverUrl, 'test-key', 'node-abc-111');
    expect(host.id).toBe('node-abc-111');
  });

  it('resolves exact host name', async () => {
    const host = await resolveHost(serverUrl, 'test-key', 'web-prod');
    expect(host.id).toBe('node-abc-111');
  });

  it('resolves prefix match', async () => {
    const host = await resolveHost(serverUrl, 'test-key', 'db');
    expect(host.id).toBe('node-xyz-999');
  });

  it('throws on ambiguous host prefix', async () => {
    await expect(resolveHost(serverUrl, 'test-key', 'node-abc')).rejects.toThrow(/ambiguous host identifier 'node-abc'/i);
  });

  it('throws on non-existent host', async () => {
    await expect(resolveHost(serverUrl, 'test-key', 'unknown-host')).rejects.toThrow(/no such host: 'unknown-host'/i);
  });
});
