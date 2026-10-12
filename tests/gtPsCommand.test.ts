import { execFile } from 'child_process';
import path from 'path';
import http from 'http';
import { ConfigStore } from '../src/client/config/configStore';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt ps & gt prune remote node management', () => {
  let server: http.Server;
  let serverPort: number;
  let mockHosts: any[] = [
    { id: 'node-1', name: 'worker-online', status: 'online', platform: 'linux', ip: '10.0.0.1', lastSeen: Date.now() },
    { id: 'node-2', name: 'worker-offline', status: 'offline', platform: 'linux', ip: '10.0.0.2', lastSeen: Date.now() - 3600000 },
  ];

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/api/terminal/hosts') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          hosts: mockHosts,
        }));
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/terminal/hosts/offline') {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, prunedCount: 1 }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverPort = addr.port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile('node', [gtPath, ...args], {
        env: { ...process.env, GT_SERVER: `http://127.0.0.1:${serverPort}`, GT_KEY: 'test-key' }
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      });
    });
  }

  it('filters to online nodes by default in "gt ps"', async () => {
    const res = await run(['ps']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('worker-online');
    expect(res.stdout).not.toContain('worker-offline');
  });

  it('displays VERSION column in table header', async () => {
    const res = await run(['ps']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('VERSION');
  });

  it('shows all nodes including offline when passing -a or --all', async () => {
    const res = await run(['ps', '-a']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('worker-online');
    expect(res.stdout).toContain('worker-offline');

    const resAll = await run(['ps', '--all']);
    expect(resAll.stdout).toContain('worker-offline');
  });

  it('lists nodes with "gt nodes -a"', async () => {
    const res = await run(['nodes', '-a']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('worker-offline');
  });

  it('prunes offline nodes with "gt nodes prune"', async () => {
    const res = await run(['nodes', 'prune']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Pruned 1 offline host(s)');
  });

  it('does not display obsolete "gt ps -l" tip when hosts are empty', async () => {
    const orig = mockHosts;
    mockHosts = [];
    try {
      const res = await run(['ps']);
      expect(res.code).toBe(0);
      expect(res.stdout).not.toContain('gt ps -l');
      expect(res.stdout).not.toContain('local agent daemon');
    } finally {
      mockHosts = orig;
    }
  });

  it('handles long VERSION without squeezing PLATFORM and aligns columns', async () => {
    const longVersion = 'v1.2.3-alpha.999-nightly-build';
    const orig = mockHosts;
    mockHosts = [
      { id: 'node-long', name: 'worker-long', status: 'online', version: longVersion, platform: 'linux-arm64', ip: '10.0.0.5', lastSeen: Date.now() },
    ];
    try {
      const res = await run(['ps']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(longVersion);
      expect(res.stdout).toMatch(new RegExp(`${longVersion}\\s+linux-arm64`));
      expect(res.stdout).not.toContain('gt ps -l');
    } finally {
      mockHosts = orig;
    }
  });

  it('marks local machine agent with (local) in NAME column', async () => {
    const localMachineId = ConfigStore.getMachineId();
    const orig = mockHosts;
    mockHosts = [
      { id: 'node-local', name: 'worker-this-machine', status: 'online', machineId: localMachineId, version: '1.0.0', platform: 'linux', ip: '127.0.0.1', lastSeen: Date.now() },
    ];
    try {
      const res = await run(['ps']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('worker-this-machine (local)');
    } finally {
      mockHosts = orig;
    }
  });
});
