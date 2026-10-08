import { spawnTerminalSession } from '../src/terminal/services/terminalService';

describe('terminalService', () => {
  it('should spawn a terminal session and receive initial data or exit code', (done) => {
    const session = spawnTerminalSession({ cols: 80, rows: 24 });
    expect(session).toBeDefined();
    expect(typeof session.pid).toBe('number');

    session.onExit(() => {
      done();
    });

    const listener = session.onData((data: string) => {
      expect(typeof data).toBe('string');
      listener.dispose();
      session.kill();
    });

    session.write('echo "hello terminal"\r');
  }, 10000);
  it('falls back to existing shell when SHELL environment variable does not exist', () => {
    const { getDefaultShell } = require('../src/terminal/services/terminalService');
    const origShell = process.env.SHELL;
    try {
      process.env.SHELL = '/nonexistent/custom/shell';
      const shell = getDefaultShell();
      expect(shell).toMatch(/\/(bash|sh)$/);
    } finally {
      process.env.SHELL = origShell;
    }
  });

  it('handles invalid or tilde cwd gracefully without crashing', () => {
    const nonExistent = `/tmp/nonexistent-dir-${Date.now()}`;
    const session = spawnTerminalSession({ cols: 80, rows: 24, cwd: nonExistent });
    expect(session).toBeDefined();
    expect(typeof session.pid).toBe('number');
    session.kill();
  });
});
