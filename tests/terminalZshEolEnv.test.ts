import * as pty from 'node-pty';
import { NodePtyDriver } from '../src/agent/pty/drivers';
import { StreamSessionManager } from '../src/agent/pty/sessionManager';

describe('Terminal Service Environment Options', () => {
  it('includes PROMPT_EOL_MARK empty string in default terminal env for PTY driver', () => {
    const spawnSpy = jest.spyOn(pty, 'spawn');
    let driver: any;
    try {
      driver = new NodePtyDriver({
        command: 'echo test',
        shell: '/bin/sh',
        cwd: process.cwd(),
        env: {
          PROMPT_EOL_MARK: '',
        },
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      });
      expect(spawnSpy).toHaveBeenCalled();
      const lastCall = spawnSpy.mock.calls[spawnSpy.mock.calls.length - 1];
      const spawnOptions = lastCall[2] as any;
      expect(spawnOptions.env).toBeDefined();
      expect(spawnOptions.env.PROMPT_EOL_MARK).toBe('');
    } finally {
      if (driver) driver.kill();
      spawnSpy.mockRestore();
    }
  });

  it('includes PROMPT_EOL_MARK in StreamSessionManager default taskEnv', () => {
    let capturedOptions: any = null;
    const spawnSpy = jest.spyOn(pty, 'spawn').mockImplementation((...args: any[]) => {
      capturedOptions = args[2];
      return {
        onData: jest.fn(),
        onExit: jest.fn(),
        kill: jest.fn(),
        resize: jest.fn(),
        write: jest.fn(),
      } as any;
    });

    try {
      const mgr = new StreamSessionManager(() => {});
      mgr.startStream({
        taskId: 'test-prompt-eol',
        command: 'echo test',
        tty: true,
      });
      expect(spawnSpy).toHaveBeenCalled();
      expect(capturedOptions?.env?.PROMPT_EOL_MARK).toBe('');
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('strips multiplexer env vars (TMUX, STY, etc.) from StreamSessionManager taskEnv by default', () => {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalSty = process.env.STY;
    const originalWindow = process.env.WINDOW;
    const originalTermSessionId = process.env.TERM_SESSION_ID;

    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    process.env.TMUX_PANE = '%1';
    process.env.STY = 'screen-session';
    process.env.WINDOW = '0';
    process.env.TERM_SESSION_ID = 'session-123';

    let capturedOptions: any = null;
    const spawnSpy = jest.spyOn(pty, 'spawn').mockImplementation((...args: any[]) => {
      capturedOptions = args[2];
      return {
        onData: jest.fn(),
        onExit: jest.fn(),
        kill: jest.fn(),
        resize: jest.fn(),
        write: jest.fn(),
      } as any;
    });

    try {
      const mgr = new StreamSessionManager(() => {});
      mgr.startStream({
        taskId: 'test-tmux-strip',
        command: 'echo test',
        tty: true,
      });
      expect(spawnSpy).toHaveBeenCalled();
      expect(capturedOptions?.env?.TMUX).toBeUndefined();
      expect(capturedOptions?.env?.TMUX_PANE).toBeUndefined();
      expect(capturedOptions?.env?.STY).toBeUndefined();
      expect(capturedOptions?.env?.WINDOW).toBeUndefined();
      expect(capturedOptions?.env?.TERM_SESSION_ID).toBeUndefined();
    } finally {
      spawnSpy.mockRestore();
      if (originalTmux !== undefined) process.env.TMUX = originalTmux;
      else delete process.env.TMUX;
      if (originalTmuxPane !== undefined) process.env.TMUX_PANE = originalTmuxPane;
      else delete process.env.TMUX_PANE;
      if (originalSty !== undefined) process.env.STY = originalSty;
      else delete process.env.STY;
      if (originalWindow !== undefined) process.env.WINDOW = originalWindow;
      else delete process.env.WINDOW;
      if (originalTermSessionId !== undefined) process.env.TERM_SESSION_ID = originalTermSessionId;
      else delete process.env.TERM_SESSION_ID;
    }
  });

  it('removes empty multiplexer env vars but preserves explicit non-empty ones', () => {
    let capturedOptions: any = null;
    const spawnSpy = jest.spyOn(pty, 'spawn').mockImplementation((...args: any[]) => {
      capturedOptions = args[2];
      return {
        onData: jest.fn(),
        onExit: jest.fn(),
        kill: jest.fn(),
        resize: jest.fn(),
        write: jest.fn(),
      } as any;
    });

    try {
      const mgr = new StreamSessionManager(() => {});
      mgr.startStream({
        taskId: 'test-tmux-explicit',
        command: 'echo test',
        env: {
          TMUX: '',
          STY: 'explicit-sty',
        },
        tty: true,
      });
      expect(spawnSpy).toHaveBeenCalled();
      expect(capturedOptions?.env?.TMUX).toBeUndefined();
      expect(capturedOptions?.env?.STY).toBe('explicit-sty');
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
