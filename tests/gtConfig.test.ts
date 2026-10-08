import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');
const configDir = path.join(os.homedir(), '.gt');
const configFile = path.join(configDir, 'config.json');

function runGt(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [gtPath, ...args], {
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString()
      });
    });
  });
}

describe('gt ConfigStore and login/logout/config commands', () => {
  let server: http.Server;
  let serverUrl: string;
  let backupConfig: string | null = null;

  beforeAll((done) => {
    if (fs.existsSync(configFile)) {
      backupConfig = fs.readFileSync(configFile, 'utf-8');
    }

    server = http.createServer((req, res) => {
      if (req.url === '/api/terminal/hosts') {
        const key = req.headers['x-admin-key'];
        if (key === 'valid-secret') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hosts: [] }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, () => {
      const port = (server.address() as any).port;
      serverUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    if (backupConfig !== null) {
      fs.writeFileSync(configFile, backupConfig, 'utf-8');
    } else if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile);
    }
    server.close(done);
  });

  it('rejects login with invalid key (401)', async () => {
    const res = await runGt(['auth', 'login', serverUrl, 'wrong-key']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Authentication failed');
  });

  it('successfully logs in and creates ~/.gt/config.json with 0600 permissions', async () => {
    const res = await runGt(['auth', 'login', serverUrl, 'valid-secret']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Successfully verified and logged in');
    expect(fs.existsSync(configFile)).toBe(true);

    const stat = fs.statSync(configFile);
    if (os.platform() !== 'win32') {
      expect((stat.mode & 0o777)).toBe(0o600);
    }

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(config.server).toBe(serverUrl);
    expect(config.key).toBe('valid-secret');
  });

  it('runs config list and masks secret key', async () => {
    const res = await runGt(['config', 'list']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`server = "${serverUrl}"`);
    expect(res.stdout).toContain('key    = "val***"');
  });

  it('runs config set and get', async () => {
    const setRes = await runGt(['config', 'set', 'server', 'http://custom-server:3000']);
    expect(setRes.code).toBe(0);

    const getRes = await runGt(['config', 'get', 'server']);
    expect(getRes.code).toBe(0);
    expect(getRes.stdout.trim()).toBe('http://custom-server:3000');
  });

  it('runs logout and removes credentials from config.json', async () => {
    const res = await runGt(['auth', 'logout']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Successfully logged out');

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(config.key).toBeUndefined();
  });
});
