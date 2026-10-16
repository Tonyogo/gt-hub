export type TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed';

export interface TaskSummary {
  taskId: string;
  command: string;
  cwd?: string;
  status: TaskStatus;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  signal: string | null;
  error?: string | null;
  pid?: number;
}

export interface TaskLogResponse {
  success: boolean;
  taskId: string;
  status: TaskStatus;
  exitCode: number | null;
  signal: string | null;
  output: string;
  offset: number;
  totalBytes?: number;
  error?: string;
}

export interface CreateTaskInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}
