import fs from 'fs';
import { resolveWorkingDir, getDefaultShell } from '../tasks/taskManager';
import {
  tryRequirePty,
  hasSystemPython3,
  NodePtyDriver,
  PosixPtyDriver,
  InteractivePipeDriver,
} from './drivers';

export interface StreamSession {
  taskId: string;
  driverType: string;
  driver: any;
  isPty: boolean;
  proc: any;
  timeoutTimer: NodeJS.Timeout | null;
}

export class StreamSessionManager {
  public send: (data: any) => void;
  public sessions: Map<string, StreamSession>;

  constructor(sendFn: (data: any) => void) {
    this.send = sendFn;
    this.sessions = new Map();
  }

  startStream({
    taskId,
    command,
    cwd,
    env = {},
    cols = 80,
    rows = 24,
    timeoutMs = 0,
    tty = true,
    interactive = false,
    _forceFallback = false,
    _forcePipeFallback = false,
  }: {
    taskId: string;
    command: string;
    cwd?: string | null;
    env?: Record<string, any>;
    cols?: number;
    rows?: number;
    timeoutMs?: number;
    tty?: boolean;
    interactive?: boolean;
    _forceFallback?: boolean;
    _forcePipeFallback?: boolean;
  }): void {
    const workingDir = resolveWorkingDir(cwd);
    if (cwd && !fs.existsSync(workingDir)) {
      const errMsg = Buffer.from(`\r\n\x1b[31m[Error] Working directory does not exist: ${workingDir}\x1b[0m\r\n`);
      this.send({ type: 'cmd_stream_data', taskId, data: errMsg.toString('base64') });
      this.send({ type: 'cmd_stream_exit', taskId, exitCode: 1, signal: null });
      return;
    }
    const shell = getDefaultShell();
    const taskEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };

    let driver: any = null;
    let driverType: string | null = null;
    const pty = tryRequirePty();
    const canUseNodePty = Boolean(tty && pty && !_forceFallback && !_forcePipeFallback);

    const onData = (chunk: any) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
      this.send({
        type: 'cmd_stream_data',
        taskId,
        data: buf.toString('base64'),
      });
    };

    const onExit = (code: number | null, signal: string | null) => {
      const session = this.sessions.get(taskId);
      if (session && session.timeoutTimer) clearTimeout(session.timeoutTimer);
      this.sessions.delete(taskId);
      this.send({
        type: 'cmd_stream_exit',
        taskId,
        exitCode: code !== null && code !== undefined ? code : (signal ? 130 : 0),
        signal: signal || null,
      });
    };

    if (canUseNodePty) {
      // 1. Layer 1: NodePtyDriver
      try {
        driver = new NodePtyDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'node-pty';
      } catch (err) {
        driver = null;
      }
    }

    if (!driver && tty && !_forcePipeFallback && hasSystemPython3()) {
      // 2. Layer 2: PosixPtyDriver (轻量原生 POSIX PTY)
      try {
        driver = new PosixPtyDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'posix-pty';
      } catch (err) {
        driver = null;
      }
    }

    if (!driver) {
      // 3. Layer 3: InteractivePipeDriver (纯管道兜底)
      if (tty && (!pty || _forcePipeFallback)) {
        const warnMsg = Buffer.from('\r\n\x1b[33m[Warning] node-pty not available on agent; running in interactive pipe mode.\x1b[0m\r\n');
        this.send({ type: 'cmd_stream_data', taskId, data: warnMsg.toString('base64') });
      }
      try {
        driver = new InteractivePipeDriver({ command, shell, cwd: workingDir, env: taskEnv, cols, rows, onData, onExit });
        driverType = 'pipe-fallback';
      } catch (err) {
        this.send({ type: 'cmd_stream_exit', taskId, exitCode: 1, signal: null });
        return;
      }
    }

    const session: StreamSession = {
      taskId,
      driverType: driverType!,
      driver,
      isPty: driverType === 'node-pty' || driverType === 'posix-pty',
      proc: driver.proc,
      timeoutTimer: null,
    };

    if (timeoutMs && timeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        this.kill(taskId, 'SIGTERM');
      }, timeoutMs);
    }

    this.sessions.set(taskId, session);
  }

  writeInput(taskId: string, base64Data: string): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      const buf = Buffer.from(base64Data, 'base64');
      session.driver.write(buf);
    } catch {}
  }

  resize(taskId: string, cols: number, rows: number): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      session.driver.resize(cols, rows);
    } catch {}
  }

  kill(taskId: string, signal: string = 'SIGTERM'): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      session.driver.kill(signal);
    } catch {}
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    this.sessions.delete(taskId);
  }

  killAll(): void {
    for (const taskId of Array.from(this.sessions.keys())) {
      this.kill(taskId, 'SIGTERM');
    }
  }
}
