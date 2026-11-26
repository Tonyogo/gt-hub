import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';

export function getDefaultShell(options: { shell?: string } = {}): string {
  if (options.shell) return options.shell;
  if (os.platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  if (fs.existsSync('/usr/bin/bash')) return '/usr/bin/bash';
  if (fs.existsSync('/bin/sh')) return '/bin/sh';
  return '/bin/sh';
}

export function resolveWorkingDir(cwd?: string | null): string {
  const defaultDir = os.homedir() || process.env.HOME || process.cwd();
  if (!cwd || typeof cwd !== 'string') return defaultDir;
  let trimmed = cwd.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return defaultDir;
  const home = os.homedir() || process.env.HOME || defaultDir;
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(path.join(home, trimmed.slice(2)));
  }
  return path.resolve(trimmed);
}

export function killProcessTree(child: ChildProcess | number | null | undefined, signal: string | number = 'SIGTERM'): void {
  if (!child) return;
  const pid = typeof child === 'number' ? child : child.pid;
  if (!pid) return;
  const isWindows = os.platform() === 'win32';
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal as any);
    }
  } catch (e) {
    if (child && typeof (child as ChildProcess).kill === 'function') {
      try { (child as ChildProcess).kill(signal as any); } catch {}
    } else {
      try { process.kill(pid, signal as any); } catch {}
    }
  }
}

export function killProcessTreeSync(pid: number | null | undefined, signal: string | number = 'SIGTERM'): void {
  if (!pid) return;
  const isWindows = os.platform() === 'win32';
  try {
    if (isWindows) {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal as any);
    }
  } catch (e) {
    try { process.kill(pid, signal as any); } catch {}
  }
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

export function sliceBufferUtf8Safe(buf: Buffer, startOffset: number): string {
  let idx = Math.max(0, Math.min(startOffset, buf.length));
  // In UTF-8, continuation bytes match 10xxxxxx (0x80 to 0xBF)
  while (idx < buf.length && (buf[idx] & 0b11000000) === 0b10000000) {
    idx++;
  }
  return buf.subarray(idx).toString('utf-8');
}

export function resolveUtf8Locale(env?: Record<string, any>): string {
  const candidate = env?.LANG || env?.LC_ALL || process.env.LANG || process.env.LC_ALL || '';
  if (typeof candidate === 'string' && /utf-?8/i.test(candidate)) {
    return candidate;
  }
  return os.platform() === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8';
}

export interface TaskChunk {
  type: 'stdout' | 'stderr';
  text: string;
  bytes?: number;
  startOffset: number;
  endOffset: number;
}

export interface TaskFinishedEvent {
  taskId: string;
  command: string;
  cwd: string;
  status: 'completed' | 'failed' | 'timeout' | 'killed';
  exitCode: number | null;
  startTime: number;
  endTime: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string;
  totalBytes: number;
}

export interface TaskRecord {
  taskId: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  stdout: string;
  stderr: string;
  output: string;
  totalBytes: number;
  chunks: TaskChunk[];
  child: ChildProcess | null;
  pid: number | null;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  notifiedFinish?: boolean;
  onFinishCallbacks?: Array<(event: TaskFinishedEvent) => void>;
}

export interface TaskManagerOptions {
  storageDir?: string;
  persist?: boolean;
}

interface TaskLogState {
  pendingChunks: string[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  writeChain: Promise<void>;
  handle: fs.promises.FileHandle | null;
  writtenBytes: number;
  initialized: boolean;
  disposed?: boolean;
}

interface FinishOutputConfig {
  includeOutput: boolean;
  maxOutputBytes?: number;
}

const CHUNK_COALESCE_MAX_BYTES = 32 * 1024;
const LOG_FLUSH_BATCH_BYTES = 64 * 1024;
const LOG_FLUSH_DELAY_MS = 50;

export class TaskManager {
  public tasks: Map<string, TaskRecord>;
  public MAX_TASKS: number;
  public MAX_BUFFER_SIZE: number;
  public TASK_TTL_MS: number;
  public storageDir: string | null = null;
  private reconcileTimers: Map<string, NodeJS.Timeout> = new Map();
  private finishListeners: Set<(event: TaskFinishedEvent) => void> = new Set();
  private chunkHeads: WeakMap<TaskRecord, number> = new WeakMap();
  private finishOutputConfigs: WeakMap<TaskRecord, FinishOutputConfig> = new WeakMap();
  private logStates: Map<string, TaskLogState> = new Map();
  private saveChain: Promise<void> = Promise.resolve();
  private saveRequested = false;
  private saveInFlight = false;
  private logDirEnsured = false;

  public onTaskFinished(listener: (event: TaskFinishedEvent) => void): () => void {
    this.finishListeners.add(listener);
    return () => {
      this.finishListeners.delete(listener);
    };
  }

