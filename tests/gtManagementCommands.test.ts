import { execFile } from 'child_process';
import path from 'path';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

function runGt(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [gtPath, ...args], (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

describe('gt management commands & legacy deprecation', () => {
  it('displays Docker-style commands in --help', async () => {
    const res = await runGt(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('gt ps [-a|--all]');
    expect(res.stdout).toContain('gt exec');
    expect(res.stdout).toContain('gt logs');
    expect(res.stdout).toContain('gt kill');
    expect(res.stdout).toContain('gt prune');
    expect(res.stdout).toContain('gt login');
    expect(res.stdout).toContain('gt logout');
    expect(res.stdout).toContain('gt agent run');
  });

  it('allows top-level agent commands and does not reject with 125', async () => {
    // Top-level commands should now be accepted and not throw 125 migration error
    const resRun = await runGt(['run', '--help']);
    expect(resRun.code).not.toBe(125);
    expect(resRun.stderr).not.toContain("has been moved to 'gt agent");

    const resStop = await runGt(['stop', 'non-existent-agent-123']);
    expect(resStop.code).not.toBe(125);
    expect(resStop.stderr).not.toContain("has been moved to 'gt agent");

    const resRm = await runGt(['rm', 'non-existent-agent-123']);
    expect(resRm.code).not.toBe(125);
    expect(resRm.stderr).not.toContain("has been moved to 'gt agent");
  });

  it('supports "nodes" and "hosts" as modern cluster commands', async () => {
    const resNodes = await runGt(['nodes', '--help']);
    expect(resNodes.code).toBe(0);
    expect(resNodes.stdout).toContain('nodes');

    const resHosts = await runGt(['hosts', '--help']);
    expect(resHosts.code).toBe(0);
    expect(resHosts.stdout).toContain('hosts');
  });
});
