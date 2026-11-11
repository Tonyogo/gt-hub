import { terminalHostManager } from './terminalHostManager';
import terminalLogService from './terminalLogService';
import { terminalExecCallbackService, ExecCallbackConfig } from './terminalExecCallbackService';
import { scriptService } from '../../server/modules/scripts/scriptService';
import { quoteShellArg } from '../../shared/utils/shell';

export interface StartExecutionOptions {
  command?: string;
  scriptName?: string;
  scriptArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  waitMs?: number;
  env?: Record<string, string>;
  stdin?: string;
  callback?: ExecCallbackConfig;
}

export class TerminalExecService {
  private loggedFinishedTasks = new Set<string>();
  private taskWaiters = new Map<string, (finishedData: any) => void>();

  public async startExecution(hostId: string, options: StartExecutionOptions): Promise<any> {
    if (!hostId || !hostId.trim()) {
      return { success: false, error: 'hostId is required' };
    }

    let trimmedCmd = options?.command ? options.command.trim() : '';

    if (!trimmedCmd && options?.scriptName && typeof options.scriptName === 'string') {
      try {
        const script = await scriptService.getScript(options.scriptName.trim());
        const argsPart = (options.scriptArgs || []).map((a) => quoteShellArg(String(a))).join(' ');
        trimmedCmd = `sh -c ${quoteShellArg(script.content)} ${quoteShellArg(script.name)}${argsPart ? ' ' + argsPart : ''}`;
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to load script' };
      }
    }

    if (!trimmedCmd) {
      return { success: false, error: 'command is required' };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.min(Math.max(options.timeoutMs || 300000, 1000), 3600000); // 1s to 1 hour
    const trimmedHost = hostId.trim();

    const hasWait = typeof options.waitMs === 'number' && !isNaN(options.waitMs) && options.waitMs > 0;
    const clampedWaitMs = hasWait ? Math.min(Math.max(options.waitMs!, 0), 60000) : 0;

    let finishPromiseResolve!: (data: any) => void;
    let finishPromise: Promise<any> | null = null;
    if (clampedWaitMs > 0) {
      finishPromise = new Promise<any>((resolve) => {
        finishPromiseResolve = resolve;
      });
      this.taskWaiters.set(taskId, finishPromiseResolve);
    }

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
      if (clampedWaitMs > 0 && effectiveTaskId !== taskId) {
        this.taskWaiters.delete(taskId);
        this.taskWaiters.set(effectiveTaskId, finishPromiseResolve);
      }

      const logMsg = `[Exec] Started task ${effectiveTaskId} on [${trimmedHost}]: ${trimmedCmd} (timeout: ${timeoutMs}ms${options.cwd ? `, cwd: ${options.cwd.trim()}` : ''})`;
      terminalLogService.addLog('info', logMsg);

      if (clampedWaitMs > 0 && finishPromise) {
        let waitTimer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
          waitTimer = setTimeout(() => resolve({ timedOut: true }), clampedWaitMs);
          if (typeof waitTimer.unref === 'function') waitTimer.unref();
        });

        const raceResult = await Promise.race([finishPromise, timeoutPromise]);
        if (waitTimer) clearTimeout(waitTimer);

        if ((raceResult as any)?.timedOut) {
          this.taskWaiters.delete(effectiveTaskId);

          let callbackRegistered: boolean | undefined = undefined;
          if (options.callback) {
            terminalExecCallbackService.registerCallback({
              taskId: effectiveTaskId,
              hostId: trimmedHost,
              command: trimmedCmd,
              cwd: res.data.cwd || options.cwd,
              startTime: res.data.startTime,
              taskTimeoutMs: timeoutMs,
              callback: options.callback,
            });
            callbackRegistered = true;
          }

          return {
            success: true,
            completed: false,
            taskId: effectiveTaskId,
            hostId: trimmedHost,
            ...res.data,
            ...(callbackRegistered ? { callbackRegistered: true } : {}),
          };
        } else {
          this.taskWaiters.delete(effectiveTaskId);
          const finishedData = raceResult;

          return {
            success: true,
            completed: true,
            taskId: effectiveTaskId,
            hostId: trimmedHost,
            command: trimmedCmd,
            cwd: finishedData.cwd || options.cwd,
            status: finishedData.status,
            exitCode: finishedData.exitCode,
            stdout: finishedData.stdout || '',
            stderr: finishedData.stderr || '',
            output: finishedData.output || '',
            totalBytes: finishedData.totalBytes || 0,
            durationMs: finishedData.durationMs ?? 0,
            startTime: finishedData.startTime || res.data.startTime,
            endTime: finishedData.endTime || Date.now(),
            ...(options.callback ? { callbackRegistered: false, callbackSkippedReason: 'completed_within_wait' } : {}),
          };
        }
      }

      let callbackRegistered: boolean | undefined = undefined;
      if (options.callback) {
        terminalExecCallbackService.registerCallback({
          taskId: effectiveTaskId,
          hostId: trimmedHost,
          command: trimmedCmd,
          cwd: res.data.cwd || options.cwd,
          startTime: res.data.startTime,
          taskTimeoutMs: timeoutMs,
          callback: options.callback,
        });
        callbackRegistered = true;
      }

      return {
        success: true,
        taskId: effectiveTaskId,
        hostId: trimmedHost,
        ...res.data,
        ...(callbackRegistered ? { callbackRegistered: true } : {}),
      };
    }

    if (clampedWaitMs > 0) {
      this.taskWaiters.delete(taskId);
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

  public async handleAgentTaskFinished(hostId: string, data: any): Promise<void> {
    if (!hostId || !data || !data.taskId) return;
    const trimmedHost = hostId.trim();
    const trimmedTaskId = String(data.taskId).trim();
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

    const waiter = this.taskWaiters.get(trimmedTaskId);
    if (waiter) {
      this.taskWaiters.delete(trimmedTaskId);
      waiter(data);
      return;
    }

    await terminalExecCallbackService.handleTaskFinished(trimmedHost, data);
  }
}

export const terminalExecService = new TerminalExecService();
export default terminalExecService;
