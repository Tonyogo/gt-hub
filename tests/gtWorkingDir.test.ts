import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
const { resolveWorkingDir, TaskManager } = require('../scripts/gt.js');

describe('resolveWorkingDir', () => {
  const home = os.homedir() || process.env.HOME || process.cwd();

  it('handles null, undefined, empty, and whitespace strings by returning defaultDir', () => {
    expect(resolveWorkingDir(undefined)).toBe(home);
    expect(resolveWorkingDir(null)).toBe(home);
    expect(resolveWorkingDir('')).toBe(home);
    expect(resolveWorkingDir('   ')).toBe(home);
  });

  it('expands ~ to home directory', () => {
    expect(resolveWorkingDir('~')).toBe(home);
  });

  it('expands ~/path correctly', () => {
    expect(resolveWorkingDir('~/gemini-proxy')).toBe(path.resolve(path.join(home, 'gemini-proxy')));
    expect(resolveWorkingDir('~/foo/bar')).toBe(path.resolve(path.join(home, 'foo/bar')));
  });

  it('expands ~\\path (Windows style) correctly', () => {
    expect(resolveWorkingDir('~\\gemini-proxy')).toBe(path.resolve(path.join(home, 'gemini-proxy')));
  });

  it('strips surrounding single or double quotes and expands ~', () => {
    expect(resolveWorkingDir('"~/gemini-proxy"')).toBe(path.resolve(path.join(home, 'gemini-proxy')));
    expect(resolveWorkingDir("'~/gemini-proxy'")).toBe(path.resolve(path.join(home, 'gemini-proxy')));
    expect(resolveWorkingDir('"~"')).toBe(home);
    expect(resolveWorkingDir("'/tmp'")).toBe(path.resolve('/tmp'));
  });

  it('resolves relative paths relative to process.cwd()', () => {
    expect(resolveWorkingDir('scripts')).toBe(path.resolve(process.cwd(), 'scripts'));
    expect(resolveWorkingDir('./scripts')).toBe(path.resolve(process.cwd(), './scripts'));
  });

  it('preserves absolute paths', () => {
    expect(resolveWorkingDir('/tmp')).toBe(path.resolve('/tmp'));
  });
});

describe('TaskManager working directory and error handling', () => {
  let taskManager: any;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  it('returns clean error when working directory does not exist', () => {
    const res = taskManager.startTask({
      taskId: 'test-nonexistent-dir-' + Date.now(),
      command: 'echo 1',
      cwd: '/nonexistent/path/that/cannot/exist/anywhere',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/working directory does not exist/i);
  });

  it('returns clean error when working directory is a regular file', () => {
    const res = taskManager.startTask({
      taskId: 'test-file-as-dir-' + Date.now(),
      command: 'echo 1',
      cwd: path.resolve(__filename),
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/working directory is not a directory/i);
  });

  it('successfully starts task when cwd uses tilde pointing to existing directory', async () => {
    const res = taskManager.startTask({
      taskId: 'test-tilde-dir-' + Date.now(),
      command: 'pwd',
      cwd: '~',
    });
    expect(res.success).toBe(true);

    // Poll until task finishes or max 3 seconds
    let finished = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const task = taskManager.getTask(res.taskId);
      if (task.success && (task.status === 'completed' || task.status === 'failed')) {
        expect(task.status).toBe('completed');
        expect(task.output.trim()).toBe(os.homedir() || process.env.HOME);
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);
  });

  it('falls back to valid system shell when invalid SHELL is given in env', async () => {
    const res = taskManager.startTask({
      taskId: 'test-bad-shell-' + Date.now(),
      command: 'echo shell-ok',
      cwd: process.cwd(),
      env: { SHELL: '/usr/bin/nonexistent_zsh_custom' },
    });
    expect(res.success).toBe(true);

    let finished = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const task = taskManager.getTask(res.taskId);
      if (task.success && (task.status === 'completed' || task.status === 'failed')) {
        expect(task.status).toBe('completed');
        expect(task.output).toMatch(/shell-ok/);
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);
  });
});
