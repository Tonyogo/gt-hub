import terminalLogService, { TerminalLogEntry } from '../src/terminal/services/terminalLogService';

describe('TerminalLogService', () => {
  beforeEach(() => {
    terminalLogService.clearHistory();
  });

  it('buffers log entries up to maximum capacity of 100', () => {
    for (let i = 0; i < 110; i++) {
      terminalLogService.addLog('info', `Log message ${i}`);
    }

    const history = terminalLogService.getHistory();
    expect(history.length).toBe(100);
    expect(history[0].message).toBe('Log message 10');
    expect(history[99].message).toBe('Log message 109');
  });

  it('dispatches event on new log entry', (done) => {
    terminalLogService.once('log', (entry: TerminalLogEntry) => {
      expect(entry.level).toBe('warn');
      expect(entry.message).toBe('Test warning');
      done();
    });

    terminalLogService.addLog('warn', 'Test warning');
  });
});
