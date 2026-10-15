import fs from 'fs';
import path from 'path';
import os from 'os';
import { CronJobConfig, CronExecutionRecord, CronJobSummary } from '../../shared/types/cron';
import { getNextCronTime, isValidCronExpression } from '../../shared/utils/cronParser';
import { taskManager } from '../tasks/taskManager';

export interface AgentCronSchedulerOptions {
  storageFile?: string;
  historyFile?: string;
  cacheDir?: string;
  getScriptContent?: (name: string) => Promise<string>;
}

function quoteShellArg(arg: string): string {
  if (/^[a-zA-Z0-9_\-\.\/=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function getDefaultConfigDir(): string {
  return path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt');
}

export class AgentCronScheduler {
  private storageFile: string;
  private historyFile: string;
  private cacheDir: string;
  private getScriptContent?: (name: string) => Promise<string>;

  private jobs: Map<string, CronJobConfig> = new Map();
  private activeTimers: Map<string, NodeJS.Timeout> = new Map();
  private history: CronExecutionRecord[] = [];
  private runningExecutions: Map<string, string> = new Map(); // jobId -> executionId
  private reportCallbacks: ((record: CronExecutionRecord) => void)[] = [];
  private started: boolean = false;
  private readonly MAX_HISTORY = 100;

  constructor(options?: AgentCronSchedulerOptions) {
    const baseDir = getDefaultConfigDir();
    this.storageFile = options?.storageFile || path.join(baseDir, 'cron.json');
    this.historyFile = options?.historyFile || path.join(path.dirname(this.storageFile), 'schedule', 'history.json');
    this.cacheDir = options?.cacheDir || path.join(baseDir, 'scripts', 'cache');
    this.getScriptContent = options?.getScriptContent;

    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (fs.existsSync(this.storageFile)) {
      try {
        const raw = fs.readFileSync(this.storageFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const job of parsed) {
            if (job && job.id && isValidCronExpression(job.cron)) {
              this.jobs.set(job.id, job);
            }
          }
        }
      } catch (err: any) {
        // Ignore JSON read error, use empty
      }
    }

    if (fs.existsSync(this.historyFile)) {
      try {
        const raw = fs.readFileSync(this.historyFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.history = parsed.slice(-this.MAX_HISTORY);
        }
      } catch {}
    }
  }

  private saveJobsToDisk(): void {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const data = JSON.stringify(Array.from(this.jobs.values()), null, 2);
      fs.writeFileSync(this.storageFile, data, { encoding: 'utf-8', mode: 0o600 });
    } catch {}
  }

  private saveHistoryToDisk(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const data = JSON.stringify(this.history, null, 2);
      fs.writeFileSync(this.historyFile, data, { encoding: 'utf-8', mode: 0o600 });
    } catch {}
  }

  private addHistoryRecord(record: CronExecutionRecord): void {
    this.history.unshift(record);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(0, this.MAX_HISTORY);
    }
    this.saveHistoryToDisk();
  }

  private emitReport(record: CronExecutionRecord): void {
    for (const cb of this.reportCallbacks) {
      try {
        cb(record);
      } catch {}
    }
  }

  public onReport(callback: (record: CronExecutionRecord) => void): void {
    this.reportCallbacks.push(callback);
  }

  public start(): void {
    this.started = true;
    for (const job of this.jobs.values()) {
      if (job.status === 'active') {
        this.scheduleJob(job.id);
      }
    }
  }

  public stop(): void {
    this.started = false;
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  public syncJobs(jobs: CronJobConfig[]): void {
    // Clear all existing timers
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();

    this.jobs.clear();
    for (const job of jobs) {
      if (job && job.id && isValidCronExpression(job.cron)) {
        this.jobs.set(job.id, job);
      }
    }

    this.saveJobsToDisk();

    if (this.started) {
      for (const job of this.jobs.values()) {
        if (job.status === 'active') {
          this.scheduleJob(job.id);
        }
      }
    }
  }

  public getJobs(): CronJobConfig[] {
    return Array.from(this.jobs.values());
  }

  public getSummaries(): CronJobSummary[] {
    const list: CronJobSummary[] = [];
    for (const job of this.jobs.values()) {
      let nextRunTime: number | null = null;
      if (job.status === 'active') {
        try {
          nextRunTime = getNextCronTime(job.cron, undefined, job.timezone).getTime();
        } catch {
          nextRunTime = null;
        }
      }

      const lastExecution = this.history.find(h => h.jobId === job.id) || null;

      list.push({
        ...job,
        nextRunTime,
        lastExecution,
      });
    }
    return list;
  }

  public getExecutionHistory(jobId?: string, limit: number = 20): CronExecutionRecord[] {
    let list = this.history;
    if (jobId) {
      list = list.filter(h => h.jobId === jobId);
    }
    return list.slice(0, limit);
  }

  private scheduleJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'active') return;

    if (this.activeTimers.has(jobId)) {
      clearTimeout(this.activeTimers.get(jobId)!);
      this.activeTimers.delete(jobId);
    }

    let nextDate: Date;
    try {
      nextDate = getNextCronTime(job.cron, undefined, job.timezone);
    } catch {
      return;
    }

    const now = Date.now();
    const delay = Math.max(0, nextDate.getTime() - now);

    // Node.js setTimeout max limit is 2^31 - 1 (~24.8 days)
    const MAX_TIMEOUT = 2147483647;
    const timeoutDuration = Math.min(delay, MAX_TIMEOUT);

    const timer = setTimeout(async () => {
      this.activeTimers.delete(jobId);
      // If we haven't reached the target time yet (due to MAX_TIMEOUT capping), reschedule
      if (Date.now() < nextDate.getTime() - 1000) {
        if (this.started) {
          this.scheduleJob(jobId);
        }
        return;
      }

      try {
        await this.executeJob(jobId, 'scheduled', nextDate.getTime());
      } catch {}

      if (this.started && this.jobs.has(jobId) && this.jobs.get(jobId)!.status === 'active') {
        this.scheduleJob(jobId);
      }
    }, timeoutDuration);

    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.activeTimers.set(jobId, timer);
  }

  public async triggerJob(jobId: string): Promise<CronExecutionRecord> {
    return this.executeJob(jobId, 'manual');
  }

  private async executeJob(
    jobId: string,
    mode: 'scheduled' | 'manual',
    triggerTime?: number
  ): Promise<CronExecutionRecord> {
    const job = this.jobs.get(jobId);
    const now = Date.now();
    const planTriggerTime = triggerTime || now;

    if (!job) {
      const notFoundRecord: CronExecutionRecord = {
        executionId: `cron_${jobId}_${now}`,
        jobId,
        jobName: jobId,
        triggerTime: planTriggerTime,
        startTime: now,
        endTime: now,
        status: 'failed',
        exitCode: 1,
        error: `Job "${jobId}" not found`,
        durationMs: 0,
      };
      this.addHistoryRecord(notFoundRecord);
      this.emitReport(notFoundRecord);
      return notFoundRecord;
    }

    if (mode === 'scheduled' && job.status === 'paused') {
      const pausedRecord: CronExecutionRecord = {
        executionId: `cron_${job.id}_${now}`,
        jobId: job.id,
        jobName: job.name,
        triggerTime: planTriggerTime,
        startTime: now,
        endTime: now,
        status: 'skipped',
        exitCode: null,
        error: `Skipped: job "${job.name}" is paused`,
        durationMs: 0,
      };
      return pausedRecord;
    }

    // Check concurrency overlap protection
    if (job.concurrency === 'forbid' && this.runningExecutions.has(job.id)) {
      const activeExecId = this.runningExecutions.get(job.id)!;
      const existingTask = taskManager.getTask(activeExecId);
      if (existingTask && existingTask.status === 'running') {
        const skippedRecord: CronExecutionRecord = {
          executionId: `cron_${job.id}_${now}`,
          jobId: job.id,
          jobName: job.name,
          triggerTime: planTriggerTime,
          startTime: now,
          endTime: now,
          status: 'skipped',
          exitCode: null,
          error: `Skipped: previous execution ${activeExecId} is still running`,
          durationMs: 0,
        };
        this.addHistoryRecord(skippedRecord);
        this.emitReport(skippedRecord);
        return skippedRecord;
      }
    }

    const executionId = `cron_${job.id}_${now}`;
    this.runningExecutions.set(job.id, executionId);

    let commandToRun = '';

    if (job.source === 'hub') {
      const scriptName = job.scriptName;
      if (!scriptName) {
        const errRecord: CronExecutionRecord = {
          executionId,
          jobId: job.id,
          jobName: job.name,
          triggerTime: planTriggerTime,
          startTime: now,
          endTime: now,
          status: 'failed',
          exitCode: 1,
          error: 'Hub script source specified but scriptName is missing',
          durationMs: 0,
        };
        this.runningExecutions.delete(job.id);
        this.addHistoryRecord(errRecord);
        this.emitReport(errRecord);
        return errRecord;
      }

      const scriptPath = path.join(this.cacheDir, scriptName);
      if (!fs.existsSync(scriptPath)) {
        if (this.getScriptContent) {
          try {
            const content = await this.getScriptContent(scriptName);
            const dir = path.dirname(scriptPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            }
            fs.writeFileSync(scriptPath, content, { encoding: 'utf-8', mode: 0o755 });
            if (os.platform() !== 'win32') {
              try { fs.chmodSync(scriptPath, 0o755); } catch {}
            }
          } catch (err: any) {
            const errRecord: CronExecutionRecord = {
              executionId,
              jobId: job.id,
              jobName: job.name,
              triggerTime: planTriggerTime,
              startTime: now,
              endTime: now,
              status: 'failed',
              exitCode: 1,
              error: `Failed to fetch hub script "${scriptName}": ${err.message}`,
              durationMs: 0,
            };
            this.runningExecutions.delete(job.id);
            this.addHistoryRecord(errRecord);
            this.emitReport(errRecord);
            return errRecord;
          }
        } else {
          const errRecord: CronExecutionRecord = {
            executionId,
            jobId: job.id,
            jobName: job.name,
            triggerTime: planTriggerTime,
            startTime: now,
            endTime: now,
            status: 'failed',
            exitCode: 1,
            error: `Script "${scriptName}" not found in local cache`,
            durationMs: 0,
          };
          this.runningExecutions.delete(job.id);
          this.addHistoryRecord(errRecord);
          this.emitReport(errRecord);
          return errRecord;
        }
      }

      const argsStr = (job.scriptArgs || []).map(a => quoteShellArg(a)).join(' ');
      commandToRun = argsStr ? `"${scriptPath}" ${argsStr}` : `"${scriptPath}"`;
    } else {
      commandToRun = job.command || '';
      if (!commandToRun.trim()) {
        const errRecord: CronExecutionRecord = {
          executionId,
          jobId: job.id,
          jobName: job.name,
          triggerTime: planTriggerTime,
          startTime: now,
          endTime: now,
          status: 'failed',
          exitCode: 1,
          error: 'No command specified for cron job',
          durationMs: 0,
        };
        this.runningExecutions.delete(job.id);
        this.addHistoryRecord(errRecord);
        this.emitReport(errRecord);
        return errRecord;
      }
    }

    const startRes = taskManager.startTask({
      taskId: executionId,
      command: commandToRun,
      cwd: job.cwd,
      timeoutMs: job.timeoutMs || 0,
      env: job.env,
    });

    if (!startRes.success) {
      const errRecord: CronExecutionRecord = {
        executionId,
        jobId: job.id,
        jobName: job.name,
        triggerTime: planTriggerTime,
        startTime: now,
        endTime: now,
        status: 'failed',
        exitCode: 1,
        error: startRes.error || 'Failed to spawn task process',
        durationMs: 0,
      };
      this.runningExecutions.delete(job.id);
      this.addHistoryRecord(errRecord);
      this.emitReport(errRecord);
      return errRecord;
    }

    return new Promise<CronExecutionRecord>((resolve) => {
      const taskRecord = taskManager.tasks.get(executionId);

      const onFinished = () => {
        this.runningExecutions.delete(job.id);
        const taskInfo = taskManager.getTask(executionId);
        let status: 'completed' | 'failed' | 'timeout' = 'completed';

        if (taskInfo.status === 'timeout') {
          status = 'timeout';
        } else if (taskInfo.status === 'failed' || (taskInfo.exitCode !== null && taskInfo.exitCode !== 0)) {
          status = 'failed';
        } else if (taskInfo.status === 'completed') {
          status = 'completed';
        } else {
          status = 'failed';
        }

        const record: CronExecutionRecord = {
          executionId,
          jobId: job.id,
          jobName: job.name,
          triggerTime: planTriggerTime,
          startTime: taskInfo.startTime || now,
          endTime: taskInfo.endTime || Date.now(),
          status,
          exitCode: taskInfo.exitCode !== undefined ? taskInfo.exitCode : null,
          error: status === 'completed' ? null : (taskInfo.stderr ? taskInfo.stderr.trim() : null),
          durationMs: taskInfo.durationMs,
        };

        this.addHistoryRecord(record);
        this.emitReport(record);
        resolve(record);
      };

      if (taskRecord && taskRecord.child) {
        taskRecord.child.on('close', onFinished);
        taskRecord.child.on('error', onFinished);
      } else {
        onFinished();
      }
    });
  }
}
