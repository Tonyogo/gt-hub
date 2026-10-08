import { terminalExecService } from '../src/terminal/services/terminalExecService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import terminalLogService from '../src/terminal/services/terminalLogService';

describe('TerminalExecService audit logging', () => {
  beforeEach(() => {
    terminalLogService.clearHistory();
    jest.restoreAllMocks();
  });

  it('records audit log when task starts successfully', async () => {
    jest.spyOn(terminalHostManager, 'executeCmdRpc').mockResolvedValue({
      success: true,
      data: { taskId: 'task-audit-1' },
    });

    const res = await terminalExecService.startExecution('host-prod-1', {
      command: 'echo "hello"',
      timeoutMs: 5000,
    });

    expect(res.success).toBe(true);
    const logs = terminalLogService.getHistory();
    const startLog = logs.find(l => l.message.includes('[Exec] Started task task-audit-1 on [host-prod-1]: echo "hello"'));
    expect(startLog).toBeDefined();
    expect(startLog?.level).toBe('info');
  });

  it('records error log when task start fails', async () => {
    jest.spyOn(terminalHostManager, 'executeCmdRpc').mockResolvedValue({
      success: false,
      error: 'Host offline',
    });

    const res = await terminalExecService.startExecution('host-prod-1', {
      command: 'uptime',
    });

    expect(res.success).toBe(false);
    const logs = terminalLogService.getHistory();
    const errLog = logs.find(l => l.message.includes('[Exec] Failed to start command on [host-prod-1]: Host offline'));
    expect(errLog).toBeDefined();
    expect(errLog?.level).toBe('error');
  });

  it('records finished audit log only once on terminal status poll', async () => {
    jest.spyOn(terminalHostManager, 'executeCmdRpc').mockResolvedValue({
      success: true,
      data: {
        taskId: 'task-audit-2',
        status: 'completed',
        exitCode: 0,
        durationMs: 1200,
      },
    });

    await terminalExecService.getExecutionStatus('host-prod-1', 'task-audit-2', 0);
    // Poll again to ensure deduplication
    await terminalExecService.getExecutionStatus('host-prod-1', 'task-audit-2', 10);

    const logs = terminalLogService.getHistory().filter(l => l.message.includes('task-audit-2'));
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain('[Exec] Task task-audit-2 on [host-prod-1] finished: status=completed, exitCode=0, duration=1200ms');
    expect(logs[0].level).toBe('info');
  });

  it('records warning audit log on kill execution', async () => {
    jest.spyOn(terminalHostManager, 'executeCmdRpc').mockResolvedValue({
      success: true,
      data: { message: 'Kill signal sent' },
    });

    await terminalExecService.killExecution('host-prod-1', 'task-audit-3', 'SIGKILL');

    const logs = terminalLogService.getHistory();
    const killLog = logs.find(l => l.message.includes('[Exec] Sent kill signal SIGKILL to task task-audit-3 on [host-prod-1]'));
    expect(killLog).toBeDefined();
    expect(killLog?.level).toBe('warn');
  });
});
