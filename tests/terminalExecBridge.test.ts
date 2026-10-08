import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { TerminalExecBridge } from '../src/terminal/services/terminalExecBridge';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('TerminalExecBridge', () => {
  let bridge: TerminalExecBridge;

  beforeEach(() => {
    bridge = new TerminalExecBridge();
  });

  it('rejects connection if hostId is missing or host is offline', () => {
    const mockWs = {
      send: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
      readyState: 1,
    } as any;

    const req = {
      url: '/api/terminal/exec-ws?hostId=non-existent-host',
      headers: { host: 'localhost' },
    } as any;

    bridge.handleCliConnection(mockWs, req);
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('[Host Offline]'));
    expect(mockWs.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('routes agent stream data and exit to corresponding CLI socket', (done) => {
    const mockCliWs = new EventEmitter() as any;
    mockCliWs.send = jest.fn();
    mockCliWs.close = jest.fn();
    mockCliWs.readyState = 1;

    // Register a mock online agent
    const mockAgentWs = new EventEmitter() as any;
    mockAgentWs.send = jest.fn();
    mockAgentWs.readyState = 1;
    terminalHostManager.registerAgent({
      hostId: 'test-agent-1',
      name: 'test-agent',
      agentWs: mockAgentWs,
    });

    const req = {
      url: '/api/terminal/exec-ws?hostId=test-agent-1',
      headers: { host: 'localhost' },
    } as any;

    bridge.handleCliConnection(mockCliWs, req);

    // Simulate CLI sending exec_start
    mockCliWs.emit('message', Buffer.from(JSON.stringify({
      type: 'exec_start',
      command: 'bash',
      tty: true,
      cols: 80,
      rows: 24,
    })));

    // Verify message was forwarded to agent via session or agentWs
    expect(mockAgentWs.send).toHaveBeenCalledWith(expect.stringContaining('"action":"start_stream"'));

    // Extract taskId from the message sent to agent
    const sentMsg = mockAgentWs.send.mock.calls.find((call: any[]) => call[0].includes('start_stream'))[0];
    const parsed = JSON.parse(sentMsg.slice(5));
    const taskId = parsed.taskId;

    // Simulate Agent returning stdout stream
    const base64Data = Buffer.from('hello world\n').toString('base64');
    bridge.handleAgentStreamMessage('test-agent-1', {
      type: 'cmd_stream_data',
      taskId,
      data: base64Data,
    });

    expect(mockCliWs.send).toHaveBeenCalledWith(Buffer.from('hello world\n'));

    // Simulate Agent exiting
    bridge.handleAgentStreamMessage('test-agent-1', {
      type: 'cmd_stream_exit',
      taskId,
      exitCode: 0,
    });

    expect(mockCliWs.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'exec_exit',
      exitCode: 0,
      signal: null,
    }));
    expect(mockCliWs.close).toHaveBeenCalledWith(1000, 'Process exited');

    done();
  });
});
