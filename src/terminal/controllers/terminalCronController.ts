import { Request, Response } from 'express';
import { terminalCronService } from '../services/terminalCronService';

export class TerminalCronController {
  public async getJobs(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const jobs = await terminalCronService.getJobs(nodeId);
      const timezone = terminalCronService.getNodeTimezone(nodeId);
      res.json({ success: true, data: jobs, timezone });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to list cron jobs' });
    }
  }

  public async addJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const job = await terminalCronService.addJob(nodeId, req.body);
      res.status(201).json({ success: true, data: job });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to create cron job' });
    }
  }

  public async updateJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const jobId = String(req.params.jobId);
      const job = await terminalCronService.updateJob(nodeId, jobId, req.body);
      res.json({ success: true, data: job });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ success: false, error: err.message || 'Failed to update cron job' });
    }
  }

  public async deleteJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const jobId = String(req.params.jobId);
      const success = await terminalCronService.removeJob(nodeId, jobId);
      if (!success) {
        res.status(404).json({ success: false, error: `Job "${jobId}" not found on node "${nodeId}"` });
        return;
      }
      res.json({ success: true, message: `Job "${jobId}" deleted successfully` });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to delete cron job' });
    }
  }

  public async triggerJob(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const jobId = String(req.params.jobId);
      const success = await terminalCronService.triggerJob(nodeId, jobId);
      res.json({ success, message: `Execution triggered for job "${jobId}"` });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ success: false, error: err.message || 'Failed to trigger cron job' });
    }
  }

  public async getJobLogs(req: Request, res: Response): Promise<void> {
    try {
      const nodeId = String(req.params.nodeId);
      const jobId = String(req.params.jobId);
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const logs = await terminalCronService.getJobLogs(nodeId, jobId, offset);
      res.json(logs);
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ success: false, error: err.message || 'Failed to get job logs' });
    }
  }
}

export const terminalCronController = new TerminalCronController();
export default terminalCronController;
