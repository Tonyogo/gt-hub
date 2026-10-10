import path from 'path';
import { spawnSync } from 'child_process';
import { parseExecArgs } from '../src/client/commands/exec';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt Commander CLI Structure', () => {
  it('exits with code 2 on unknown command', () => {
    const res = spawnSync('node', [gtPath, 'unknown-xyz'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  });

  it('outputs help menu containing nodes, agent, auth, and config command groups', () => {
    const res = spawnSync('node', [gtPath, '--help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nodes');
    expect(res.stdout).toContain('agent');
    expect(res.stdout).toContain('auth');
    expect(res.stdout).toContain('config');
    expect(res.stdout).toContain('exec');
    expect(res.stdout).toContain('cp');
    expect(res.stdout).toContain('task');
  });

  it('supports agent subcommands: start, stop, restart, status, logs, name', () => {
    const res = spawnSync('node', [gtPath, 'agent', '--help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('start');
    expect(res.stdout).toContain('stop');
    expect(res.stdout).toContain('restart');
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('name');
    expect(res.stdout).not.toMatch(/^\s*run\s/m);
    expect(res.stdout).not.toMatch(/^\s*prune\s/m);
  });

  it('supports gt agent name querying and setting', () => {
    const queryRes = spawnSync('node', [gtPath, 'agent', 'name'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(queryRes.status).toBe(0);
    expect(queryRes.stdout).toMatch(/\w+/);

    const setRes = spawnSync('node', [gtPath, 'agent', 'name', 'test-node-x'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(setRes.status).toBe(0);
    expect(setRes.stdout).toContain('Agent name set to "test-node-x"');
  });

  it('rejects removed agent subcommands with exit code 2', () => {
    const runRes = spawnSync('node', [gtPath, 'agent', 'run'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(runRes.status).toBe(2);

    const rmRes = spawnSync('node', [gtPath, 'agent', 'rm'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(rmRes.status).toBe(2);
  });

  it('rejects removed config get/set commands with exit code 2', () => {
    const getRes = spawnSync('node', [gtPath, 'config', 'get', 'server'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(getRes.status).toBe(2);
  });

  it('forwards -c flag in exec verbatim to remote command without Commander consuming it as --context', () => {
    const parsed = parseExecArgs(['-d', 'worker', 'bash', '-c', 'ls -la']);
    expect(parsed.host).toBe('worker');
    expect(parsed.fullCommand).toBe("bash -c 'ls -la'");
  });

  it('preserves gt ps as a remote node listing command', () => {
    const res = spawnSync('node', [gtPath, 'ps', '--help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('List connected hosts');
    expect(res.stdout).not.toContain('--local');
  });

  it('rejects removed top-level shortcut commands with exit code 2', () => {
    for (const cmd of ['host', 'hosts', 'kill', 'logs', 'prune']) {
      const res = spawnSync('node', [gtPath, cmd], {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('error: unknown command');
    }
  });
});
