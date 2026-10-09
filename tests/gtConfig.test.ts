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

  it('rejects removed config set and get commands with exit code 2', async () => {
    const setRes = await runGt(['config', 'set', 'server', 'http://custom-server:3000']);
    expect(setRes.code).toBe(2);

    const getRes = await runGt(['config', 'get', 'server']);
    expect(getRes.code).toBe(2);
  });

  it('runs logout and removes credentials from config.json', async () => {
    const res = await runGt(['auth', 'logout']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Successfully logged out');

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(config.key).toBeUndefined();
  });

  it('displays default server port 8000 in help menu', async () => {
    const res = await runGt(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('http://localhost:8000');
    expect(res.stdout).not.toContain('http://localhost:3000');

    const resH = await runGt(['-h']);
    expect(resH.code).toBe(0);
    expect(resH.stdout).toContain('http://localhost:8000');
    expect(resH.stdout).not.toContain('http://localhost:3000');
  });

  it('defaults effective server to port 8000 when unconfigured', async () => {
    // In an isolated execution without stored server or env var
    const checkScript = `
      const gt = require('${gtPath.replace(/\\/g, '/')}');
      const { server } = gt.ConfigStore.getEffectiveConfig();
      console.log('EFFECTIVE_SERVER=' + server);
    `;
    const res = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile('node', ['-e', checkScript], {
        env: {
          ...process.env,
          GT_SERVER: '',
          GT_CONFIG_DIR: path.join(os.tmpdir(), 'empty-gt-config-' + Date.now()),
        },
      }, (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
        });
      });
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('EFFECTIVE_SERVER=http://localhost:8000');
  });

  it('respects CLI option and environment variable precedence over default port 8000', async () => {
    const checkScript = `
      const gt = require('${gtPath.replace(/\\/g, '/')}');
      const fromCli = gt.ConfigStore.getEffectiveConfig({ server: 'http://cli-override:9000' });
      const fromEnv = gt.ConfigStore.getEffectiveConfig();
      console.log('CLI_SERVER=' + fromCli.server);
      console.log('ENV_SERVER=' + fromEnv.server);
    `;
    const res = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile('node', ['-e', checkScript], {
        env: {
          ...process.env,
          GT_SERVER: 'http://env-override:9001',
          GT_CONFIG_DIR: path.join(os.tmpdir(), 'empty-gt-config-' + Date.now()),
        },
      }, (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout.toString(),
        });
      });
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('CLI_SERVER=http://cli-override:9000');
    expect(res.stdout).toContain('ENV_SERVER=http://env-override:9001');
  });

  it('exitWithError formats messages and exits with provided exit code', async () => {
    const checkScript = `
      const gt = require('${gtPath.replace(/\\/g, '/')}');
      gt.exitWithError('custom error message', 42);
    `;
    const res = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', ['-e', checkScript], (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stderr: stderr.toString(),
        });
      });
    });
    expect(res.code).toBe(42);
    expect(res.stderr).toContain('Error: custom error message');
  });

  it('resolves server and key from GT_SERVER and GT_KEY environment variables', () => {
    const { ConfigStore } = require('../src/client/config/configStore');
    const result = ConfigStore.getEffectiveConfig({}, {
      GT_SERVER: 'http://custom-hub:9999',
      GT_KEY: 'test-gt-key',
    });
    expect(result.server).toBe('http://custom-hub:9999');
    expect(result.key).toBe('test-gt-key');
  });
});

