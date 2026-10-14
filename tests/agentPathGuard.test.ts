import os from 'os';
import path from 'path';
import fs from 'fs';
import { checkPathPermission, PermissionMode } from '../src/agent/security/pathGuard';

describe('Agent PathGuard', () => {
  const home = os.homedir();

  it('blocks SSH keys in default mode', () => {
    const sshPath = path.join(home, '.ssh', 'id_rsa');
    const res = checkPathPermission(sshPath, 'default');
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/sensitive/i);
  });

  it('blocks agent credentials in default mode', () => {
    const configPath = path.join(home, '.gt', 'agent.json');
    const res = checkPathPermission(configPath, 'default');
    expect(res.allowed).toBe(false);
  });

  it('blocks /etc/shadow on unix systems in default mode', () => {
    if (os.platform() !== 'win32') {
      const res = checkPathPermission('/etc/shadow', 'default');
      expect(res.allowed).toBe(false);
    }
  });

  it('allows access to regular user files in default mode without workspace', () => {
    const regularPath = path.join(home, 'documents', 'project', 'file.txt');
    const res = checkPathPermission(regularPath, 'default');
    expect(res.allowed).toBe(true);
  });

  it('enforces workspace boundary when workspace is specified', () => {
    const workspace = path.join(home, 'my-workspace');
    const inside = path.join(workspace, 'sub', 'file.txt');
    const outside = path.join(home, 'other-dir', 'file.txt');

    expect(checkPathPermission(inside, 'default', workspace).allowed).toBe(true);
    const outsideRes = checkPathPermission(outside, 'default', workspace);
    expect(outsideRes.allowed).toBe(false);
    expect(outsideRes.reason).toMatch(/outside workspace/i);
  });

  it('allows all paths in bypass mode', () => {
    const sshPath = path.join(home, '.ssh', 'id_rsa');
    const res = checkPathPermission(sshPath, 'bypass');
    expect(res.allowed).toBe(true);
  });

  it('detects symlink pointing to sensitive path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-symlink-test-'));
    const symlinkPath = path.join(tempDir, 'fake-key');
    const targetPath = path.join(home, '.ssh', 'authorized_keys');

    try {
      fs.symlinkSync(targetPath, symlinkPath);
      const res = checkPathPermission(symlinkPath, 'default');
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/sensitive/i);
    } catch (err: any) {
      if (err.code !== 'EPERM') throw err; // Windows non-admin symlink skip
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });
});
