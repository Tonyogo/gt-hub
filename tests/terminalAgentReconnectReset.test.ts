import { terminalHostManager, RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { isSyntheticTerminalReport } from '../frontend/src/utils/terminalFilter';

describe('Terminal Agent Reconnect and Replay Loop Prevention Tests', () => {
  const testHostId = 'agent-test-reconnect-node';

  afterEach(() => {
    terminalHostManager.unregisterAgent(testHostId);
  });

  test('registerAgent preserves historyBuffer on agent re-registration (soft reconnect)', () => {
    const mockAgentWs1 = { readyState: 1, send: jest.fn() };
    const mockClientWs = { readyState: 1, send: jest.fn() };

    terminalHostManager.registerAgent({
      hostId: testHostId,
      name: 'Test Node',
      agentWs: mockAgentWs1,
    });

    const session = terminalHostManager.getSession(testHostId) as RemoteAgentTerminalSession;
    session.attach(mockClientWs);
    session.handleData('PRESERVED_TERMINAL_OUTPUT\r\n');
    expect(session.getHistory()).toContain('PRESERVED_TERMINAL_OUTPUT');

    // Agent reconnects
    const mockAgentWs2 = { readyState: 1, send: jest.fn() };
    terminalHostManager.registerAgent({
      hostId: testHostId,
      name: 'Test Node',
      agentWs: mockAgentWs2,
    });

    // History must be preserved, not wiped!
    expect(session.getHistory()).toContain('PRESERVED_TERMINAL_OUTPUT');

    // Client must NOT receive reset or clear screen signals on soft reconnect
    const sentToClient = mockClientWs.send.mock.calls.map(call => call[0]);
    const hasResetSignal = sentToClient.some(msg =>
      (typeof msg === 'string' && msg.includes('JSON:{"type":"reset"}')) ||
      (typeof msg === 'string' && msg.includes('\x1b[2J\x1b[H'))
    );
    expect(hasResetSignal).toBe(false);

    // CRITICAL: Agent WebSocket must NOT receive a reset command on re-registration (must not kill agent pty)
    const sentToAgent2 = mockAgentWs2.send.mock.calls.map(call => call[0]);
    expect(sentToAgent2).not.toContain('JSON:{"type":"reset"}');
  });

  test('RemoteAgentTerminalSession.reset preserves agent PTY unless resetAgentPty is explicitly true', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const mockClientWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-host-pty', mockAgentWs);
    session.attach(mockClientWs);

    // Non-destructive reset (e.g. reconnect / buffer purge): resetAgentPty is false
    session.reset(true, false);
    expect(mockAgentWs.send).not.toHaveBeenCalledWith('JSON:{"type":"reset"}');
    expect(mockClientWs.send).toHaveBeenCalledWith('JSON:{"type":"reset"}');

    mockAgentWs.send.mockClear();
    mockClientWs.send.mockClear();

    // Explicit user reset (e.g. Web UI Reset Session button): resetAgentPty is true
    session.reset(true, true);
    expect(mockAgentWs.send).toHaveBeenCalledWith('JSON:{"type":"reset"}');
    expect(mockClientWs.send).toHaveBeenCalledWith('JSON:{"type":"reset"}');
  });

  test('isSyntheticTerminalReport catches various complex device reports', () => {
    // CPR (Cursor Position Report) variations
    expect(isSyntheticTerminalReport('\x1b[1;1R')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[45;120R')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[1;1;1R')).toBe(true);

    // Primary & Secondary Device Attributes
    expect(isSyntheticTerminalReport('\x1b[?1;2c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?62;1;2;4;6;7;8;9;15;18;21;22c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[>0;276;0c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[>1;10;0c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[=0c')).toBe(true);

    // Color queries (OSC 10 / 11)
    expect(isSyntheticTerminalReport('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]11;rgb:0000/0000/0000\x07')).toBe(true);

    // Mode reports (DECRPM)
    expect(isSyntheticTerminalReport('\x1b[?2004;1$y')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[12;2$y')).toBe(true);

    // User keystrokes must NEVER be filtered
    expect(isSyntheticTerminalReport('ls -la\r')).toBe(false);
    expect(isSyntheticTerminalReport('\x03')).toBe(false); // Ctrl+C
    expect(isSyntheticTerminalReport('\x1b[A')).toBe(false); // Up arrow
  });
});
