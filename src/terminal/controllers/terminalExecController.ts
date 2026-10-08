import { Request, Response } from 'express';
import terminalExecService from '../services/terminalExecService';

class TerminalExecController {
  public async startExec(req: Request, res: Response): Promise<any> {
    const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
    const { command, cwd, timeoutMs, env, stdin } = req.body || {};

    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ success: false, error: 'Field "command" is required' });
    }

    const result = await terminalExecService.startExecution(hostId, {
      command,
      cwd,
      timeoutMs: timeoutMs !== undefined ? parseInt(String(timeoutMs), 10) : undefined,
      env: typeof env === 'object' && env !== null ? env : undefined,
      stdin: typeof stdin === 'string' ? stdin : undefined,
    });

    if (!result.success) {
      const isOffline = result.error && result.error.includes('offline');
      return res.status(isOffline ? 503 : 400).json(result);
    }

    return res.status(202).json(result);
  }

  public async getExecStatus(req: Request, res: Response): Promise<any> {
    const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    const offset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : 0;

    const result = await terminalExecService.getExecutionStatus(hostId, taskId, isNaN(offset) ? 0 : offset);

    if (!result.success) {
      const isNotFound = result.error && (result.error.includes('not found') || result.error.includes('No such task'));
      return res.status(isNotFound ? 404 : 500).json(result);
    }

    return res.status(200).json(result);
  }

  public async killExec(req: Request, res: Response): Promise<any> {
    const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    const { signal } = req.body || {};

    const result = await terminalExecService.killExecution(hostId, taskId, signal);

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  }

  public async listExec(req: Request, res: Response): Promise<any> {
    const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
    const limit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : 20;

    const result = await terminalExecService.listExecutions(hostId, isNaN(limit) ? 20 : limit);

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  }
}

export const terminalExecController = new TerminalExecController();
export default terminalExecController;
