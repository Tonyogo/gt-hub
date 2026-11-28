import http from 'http';
import { URL } from 'url';
import { RawData } from 'ws';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';
import {
  BIN_MSG_TYPE,
  PROTOCOL_VERSION,
  encodeBinaryPacket,
  decodeBinaryPacket,
  sendControlFrame,
  sendWsSafe,
} from '../../shared/protocol/binaryProtocol';

export interface ActiveExecSession {
  taskId: string;
  hostId: string;
  cliWs: any;
  createdAt: number;
}

const EXEC_WS_CONTROL_TYPES = new Set([
  'exec_start',
  'resize',
  'exec_stdin_eof',
  'exec_kill',
  'ping',
]);

export class TerminalExecBridge {
  private activeSessions: Map<string, ActiveExecSession> = new Map();
  private hostToTasks: Map<string, Set<string>> = new Map();

  public handleCliConnection(ws: any, req: http.IncomingMessage): void {
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const rawHostId = (parsedUrl.searchParams.get('hostId') || parsedUrl.searchParams.get('id') || '').trim();

    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(rawHostId);
    const host = canonicalHostId ? terminalHostManager.getHost(canonicalHostId) : null;

    if (!canonicalHostId || !host || host.status !== 'online') {
      logger.warn(`[ExecBridge] CLI attempted connection to offline/unknown host: "${rawHostId}"`);
      try {
        sendWsSafe(ws, `\r\n\x1b[33m[Host Offline] Host "${rawHostId}" is offline or unavailable.\x1b[0m\r\n`, { binary: false, compress: false });
        ws.close(1008, 'Host is offline or unavailable');
      } catch {}
      return;
    }

    let assignedTaskId: string | null = null;

    ws.on('message', (message: RawData, isBinary?: boolean) => {
      try {
        let control: any = null;
        const isRawBuf = Buffer.isBuffer(message) || ArrayBuffer.isView(message) || message instanceof ArrayBuffer;
        const rawBuf = isRawBuf
          ? Buffer.isBuffer(message)
            ? message
            : ArrayBuffer.isView(message)
              ? Buffer.from(message.buffer, message.byteOffset, message.byteLength)
              : Buffer.from(message as ArrayBuffer)
          : null;

        // Strict binary WS frames (isBinary === true) once session has started are ALWAYS binary stdin.
        if (isBinary === true && assignedTaskId && rawBuf) {
          this.sendStreamInputToAgent(canonicalHostId, assignedTaskId, rawBuf);
          return;
        }

        if (isBinary !== true) {
          const msgStr = typeof message === 'string'
            ? message
            : (rawBuf ? rawBuf.toString('utf-8') : String(message));
          let parsed: any = null;
          if (msgStr.startsWith('JSON:')) {
            try {
              parsed = JSON.parse(msgStr.slice(5));
            } catch {}
          } else if (msgStr.startsWith('{')) {
            try {
              parsed = JSON.parse(msgStr);
            } catch {}
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && EXEC_WS_CONTROL_TYPES.has(parsed.type)) {
            control = parsed;
          }
        }

        if (!control) {
          if (assignedTaskId) {
            const payloadBuf = rawBuf || Buffer.from(typeof message === 'string' ? message : String(message), 'utf-8');
            this.sendStreamInputToAgent(canonicalHostId, assignedTaskId, payloadBuf);
          }
          return;
        }

        if (control.type === 'ping') {
          try {
            sendWsSafe(ws, JSON.stringify({ type: 'pong' }), { binary: false, compress: false });
          } catch {}
          return;
        }

        if (control.type === 'exec_start') {
          if (assignedTaskId) {
            try {
              sendWsSafe(ws, JSON.stringify({ type: 'exec_error', error: 'Execution session already started on this connection' }), { binary: false, compress: false });
            } catch {}
            return;
          }

          if (!control.command || typeof control.command !== 'string' || !control.command.trim()) {
            try {
              sendWsSafe(ws, JSON.stringify({ type: 'exec_error', error: 'Field "command" is required' }), { binary: false, compress: false });
              ws.close(1008, 'Invalid exec_start payload');
            } catch {}
            return;
          }

          const session = terminalHostManager.getSession(canonicalHostId);
          const agentWs = session && typeof session.getAgentWs === 'function' ? session.getAgentWs() : null;
          if (!session || (typeof session.getAgentWs === 'function' && (!agentWs || agentWs.readyState !== 1))) {
            try {
              sendWsSafe(ws, JSON.stringify({ type: 'exec_error', error: `Host "${rawHostId}" is offline or unavailable`, code: 'EHOSTUNREACH' }), { binary: false, compress: false });
              sendWsSafe(ws, `\r\n\x1b[33m[Host Offline] Host "${rawHostId}" is offline or unavailable.\x1b[0m\r\n`, { binary: false, compress: false });
              ws.close(1008, 'Host is offline or unavailable');
            } catch {}
            return;
          }

          assignedTaskId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.activeSessions.set(assignedTaskId, {
            taskId: assignedTaskId,
            hostId: canonicalHostId,
            cliWs: ws,
            createdAt: Date.now(),
          });

          if (!this.hostToTasks.has(canonicalHostId)) {
            this.hostToTasks.set(canonicalHostId, new Set());
          }
          this.hostToTasks.get(canonicalHostId)!.add(assignedTaskId);

          this.sendToAgent(canonicalHostId, {
            type: 'cmd_exec',
            action: 'start_stream',
            taskId: assignedTaskId,
            command: control.command,
            cwd: control.cwd,
            env: control.env,
            timeoutMs: control.timeoutMs,
            tty: control.tty !== false,
            interactive: control.interactive !== false,
            cols: control.cols || 80,
            rows: control.rows || 24,
            stdinEof: true,
          });

          sendWsSafe(ws, JSON.stringify({
            type: 'exec_started',
            taskId: assignedTaskId,
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              stdinEof: true,
              binaryStdin: true,
              binaryControl: false,
            },
          }), { binary: false, compress: false });
          return;
        }

        if (control.type === 'resize' && assignedTaskId) {
          this.sendToAgent(canonicalHostId, {
            type: 'cmd_stream_resize',
            taskId: assignedTaskId,
            cols: control.cols,
            rows: control.rows,
          });
          return;
        }

        if (control.type === 'exec_stdin_eof' && assignedTaskId) {
          this.sendToAgent(canonicalHostId, {
            type: 'cmd_stream_eof',
            taskId: assignedTaskId,
          });
          return;
        }

        if (control.type === 'exec_kill' && assignedTaskId) {
          this.sendToAgent(canonicalHostId, {
            type: 'cmd_stream_kill',
            taskId: assignedTaskId,
            signal: control.signal || 'SIGTERM',
          });
          return;
        }
      } catch (err: any) {
        logger.error(`[ExecBridge] Error handling message from CLI: ${err.message}`);
      }
    });

