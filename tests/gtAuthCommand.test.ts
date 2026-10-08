import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt login & logout commands', () => {
  let server: http.Server;
  let serverPort: number;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-auth-test-'));

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-admin-key'] === 'valid-secret') {
        res.statusCode = 200;
        res.end(JSON.stringify({ hosts: [] }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      done();
    });
  });

  function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile('node', [gtPath, ...args], {
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, TERMINAL_SERVER: '', ADMIN_SECRET_KEY: '' }
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      });
    });
  }

  it('successfully logs in with "gt login <server> <key>"', async () => {
    const res = await run(['login', `http://127.0.0.1:${serverPort}`, 'valid-secret']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Successfully verified and logged in');

    const configPath = path.join(tmpHome, '.gt', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.key).toBe('valid-secret');
  });

  it('fails with invalid credentials', async () => {
    const res = await run(['login', `http://127.0.0.1:${serverPort}`, 'wrong-secret']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Authentication failed');
  });

  it('logs out with "gt logout"', async () => {
    const res = await run(['logout']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Successfully logged out');

    const configPath = path.join(tmpHome, '.gt', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.key).toBeUndefined();
  });
});
