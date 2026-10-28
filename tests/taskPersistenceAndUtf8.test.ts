import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  TaskManager,
  sliceBufferUtf8Safe,
  resolveUtf8Locale,
} from '../src/agent/tasks/taskManager';

describe('TaskManager Disk Persistence & UTF-8 Safe Slicing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `gt-task-persist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('sliceBufferUtf8Safe aligns mid-character byte offsets for Chinese and Emoji without U+FFFD', () => {
    const sample = '你好世界🚀测试日志';
    const buf = Buffer.from(sample, 'utf-8');

    for (let offset = 0; offset <= buf.length; offset++) {
      const sliced = sliceBufferUtf8Safe(buf, offset);
      expect(sliced).not.toContain('\uFFFD');
      expect(sample.endsWith(sliced)).toBe(true);
    }
  });

  test('resolveUtf8Locale preserves existing UTF-8 LANG or falls back to C.UTF-8 on Linux', () => {
    expect(resolveUtf8Locale({ LANG: 'zh_CN.UTF-8' })).toBe('zh_CN.UTF-8');
    const fallback = resolveUtf8Locale({ LANG: 'POSIX' });
    expect(fallback.toLowerCase()).toContain('utf-8');
  });

  test('persists task metadata and logs to disk and recovers them across TaskManager restart', async () => {
    const tm1 = new TaskManager({ storageDir: tempDir });
    const startRes = tm1.startTask({
      taskId: 'persist-task-1',
      command: 'echo "持久化日志第一行" && echo "第二行告警" >&2',
    });
    expect(startRes.success).toBe(true);

    // Wait for task completion
    let poll1: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 80));
      poll1 = tm1.getTask('persist-task-1', 0);
      if (poll1.status === 'completed' || poll1.status === 'failed') break;
    }
    expect(poll1.status).toBe('completed');
    expect(poll1.output).toContain('持久化日志第一行');
    expect(poll1.output).toContain('第二行告警');

    // Verify files exist on disk
    expect(fs.existsSync(path.join(tempDir, 'tasks.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'logs', 'persist-task-1.log'))).toBe(true);

    // Simulate Agent restart by creating a brand new TaskManager instance on the same storageDir
    const tm2 = new TaskManager({ storageDir: tempDir });
    const listRes = tm2.listTasks(10);
    expect(listRes.success).toBe(true);
    expect(listRes.tasks.length).toBe(1);
    expect(listRes.tasks[0].taskId).toBe('persist-task-1');
    expect(listRes.tasks[0].status).toBe('completed');

    // Poll full and partial offset from disk after restart
    const recoveredFull = tm2.getTask('persist-task-1', 0);
    expect(recoveredFull.success).toBe(true);
    expect(recoveredFull.output).toContain('持久化日志第一行');
    expect(recoveredFull.output).toContain('第二行告警');

    // Poll mid-character offset (byte 1 of a 3-byte Chinese character)
    const recoveredMid = tm2.getTask('persist-task-1', 1);
    expect(recoveredMid.output).not.toContain('\uFFFD');
    expect(recoveredMid.output).toContain('久化日志第一行');
  });

  test('reconciles stale running task to completed on restart when PID is no longer alive', () => {
    const logDir = path.join(tempDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'stale-running-1.log');
    fs.writeFileSync(logPath, 'partial output before agent restart\n', 'utf-8');

    const fakeTasksJson = [
      {
        taskId: 'stale-running-1',
        command: 'echo "done"',
        cwd: tempDir,
        status: 'running',
        exitCode: null,
        startTime: Date.now() - 5000,
        endTime: null,
        pid: 99999999, // non-existent PID
        totalBytes: Buffer.byteLength('partial output before agent restart\n'),
      },
    ];
    fs.writeFileSync(path.join(tempDir, 'tasks.json'), JSON.stringify(fakeTasksJson, null, 2), 'utf-8');

    const tm = new TaskManager({ storageDir: tempDir });
    const taskRes = tm.getTask('stale-running-1', 0);
    expect(taskRes.success).toBe(true);
    expect(taskRes.status).toBe('completed');
    expect(taskRes.output).toContain('partial output before agent restart');
  });
});