  private extractOutputFromChunks(
    record: TaskRecord,
    maxBytes?: number
  ): { stdout: string; stderr: string; output: string } {
    const head = this.chunkHeads.get(record) ?? 0;
    const chunks = record.chunks;
    if (!chunks || chunks.length <= head) {
      if (record.stdout || record.stderr || record.output) {
        if (maxBytes === undefined) {
          return { stdout: record.stdout, stderr: record.stderr, output: record.output };
        }
        return {
          stdout: this.sliceStringTailUtf8(record.stdout, maxBytes),
          stderr: this.sliceStringTailUtf8(record.stderr, maxBytes),
          output: this.sliceStringTailUtf8(record.output, maxBytes),
        };
      }
      return { stdout: '', stderr: '', output: '' };
    }

    if (maxBytes === undefined) {
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      const outputParts: string[] = [];
      for (let i = head; i < chunks.length; i++) {
        const chunk = chunks[i];
        outputParts.push(chunk.text);
        if (chunk.type === 'stdout') {
          stdoutParts.push(chunk.text);
        } else {
          stderrParts.push(chunk.text);
        }
      }
      return {
        stdout: stdoutParts.join(''),
        stderr: stderrParts.join(''),
        output: outputParts.join(''),
      };
    }

    let stdoutBudget = Math.max(0, maxBytes);
    let stderrBudget = Math.max(0, maxBytes);
    let outputBudget = Math.max(0, maxBytes);
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    const outputParts: string[] = [];

    for (let i = chunks.length - 1; i >= head; i--) {
      if (stdoutBudget <= 0 && stderrBudget <= 0 && outputBudget <= 0) {
        break;
      }
      const chunk = chunks[i];
      const chunkBytes = chunk.bytes ?? Buffer.byteLength(chunk.text, 'utf-8');

      if (outputBudget > 0) {
        if (chunkBytes <= outputBudget) {
          outputParts.push(chunk.text);
          outputBudget -= chunkBytes;
        } else {
          outputParts.push(this.sliceStringTailUtf8(chunk.text, outputBudget));
          outputBudget = 0;
        }
      }

      if (chunk.type === 'stdout' && stdoutBudget > 0) {
        if (chunkBytes <= stdoutBudget) {
          stdoutParts.push(chunk.text);
          stdoutBudget -= chunkBytes;
        } else {
          stdoutParts.push(this.sliceStringTailUtf8(chunk.text, stdoutBudget));
          stdoutBudget = 0;
        }
      } else if (chunk.type === 'stderr' && stderrBudget > 0) {
        if (chunkBytes <= stderrBudget) {
          stderrParts.push(chunk.text);
          stderrBudget -= chunkBytes;
        } else {
          stderrParts.push(this.sliceStringTailUtf8(chunk.text, stderrBudget));
          stderrBudget = 0;
        }
      }
    }

    stdoutParts.reverse();
    stderrParts.reverse();
    outputParts.reverse();
    return {
      stdout: stdoutParts.join(''),
      stderr: stderrParts.join(''),
      output: outputParts.join(''),
    };
  }

  private sliceStringTailUtf8(text: string, maxBytes: number): string {
    if (!text || maxBytes <= 0) return '';
    const buf = Buffer.from(text, 'utf-8');
    if (buf.length <= maxBytes) return text;
    return sliceBufferUtf8Safe(buf, buf.length - maxBytes);
  }

  private emitTaskFinished(record: TaskRecord): void {
    if (record.notifiedFinish || record.status === 'running') return;
    record.notifiedFinish = true;
    const endTime = record.endTime || Date.now();
    record.endTime = endTime;

    const outputCfg = this.finishOutputConfigs.get(record);
    const includeForCallbacks = outputCfg ? outputCfg.includeOutput : true;
    const hasGlobalListeners = this.finishListeners.size > 0;
    const shouldExtract = includeForCallbacks || hasGlobalListeners;
    const maxBytes = hasGlobalListeners ? undefined : outputCfg?.maxOutputBytes;
    const extracted = shouldExtract
      ? this.extractOutputFromChunks(record, maxBytes)
      : { stdout: '', stderr: '', output: '' };

    const totalBytes =
      record.totalBytes !== undefined ? record.totalBytes : Buffer.byteLength(extracted.output || '', 'utf-8');

    const callbackEvent: TaskFinishedEvent = {
      taskId: record.taskId,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      startTime: record.startTime,
      endTime,
      durationMs: Math.max(0, endTime - record.startTime),
      stdout: includeForCallbacks ? extracted.stdout : '',
      stderr: includeForCallbacks ? extracted.stderr : '',
      output: includeForCallbacks ? extracted.output : '',
      totalBytes,
    };

    if (record.onFinishCallbacks && record.onFinishCallbacks.length > 0) {
      for (const cb of record.onFinishCallbacks) {
        try {
          cb(callbackEvent);
        } catch {}
      }
    }

    if (hasGlobalListeners) {
      const globalEvent: TaskFinishedEvent = includeForCallbacks
        ? callbackEvent
        : {
            ...callbackEvent,
            stdout: extracted.stdout,
            stderr: extracted.stderr,
            output: extracted.output,
          };
      for (const listener of this.finishListeners) {
        try {
          listener(globalEvent);
        } catch {}
      }
    }
  }

