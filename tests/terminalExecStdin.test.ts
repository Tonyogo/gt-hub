import { terminalExecService } from '../src/terminal/services/terminalExecService';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('terminalExecService with stdin support', () => {
  it('passes stdin parameter to agent RPC payload', async () => {
    const executeSpy = jest.spyOn(terminalHostManager, 'executeCmdRpc').mockResolvedValue({
      success: true,
      data: { taskId: 'mock-task-123' },
    });

    const result = await terminalExecService.startExecution('test-host', {
      command: 'cat',
      stdin: 'hello from test stdin',
    });

    expect(result.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith('test-host', expect.objectContaining({
      action: 'start',
      command: 'cat',
      stdin: 'hello from test stdin',
    }));

    executeSpy.mockRestore();
  });
});
