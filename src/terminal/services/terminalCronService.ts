import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CronJobConfig, CronExecutionRecord, CronJobSummary } from '../../shared/types/cron';
import { getNextCronTime, isValidCronExpression, isValidTimezone } from '../../shared/utils/cronParser';
import { terminalHostManager } from './terminalHostManager';
import logger from '../../utils/logger';

interface NodeCronData {
  nodeId: string;
  timezone?: string;
  jobs: CronJobConfig[];
  executions: CronExecutionRecord[];
}

export class TerminalCronService {
  private storageDir: string;
  private readonly MAX_EXECUTIONS = 100;

  constructor(customStorageDir?: string) {
    if (customStorageDir) {
      this.storageDir = path.resolve(customStorageDir);
    } else {
      this.storageDir = path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'cron');
    }
    this.ensureDir();
  }

  public setStorageDir(dir: string): void {
    this.storageDir = path.resolve(dir);
    this.ensureDir();
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
  }

  private resolveCanonicalNodeId(nodeId: string): string {
    return terminalHostManager.resolveCanonicalHostId(nodeId) || nodeId.trim();
  }

  private getNodeFilePath(nodeId: string): string {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    return path.join(this.storageDir, `${canonicalId}.json`);
  }

  private loadNodeData(nodeId: string): NodeCronData {
    this.ensureDir();
    const filePath = this.getNodeFilePath(nodeId);
    const canonicalId = this.resolveCanonicalNodeId(nodeId);

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          nodeId: parsed.nodeId || canonicalId,
          timezone: typeof parsed.timezone === 'string' && isValidTimezone(parsed.timezone) && parsed.timezone !== 'local' ? parsed.timezone.trim() : undefined,
          jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
          executions: Array.isArray(parsed.executions) ? parsed.executions : [],
        };
      } catch {
        // Corrupted file, fallback
      }
    }

    return {
      nodeId: canonicalId,
      jobs: [],
      executions: [],
    };
  }

  private saveNodeData(nodeId: string, data: NodeCronData): void {
    this.ensureDir();
    const filePath = this.getNodeFilePath(nodeId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err: any) {
      logger.error(`[TerminalCronService] Failed to save cron data for ${nodeId}: ${err.message}`);
    }
  }

  public syncToAgent(nodeId: string, jobs?: CronJobConfig[]): void {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const ws = terminalHostManager.getAgentWs(canonicalId);
    if (ws && (ws.readyState === 1 || ws.readyState === (ws.constructor?.OPEN ?? 1))) {
      const jobList = jobs || this.loadNodeData(canonicalId).jobs;
      try {
        ws.send(`JSON:${JSON.stringify({ type: 'cron_sync', jobs: jobList })}`);
      } catch (err: any) {
        logger.warn(`[TerminalCronService] Failed to push cron_sync to ${canonicalId}: ${err.message}`);
      }
    }
  }

  public syncOnConnect(nodeId: string): void {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const host = terminalHostManager.getHost(canonicalId);
    const hostTz = (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone)) ? host.timezone.trim() : undefined;

    const filePath = this.getNodeFilePath(canonicalId);
    if (fs.existsSync(filePath)) {
      const data = this.loadNodeData(canonicalId);
      let updated = false;
      if (hostTz && data.timezone !== hostTz) {
        data.timezone = hostTz;
        updated = true;
      }
      if (updated) {
        this.saveNodeData(canonicalId, data);
      }
      if (data.jobs && data.jobs.length > 0) {
        this.syncToAgent(canonicalId, data.jobs);
      }
    } else if (hostTz) {
      this.saveNodeData(canonicalId, {
        nodeId: canonicalId,
        timezone: hostTz,
        jobs: [],
        executions: [],
      });
    }
  }

  public getNodeTimezone(nodeId: string): string | undefined {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const host = terminalHostManager.getHost(canonicalId);
    if (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone)) {
      return host.timezone.trim();
    }
    const data = this.loadNodeData(canonicalId);
    if (data.timezone && data.timezone !== 'local' && isValidTimezone(data.timezone)) {
      return data.timezone.trim();
    }
    return undefined;
  }

  public async getJobs(nodeId: string): Promise<CronJobSummary[]> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);

    const host = terminalHostManager.getHost(canonicalId);
    const hostTimezone = (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone))
      ? host.timezone.trim()
      : (data.timezone && data.timezone !== 'local' && isValidTimezone(data.timezone) ? data.timezone.trim() : undefined);

    return data.jobs.map((job) => {
      let nextRunTime: number | null = null;
      if (job.status === 'active') {
        try {
          const effectiveTimezone = (job.timezone && job.timezone !== 'local')
            ? job.timezone
            : hostTimezone;
          nextRunTime = getNextCronTime(job.cron, undefined, effectiveTimezone).getTime();
        } catch {
          nextRunTime = null;
        }
      }

      const lastExecution = data.executions.find(e => e.jobId === job.id) || null;

      return {
        ...job,
        nextRunTime,
        lastExecution,
      };
    });
  }

  public async addJob(nodeId: string, jobData: Partial<CronJobConfig>): Promise<CronJobConfig> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);

    if (!jobData.name || typeof jobData.name !== 'string' || !jobData.name.trim()) {
      throw new Error('Cron job name is required');
    }
    const name = jobData.name.trim();

    if (!jobData.cron || typeof jobData.cron !== 'string' || !isValidCronExpression(jobData.cron)) {
      throw new Error(`Invalid cron expression: "${jobData.cron}"`);
    }
    const cron = jobData.cron.trim();

    if (jobData.timezone !== undefined && !isValidTimezone(jobData.timezone)) {
      throw new Error(`Invalid timezone: "${jobData.timezone}"`);
    }
    const timezone = jobData.timezone && jobData.timezone.trim() ? jobData.timezone.trim() : undefined;

    const source = jobData.source || (jobData.scriptName ? 'hub' : 'command');
    if (source === 'command' && (!jobData.command || typeof jobData.command !== 'string' || !jobData.command.trim())) {
      throw new Error('Command is required when source is "command"');
    }
    if (source === 'hub' && (!jobData.scriptName || typeof jobData.scriptName !== 'string' || !jobData.scriptName.trim())) {
      throw new Error('scriptName is required when source is "hub"');
    }

    const data = this.loadNodeData(canonicalId);
    const host = terminalHostManager.getHost(canonicalId);
    const hostTz = (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone)) ? host.timezone.trim() : undefined;
    if (hostTz && data.timezone !== hostTz) {
      data.timezone = hostTz;
    }

    // Check duplicate ID or name
    const existing = data.jobs.find(j => j.name === name || (jobData.id && j.id === jobData.id));
    if (existing) {
      throw new Error(`Job "${existing.name}" already exists on node "${canonicalId}"`);
    }

    const id = jobData.id && jobData.id.trim()
      ? jobData.id.trim()
      : `cron_${crypto.randomBytes(4).toString('hex')}`;

    const newJob: CronJobConfig = {
      id,
      name,
      cron,
      timezone,
      source,
      command: jobData.command?.trim(),
      scriptName: jobData.scriptName?.trim(),
      scriptArgs: Array.isArray(jobData.scriptArgs) ? jobData.scriptArgs : [],
      cwd: jobData.cwd?.trim(),
      env: jobData.env || {},
      timeoutMs: typeof jobData.timeoutMs === 'number' ? jobData.timeoutMs : undefined,
      concurrency: jobData.concurrency === 'allow' ? 'allow' : 'forbid',
      status: jobData.status === 'paused' ? 'paused' : 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    data.jobs.push(newJob);
    this.saveNodeData(canonicalId, data);
    this.syncToAgent(canonicalId, data.jobs);

    return newJob;
  }

  public async removeJob(nodeId: string, jobId: string): Promise<boolean> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);
    const host = terminalHostManager.getHost(canonicalId);
    const hostTz = (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone)) ? host.timezone.trim() : undefined;
    if (hostTz && data.timezone !== hostTz) {
      data.timezone = hostTz;
    }

    const idx = data.jobs.findIndex(j => j.id === jobId || j.name === jobId);
    if (idx === -1) {
      return false;
    }

    data.jobs.splice(idx, 1);
    this.saveNodeData(canonicalId, data);
    this.syncToAgent(canonicalId, data.jobs);

    return true;
  }

  public async updateJob(nodeId: string, jobId: string, updates: Partial<CronJobConfig>): Promise<CronJobConfig> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);
    const host = terminalHostManager.getHost(canonicalId);
    const hostTz = (host?.timezone && host.timezone !== 'local' && isValidTimezone(host.timezone)) ? host.timezone.trim() : undefined;
    if (hostTz && data.timezone !== hostTz) {
      data.timezone = hostTz;
    }

    const job = data.jobs.find(j => j.id === jobId || j.name === jobId);
    if (!job) {
      throw new Error(`Job "${jobId}" not found on node "${canonicalId}"`);
    }

    if (updates.name && updates.name.trim() !== job.name) {
      const conflict = data.jobs.find(j => j.id !== job.id && j.name === updates.name?.trim());
      if (conflict) {
        throw new Error(`Another job with name "${updates.name}" already exists on node "${canonicalId}"`);
      }
      job.name = updates.name.trim();
    }

    if (updates.cron) {
      if (!isValidCronExpression(updates.cron)) {
        throw new Error(`Invalid cron expression: "${updates.cron}"`);
      }
      job.cron = updates.cron.trim();
    }

    if (updates.timezone !== undefined) {
      if (!isValidTimezone(updates.timezone)) {
        throw new Error(`Invalid timezone: "${updates.timezone}"`);
      }
      job.timezone = updates.timezone && updates.timezone.trim() ? updates.timezone.trim() : undefined;
    }

    if (updates.source) {
      job.source = updates.source;
    }
    if (updates.command !== undefined) {
      job.command = updates.command?.trim();
    }
    if (updates.scriptName !== undefined) {
      job.scriptName = updates.scriptName?.trim();
    }
    if (updates.scriptArgs !== undefined) {
      job.scriptArgs = Array.isArray(updates.scriptArgs) ? updates.scriptArgs : [];
    }
    if (updates.cwd !== undefined) {
      job.cwd = updates.cwd?.trim();
    }
    if (updates.env !== undefined) {
      job.env = updates.env;
    }
    if (updates.timeoutMs !== undefined) {
      job.timeoutMs = updates.timeoutMs;
    }
    if (updates.concurrency !== undefined) {
      job.concurrency = updates.concurrency;
    }
    if (updates.status !== undefined) {
      job.status = updates.status;
    }

    job.updatedAt = Date.now();
    this.saveNodeData(canonicalId, data);
    this.syncToAgent(canonicalId, data.jobs);

    return job;
  }

  public async triggerJob(nodeId: string, jobId: string): Promise<boolean> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);

    const job = data.jobs.find(j => j.id === jobId || j.name === jobId);
    if (!job) {
      throw new Error(`Job "${jobId}" not found on node "${canonicalId}"`);
    }

    const ws = terminalHostManager.getAgentWs(canonicalId);
    if (!ws || (ws.readyState !== 1 && ws.readyState !== (ws.constructor?.OPEN ?? 1))) {
      throw new Error(`Node "${nodeId}" is offline or unavailable`);
    }

    try {
      ws.send(`JSON:${JSON.stringify({ type: 'cron_trigger', jobId: job.id })}`);
      return true;
    } catch (err: any) {
      throw new Error(`Failed to send trigger to agent: ${err.message}`);
    }
  }

  public async recordExecution(nodeId: string, record: CronExecutionRecord): Promise<void> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);

    data.executions.unshift(record);
    if (data.executions.length > this.MAX_EXECUTIONS) {
      data.executions = data.executions.slice(0, this.MAX_EXECUTIONS);
    }

    this.saveNodeData(canonicalId, data);
  }

  public async getJobLogs(nodeId: string, jobId: string, offset: number = 0): Promise<any> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);

    const job = data.jobs.find(j => j.id === jobId || j.name === jobId);
    if (!job) {
      throw new Error(`Job "${jobId}" not found on node "${canonicalId}"`);
    }

    const latestExec = data.executions.find(e => e.jobId === job.id);
    if (!latestExec) {
      return {
        success: true,
        taskId: null,
        stdout: '',
        stderr: '',
        output: '',
        offset: 0,
        status: 'not_run',
        message: 'No execution records found for this job yet',
      };
    }

    // Attempt to query live task output from taskManager via agent cmdRpc
    try {
      const res = await terminalHostManager.executeCmdRpc(canonicalId, {
        action: 'status',
        taskId: latestExec.executionId,
        offset,
      });
      if (res && res.success) {
        return res.data || res;
      }
    } catch {}

    // Fallback to cached summary
    return {
      success: true,
      taskId: latestExec.executionId,
      stdout: '',
      stderr: latestExec.error || '',
      output: latestExec.error || '',
      offset: 0,
      status: latestExec.status,
      exitCode: latestExec.exitCode,
      durationMs: latestExec.durationMs,
    };
  }
}

export const terminalCronService = new TerminalCronService();
