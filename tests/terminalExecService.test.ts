import { terminalExecService } from '../src/terminal/services/terminalExecService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

jest.mock('../src/terminal/services/terminalHostManager');

describe('TerminalExecService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects startExecution when hostId or command is missing', async () => {
    const res1 = await terminalExecService.startExecution('', { command: 'ls' });
    expect(res1.success).toBe(false);
    expect(res1.error).toMatch(/hostId is required/i);

    const res2 = await terminalExecService.startExecution('node-1', { command: '   ' });
    expect(res2.success).toBe(false);
    expect(res2.error).toMatch(/command is required/i);
  });

  it('delegates startExecution to terminalHostManager with unique taskId', async () => {
    (terminalHostManager.executeCmdRpc as jest.Mock).mockResolvedValue({
      success: true,
      data: { taskId: 'task-123', status: 'running' }
    });

    const res = await terminalExecService.startExecution('node-1', {
      command: 'echo 123',
      timeoutMs: 60000
    });

    expect(res.success).toBe(true);
    expect(terminalHostManager.executeCmdRpc).toHaveBeenCalledWith('node-1', expect.objectContaining({
      action: 'start',
      command: 'echo 123',
      timeoutMs: 60000
    }));
  });

  it('handles startExecution failure from terminalHostManager', async () => {
    (terminalHostManager.executeCmdRpc as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Agent "node-1" is offline or unavailable'
    });

    const res = await terminalExecService.startExecution('node-1', { command: 'ls' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/offline/i);
  });

  it('validates and gets execution status', async () => {
    const missingHost = await terminalExecService.getExecutionStatus('', 'task-1');
    expect(missingHost.success).toBe(false);
    expect(missingHost.error).toMatch(/hostId is required/i);

    const missingTask = await terminalExecService.getExecutionStatus('node-1', '');
    expect(missingTask.success).toBe(false);
    expect(missingTask.error).toMatch(/taskId is required/i);

    (terminalHostManager.executeCmdRpc as jest.Mock).mockResolvedValue({
      success: true,
      data: { taskId: 'task-1', status: 'completed', exitCode: 0, stdout: 'ok\n' }
    });

    const res = await terminalExecService.getExecutionStatus('node-1', 'task-1', 10);
    expect(res.success).toBe(true);
    expect(res.status).toBe('completed');
    expect(res.stdout).toBe('ok\n');
    expect(terminalHostManager.executeCmdRpc).toHaveBeenCalledWith('node-1', {
      action: 'poll',
      taskId: 'task-1',
      offset: 10
    });
  });

  it('validates and kills execution', async () => {
    const missingHost = await terminalExecService.killExecution('', 'task-1');
    expect(missingHost.success).toBe(false);

    const missingTask = await terminalExecService.killExecution('node-1', '');
    expect(missingTask.success).toBe(false);

    (terminalHostManager.executeCmdRpc as jest.Mock).mockResolvedValue({
      success: true,
      data: { message: 'Signal sent' }
    });

    const res = await terminalExecService.killExecution('node-1', 'task-1', 'SIGKILL');
    expect(res.success).toBe(true);
    expect(res.status).toBe('killed');
    expect(terminalHostManager.executeCmdRpc).toHaveBeenCalledWith('node-1', {
      action: 'kill',
      taskId: 'task-1',
      signal: 'SIGKILL'
    });
  });

  it('validates and lists executions', async () => {
    const missingHost = await terminalExecService.listExecutions('');
    expect(missingHost.success).toBe(false);

    (terminalHostManager.executeCmdRpc as jest.Mock).mockResolvedValue({
      success: true,
      data: { tasks: [{ taskId: 'task-1', command: 'ls', status: 'completed' }] }
    });

    const res = await terminalExecService.listExecutions('node-1', 50);
    expect(res.success).toBe(true);
    expect(res.tasks).toHaveLength(1);
    expect(terminalHostManager.executeCmdRpc).toHaveBeenCalledWith('node-1', {
      action: 'list',
      limit: 50
    });
  });
});
