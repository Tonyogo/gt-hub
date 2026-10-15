export type CronConcurrencyPolicy = 'forbid' | 'allow';
export type CronJobStatus = 'active' | 'paused';
export type CronScriptSource = 'hub' | 'command';

export interface CronJobConfig {
  id: string;
  name: string;
  cron: string;
  source: CronScriptSource;
  command?: string;
  scriptName?: string;
  scriptArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  concurrency: CronConcurrencyPolicy;
  status: CronJobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CronExecutionRecord {
  executionId: string;
  jobId: string;
  jobName: string;
  triggerTime: number;
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'timeout';
  exitCode: number | null;
  error?: string | null;
  durationMs?: number;
}

export interface CronJobSummary extends CronJobConfig {
  nextRunTime: number | null;
  lastExecution?: CronExecutionRecord | null;
}

export type CronJobItem = CronJobSummary;

export interface CronFormData {
  name: string;
  cron: string;
  source: CronScriptSource;
  command?: string;
  scriptName?: string;
  scriptArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  concurrency: CronConcurrencyPolicy;
}

export interface ScriptOption {
  name: string;
  title?: string;
  description?: string;
  interpreter?: string;
}

export interface CronExecutionLogResponse {
  success: boolean;
  taskId: string | null;
  stdout?: string;
  stderr?: string;
  output?: string;
  offset?: number;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  message?: string;
}
