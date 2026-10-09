import { taskManager } from '../tasks/taskManager';

export function handleCmdExec(control: any, targetWs: any): void {
  const { reqId, action, taskId, command, cwd, timeoutMs, env, stdin, offset, signal, limit } = control;

  const reply = (success: boolean, data: any = null, error: string | null = null) => {
    const isOpen = targetWs && (targetWs.readyState === 1 || targetWs.readyState === (targetWs.constructor?.OPEN ?? 1));
    if (isOpen) {
      targetWs.send(
        `JSON:${JSON.stringify({
          type: 'cmd_exec_res',
          reqId,
          taskId,
          success,
          data,
          error,
        })}`
      );
    }
  };

  try {
    if (action === 'start') {
      const res = taskManager.startTask({ taskId, command, cwd, timeoutMs, env, stdin });
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'poll' || action === 'status' || action === 'stream') {
      const res = taskManager.getTask(taskId, offset || 0);
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'kill') {
      const res = taskManager.killTask(taskId, signal);
      if (res.success) {
        return reply(true, res);
      }
      return reply(false, null, res.error);
    }

    if (action === 'list') {
      const res = taskManager.listTasks(limit);
      return reply(true, res);
    }

    reply(false, null, `Unknown cmd_exec action: ${action}`);
  } catch (err: any) {
    reply(false, null, err.message);
  }
}
