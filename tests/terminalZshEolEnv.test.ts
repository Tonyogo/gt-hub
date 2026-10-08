import * as pty from 'node-pty';
import { spawnTerminalSession } from '../src/terminal/services/terminalService';

describe('Terminal Service Environment Options', () => {
  it('includes PROMPT_EOL_MARK empty string in default terminal env', () => {
    const spawnSpy = jest.spyOn(pty, 'spawn');
    const ptyProcess = spawnTerminalSession({ cols: 80, rows: 24 });
    try {
      expect(spawnSpy).toHaveBeenCalled();
      const lastCall = spawnSpy.mock.calls[spawnSpy.mock.calls.length - 1];
      const spawnOptions = lastCall[2] as any;
      expect(spawnOptions.env).toBeDefined();
      expect(spawnOptions.env.PROMPT_EOL_MARK).toBe('');
    } finally {
      ptyProcess.kill();
      spawnSpy.mockRestore();
    }
  });
});
