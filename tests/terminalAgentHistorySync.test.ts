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
});
