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
});
