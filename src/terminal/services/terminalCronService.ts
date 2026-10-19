import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CronJobConfig, CronExecutionRecord, CronJobSummary } from '../../shared/types/cron';
import { getNextCronTime, isValidCronExpression, isValidTimezone } from '../../shared/utils/cronParser';
import { terminalHostManager } from './terminalHostManager';
import logger from '../../utils/logger';
import config from '../../server/config/default';

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

  public resolveCanonicalNodeId(nodeId: string): string {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('Node ID is required');
    }
    const trimmed = nodeId.trim();
    if (!trimmed) {
      throw new Error('Node ID cannot be empty');
    }
    const resolved = terminalHostManager.resolveCanonicalHostId(trimmed);
    const candidate = (resolved || trimmed).trim();

    if (
      candidate === '.' ||
      candidate === '..' ||
      candidate.includes('..') ||
      candidate.includes('/') ||
      candidate.includes('\\') ||
      !/^[a-zA-Z0-9_\-\.]+$/.test(candidate)
    ) {
      throw new Error(`Invalid node ID: "${nodeId}"`);
    }
    return candidate;
  }

  private getNodeFilePath(nodeId: string): string {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const resolvedDir = path.resolve(this.storageDir);
    const filePath = path.resolve(resolvedDir, `${canonicalId}.json`);
    if (!filePath.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Path traversal detected for node ID: "${nodeId}"`);
    }
    return filePath;
  }

  private loadNodeData(nodeId: string): NodeCronData {
    this.ensureDir();
    const filePath = this.getNodeFilePath(nodeId);
    const canonicalId = this.resolveCanonicalNodeId(nodeId);

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        let migrated = false;
        if (parsed.timezone !== config.timeZone) {
          migrated = true;
        }
        const jobs: CronJobConfig[] = Array.isArray(parsed.jobs)
          ? parsed.jobs.map((job: any) => {
              if (job.timezone !== config.timeZone) {
                migrated = true;
              }
              return {
                ...job,
                timezone: config.timeZone,
              };
            })
          : [];

        const data: NodeCronData = {
          nodeId: parsed.nodeId || canonicalId,
          timezone: config.timeZone,
          jobs,
          executions: Array.isArray(parsed.executions) ? parsed.executions : [],
        };
        if (migrated) {
          this.saveNodeData(canonicalId, data);
        }
        return data;
      } catch {
        // Corrupted file, fallback
      }
    }

    return {
      nodeId: canonicalId,
      timezone: config.timeZone,
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
        ws.send(`JSON:${JSON.stringify({ type: 'cron_sync', jobs: jobList, serverTimezone: config.timeZone })}`);
      } catch (err: any) {
        logger.warn(`[TerminalCronService] Failed to push cron_sync to ${canonicalId}: ${err.message}`);
      }
    }
  }

  public syncOnConnect(nodeId: string): void {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const filePath = this.getNodeFilePath(canonicalId);
    if (fs.existsSync(filePath)) {
      const data = this.loadNodeData(canonicalId);
      if (data.jobs) {
        this.syncToAgent(canonicalId, data.jobs);
      }
    } else {
      this.saveNodeData(canonicalId, {
        nodeId: canonicalId,
        timezone: config.timeZone,
        jobs: [],
        executions: [],
      });
    }
  }

  public getNodeTimezone(_nodeId?: string): string {
    return config.timeZone;
  }

  public async getJobs(nodeId: string): Promise<CronJobSummary[]> {
    const canonicalId = this.resolveCanonicalNodeId(nodeId);
    const data = this.loadNodeData(canonicalId);

    return data.jobs.map((job) => {
      let nextRunTime: number | null = null;
      if (job.status === 'active') {
        try {
          nextRunTime = getNextCronTime(job.cron, undefined, config.timeZone).getTime();
        } catch {
          nextRunTime = null;
        }
      }

      const lastExecution = data.executions.find(e => e.jobId === job.id) || null;

      return {
        ...job,
        timezone: config.timeZone,
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

    const source = jobData.source || (jobData.scriptName ? 'hub' : 'command');
    if (source === 'command' && (!jobData.command || typeof jobData.command !== 'string' || !jobData.command.trim())) {
      throw new Error('Command is required when source is "command"');
    }
    if (source === 'hub' && (!jobData.scriptName || typeof jobData.scriptName !== 'string' || !jobData.scriptName.trim())) {
      throw new Error('scriptName is required when source is "hub"');
    }

    const data = this.loadNodeData(canonicalId);

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
      timezone: config.timeZone,
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
    }
    job.timezone = config.timeZone;

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
      throw new Error(`Failed to send trigger to agent: ${err.message}`, { cause: err });
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
