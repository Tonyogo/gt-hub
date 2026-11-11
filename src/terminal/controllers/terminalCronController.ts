import { Request, Response } from 'express';
import { terminalCronService } from '../services/terminalCronService';
import config from '../../server/config/default';
import { extractHostId } from '../utils/requestParams';
import { mapRpcErrorToHttpStatus } from '../utils/httpErrorMapper';

export class TerminalCronController {
  public async getJobs(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const jobs = await terminalCronService.getJobs(nodeId);
      res.json({ success: true, data: jobs, timezone: config.timeZone });
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to list cron jobs' });
    }
  }

  public async addJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const job = await terminalCronService.addJob(nodeId, req.body);
      res.status(201).json({ success: true, data: job });
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to create cron job' });
    }
  }

  public async updateJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const jobId = String(req.params.jobId);
      const job = await terminalCronService.updateJob(nodeId, jobId, req.body);
      res.json({ success: true, data: job });
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to update cron job' });
    }
  }

  public async deleteJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const jobId = String(req.params.jobId);
      const success = await terminalCronService.removeJob(nodeId, jobId);
      if (!success) {
        res.status(404).json({ success: false, error: `Job "${jobId}" not found on node "${nodeId}"` });
        return;
      }
      res.json({ success: true, message: `Job "${jobId}" deleted successfully` });
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to delete cron job' });
    }
  }

  public async triggerJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const jobId = String(req.params.jobId);
      const success = await terminalCronService.triggerJob(nodeId, jobId);
      res.json({ success, message: `Execution triggered for job "${jobId}"` });
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to trigger cron job' });
    }
  }

  public async getJobLogs(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = extractHostId(req);
      const jobId = String(req.params.jobId);
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const logs = await terminalCronService.getJobLogs(nodeId, jobId, offset);
      res.json(logs);
    } catch (err: any) {
      const status = mapRpcErrorToHttpStatus(err.message, 400);
      res.status(status).json({ success: false, error: err.message || 'Failed to get job logs' });
    }
  }
}

export const terminalCronController = new TerminalCronController();
export default terminalCronController;
