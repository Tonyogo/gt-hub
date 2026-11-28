import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { resolveWorkingDir, getDefaultShell } from '../tasks/taskManager';
import {
  tryRequirePty,
  hasSystemPython3,
  NodePtyDriver,
  PosixPtyDriver,
  InteractivePipeDriver,
} from './drivers';
import { BIN_MSG_TYPE, encodeBinaryPacket } from '../../shared/protocol/binaryProtocol';
import { StreamBatcher } from '../../shared/utils/streamBatcher';
import { TerminalHistoryBuffer } from './terminalHistoryBuffer';

export interface StreamSession {
  taskId: string;
  driverType: string;
  driver: any;
  isPty: boolean;
  proc: any;
  timeoutTimer: NodeJS.Timeout | null;
  batcher?: { flush: () => void };
  history?: TerminalHistoryBuffer;
  superseded?: boolean;
  exitEmitted?: boolean;
}

export class StreamSessionManager {
  public send: (data: any) => void;
  public sessions: Map<string, StreamSession>;
  private readonly maxScrollbackBytes: number;

  constructor(sendFn: (data: any) => void, maxScrollbackBytes: number = 1 * 1024 * 1024) {
    this.send = sendFn;
    this.sessions = new Map();
    this.maxScrollbackBytes = maxScrollbackBytes;
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  sendHistorySync(taskId: string, paneId?: string, replyIfEmpty: boolean = false): boolean {
    const session = this.sessions.get(taskId);
    if (!session || !session.history) {
      return false;
    }
    const targetPaneId = paneId || (taskId.startsWith('pane-') ? taskId.slice(5) : taskId);
    const histBuf = session.history.getBuffer();
    if (histBuf.length === 0) {
      if (replyIfEmpty) {
        try {
          this.send({ type: 'history_sync', paneId: targetPaneId, history: '' });
        } catch {}
      }
      return true;
    }
    try {
      this.send(encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, targetPaneId, histBuf));
      return true;
    } catch {
      return false;
    }
  }

  sendAllPaneHistorySync(): void {
    for (const session of this.sessions.values()) {
      if (session.taskId.startsWith('pane-') && session.history && session.history.getSize() > 0) {
        this.sendHistorySync(session.taskId, session.taskId.slice(5));
      }
    }
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
    stdinEof = false,
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
    stdinEof?: boolean;
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
      PROMPT_EOL_MARK: '',
    };
    if (!env.TMUX) delete taskEnv.TMUX;
    if (!env.TMUX_PANE) delete taskEnv.TMUX_PANE;
    if (!env.STY) delete taskEnv.STY;
    if (!env.WINDOW) delete taskEnv.WINDOW;
    if (!env.TERM_SESSION_ID) delete taskEnv.TERM_SESSION_ID;

    if (this.sessions.has(taskId)) {
      const oldSession = this.sessions.get(taskId);
      if (oldSession) {
        oldSession.superseded = true;
        if (oldSession.timeoutTimer) {
          clearTimeout(oldSession.timeoutTimer);
          oldSession.timeoutTimer = null;
        }
        if (oldSession.batcher) {
          oldSession.batcher.flush();
        }
        this.sessions.delete(taskId);
        try {
          oldSession.driver?.kill('SIGTERM');
        } catch {}
      }
    }

    let driver: any = null;
    let driverType: string | null = null;
    let session: StreamSession | null = null;
    const pty = tryRequirePty();
    const canUseNodePty = Boolean(tty && pty && !_forceFallback && !_forcePipeFallback);

    const isPaneStream = taskId.startsWith('pane-');
    const isRawBinaryOutput = !tty && !isPaneStream;
    const paneHistory = isPaneStream
      ? new TerminalHistoryBuffer(this.maxScrollbackBytes, false)
      : undefined;