    const cleanup = () => {
      if (assignedTaskId && this.activeSessions.has(assignedTaskId)) {
        this.sendToAgent(canonicalHostId, {
          type: 'cmd_stream_kill',
          taskId: assignedTaskId,
          signal: 'SIGHUP',
        });
        this.activeSessions.delete(assignedTaskId);
        const set = this.hostToTasks.get(canonicalHostId);
        if (set) {
          set.delete(assignedTaskId);
          if (set.size === 0) this.hostToTasks.delete(canonicalHostId);
        }
      }
      assignedTaskId = null;
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  public handleAgentStreamMessage(hostId: string, message: any): void {
    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(hostId) || hostId;
    const matchesHost = (sessionHostId: string) => sessionHostId === hostId || sessionHostId === canonicalHostId;

    if (Buffer.isBuffer(message)) {
      const decoded = decodeBinaryPacket(message);
      if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
        const session = this.activeSessions.get(decoded.id);
        if (session && matchesHost(session.hostId) && session.cliWs && session.cliWs.readyState === 1) {
          sendWsSafe(session.cliWs, decoded.payload, { binary: true, compress: false });
        }
        return;
      }
    }

    if (!message || typeof message !== 'object') return;
    const { taskId, type } = message;
    if (!taskId) return;

    const session = this.activeSessions.get(taskId);
    if (!session || !matchesHost(session.hostId) || !session.cliWs || session.cliWs.readyState !== 1) {
      return;
    }

    if (type === 'cmd_stream_data') {
      try {
        const buf = Buffer.from(message.data, 'base64');
        sendWsSafe(session.cliWs, buf, { binary: true, compress: false });
      } catch (err: any) {
        logger.warn(`[ExecBridge] Failed to write stream data to CLI [${taskId}]: ${err.message}`);
      }
      return;
    }

    if (type === 'cmd_stream_exit') {
      // Remove session BEFORE closing socket so ws 'close' cleanup does not send spurious cmd_stream_kill
      this.activeSessions.delete(taskId);
      const set = this.hostToTasks.get(session.hostId);
      if (set) {
        set.delete(taskId);
        if (set.size === 0) this.hostToTasks.delete(session.hostId);
      }
      try {
        sendWsSafe(session.cliWs, JSON.stringify({
          type: 'exec_exit',
          exitCode: message.exitCode !== undefined ? message.exitCode : 0,
          signal: message.signal || null,
        }), { binary: false, compress: false });
        session.cliWs.close(1000, 'Process exited');
      } catch {}
    }
  }

  public handleAgentDisconnected(hostId: string): void {
    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(hostId) || hostId;
    const hostKeys = canonicalHostId !== hostId ? [hostId, canonicalHostId] : [hostId];

    for (const targetHostId of hostKeys) {
      const tasks = this.hostToTasks.get(targetHostId);
      if (!tasks) continue;

      for (const taskId of tasks) {
        const session = this.activeSessions.get(taskId);
        this.activeSessions.delete(taskId);
        if (session && session.cliWs) {
          try {
            sendWsSafe(session.cliWs, '\r\n\x1b[31m[Agent Disconnected] Remote host lost connection.\x1b[0m\r\n', { binary: false, compress: false });
          } catch {}
          try {
            session.cliWs.close(1012, 'Agent disconnected');
          } catch {
            try {
              session.cliWs.terminate?.();
            } catch {}
          }
        }
      }
      this.hostToTasks.delete(targetHostId);
    }
  }

  private sendStreamInputToAgent(hostId: string, taskId: string, buf: Buffer): void {
    const packet = encodeBinaryPacket(BIN_MSG_TYPE.STREAM_INPUT, taskId, buf);
    const session = terminalHostManager.getSession(hostId);
    if (!session) return;
    const agentWs = typeof session.getAgentWs === 'function' ? session.getAgentWs() : null;
    if (agentWs && agentWs.readyState === 1) {
      sendWsSafe(agentWs, packet, { binary: true, compress: false });
    } else if (typeof session.getAgentWs !== 'function') {
      session.write(packet as any);
    }
  }

  private sendToAgent(hostId: string, payload: any): void {
    const session = terminalHostManager.getSession(hostId);
    if (!session) return;
    const agentWs = typeof session.getAgentWs === 'function' ? session.getAgentWs() : null;
    if (agentWs && agentWs.readyState === 1) {
      sendControlFrame(agentWs, payload, hostId);
    } else if (typeof session.getAgentWs !== 'function') {
      session.write(`JSON:${JSON.stringify(payload)}`);
    }
  }
}

export const terminalExecBridge = new TerminalExecBridge();
export default terminalExecBridge;
