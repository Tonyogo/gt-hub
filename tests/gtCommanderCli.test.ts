import path from 'path';
import { spawnSync } from 'child_process';
import { parseExecArgs } from '../src/client/commands/exec';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt Commander CLI Structure', () => {
  it('exits with code 2 on unknown command', () => {
    const res = spawnSync('node', [gtPath, 'unknown-xyz'], { encoding: 'utf-8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  });

  it('outputs help menu containing nodes, agent, auth, and config command groups', () => {
    const res = spawnSync('node', [gtPath, '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nodes');
    expect(res.stdout).toContain('agent');
    expect(res.stdout).toContain('auth');
    expect(res.stdout).toContain('config');
    expect(res.stdout).toContain('exec');
    expect(res.stdout).toContain('cp');
    expect(res.stdout).toContain('task');
  });

  it('supports agent subcommands: run, start, stop, restart, status, logs, prune', () => {
    const res = spawnSync('node', [gtPath, 'agent', '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('run');
    expect(res.stdout).toContain('start');
    expect(res.stdout).toContain('stop');
    expect(res.stdout).toContain('restart');
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('prune');
  });

  it('forwards -c flag in exec verbatim to remote command without Commander consuming it as --context', () => {
    const parsed = parseExecArgs(['-d', 'worker', 'bash', '-c', 'ls -la']);
    expect(parsed.host).toBe('worker');
    expect(parsed.fullCommand).toBe("bash -c 'ls -la'");
  });
});
