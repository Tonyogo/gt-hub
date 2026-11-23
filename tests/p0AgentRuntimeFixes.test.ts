import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkPathPermission, resolveRealPath } from '../src/agent/security/pathGuard';
import { buildLocalFileRpcPayload } from '../src/agent/daemon';
import { tryRequirePty, hasSystemPython3, NodePtyDriver, PosixPtyDriver, InteractivePipeDriver } from '../src/agent/pty/drivers';
import { StreamSessionManager } from '../src/agent/pty/sessionManager';
import { TaskManager, isPidAlive } from '../src/agent/tasks/taskManager';

describe('Batch B: Task 5 - pathGuard and daemon fileRpc security', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-p0-test-'));
  });

  afterEach(() => {
    delete process.env.GT_CONFIG_DIR;
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('blocks symlink inside workspace that escapes workspace to outside file', () => {
    const workspace = path.join(tempBaseDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const outsideFile = path.join(tempBaseDir, 'outside.txt');
    fs.writeFileSync(outsideFile, 'secret outside data');

    const escapeLink = path.join(workspace, 'escape-link');
    fs.symlinkSync(outsideFile, escapeLink);

    const result = checkPathPermission(escapeLink, 'default', workspace);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside workspace/i);
  });

  it('Review Focus #2: allows legitimate file inside workspace even when workspace uses macOS symlinked paths', () => {
    const workspace = path.join(tempBaseDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const fileInside = path.join(workspace, 'legit.txt');
    fs.writeFileSync(fileInside, 'normal content');

    // Legit file inside workspace
    const result = checkPathPermission(fileInside, 'default', workspace);
    expect(result.allowed).toBe(true);

    // Cross-path checking with canonical realpath vs symlinked path
    const realWorkspace = resolveRealPath(workspace);
    const resultCross1 = checkPathPermission(fileInside, 'default', realWorkspace);
    expect(resultCross1.allowed).toBe(true);

    const fileViaReal = path.join(realWorkspace, 'legit.txt');
    const resultCross2 = checkPathPermission(fileViaReal, 'default', workspace);
    expect(resultCross2.allowed).toBe(true);

    // If on macOS and workspace starts with /var/, check /private/var/
    if (os.platform() === 'darwin' && workspace.startsWith('/var/')) {
      const privateWorkspace = '/private' + workspace;
      if (fs.existsSync(privateWorkspace)) {
        const resultCross = checkPathPermission(fileInside, 'default', privateWorkspace);
        expect(resultCross.allowed).toBe(true);
      }
    }
  });

  it('protects agent.json and config.json inside GT_CONFIG_DIR when set', () => {
    const customConfigDir = path.join(tempBaseDir, 'custom-gt-config');
    fs.mkdirSync(customConfigDir, { recursive: true });
    process.env.GT_CONFIG_DIR = customConfigDir;

    const agentJson = path.join(customConfigDir, 'agent.json');
    const configJson = path.join(customConfigDir, 'config.json');
    fs.writeFileSync(agentJson, '{}');
    fs.writeFileSync(configJson, '{}');

    const agentCheck = checkPathPermission(agentJson, 'default');
    expect(agentCheck.allowed).toBe(false);
    expect(agentCheck.reason).toMatch(/restricted/i);

    const configCheck = checkPathPermission(configJson, 'default');
    expect(configCheck.allowed).toBe(false);
    expect(configCheck.reason).toMatch(/restricted/i);
  });

  it('buildLocalFileRpcPayload enforces local permissionMode and workspace, ignoring remote bypass values', () => {
    const remoteControl = {
      action: 'read',
      path: '/etc/shadow',
      permissionMode: 'bypass',
      workspace: '/',
    };

    const payload = buildLocalFileRpcPayload(remoteControl, 'default', '/safe/ws');
    expect(payload.action).toBe('read');
    expect(payload.path).toBe('/etc/shadow');
    expect(payload.permissionMode).toBe('default');
    expect(payload.workspace).toBe('/safe/ws');
  });
});

describe('Batch B: Task 6 - Shell process/FD leaks, EPIPE, PTY reset races & injection', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-p0-t6-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('kills SIGTERM-ignoring shell via SIGHUP/SIGKILL escalation without leaking PID', async () => {
    const hasPty = tryRequirePty();
    const DriverClass = hasPty ? NodePtyDriver : (hasSystemPython3() ? PosixPtyDriver : InteractivePipeDriver);
    const driver = new DriverClass({
      command: 'trap "" TERM; sleep 30',
      shell: '/bin/sh',
      cwd: os.tmpdir(),
      env: process.env as Record<string, string>,
      onData: () => {},
      onExit: () => {},
    });
    const pid = driver.proc ? driver.proc.pid : null;
    expect(pid).toBeTruthy();
    expect(isPidAlive(pid)).toBe(true);

    driver.kill('SIGTERM');

    // Wait up to 2.5s for process to exit due to escalation
    const start = Date.now();
    while (Date.now() - start < 2500) {
      if (!isPidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(pid)).toBe(false);
  }, 10000);

  it('Review Focus #3: InteractivePipeDriver SIGINT does NOT escalate to SIGKILL', async () => {
    let ready = false;
    const driver = new InteractivePipeDriver({
      command: 'trap "" INT; echo ready; sleep 5',
      shell: '/bin/sh',
      cwd: os.tmpdir(),
      env: process.env as Record<string, string>,
      onData: (data) => {
        if (data.toString().includes('ready')) ready = true;
      },
      onExit: () => {},
    });
    const pid = driver.proc ? driver.proc.pid : null;
    expect(pid).toBeTruthy();

    const start = Date.now();
    while (!ready && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Send Ctrl+C (0x03) -> sends SIGINT
    driver.write(Buffer.from([0x03]));

    // Wait 1300ms - longer than 1000ms escalation timer
    await new Promise((r) => setTimeout(r, 1300));
    expect(isPidAlive(pid)).toBe(true);

    // Now call driver.kill('SIGTERM') -> should escalate to SIGKILL and terminate
    driver.kill('SIGTERM');
    const killStart = Date.now();
    while (Date.now() - killStart < 2500) {
      if (!isPidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(pid)).toBe(false);
  }, 10000);

  it('StreamSessionManager same-taskId reset cleanly replaces session without exit race', async () => {
    const sentMessages: any[] = [];
    const manager = new StreamSessionManager((msg) => sentMessages.push(msg));

    // Start first stream
    manager.startStream({
      taskId: 'pane-split',
      command: 'sleep 0.1',
    });
    const firstSession = (manager as any).sessions.get('pane-split');
    expect(firstSession).toBeTruthy();

    // Immediately reset / replace with second stream
    manager.startStream({
      taskId: 'pane-split',
      command: 'sleep 5',
    });
    const secondSession = (manager as any).sessions.get('pane-split');
    expect(secondSession).toBeTruthy();
    expect(secondSession).not.toBe(firstSession);

    // Wait 400ms for first sleep 0.1 process to exit
    await new Promise((r) => setTimeout(r, 400));

    // Second session must still be present in manager.sessions
    expect((manager as any).sessions.get('pane-split')).toBe(secondSession);

    // No cmd_stream_exit should have been sent for pane-split yet!
    const exitMsgs = sentMessages.filter((m) => m.type === 'cmd_stream_exit' && m.taskId === 'pane-split');
    expect(exitMsgs.length).toBe(0);

    // Clean up second session
    manager.kill('pane-split', 'SIGKILL');
  }, 10000);

  it('StreamSessionManager timeout emits cmd_stream_exit and clears sessions', async () => {
    const sentMessages: any[] = [];
    const manager = new StreamSessionManager((msg) => sentMessages.push(msg));
    const taskId = `timeout-test-${Date.now()}`;

    manager.startStream({
      taskId,
      command: 'sleep 10',
      timeoutMs: 150,
      _forcePipeFallback: true,
    });

    expect(manager.sessions.has(taskId)).toBe(true);

    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (sentMessages.some((m) => m.type === 'cmd_stream_exit' && m.taskId === taskId)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(manager.sessions.has(taskId)).toBe(false);
    const exitMsg = sentMessages.find((m) => m.type === 'cmd_stream_exit' && m.taskId === taskId);
    expect(exitMsg).toBeTruthy();
    expect(exitMsg.taskId).toBe(taskId);
  }, 10000);

  it('TaskManager handles fast-exit without uncaught EPIPE', async () => {
    const tm = new TaskManager({
      storageDir: path.join(tempBaseDir, 'tasks'),
    });

    let uncaughtErr: any = null;
    const onUncaught = (err: any) => { uncaughtErr = err; };
    process.on('uncaughtException', onUncaught);

    try {
      const largeStdin = 'x'.repeat(256 * 1024);
      const res = tm.startTask({
        taskId: 'epipe-test',
        command: 'exit 0',
        stdin: largeStdin,
      });
      expect(res.success).toBe(true);

      const start = Date.now();
      while (Date.now() - start < 3000) {
        const task = tm.getTask('epipe-test');
        if (task && task.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const task = tm.getTask('epipe-test');
      expect(task?.status).toBe('completed');
      expect(uncaughtErr).toBeNull();
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  }, 10000);

  it('daemon.ts guards main PTY onExit with ptySpawnGeneration and avoids PTY injection in catch block', () => {
    const daemonSrc = fs.readFileSync(path.resolve(__dirname, '../src/agent/daemon.ts'), 'utf-8');
    // Must have ptySpawnGeneration
    expect(daemonSrc).toMatch(/ptySpawnGeneration/);
    expect(daemonSrc).toMatch(/spawnId\s*!==\s*ptySpawnGeneration/);

    // Must NOT write data to ptyProcess in catch block
    const catchBlockRegex = /catch\s*\([^)]*\)\s*\{[^}]*ptyProcess\.write\s*\(\s*data\.toString\(\)\s*\)/s;
    expect(catchBlockRegex.test(daemonSrc)).toBe(false);
  });
});
