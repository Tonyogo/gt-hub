export type TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed';

export interface TaskSummary {
  taskId: string;
  command: string;
  status: TaskStatus;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  signal: string | null;
  error?: string | null;
  pid?: number;
  cwd?: string;
}

export interface StartTaskOptions {
  taskId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string | null;
}

export interface TaskProcessRecord {
  taskId: string;
  command: string;
  status: TaskStatus;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  signal: string | null;
  outputBuffer: string[];
  totalOutputBytes: number;
  process: any;
  listeners: Set<(chunk: string) => void>;
  exitListeners: Set<(code: number | null, signal: string | null) => void>;
  timer: any;
}
