import { TerminalHostManager, RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { TerminalHistoryBuffer } from '../src/agent/pty/terminalHistoryBuffer';
import { BIN_MSG_TYPE, encodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';

describe('Terminal Agent History Sync & Hub Stateless Recovery Tests', () => {
  const hostId = 'agent-test-history-sync-node';

  test('Hub restart recovery: Agent syncs preserved history to new Hub and replays to browser client', () => {
    // 1. Simulate Agent running locally with its shell outputting data
    const agentBuffer = new TerminalHistoryBuffer(1024 * 1024);
    agentBuffer.push('Welcome to Ubuntu 22.04 LTS (GNU/Linux 5.15.0-x86_64)\r\n');
    agentBuffer.push('$ npm run dev\r\n');
    agentBuffer.push('[DevServer] App running on port 3000\r\n');
    expect(agentBuffer.getSize()).toBeGreaterThan(50);

    // 2. Hub restarts! (Simulate fresh TerminalHostManager instance with 0 state)
    const freshHubManager = new TerminalHostManager();
    expect(freshHubManager.getHosts().length).toBe(0);

    // 3. Agent reconnects to the new Hub
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    freshHubManager.registerAgent({
      hostId,
      name: 'Sync Node',
      agentWs: mockAgentWs,
    });

    const session = freshHubManager.getSession(hostId) as RemoteAgentTerminalSession;
    expect(session).toBeDefined();

    // 4. Agent sends binary HISTORY_SYNC packet to Hub
    const historyPacket = encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, hostId, agentBuffer.getBuffer());
    freshHubManager.handleAgentHistorySync(hostId, agentBuffer.getBuffer());

    // 5. Browser client attaches to the terminal session
    const mockClientWs = { readyState: 1, send: jest.fn() };
    session.attach(mockClientWs);

    // 6. Verify client received full history without any loss
    expect(mockClientWs.send).toHaveBeenCalled();
    const sentHistory = mockClientWs.send.mock.calls[0][0];
    expect(sentHistory).toContain('Welcome to Ubuntu 22.04 LTS');
    expect(sentHistory).toContain('$ npm run dev');
    expect(sentHistory).toContain('[DevServer] App running on port 3000');
  });

  test('Client attaches before history is synced: Hub triggers on-demand history_req to Agent', () => {
    const hubManager = new TerminalHostManager();
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    hubManager.registerAgent({
      hostId,
      name: 'Sync Node',
      agentWs: mockAgentWs,
    });

    const session = hubManager.getSession(hostId) as RemoteAgentTerminalSession;
    const mockClientWs = { readyState: 1, send: jest.fn() };

    // Browser client connects BEFORE any history is synced
    session.attach(mockClientWs);

    // Hub must have sent history_req to the Agent WebSocket
    expect(mockAgentWs.send).toHaveBeenCalledWith('JSON:{"type":"history_req"}');
    // Client should not have received empty data yet
    expect(mockClientWs.send).not.toHaveBeenCalled();

    // Now Agent responds with history_sync
    const testOutput = 'Preserved output from Agent local memory: $ uptime\r\n';
    session.handleHistorySync(testOutput);

    // Attached client must immediately receive the history replay!
    expect(mockClientWs.send).toHaveBeenCalledTimes(1);
    expect(mockClientWs.send).toHaveBeenCalledWith(expect.stringContaining('Preserved output from Agent local memory'));
  });

  test('Client does not receive duplicate history replays', () => {
    const hubManager = new TerminalHostManager();
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    hubManager.registerAgent({
      hostId,
      name: 'Sync Node',
      agentWs: mockAgentWs,
    });

    const session = hubManager.getSession(hostId) as RemoteAgentTerminalSession;
    session.handleHistorySync('Initial synced history\r\n');

    const mockClientWs = { readyState: 1, send: jest.fn() };
    session.attach(mockClientWs);
    expect(mockClientWs.send).toHaveBeenCalledTimes(1);

    // Agent sends a second history_sync later (e.g. from registered hook)
    session.handleHistorySync('Updated synced history\r\n');

    // The already-replayed client must NOT receive duplicate replay
    expect(mockClientWs.send).toHaveBeenCalledTimes(1);
  });

  test('Binary HISTORY_SYNC preserves UTF-8 multi-byte characters and ANSI sequences', () => {
    const hubManager = new TerminalHostManager();
    const session = new RemoteAgentTerminalSession(hostId);

    const unicodeWithAnsi = '\x1b[32m[系统初始化]\x1b[0m 欢迎使用 Gemini Terminal 🚀 中文字符测试\r\n';
    const binarySync = Buffer.from(unicodeWithAnsi, 'utf-8');

    session.handleHistorySync(binarySync);

    const mockClientWs = { readyState: 1, send: jest.fn() };
    session.attach(mockClientWs);

    expect(mockClientWs.send).toHaveBeenCalled();
    const sent = mockClientWs.send.mock.calls[0][0];
    expect(sent).toContain('系统初始化');
    expect(sent).toContain('欢迎使用 Gemini Terminal 🚀 中文字符测试');
  });

  test('Idle eviction followed by incremental TUI output still triggers history_req and restores alt-screen + mouse modes on reattach', () => {
    jest.useFakeTimers();
    try {
      const hubManager = new TerminalHostManager();
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      hubManager.registerAgent({
        hostId,
        name: 'Evict Sync Node',
        agentWs: mockAgentWs,
      });

      const session = hubManager.getSession(hostId) as RemoteAgentTerminalSession;
      const client1 = { readyState: 1, send: jest.fn() };
      session.attach(client1);

      // Claude enters alternate screen with SGR mouse tracking
      session.handleData('$ claude\r\n\x1b[?1049h\x1b[?1000h\x1b[?1006hClaude Code Ready\r\n');
      session.flush();
      mockAgentWs.send.mockClear();

      // User leaves terminal page -> triggers 10-min idle eviction
      session.detach(client1);
      jest.advanceTimersByTime(10 * 60 * 1000 + 100);
      expect(session.getHistory()).toBe('');

      // While user is away, background Claude emits spinner/status redraw WITHOUT 1049h/1000h/1006h
      session.handleData('\x1b[?2026h\x1b[10;1HThinking...\x1b[?2026l');
      expect(session.getHistory().length).toBeGreaterThan(0);

      // User re-enters terminal page
      const client2 = { readyState: 1, send: jest.fn() };
      session.attach(client2);

      // Hub MUST request authoritative history from Agent despite non-empty post-eviction fragment
      expect(mockAgentWs.send).toHaveBeenCalledWith('JSON:{"type":"history_req"}');
      // Hub MUST NOT prematurely mark poisoned fragment as complete replay to client2
      expect(client2.send).not.toHaveBeenCalled();

      // Agent replies with full preserved state (including 1049h + 1000h + 1006h)
      session.handleHistorySync('$ claude\r\n\x1b[?1049h\x1b[?1000h\x1b[?1006hClaude Code Ready\r\nThinking...');
      expect(client2.send).toHaveBeenCalledTimes(1);
      const replayed = client2.send.mock.calls[0][0];
      expect(replayed).toContain('\x1b[?1049h');
      expect(replayed).toContain('\x1b[?1000h');
      expect(replayed).toContain('\x1b[?1006h');
    } finally {
      jest.useRealTimers();
    }
  });

  test('Split pane idle eviction requests pane-scoped history_req and restores alt-screen state', () => {
    jest.useFakeTimers();
    try {
      const hubManager = new TerminalHostManager();
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      hubManager.registerAgent({
        hostId,
        name: 'Split Evict Node',
        agentWs: mockAgentWs,
      });

      const splitSession = hubManager.getSession(hostId, 'split') as RemoteAgentTerminalSession;
      const client1 = { readyState: 1, send: jest.fn() };
      splitSession.attach(client1);
      splitSession.resize(80, 24);
      hubManager.handleAgentPaneData(hostId, 'split', '\x1b[?1049h\x1b[?1000h\x1b[?1006hSplit Claude');
      splitSession.flush();
      mockAgentWs.send.mockClear();

      splitSession.detach(client1);
      jest.advanceTimersByTime(10 * 60 * 1000 + 100);
      hubManager.handleAgentPaneData(hostId, 'split', '\x1b[2KRedraw');

      const client2 = { readyState: 1, send: jest.fn() };
      splitSession.attach(client2);

      expect(mockAgentWs.send).toHaveBeenCalledWith('JSON:{"type":"history_req","paneId":"split"}');
      expect(client2.send).not.toHaveBeenCalled();

      hubManager.handleAgentPaneHistorySync(hostId, 'split', '\x1b[?1049h\x1b[?1000h\x1b[?1006hSplit Claude\r\nRedraw');
      expect(client2.send).toHaveBeenCalledTimes(1);
      expect(client2.send.mock.calls[0][0]).toContain('\x1b[?1049h');
      expect(client2.send.mock.calls[0][0]).toContain('\x1b[?1006h');
    } finally {
      jest.useRealTimers();
    }
  });

  test('sendHistoryChunks does not split \\x1b[?1049h or \\x1b[?1006h across 64KB chunk boundaries', () => {
    const session = new RemoteAgentTerminalSession(hostId);
    const prefixLen = 64 * 1024 - 16; // account for '\x1b[0m\x1b[?25h' (10 chars) + straddle at 65536
    const payload = 'A'.repeat(prefixLen) + '\x1b[?1049h\x1b[?1000h\x1b[?1006hTUI Body';
    session.handleHistorySync(payload);

    const mockClientWs = { readyState: 1, send: jest.fn() };
    session.attach(mockClientWs);

    expect(mockClientWs.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockClientWs.send.mock.calls) {
      const chunk: string = call[0];
      // No chunk may end with a truncated CSI escape such as '\x1b[?1049'
      expect(chunk).not.toMatch(/\x1b\[[0-9;:?]*$/);
    }
  });
});
