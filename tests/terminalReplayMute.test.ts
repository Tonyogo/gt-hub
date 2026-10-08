import { isSyntheticTerminalReport } from '../frontend/src/utils/terminalFilter';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('Terminal Reconnect Replay Mute', () => {
  it('should classify and filter all standard query response escape sequences', () => {
    // 1. Cursor Position Reports (CPR)
    expect(isSyntheticTerminalReport('\x1b[1;1R')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[24;80R')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[120;300R')).toBe(true);

    // 2. Device Attributes (DA / DA2)
    expect(isSyntheticTerminalReport('\x1b[>0;276;0c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?1;2c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[>1;10;0c')).toBe(true);

    // 3. OSC 10 & 11 Color Reports (terminated by ST \x1b\\ or BEL \x07)
    expect(isSyntheticTerminalReport('\x1b]10;rgb:f1f1/f5f5/f9f9\x1b\\')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]11;rgb:0909/0a0a/0f0f\x1b\\')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]11;rgb:0000/0000/0000\x07')).toBe(true);

    // 4. DECRPM Mode Reports
    expect(isSyntheticTerminalReport('\x1b[12;2$y')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?2004;1$y')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?1049;1$y')).toBe(true);
  });

  it('should never filter valid user typing or editor sequences', () => {
    const userInputs = [
      'a', 'Z', '9', '$', ':', ' ', '\r', '\n', '\t', '\x1b',
      'ls -la\r',
      ':wq\r',
      ':q!\r',
      '\x1b[A', // Up arrow
      '\x1b[B', // Down arrow
      '\x1b[C', // Right arrow
      '\x1b[D', // Left arrow
      '\x03',   // Ctrl+C
      '\x04',   // Ctrl+D
      '\x0c',   // Ctrl+L
      '\x1b[1;5A', // Ctrl+Up
      '\x1b[1;5B', // Ctrl+Down
    ];

    for (const input of userInputs) {
      expect(isSyntheticTerminalReport(input)).toBe(false);
    }
  });

  it('should replay historical buffer cleanly in RemoteAgentTerminalSession', (done) => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('replay-test-agent', mockAgentWs);

    const mockSocket = {
      readyState: 1,
      received: [] as string[],
      send(data: string) {
        this.received.push(data);
      },
    };

    session.attach(mockSocket as any);

    // Send output through session
    session.handleData('HELLO_REPLAY_TEST');

    expect(mockSocket.received.length).toBeGreaterThan(0);
    const combined = mockSocket.received.join('');
    expect(combined).toContain('HELLO_REPLAY_TEST');

    session.detach(mockSocket as any);
    done();
  });
});
