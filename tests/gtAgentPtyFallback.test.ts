// @ts-ignore
import { StreamSessionManager, hasSystemPython3, PosixPtyDriver, InteractivePipeDriver, NodePtyDriver, tryRequirePty, getDefaultShell } from '../scripts/gt.js';

describe('StreamSessionManager PTY Fallback & Interactive Execution', () => {
  jest.setTimeout(25000);
  it('detects and selects available pty drivers correctly', () => {
    const messages: any[] = [];
    const mgr = new StreamSessionManager((msg: any) => messages.push(msg));
    expect(typeof mgr.startStream).toBe('function');
    expect(typeof hasSystemPython3).toBe('function');
    expect(typeof hasSystemPython3()).toBe('boolean');
  });

  it('runs Layer 1 NodePtyDriver when available', (done) => {
    if (!tryRequirePty()) {
      return done();
    }
    const messages: any[] = [];
    const taskId = `test-node-pty-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        const fullOutput = messages
          .filter(m => m.type === 'cmd_stream_data' && m.taskId === taskId)
          .map(m => Buffer.from(m.data, 'base64').toString('utf-8'))
          .join('');

        expect(fullOutput).toContain('NODE_PTY_OK');
        expect(msg.exitCode).toBe(0);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'echo NODE_PTY_OK',
      tty: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(session?.driverType).toBe('node-pty');
  });

  it('runs Layer 2 PosixPtyDriver with fallback and handles raw CR input', (done) => {
    const messages: any[] = [];
    const taskId = `test-posix-pty-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        const fullOutput = messages
          .filter(m => m.type === 'cmd_stream_data' && m.taskId === taskId)
          .map(m => Buffer.from(m.data, 'base64').toString('utf-8'))
          .join('');

        expect(fullOutput).toContain('POSIX_PTY_WORKS');
        expect(msg.exitCode).toBe(0);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'bash',
      tty: true,
      interactive: true,
      cols: 80,
      rows: 24,
      timeoutMs: 10000,
      _forceFallback: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(['posix-pty', 'pipe-fallback']).toContain(session?.driverType);

    // Test resize
    mgr.resize(taskId, 100, 30);

    setTimeout(() => {
      mgr.writeInput(taskId, Buffer.from('echo POSIX_PTY_WORKS\r').toString('base64'));
      setTimeout(() => {
        mgr.writeInput(taskId, Buffer.from('exit\r').toString('base64'));
      }, 500);
    }, 300);
  });

  it('dynamically resizes PosixPtyDriver terminal window size via ioctl and SIGWINCH', (done) => {
    if (!hasSystemPython3()) {
      done();
      return;
    }
    const messages: any[] = [];
    const taskId = `test-posix-pty-resize-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        const fullOutput = messages
          .filter(m => m.type === 'cmd_stream_data' && m.taskId === taskId)
          .map(m => Buffer.from(m.data, 'base64').toString('utf-8'))
          .join('');

        expect(msg.exitCode).toBe(0);
        // Expect stty size to reflect new dimensions (rows cols => 18 45)
        expect(fullOutput).toMatch(/18\s+45/);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'bash',
      tty: true,
      interactive: true,
      cols: 80,
      rows: 24,
      timeoutMs: 10000,
      _forceFallback: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(session?.driverType).toBe('posix-pty');

    // Wait a brief moment for bash to spawn, then trigger resize to mobile-like dimensions (45 cols, 18 rows)
    setTimeout(() => {
      mgr.resize(taskId, 45, 18);
      setTimeout(() => {
        mgr.writeInput(taskId, Buffer.from('stty size\r').toString('base64'));
        setTimeout(() => {
          mgr.writeInput(taskId, Buffer.from('exit\r').toString('base64'));
        }, 500);
      }, 300);
    }, 200);
  }, 10000);

  it('runs Layer 3 InteractivePipeDriver with CR-to-LF translation and warning notice', (done) => {
    const messages: any[] = [];
    const taskId = `test-pipe-fallback-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        const fullOutput = messages
          .filter(m => m.type === 'cmd_stream_data' && m.taskId === taskId)
          .map(m => Buffer.from(m.data, 'base64').toString('utf-8'))
          .join('');

        expect(fullOutput).toContain('[Warning] node-pty not available on agent; running in interactive pipe mode.');
        expect(fullOutput).toContain('PIPE_WORKS');
        expect(msg.exitCode).toBe(0);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'bash',
      tty: true,
      interactive: true,
      cols: 80,
      rows: 24,
      timeoutMs: 10000,
      _forcePipeFallback: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(session?.driverType).toBe('pipe-fallback');

    setTimeout(() => {
      mgr.writeInput(taskId, Buffer.from('echo PIPE_WORKS\r').toString('base64'));
      setTimeout(() => {
        mgr.writeInput(taskId, Buffer.from('exit\r').toString('base64'));
      }, 500);
    }, 300);
  });

  it('handles Ctrl+C (0x03) in InteractivePipeDriver by sending SIGINT', (done) => {
    const messages: any[] = [];
    const taskId = `test-pipe-sigint-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        // Exit triggered by SIGINT or killed
        expect(mgr.sessions.has(taskId)).toBe(false);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'sleep 30',
      tty: true,
      _forcePipeFallback: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(session?.driverType).toBe('pipe-fallback');

    setTimeout(() => {
      // Send Ctrl+C
      mgr.writeInput(taskId, Buffer.from([0x03]).toString('base64'));
    }, 200);
  });

  it('handles Ctrl+D (0x04) in InteractivePipeDriver by closing stdin', (done) => {
    const messages: any[] = [];
    const taskId = `test-pipe-eof-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        expect(mgr.sessions.has(taskId)).toBe(false);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'bash',
      tty: true,
      _forcePipeFallback: true,
    });

    const session = mgr.sessions.get(taskId);
    expect(session?.driverType).toBe('pipe-fallback');

    setTimeout(() => {
      // Send Ctrl+D (EOF)
      mgr.writeInput(taskId, Buffer.from([0x04]).toString('base64'));
    }, 300);
  });

  it('cleans up session and processes on timeout', (done) => {
    const messages: any[] = [];
    const taskId = `test-timeout-${Date.now()}`;
    const mgr = new StreamSessionManager((msg: any) => {
      messages.push(msg);
      if (msg.taskId === taskId && msg.type === 'cmd_stream_exit') {
        expect(mgr.sessions.has(taskId)).toBe(false);
        done();
      }
    });

    mgr.startStream({
      taskId,
      command: 'sleep 10',
      tty: true,
      timeoutMs: 400,
      _forcePipeFallback: true,
    });

    expect(mgr.sessions.has(taskId)).toBe(true);
  });

  it('kills all running sessions with killAll', () => {
    const messages: any[] = [];
    const mgr = new StreamSessionManager((msg: any) => messages.push(msg));
    const taskId1 = `test-kill-1-${Date.now()}`;
    const taskId2 = `test-kill-2-${Date.now()}`;

    mgr.startStream({ taskId: taskId1, command: 'sleep 10', tty: true, _forcePipeFallback: true });
    mgr.startStream({ taskId: taskId2, command: 'sleep 10', tty: true, _forcePipeFallback: true });

    expect(mgr.sessions.size).toBe(2);
    mgr.killAll();
    expect(mgr.sessions.size).toBe(0);
  });

  it('tryRequirePty resolves node-pty with local fallback or respects GT_DISABLE_NODE_PTY', () => {
    const originalEnv = process.env.GT_DISABLE_NODE_PTY;
    try {
      delete process.env.GT_DISABLE_NODE_PTY;
      const loaded = tryRequirePty();
      expect(loaded).toBeDefined();

      process.env.GT_DISABLE_NODE_PTY = '1';
      expect(tryRequirePty()).toBeNull();
    } finally {
      if (originalEnv !== undefined) {
        process.env.GT_DISABLE_NODE_PTY = originalEnv;
      } else {
        delete process.env.GT_DISABLE_NODE_PTY;
      }
    }
  });

  it('getDefaultShell resolves existing system shell safely', () => {
    const shell = getDefaultShell();
    expect(typeof shell).toBe('string');
    expect(shell.length).toBeGreaterThan(0);
    // Custom option override
    expect(getDefaultShell({ shell: '/bin/customsh' })).toBe('/bin/customsh');
  });
});