    const decoder = isRawBinaryOutput ? null : new StringDecoder('utf8');
    const textBatcher = isRawBinaryOutput
      ? null
      : new StreamBatcher((batchedText) => {
          const buf = Buffer.from(batchedText, 'utf-8');
          if (paneHistory) {
            paneHistory.push(buf);
          }
          this.send(encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, taskId, buf));
        }, 8, 64 * 1024, 4096);

    const rawChunks: Buffer[] = [];
    let rawChunkBytes = 0;
    let rawFlushTimer: NodeJS.Timeout | null = null;
    const flushRawBatch = () => {
      if (rawFlushTimer) {
        clearTimeout(rawFlushTimer);
        rawFlushTimer = null;
      }
      if (rawChunks.length === 0) return;
      const combined = rawChunks.length === 1 ? rawChunks[0] : Buffer.concat(rawChunks);
      rawChunks.length = 0;
      rawChunkBytes = 0;
      this.send(encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, taskId, combined));
    };
    const rawBatcher = isRawBinaryOutput
      ? {
          push: (chunk: Buffer) => {
            if (chunk.length === 0) return;
            rawChunks.push(chunk);
            rawChunkBytes += chunk.length;
            if (rawChunkBytes >= 64 * 1024) {
              flushRawBatch();
              return;
            }
            if (!rawFlushTimer) {
              rawFlushTimer = setTimeout(() => {
                rawFlushTimer = null;
                flushRawBatch();
              }, 8);
              if (typeof rawFlushTimer.unref === 'function') {
                rawFlushTimer.unref();
              }
            }
          },
          flush: flushRawBatch,
        }
      : null;

    const activeBatcher = textBatcher || rawBatcher!;

    const onData = (chunk: any) => {
      if (isRawBinaryOutput && rawBatcher) {
        const rawBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
        if (rawBuf.length > 0) {
          rawBatcher.push(rawBuf);
        }
        return;
      }
      const text = typeof chunk === 'string'
        ? chunk
        : decoder!.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (text) {
        textBatcher!.push(text);
      }
    };

    const onExit = (code: number | null, signal: string | null) => {
      if (!session || session.superseded || session.exitEmitted) return;
      if (this.sessions.has(taskId) && this.sessions.get(taskId) !== session) return;
      session.exitEmitted = true;
      if (decoder && textBatcher) {
        const tail = decoder.end();
        if (tail) {
          textBatcher.push(tail);
        }
      }
      activeBatcher.flush();
      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = null;
      }
      if (session.history) {
        session.history.clear();
      }
      if (this.sessions.get(taskId) === session) {
        this.sessions.delete(taskId);
      }
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
        driver = new InteractivePipeDriver({
          command,
          shell,
          cwd: workingDir,
          env: taskEnv,
          cols,
          rows,
          tty,
          rawBinaryStdin: Boolean(!tty && stdinEof),
          onData,
          onExit,
        });
        driverType = 'pipe-fallback';
      } catch (err) {
        this.send({ type: 'cmd_stream_exit', taskId, exitCode: 1, signal: null });
        return;
      }
    }

    session = {
      taskId,
      driverType: driverType!,
      driver,
      isPty: driverType === 'node-pty' || driverType === 'posix-pty',
      proc: driver.proc,
      timeoutTimer: null,
      batcher: activeBatcher,
      ...(paneHistory ? { history: paneHistory } : {}),
    };

    if (timeoutMs && timeoutMs > 0) {
      session.timeoutTimer = setTimeout(() => {
        this.kill(taskId, 'SIGTERM');
      }, timeoutMs);
      session.timeoutTimer.unref();
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

  writeRawInput(taskId: string, rawBuf: Buffer | Uint8Array): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
      session.driver.write(buf);
    } catch {}
  }

  endInput(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session || !session.driver) return;
    try {
      if (typeof session.driver.endInput === 'function') {
        session.driver.endInput();
      } else if (session.isPty) {
        session.driver.write(Buffer.from([0x04]));
      }
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
    if (!session) return;
    this.sessions.delete(taskId);
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = null;
    }
    if (session.batcher) {
      session.batcher.flush();
    }
    if (session.history) {
      session.history.clear();
    }
    if (session.driver) {
      try {
        session.driver.kill(signal);
      } catch {}
    }
  }

  killAll(): void {
    for (const taskId of Array.from(this.sessions.keys())) {
      this.kill(taskId, 'SIGTERM');
    }
  }
}
