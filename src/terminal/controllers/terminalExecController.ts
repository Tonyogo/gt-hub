import { Request, Response } from 'express';
import terminalExecService, { StartExecutionOptions } from '../services/terminalExecService';
import { validateCallbackConfig } from '../services/terminalExecCallbackService';
import { extractHostId } from '../utils/requestParams';
import { mapRpcErrorToHttpStatus } from '../utils/httpErrorMapper';

class TerminalExecController {
  public async startExec(req: Request, res: Response): Promise<any> {
    const hostId = extractHostId(req);
    const { command, scriptName, scriptArgs, cwd, timeoutMs, waitMs, env, stdin, callback } = req.body || {};

    const hasCommand = typeof command === 'string' && Boolean(command.trim());
    const hasScript = typeof scriptName === 'string' && Boolean(scriptName.trim());

    if (!hasCommand && !hasScript) {
      return res.status(400).json({ success: false, error: 'Field "command" or "scriptName" is required' });
    }

    if (scriptArgs !== undefined && !Array.isArray(scriptArgs)) {
      return res.status(400).json({ success: false, error: 'Field "scriptArgs" must be an array' });
    }

    let parsedWaitMs: number | undefined = undefined;
    if (waitMs !== undefined && waitMs !== null) {
      parsedWaitMs = parseInt(String(waitMs), 10);
      if (isNaN(parsedWaitMs) || parsedWaitMs < 0) {
        return res.status(400).json({ success: false, error: 'Field "waitMs" must be a non-negative number' });
      }
    }

    let callbackConfig;
    if (callback !== undefined && callback !== null) {
      const validation = validateCallbackConfig(callback);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.error });
      }
      callbackConfig = validation.config;
    }

    const options: StartExecutionOptions = {
      command: hasCommand ? command : undefined,
      cwd,
      timeoutMs: timeoutMs !== undefined ? parseInt(String(timeoutMs), 10) : undefined,
      env: typeof env === 'object' && env !== null ? env : undefined,
      stdin: typeof stdin === 'string' ? stdin : undefined,
      callback: callbackConfig,
    };
    if (hasScript) {
      options.scriptName = scriptName;
      if (scriptArgs !== undefined) {
        options.scriptArgs = scriptArgs;
      }
    }
    if (parsedWaitMs !== undefined) {
      options.waitMs = parsedWaitMs;
    }

    const result = await terminalExecService.startExecution(hostId, options);

    if (!result.success) {
      return res.status(mapRpcErrorToHttpStatus(result.error, 400)).json(result);
    }

    return res.status(result.completed ? 200 : 202).json(result);
  }

  public async getExecStatus(req: Request, res: Response): Promise<any> {
    const hostId = extractHostId(req);
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    const offset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : 0;

    const result = await terminalExecService.getExecutionStatus(hostId, taskId, isNaN(offset) ? 0 : offset);

    if (!result.success) {
      return res.status(mapRpcErrorToHttpStatus(result.error, 500)).json(result);
    }

    return res.status(200).json(result);
  }

  public async killExec(req: Request, res: Response): Promise<any> {
    const hostId = extractHostId(req);
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    const { signal } = req.body || {};

    const result = await terminalExecService.killExecution(hostId, taskId, signal);

    if (!result.success) {
      return res.status(mapRpcErrorToHttpStatus(result.error, 500)).json(result);
    }

    return res.status(200).json(result);
  }

  public async listExec(req: Request, res: Response): Promise<any> {
    const hostId = extractHostId(req);
    const limit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : 20;

    const result = await terminalExecService.listExecutions(hostId, isNaN(limit) ? 20 : limit);

    if (!result.success) {
      return res.status(mapRpcErrorToHttpStatus(result.error, 500)).json(result);
    }

    return res.status(200).json(result);
  }
}

export const terminalExecController = new TerminalExecController();
export default terminalExecController;