  constructor(options?: TaskManagerOptions) {
    this.tasks = new Map();
    this.MAX_TASKS = 100;
    this.MAX_BUFFER_SIZE = 5 * 1024 * 1024;
    this.TASK_TTL_MS = 24 * 60 * 60 * 1000;

    if (options?.storageDir || options?.persist) {
      this.storageDir =
        options.storageDir ||
        path.join(os.homedir() || process.env.HOME || process.cwd(), '.gt', 'tasks');
      const logDir = path.join(this.storageDir, 'logs');
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          this.logDirEnsured = true;
        } catch {}
      } else {
        this.logDirEnsured = true;
      }
      this.loadFromDisk();
    } else {
      this.storageDir = null;
    }
  }

  private getTasksJsonPath(): string | null {
    if (!this.storageDir) return null;
    return path.join(this.storageDir, 'tasks.json');
  }

  private getLogFilePath(taskId: string): string | null {
    if (!this.storageDir) return null;
    return path.join(this.storageDir, 'logs', `${taskId}.log`);
  }

  private buildTasksSnapshot(
    overrides?: Record<string, { status: TaskRecord['status']; exitCode: number | null; endTime: number | null }>
  ): string {
    const data = Array.from(this.tasks.values()).map((t) => {
      const ov = overrides?.[t.taskId];
      return {
        taskId: t.taskId,
        command: t.command,
        cwd: t.cwd,
        status: ov ? ov.status : t.status,
        exitCode: ov ? ov.exitCode : t.exitCode,
        startTime: t.startTime,
        endTime: ov ? ov.endTime : t.endTime,
        pid: t.pid,
        totalBytes: t.totalBytes,
      };
    });
    return JSON.stringify(data, null, 2);
  }

  private saveToDiskSync(): void {
    if (!this.storageDir) return;
    try {
      const jsonPath = this.getTasksJsonPath();
      if (!jsonPath) return;
      const serialized = this.buildTasksSnapshot();
      const tmpPath = `${jsonPath}.tmp`;
      fs.writeFileSync(tmpPath, serialized, 'utf-8');
      fs.renameSync(tmpPath, jsonPath);
    } catch {}
  }

  private saveToDiskAsync(
    overrides?: Record<string, { status: TaskRecord['status']; exitCode: number | null; endTime: number | null }>
  ): Promise<void> {
    if (!this.storageDir) return Promise.resolve();
    if (overrides) {
      const jsonPath = this.getTasksJsonPath();
      if (!jsonPath) return Promise.resolve();
      const serialized = this.buildTasksSnapshot(overrides);
      this.saveChain = this.saveChain.then(async () => {
        try {
          if (!this.logDirEnsured && this.storageDir) {
            await fs.promises.mkdir(path.join(this.storageDir, 'logs'), { recursive: true });
            this.logDirEnsured = true;
          }
          const tmpPath = `${jsonPath}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmpPath, serialized, 'utf-8');
          await fs.promises.rename(tmpPath, jsonPath);
        } catch {}
      });
      return this.saveChain;
    }

    this.saveRequested = true;
    if (!this.saveInFlight) {
      this.saveInFlight = true;
      this.saveChain = this.saveChain.then(async () => {
        try {
          while (this.saveRequested) {
            this.saveRequested = false;
            const jsonPath = this.getTasksJsonPath();
            if (!jsonPath) break;
            if (!this.logDirEnsured && this.storageDir) {
              await fs.promises.mkdir(path.join(this.storageDir, 'logs'), { recursive: true });
              this.logDirEnsured = true;
            }
            const serialized = this.buildTasksSnapshot();
            const tmpPath = `${jsonPath}.${process.pid}.tmp`;
            await fs.promises.writeFile(tmpPath, serialized, 'utf-8');
            await fs.promises.rename(tmpPath, jsonPath);
          }
        } catch {} finally {
          this.saveInFlight = false;
        }
      });
    }
    return this.saveChain;
  }

  private getOrCreateLogState(taskId: string): TaskLogState {
    let state = this.logStates.get(taskId);
    if (!state) {
      state = {
        pendingChunks: [],
        pendingBytes: 0,
        flushTimer: null,
        writeChain: Promise.resolve(),
        handle: null,
        writtenBytes: 0,
        initialized: false,
      };
      this.logStates.set(taskId, state);
    }
    return state;
  }

  private enqueueLogWrite(taskId: string, text: string): void {
    if (!this.storageDir || !text) return;
    const state = this.getOrCreateLogState(taskId);
    state.pendingChunks.push(text);
    state.pendingBytes += Buffer.byteLength(text, 'utf-8');

    if (state.pendingBytes >= LOG_FLUSH_BATCH_BYTES) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      void this.flushTaskLog(taskId, false);
      return;
    }

    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void this.flushTaskLog(taskId, false);
      }, LOG_FLUSH_DELAY_MS);
      if (typeof state.flushTimer.unref === 'function') {
        state.flushTimer.unref();
      }
    }
  }

  private async trimLogFileAsync(logPath: string, state: TaskLogState): Promise<void> {
    if (state.handle) {
      try {
        await state.handle.close();
      } catch {}
      state.handle = null;
    }

    let readHandle: fs.promises.FileHandle | null = null;
    try {
      readHandle = await fs.promises.open(logPath, 'r');
      const stat = await readHandle.stat();
      if (stat.size <= this.MAX_BUFFER_SIZE) {
        state.writtenBytes = stat.size;
        return;
      }
      const readPos = stat.size - this.MAX_BUFFER_SIZE;
      const buf = Buffer.allocUnsafe(this.MAX_BUFFER_SIZE);
      const { bytesRead } = await readHandle.read(buf, 0, this.MAX_BUFFER_SIZE, readPos);
      await readHandle.close();
      readHandle = null;

      let idx = 0;
      while (idx < bytesRead && (buf[idx] & 0b11000000) === 0b10000000) {
        idx++;
      }
      const trimmed = buf.subarray(idx, bytesRead);
      const tmpPath = `${logPath}.trim.tmp`;
      await fs.promises.writeFile(tmpPath, trimmed);
      await fs.promises.rename(tmpPath, logPath);
      state.writtenBytes = trimmed.length;
    } catch {
      if (readHandle) {
        try {
          await readHandle.close();
        } catch {}
      }
    }
  }

  private flushTaskLog(taskId: string, closeHandle: boolean = false): Promise<void> {
    if (!this.storageDir) return Promise.resolve();
    const state = this.logStates.get(taskId);
    if (!state) return Promise.resolve();

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    const batch = state.pendingChunks.length > 0 ? state.pendingChunks.splice(0).join('') : '';
    state.pendingBytes = 0;

    if (!batch && !closeHandle) {
      return state.writeChain;
    }

    state.writeChain = state.writeChain.then(async () => {
      const logPath = this.getLogFilePath(taskId);
      if (!logPath) return;

      try {
        if (batch && !state.disposed) {
          if (!this.logDirEnsured && this.storageDir) {
            await fs.promises.mkdir(path.join(this.storageDir, 'logs'), { recursive: true });
            this.logDirEnsured = true;
          }
          if (!state.handle) {
            state.handle = await fs.promises.open(logPath, 'a');
            if (!state.initialized) {
              const st = await state.handle.stat();
              state.writtenBytes = st.size;
              state.initialized = true;
            }
          }
          if (!state.disposed) {
            const buf = Buffer.from(batch, 'utf-8');
            await state.handle.write(buf, 0, buf.length);
            state.writtenBytes += buf.length;

            if (state.writtenBytes > this.MAX_BUFFER_SIZE * 1.5) {
              await this.trimLogFileAsync(logPath, state);
            }
          }
        }
      } catch {} finally {
        if ((closeHandle || state.disposed) && state.handle) {
          try {
            await state.handle.close();
          } catch {}
          state.handle = null;
        }
        if ((closeHandle || state.disposed) && state.pendingChunks.length === 0 && !state.handle) {
          this.logStates.delete(taskId);
        }
      }
    });

    return state.writeChain;
  }

  private disposeTaskLogState(taskId: string): void {
    const state = this.logStates.get(taskId);
    if (!state) return;
    state.disposed = true;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.pendingChunks.length = 0;
    state.pendingBytes = 0;
    if (state.handle) {
      const handle = state.handle;
      state.handle = null;
      void handle.close().catch(() => {});
    }
    this.logStates.delete(taskId);
  }

  private loadFromDisk(): void {
    if (!this.storageDir) return;
    const jsonPath = this.getTasksJsonPath();
    if (!jsonPath || !fs.existsSync(jsonPath)) return;

    let records: any[] = [];
    try {
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      records = JSON.parse(raw);
    } catch {
      return;
    }

    if (!Array.isArray(records)) return;

    let hasChanges = false;
    for (const item of records) {
      if (!item || !item.taskId) continue;
      const record: TaskRecord = {
        taskId: item.taskId,
        command: item.command || '',
        cwd: item.cwd || '',
        status: item.status || 'completed',
        exitCode: item.exitCode ?? null,
        startTime: item.startTime || Date.now(),
        endTime: item.endTime ?? null,
        stdout: '',
        stderr: '',
        output: '',
        totalBytes: item.totalBytes || 0,
        chunks: [],
        child: null,
        pid: item.pid ?? null,
        timeoutTimer: null,
        killTimer: null,
      };

      if (record.status === 'running') {
        if (isPidAlive(record.pid)) {
          this.watchRunningProcess(record);
        } else {
          record.status = 'completed';
          if (record.exitCode === null || record.exitCode === undefined) {
            record.exitCode = 0;
          }
          if (!record.endTime) {
            record.endTime = Date.now();
          }
          hasChanges = true;
        }
      }

      this.tasks.set(record.taskId, record);
    }

    if (hasChanges) {
      this.saveToDiskSync();
    }
  }

  private watchRunningProcess(record: TaskRecord): void {
    if (!record.pid) return;
    const pid = record.pid;
    const taskId = record.taskId;
    const timer = setInterval(() => {
      const alive = isPidAlive(pid);
      const logPath = this.getLogFilePath(taskId);
      if (logPath && fs.existsSync(logPath)) {
        try {
          const stat = fs.statSync(logPath);
          record.totalBytes = stat.size;
        } catch {}
      }
      if (!alive) {
        clearInterval(timer);
        this.reconcileTimers.delete(taskId);
        record.status = 'completed';
        if (record.exitCode === null || record.exitCode === undefined) {
          record.exitCode = 0;
        }
        record.endTime = Date.now();
        void this.saveToDiskAsync();
        this.emitTaskFinished(record);
      }
    }, 1500);
    if (timer.unref) timer.unref();
    this.reconcileTimers.set(taskId, timer);
  }

  pruneOldTasks(): void {
    const now = Date.now();
    const removedTaskIds: string[] = [];
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== 'running' && now - task.startTime > this.TASK_TTL_MS) {
        this.tasks.delete(taskId);
        this.disposeTaskLogState(taskId);
        removedTaskIds.push(taskId);
      }
    }
    if (this.tasks.size > this.MAX_TASKS) {
      const sorted = Array.from(this.tasks.entries())
        .filter(([, t]) => t.status !== 'running')
        .sort((a, b) => a[1].startTime - b[1].startTime);
      while (this.tasks.size > this.MAX_TASKS && sorted.length > 0) {
        const item = sorted.shift();
        if (item) {
          this.tasks.delete(item[0]);
          this.disposeTaskLogState(item[0]);
          removedTaskIds.push(item[0]);
        }
      }
    }

    if (removedTaskIds.length > 0 && this.storageDir) {
      for (const taskId of removedTaskIds) {
        const logPath = this.getLogFilePath(taskId);
        if (logPath) {
          void fs.promises.rm(logPath, { force: true }).catch(() => {});
        }
      }
      void this.saveToDiskAsync();
    }
  }

  startTask({
    taskId,
    command,
    cwd,
    timeoutMs = 300000,
    env = {},
    stdin = null,
    onFinish,
    includeFinishOutput = true,
    finishMaxOutputBytes,
  }: {
    taskId: string;
    command: string;
    cwd?: string | null;
    timeoutMs?: number;
    env?: Record<string, any>;
    stdin?: string | null;
    onFinish?: (event: TaskFinishedEvent) => void;
    includeFinishOutput?: boolean;
    finishMaxOutputBytes?: number;
  }): any {
    this.pruneOldTasks();

    if (this.tasks.has(taskId)) {
      const existing = this.tasks.get(taskId)!;
      if (onFinish) {
        if (existing.status === 'running') {
          if (!existing.onFinishCallbacks) {
            existing.onFinishCallbacks = [];
          }
          existing.onFinishCallbacks.push(onFinish);
          if (includeFinishOutput) {
            const prevCfg = this.finishOutputConfigs.get(existing);
            this.finishOutputConfigs.set(existing, {
              includeOutput: true,
              maxOutputBytes:
                prevCfg?.maxOutputBytes === undefined || finishMaxOutputBytes === undefined
                  ? undefined
                  : Math.max(prevCfg.maxOutputBytes, finishMaxOutputBytes),
            });
          }
        } else {
          let stdout = '';
          let stderr = '';
          let output = '';
          if (includeFinishOutput) {
            const extracted = this.extractOutputFromChunks(existing, finishMaxOutputBytes);
            stdout = extracted.stdout;
            stderr = extracted.stderr;
            output = extracted.output;
            if (!output && this.storageDir) {
              const logPath = this.getLogFilePath(existing.taskId);
              if (logPath && fs.existsSync(logPath)) {
                try {
                  output = fs.readFileSync(logPath, 'utf-8');
                  if (finishMaxOutputBytes !== undefined) {
                    output = this.sliceStringTailUtf8(output, finishMaxOutputBytes);
                  }
                  stdout = output;
                } catch {}
              }
            }
          }
          const endTime = existing.endTime || Date.now();
          const event: TaskFinishedEvent = {
            taskId: existing.taskId,
            command: existing.command,
            cwd: existing.cwd,
            status: existing.status as any,
            exitCode: existing.exitCode,
            startTime: existing.startTime,
            endTime,
            durationMs: Math.max(0, endTime - existing.startTime),
            stdout,
            stderr,
            output,
            totalBytes: existing.totalBytes !== undefined ? existing.totalBytes : Buffer.byteLength(output || '', 'utf-8'),
          };
          queueMicrotask(() => {
            try {
              onFinish(event);
            } catch {}
          });
        }
      }
      return { success: true, taskId, status: existing.status, startTime: existing.startTime };
    }

    let workingDir = resolveWorkingDir(cwd);
    if (cwd) {
      if (!fs.existsSync(workingDir)) {
        return {
          success: false,
          error: `Working directory does not exist: ${workingDir}`,
        };
      }
      try {
        const stat = fs.statSync(workingDir);
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: `Working directory is not a directory: ${workingDir}`,
          };
        }
      } catch (err: any) {
        return {
          success: false,
          error: `Cannot access working directory: ${err.message}`,
        };
      }
    } else {
      if (!fs.existsSync(workingDir)) {
        workingDir = process.cwd();
      }
    }

    const isWindows = os.platform() === 'win32';
    let shell = env && env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : getDefaultShell();
    if (!isWindows && !fs.existsSync(shell)) {
      if (fs.existsSync('/bin/bash')) shell = '/bin/bash';
      else if (fs.existsSync('/usr/bin/bash')) shell = '/usr/bin/bash';
      else if (fs.existsSync('/bin/sh')) shell = '/bin/sh';
    }
    const shellArgs = isWindows
      ? shell.toLowerCase().includes('powershell')
        ? ['-Command', command]
        : ['/c', command]
      : ['-c', command];

    const utf8Locale = resolveUtf8Locale(env);
    const taskEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: utf8Locale,
      LC_CTYPE: utf8Locale,
    };
    delete taskEnv.TMUX;
    delete taskEnv.TMUX_PANE;
    delete taskEnv.STY;
    delete taskEnv.WINDOW;
    delete taskEnv.TERM_SESSION_ID;

    let child: ChildProcess | null = null;
    try {
      child = spawn(shell, shellArgs, {
        cwd: workingDir,
        env: taskEnv,
        stdio: [stdin !== null && stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: !isWindows,
      });
      if (child.stdin && stdin !== null && stdin !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.write(stdin);
        child.stdin.end();
      }
    } catch (err: any) {
      return { success: false, error: `Failed to spawn process: ${err.message}` };
    }

    const taskRecord: TaskRecord = {
      taskId,
      command,
      cwd: workingDir,
      status: 'running',
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      stdout: '',
      stderr: '',
      output: '',
      totalBytes: 0,
      chunks: [],
      child,
      pid: child ? child.pid || null : null,
      timeoutTimer: null,
      killTimer: null,
      notifiedFinish: false,
      onFinishCallbacks: onFinish ? [onFinish] : [],
    };

    this.finishOutputConfigs.set(taskRecord, {
      includeOutput: includeFinishOutput,
      maxOutputBytes: finishMaxOutputBytes,
    });
    this.chunkHeads.set(taskRecord, 0);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const appendDecodedText = (type: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      const bytes = Buffer.byteLength(text, 'utf-8');
      const startOffset = taskRecord.totalBytes;
      const endOffset = startOffset + bytes;
      taskRecord.totalBytes = endOffset;

      let keptText = text;
      let keptBytes = bytes;
      let chunkStartOffset = startOffset;
      if (bytes > this.MAX_BUFFER_SIZE) {
        keptText = this.sliceStringTailUtf8(text, this.MAX_BUFFER_SIZE);
        keptBytes = Buffer.byteLength(keptText, 'utf-8');
        chunkStartOffset = endOffset - keptBytes;
      }

      let head = this.chunkHeads.get(taskRecord) ?? 0;
      const len = taskRecord.chunks.length;
      const last = len > head ? taskRecord.chunks[len - 1] : null;
      if (last && last.type === type) {
        const lastBytes = last.bytes ?? Buffer.byteLength(last.text, 'utf-8');
        if (lastBytes + keptBytes <= CHUNK_COALESCE_MAX_BYTES) {
          last.text += keptText;
          last.bytes = lastBytes + keptBytes;
          last.endOffset = endOffset;
        } else {
          taskRecord.chunks.push({ type, text: keptText, bytes: keptBytes, startOffset: chunkStartOffset, endOffset });
        }
      } else {
        taskRecord.chunks.push({ type, text: keptText, bytes: keptBytes, startOffset: chunkStartOffset, endOffset });
      }

      while (
        taskRecord.chunks.length - head > 1 &&
        taskRecord.totalBytes - taskRecord.chunks[head].startOffset > this.MAX_BUFFER_SIZE
      ) {
        head++;
      }
      if (head >= 128 && head * 2 >= taskRecord.chunks.length) {
        taskRecord.chunks = taskRecord.chunks.slice(head);
        head = 0;
      }
      this.chunkHeads.set(taskRecord, head);

      if (this.storageDir) {
        this.enqueueLogWrite(taskRecord.taskId, text);
      }
    };

    const appendChunk = (type: 'stdout' | 'stderr', chunk: any) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
      const text = type === 'stdout' ? stdoutDecoder.write(buf) : stderrDecoder.write(buf);
      appendDecodedText(type, text);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => appendChunk('stdout', chunk));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => appendChunk('stderr', chunk));
    }

    child.on('error', (err: any) => {
      let extra = '';
      if (err.code === 'ENOENT') {
        if (!fs.existsSync(workingDir)) {
          extra = ` (working directory "${workingDir}" not found)`;
        } else if (!fs.existsSync(shell)) {
          extra = ` (shell executable "${shell}" not found)`;
        }
      }
      appendChunk('stderr', Buffer.from(`\nProcess execution error: ${err.message}${extra}\n`));
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
      const endTime = Date.now();
      const willEmit = !taskRecord.child?.pid;

      taskRecord.status = 'failed';
      taskRecord.endTime = endTime;

      if (this.storageDir) {
        void (async () => {
          await this.flushTaskLog(taskId, willEmit);
          await this.saveToDiskAsync({
            [taskId]: { status: 'failed', exitCode: taskRecord.exitCode, endTime },
          });
          if (willEmit) {
            this.emitTaskFinished(taskRecord);
          }
        })();
      } else {
        if (willEmit) {
          this.emitTaskFinished(taskRecord);
        }
      }
    });

    child.on('close', (code, signal) => {
      appendDecodedText('stdout', stdoutDecoder.end());
      appendDecodedText('stderr', stderrDecoder.end());
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
      if (taskRecord.killTimer) clearTimeout(taskRecord.killTimer);
      const endTime = Date.now();
      taskRecord.child = null;

      const head = this.chunkHeads.get(taskRecord) ?? 0;
      if (head > 0) {
        taskRecord.chunks = taskRecord.chunks.slice(head);
        this.chunkHeads.set(taskRecord, 0);
      }

      let finalStatus = taskRecord.status;
      let finalExitCode = taskRecord.exitCode;
      if (finalStatus === 'running') {
        if (signal) {
          finalStatus = 'killed';
        } else {
          finalExitCode = code;
          finalStatus = code === 0 ? 'completed' : 'failed';
        }
      }

      taskRecord.endTime = endTime;
      taskRecord.exitCode = finalExitCode;
      taskRecord.status = finalStatus;

      if (this.storageDir) {
        void (async () => {
          await this.flushTaskLog(taskId, true);
          await this.saveToDiskAsync({
            [taskId]: { status: finalStatus, exitCode: finalExitCode, endTime },
          });
          this.emitTaskFinished(taskRecord);
        })();
      } else {
        this.emitTaskFinished(taskRecord);
      }
    });

    if (timeoutMs > 0) {
      taskRecord.timeoutTimer = setTimeout(() => {
        if (taskRecord.status === 'running' && taskRecord.child) {
          taskRecord.status = 'timeout';
          const timeoutMsg = `\n[Agent] Process timed out after ${timeoutMs}ms. Terminating...\n`;
          appendChunk('stderr', Buffer.from(timeoutMsg));
          killProcessTree(taskRecord.child, 'SIGTERM');
          if (taskRecord.killTimer) clearTimeout(taskRecord.killTimer);
          taskRecord.killTimer = setTimeout(() => {
            if (taskRecord.child) {
              killProcessTree(taskRecord.child, 'SIGKILL');
            }
          }, 1000);
          if ((taskRecord.killTimer as any).unref) (taskRecord.killTimer as any).unref();
          void this.saveToDiskAsync();
        }
      }, timeoutMs);
      if ((taskRecord.timeoutTimer as any).unref) (taskRecord.timeoutTimer as any).unref();
    }

    this.tasks.set(taskId, taskRecord);
    void this.saveToDiskAsync();

    return {
      success: true,
      taskId,
      status: 'running',
      command,
      cwd: workingDir,
      startTime: taskRecord.startTime,
    };
  }

  getTask(taskId: string, offset: number | string = 0): any {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `No such task: ${taskId}` };
    }

    const numOffset = Math.max(0, parseInt(String(offset), 10) || 0);
    let totalBytes =
      task.totalBytes !== undefined ? task.totalBytes : Buffer.byteLength(task.output, 'utf-8');

    let incStdout = '';
    let incStderr = '';
    let incOutput = '';

    const head = this.chunkHeads.get(task) ?? 0;
    if (task.chunks && task.chunks.length > head) {
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      const outputParts: string[] = [];

      for (let i = head; i < task.chunks.length; i++) {
        const chunk = task.chunks[i];
        if (chunk.endOffset <= numOffset) {
          continue;
        }
        let chunkText = chunk.text;
        if (chunk.startOffset < numOffset) {
          const byteSliceStart = numOffset - chunk.startOffset;
          const buf = Buffer.from(chunk.text, 'utf-8');
          chunkText = sliceBufferUtf8Safe(buf, byteSliceStart);
        }
        if (chunk.type === 'stdout') {
          stdoutParts.push(chunkText);
        } else if (chunk.type === 'stderr') {
          stderrParts.push(chunkText);
        }
        outputParts.push(chunkText);
      }

      incStdout = stdoutParts.join('');
      incStderr = stderrParts.join('');
      incOutput = outputParts.join('');
    } else {
      // Chunks empty - check log file on disk if persistence is enabled
      const logPath = this.getLogFilePath(taskId);
      if (logPath && fs.existsSync(logPath)) {
        try {
          const fd = fs.openSync(logPath, 'r');
          try {
            const stat = fs.fstatSync(fd);
            totalBytes = stat.size;
            task.totalBytes = totalBytes;
            if (numOffset < totalBytes) {
              const toRead = totalBytes - numOffset;
              const sliceBuf = Buffer.allocUnsafe(toRead);
              const bytesRead = fs.readSync(fd, sliceBuf, 0, toRead, numOffset);
              incOutput = sliceBufferUtf8Safe(sliceBuf.subarray(0, bytesRead), 0);
              incStdout = incOutput;
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      } else if (numOffset === 0) {
        incStdout = task.stdout;
        incStderr = task.stderr;
        incOutput = task.output;
      } else if (task.output) {
        const buf = Buffer.from(task.output, 'utf-8');
        incOutput = sliceBufferUtf8Safe(buf, numOffset);
        incStdout = incOutput;
      }
    }

    return {
      success: true,
      taskId: task.taskId,
      status: task.status,
      exitCode: task.exitCode,
      stdout: incStdout,
      stderr: incStderr,
      output: incOutput,
      offset: totalBytes,
      outputOffset: totalBytes,
      totalBytes,
      durationMs: (task.endTime || Date.now()) - task.startTime,
      startTime: task.startTime,
      endTime: task.endTime,
    };
  }

  _killChild(child: ChildProcess | number | null | undefined, signal: string | number = 'SIGTERM'): void {
    return killProcessTree(child, signal);
  }

  killTask(taskId: string, signal: string | number = 'SIGTERM'): any {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: `No such task: ${taskId}` };
    }
    if (task.status !== 'running' || !task.child) {
      return { success: true, taskId, status: task.status, message: 'Task is not running' };
    }

    task.status = 'killed';
    void this.saveToDiskAsync();
    killProcessTree(task.child, signal || 'SIGTERM');

    if (task.killTimer) clearTimeout(task.killTimer);
    task.killTimer = setTimeout(() => {
      if (task.child) {
        killProcessTree(task.child, 'SIGKILL');
      }
    }, 1000);
    if ((task.killTimer as any).unref) (task.killTimer as any).unref();

    return { success: true, taskId, status: 'killed', message: `Signal ${signal} sent` };
  }

  listTasks(limit: number = 20): any {
    const list = Array.from(this.tasks.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit)
      .map((t) => ({
        taskId: t.taskId,
        command: t.command,
        cwd: t.cwd,
        status: t.status,
        exitCode: t.exitCode,
        durationMs: (t.endTime || Date.now()) - t.startTime,
        startTime: t.startTime,
        endTime: t.endTime,
      }));
    return { success: true, tasks: list };
  }
}

export const taskManager = new TaskManager({ persist: true });
