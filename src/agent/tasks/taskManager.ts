import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';

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

export interface TaskChunk {
  type: 'stdout' | 'stderr';
  text: string;
  startOffset: number;
  endOffset: number;
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
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

export class TaskManager {
  public tasks: Map<string, TaskRecord>;
  public MAX_TASKS: number;
  public MAX_BUFFER_SIZE: number;
  public TASK_TTL_MS: number;

  constructor() {
    this.tasks = new Map();
    this.MAX_TASKS = 100;
    this.MAX_BUFFER_SIZE = 5 * 1024 * 1024;
    this.TASK_TTL_MS = 24 * 60 * 60 * 1000;
  }

  pruneOldTasks(): void {
    const now = Date.now();
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== 'running' && (now - task.startTime > this.TASK_TTL_MS)) {
        this.tasks.delete(taskId);
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
        }
      }
    }
  }

  startTask({
    taskId,
    command,
    cwd,
    timeoutMs = 300000,
    env = {},
    stdin = null,
  }: {
    taskId: string;
    command: string;
    cwd?: string | null;
    timeoutMs?: number;
    env?: Record<string, any>;
    stdin?: string | null;
  }): any {
    this.pruneOldTasks();

    if (this.tasks.has(taskId)) {
      const existing = this.tasks.get(taskId)!;
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
    let shell = (env && env.SHELL && fs.existsSync(env.SHELL)) ? env.SHELL : getDefaultShell();
    if (!isWindows && !fs.existsSync(shell)) {
      if (fs.existsSync('/bin/bash')) shell = '/bin/bash';
      else if (fs.existsSync('/usr/bin/bash')) shell = '/usr/bin/bash';
      else if (fs.existsSync('/bin/sh')) shell = '/bin/sh';
    }
    const shellArgs = isWindows
      ? (shell.toLowerCase().includes('powershell') ? ['-Command', command] : ['/c', command])
      : ['-c', command];

    const taskEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
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
      timeoutTimer: null,
      killTimer: null,
    };

    const appendChunk = (type: 'stdout' | 'stderr', chunk: any) => {
      const text = chunk.toString('utf-8');
      const bytes = Buffer.byteLength(text, 'utf-8');
      const startOffset = taskRecord.totalBytes;
      const endOffset = startOffset + bytes;
      taskRecord.totalBytes = endOffset;
      taskRecord.chunks.push({ type, text, startOffset, endOffset });

      if (type === 'stdout') {
        taskRecord.stdout += text;
        if (taskRecord.stdout.length > this.MAX_BUFFER_SIZE) {
          taskRecord.stdout = taskRecord.stdout.slice(-this.MAX_BUFFER_SIZE);
        }
      } else {
        taskRecord.stderr += text;
        if (taskRecord.stderr.length > this.MAX_BUFFER_SIZE) {
          taskRecord.stderr = taskRecord.stderr.slice(-this.MAX_BUFFER_SIZE);
        }
      }
      taskRecord.output += text;
      if (taskRecord.output.length > this.MAX_BUFFER_SIZE) {
        taskRecord.output = taskRecord.output.slice(-this.MAX_BUFFER_SIZE);
      }

      while (taskRecord.chunks.length > 1 && taskRecord.totalBytes - taskRecord.chunks[0].startOffset > this.MAX_BUFFER_SIZE) {
        taskRecord.chunks.shift();
      }
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
      taskRecord.status = 'failed';
      taskRecord.endTime = Date.now();
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
    });

    child.on('close', (code, signal) => {
      if (taskRecord.timeoutTimer) clearTimeout(taskRecord.timeoutTimer);
      if (taskRecord.killTimer) clearTimeout(taskRecord.killTimer);
      taskRecord.endTime = Date.now();
      taskRecord.child = null;

      if (taskRecord.status === 'running') {
        if (signal) {
          taskRecord.status = 'killed';
        } else {
          taskRecord.exitCode = code;
          taskRecord.status = code === 0 ? 'completed' : 'failed';
        }
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
        }
      }, timeoutMs);
      if ((taskRecord.timeoutTimer as any).unref) (taskRecord.timeoutTimer as any).unref();
    }

    this.tasks.set(taskId, taskRecord);
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
    const totalBytes = task.totalBytes !== undefined ? task.totalBytes : Buffer.byteLength(task.output, 'utf-8');

    let incStdout = '';
    let incStderr = '';
    let incOutput = '';

    if (numOffset === 0 && (!task.chunks || task.chunks.length === 0)) {
      incStdout = task.stdout;
      incStderr = task.stderr;
      incOutput = task.output;
    } else if (task.chunks && task.chunks.length > 0) {
      for (const chunk of task.chunks) {
        if (chunk.endOffset <= numOffset) {
          continue;
        }
        let chunkText = chunk.text;
        if (chunk.startOffset < numOffset) {
          const byteSliceStart = numOffset - chunk.startOffset;
          const buf = Buffer.from(chunk.text, 'utf-8');
          chunkText = buf.slice(byteSliceStart).toString('utf-8');
        }
        if (chunk.type === 'stdout') {
          incStdout += chunkText;
        } else if (chunk.type === 'stderr') {
          incStderr += chunkText;
        }
        incOutput += chunkText;
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

export const taskManager = new TaskManager();
