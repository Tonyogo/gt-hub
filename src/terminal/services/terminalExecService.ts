import { terminalHostManager } from './terminalHostManager';
import terminalLogService from './terminalLogService';

export interface StartExecutionOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
}

export class TerminalExecService {
  private loggedFinishedTasks = new Set<string>();

  public async startExecution(hostId: string, options: StartExecutionOptions): Promise<any> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    if (!options || !options.command || !options.command.trim()) {
      return { success: false, error: 'command is required' };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.min(Math.max(options.timeoutMs || 300000, 1000), 3600000); // 1s to 1 hour
    const trimmedHost = hostId.trim();
    const trimmedCmd = options.command.trim();

    const res = await terminalHostManager.executeCmdRpc(trimmedHost, {
      action: 'start',
      taskId,
      command: trimmedCmd,
      cwd: options.cwd ? options.cwd.trim() : undefined,
      timeoutMs,
      env: options.env || {},
      stdin: typeof options.stdin === 'string' ? options.stdin : undefined,
    });

    if (res && res.success && res.data) {
      const effectiveTaskId = res.data.taskId || taskId;
      const logMsg = `[Exec] Started task ${effectiveTaskId} on [${trimmedHost}]: ${trimmedCmd} (timeout: ${timeoutMs}ms${options.cwd ? `, cwd: ${options.cwd.trim()}` : ''})`;
      terminalLogService.addLog('info', logMsg);

      return {
        success: true,
        taskId: effectiveTaskId,
        hostId: trimmedHost,
        ...res.data,
      };
    }

    const errorMsg = res?.error || 'Failed to start command on agent';
    const failLog = `[Exec] Failed to start command on [${trimmedHost}]: ${errorMsg} (cmd: ${trimmedCmd})`;
    terminalLogService.addLog('error', failLog);

    return {
      success: false,
      error: errorMsg,
    };
  }

  public async getExecutionStatus(hostId: string, taskId: string, offset: number = 0): Promise<any> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    if (!taskId || !taskId.trim()) {
      return { success: false, error: 'taskId is required' };
    }

    const trimmedHost = hostId.trim();
    const trimmedTaskId = taskId.trim();

    const res = await terminalHostManager.executeCmdRpc(trimmedHost, {
      action: 'poll',
      taskId: trimmedTaskId,
      offset: Math.max(0, offset || 0),
    });

    if (res && res.success && res.data) {
      const data = res.data;
      if (data.status && data.status !== 'running') {
        const taskKey = `${trimmedHost}:${trimmedTaskId}`;
        if (!this.loggedFinishedTasks.has(taskKey)) {
          this.loggedFinishedTasks.add(taskKey);
          if (this.loggedFinishedTasks.size > 2000) {
            const firstKey = this.loggedFinishedTasks.values().next().value;
            if (firstKey) this.loggedFinishedTasks.delete(firstKey);
          }

          const isSuccess = data.exitCode === 0 || data.status === 'completed';
          const level = isSuccess ? 'info' : 'warn';
          const finishMsg = `[Exec] Task ${trimmedTaskId} on [${trimmedHost}] finished: status=${data.status}, exitCode=${data.exitCode !== null && data.exitCode !== undefined ? data.exitCode : 'N/A'}, duration=${data.durationMs ?? 0}ms`;
          terminalLogService.addLog(level, finishMsg);
        }
      }

      return {
        success: true,
        hostId: trimmedHost,
        ...data,
      };
    }

    return {
      success: false,
      error: res?.error || 'Failed to poll command status from agent',
    };
  }

  public async killExecution(hostId: string, taskId: string, signal: string = 'SIGTERM'): Promise<any> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }
    if (!taskId || !taskId.trim()) {
      return { success: false, error: 'taskId is required' };
    }

    const trimmedHost = hostId.trim();
    const trimmedTaskId = taskId.trim();
    const targetSignal = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';

    const res = await terminalHostManager.executeCmdRpc(trimmedHost, {
      action: 'kill',
      taskId: trimmedTaskId,
      signal: targetSignal,
    });

    const killMsg = `[Exec] Sent kill signal ${targetSignal} to task ${trimmedTaskId} on [${trimmedHost}]`;
    terminalLogService.addLog('warn', killMsg);

    if (res && res.success) {
      return {
        success: true,
        taskId: trimmedTaskId,
        status: 'killed',
        message: res.data?.message || 'Kill signal sent to task',
      };
    }

    return {
      success: false,
      error: res?.error || 'Failed to kill command on agent',
    };
  }

  public async listExecutions(hostId: string, limit: number = 20): Promise<any> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }

    const res = await terminalHostManager.executeCmdRpc(hostId.trim(), {
      action: 'list',
      limit: Math.min(Math.max(limit || 20, 1), 100),
    });

    if (res && res.success && res.data) {
      return {
        success: true,
        hostId: hostId.trim(),
        tasks: res.data.tasks || [],
      };
    }

    return {
      success: false,
      error: res?.error || 'Failed to list tasks from agent',
    };
  }
}

export const terminalExecService = new TerminalExecService();
export default terminalExecService;
