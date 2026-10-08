import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('TerminalHostManager - Command Execution RPC', () => {
  let manager: TerminalHostManager;

  beforeEach(() => {
    manager = new TerminalHostManager();
  });

  it('returns offline error when agent is not registered or offline', async () => {
    const res = await manager.executeCmdRpc('offline-host-123', {
      action: 'start',
      command: 'echo hello',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/offline or unavailable/i);
  });

  it('dispatches command RPC frame and resolves on handleAgentCmdRpcResponse', async () => {
    const mockWs = {
      readyState: 1,
      send: jest.fn(),
    };

    manager.registerAgent({
      hostId: 'agent-exec-1',
      agentWs: mockWs,
    });

    const promise = manager.executeCmdRpc('agent-exec-1', {
      action: 'start',
      command: 'echo hello',
    });

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentStr = mockWs.send.mock.calls[0][0];
    expect(sentStr).toMatch(/^JSON:/);
    const payload = JSON.parse(sentStr.slice(5));
    expect(payload.type).toBe('cmd_exec');
    expect(payload.action).toBe('start');
    expect(payload.command).toBe('echo hello');
    expect(payload.reqId).toBeDefined();

    manager.handleAgentCmdRpcResponse({
      reqId: payload.reqId,
      success: true,
      data: { taskId: 'task-1', status: 'running' },
    });

    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.data.taskId).toBe('task-1');
  });

  it('cancels pending cmd RPC when agent reconnects', async () => {
    const mockWs1 = { readyState: 1, send: jest.fn() };
    const mockWs2 = { readyState: 1, send: jest.fn() };

    manager.registerAgent({
      hostId: 'agent-exec-2',
      agentWs: mockWs1,
    });

    const promise = manager.executeCmdRpc('agent-exec-2', {
      action: 'poll',
      taskId: 'task-2',
    });

    // Reconnect agent
    manager.registerAgent({
      hostId: 'agent-exec-2',
      agentWs: mockWs2,
    });

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reconnected; previous command RPC cancelled/i);
  });
});
