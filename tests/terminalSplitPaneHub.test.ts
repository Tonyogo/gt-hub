import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { BIN_MSG_TYPE, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';

describe('TerminalHostManager Multi-Pane Session Management', () => {
  let manager: TerminalHostManager;
  let mockAgentWs: any;
  const hostId = 'node-split-1';

  beforeEach(() => {
    manager = new TerminalHostManager();
    mockAgentWs = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };
    manager.registerAgent({
      hostId,
      name: 'split-test-node',
      agentWs: mockAgentWs,
    });
  });

  it('normalizes invalid paneId values to main', () => {
    expect(TerminalHostManager.normalizePaneId(undefined)).toBe('main');
    expect(TerminalHostManager.normalizePaneId('')).toBe('main');
    expect(TerminalHostManager.normalizePaneId('split')).toBe('split');
    expect(TerminalHostManager.normalizePaneId('bad/pane id!')).toBe('main');
  });

  it('isolates main and split sessions with independent history and dimensions', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;

    expect(mainSession).toBeDefined();
    expect(splitSession).toBeDefined();
    expect(mainSession).not.toBe(splitSession);
    expect(mainSession.paneId).toBe('main');
    expect(splitSession.paneId).toBe('split');

    mainSession.resize(120, 40);
    splitSession.resize(60, 40);

    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'resize', cols: 120, rows: 40 })}`
    );
    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({
        type: 'cmd_exec',
        action: 'start_stream',
        taskId: 'pane-split',
        command: 'unset TMUX TMUX_PANE STY WINDOW TERM_SESSION_ID GOOGLE_BASHRC_SOURCED; exec "${SHELL:-/bin/sh}" -l',
        env: {
          TMUX: '',
          TMUX_PANE: '',
          STY: '',
          WINDOW: '',
          TERM_SESSION_ID: '',
        },
        tty: true,
        interactive: true,
        cols: 60,
        rows: 40,
      })}`
    );
    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'cmd_stream_resize', taskId: 'pane-split', cols: 60, rows: 40 })}`
    );

    manager.handleAgentData(hostId, 'main-output-line\r\n');
    manager.handleAgentPaneData(hostId, 'split', Buffer.from('split-output-line\r\n', 'utf-8'));

    expect(mainSession.getHistory()).toContain('main-output-line');
    expect(mainSession.getHistory()).not.toContain('split-output-line');
    expect(splitSession.getHistory()).toContain('split-output-line');
    expect(splitSession.getHistory()).not.toContain('main-output-line');
  });

  it('encodes split pane input as cmd_stream_input with taskId and keeps main input raw', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;

    mainSession.write('ls -la\r');
    expect(mockAgentWs.send).toHaveBeenLastCalledWith('ls -la\r');

    splitSession.write('pwd\r');
    const lastSent = mockAgentWs.send.mock.calls[mockAgentWs.send.mock.calls.length - 1][0];
    expect(typeof lastSent).toBe('string');
    expect(lastSent).toBe(
      `JSON:${JSON.stringify({
        type: 'cmd_stream_input',
        taskId: 'pane-split',
        data: Buffer.from('pwd\r', 'utf-8').toString('base64'),
      })}`
    );
  });

  it('destroys split pane session on destroyPaneSession and refuses to destroy main session', () => {
    const splitSession = manager.getSession(hostId, 'split')!;
    manager.handleAgentPaneData(hostId, 'split', 'cached-split-text');
    expect(splitSession.getHistory()).toContain('cached-split-text');

    // Refuses to destroy main
    expect(manager.destroyPaneSession(hostId, 'main', true)).toBe(false);

    // Destroys split and notifies agent via cmd_stream_kill
    expect(manager.destroyPaneSession(hostId, 'split', true)).toBe(true);
    expect(mockAgentWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'cmd_stream_kill', taskId: 'pane-split', signal: 'SIGTERM' })}`
    );

    // Subsequent getSession creates a fresh split session with empty history
    const freshSplit = manager.getSession(hostId, 'split')!;
    expect(freshSplit).not.toBe(splitSession);
    expect(freshSplit.getHistory()).toBe('');
  });

  it('notifies attached split clients on handleAgentPaneExit and cleans up split session', () => {
    const splitSession = manager.getSession(hostId, 'split')!;
    const clientWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
    splitSession.attach(clientWs);

    manager.handleAgentPaneExit(hostId, 'split', 0);

    expect(clientWs.send).toHaveBeenCalledWith(
      `JSON:${JSON.stringify({ type: 'pane_exit', paneId: 'split', exitCode: 0 })}`
    );
  });

  it('propagates agent disconnect to both main and split pane clients', () => {
    const mainSession = manager.getSession(hostId, 'main')!;
    const splitSession = manager.getSession(hostId, 'split')!;
    const mainClient = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const splitClient = { readyState: 1, send: jest.fn(), close: jest.fn() };

    mainSession.attach(mainClient);
    splitSession.attach(splitClient);

    manager.unregisterAgent(hostId, mockAgentWs);

    expect(mainClient.send).toHaveBeenCalledWith(expect.stringContaining('agent_offline'));
    expect(splitClient.send).toHaveBeenCalledWith(expect.stringContaining('agent_offline'));
  });
});
