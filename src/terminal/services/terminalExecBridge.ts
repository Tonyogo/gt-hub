import http from 'http';
import { URL } from 'url';
import { RawData } from 'ws';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';

export interface ActiveExecSession {
  taskId: string;
  hostId: string;
  cliWs: any;
  createdAt: number;
}

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
        ws.send(`\r\n\x1b[33m[Host Offline] Host "${rawHostId}" is offline or unavailable.\x1b[0m\r\n`);
        ws.close(1008, 'Host is offline or unavailable');
      } catch {}
      return;
    }

    let assignedTaskId: string | null = null;

    ws.on('message', (message: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (assignedTaskId) {
            const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
            this.sendToAgent(canonicalHostId, {
              type: 'cmd_stream_input',
              taskId: assignedTaskId,
              data: buf.toString('base64'),
            });
          }
          return;
        }

        const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
        let control: any = null;
        if (msgStr.startsWith('JSON:')) {
          try {
            control = JSON.parse(msgStr.slice(5));
          } catch {}
        } else {
          try {
            control = JSON.parse(msgStr);
          } catch {}
        }

        if (!control) {
          if (assignedTaskId) {
            this.sendToAgent(canonicalHostId, {
              type: 'cmd_stream_input',
              taskId: assignedTaskId,
              data: Buffer.from(msgStr, 'utf-8').toString('base64'),
            });
          }
          return;
        }

        if (control.type === 'exec_start') {
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
          });

          ws.send(JSON.stringify({ type: 'exec_started', taskId: assignedTaskId }));
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
      } catch (err: any) {
        logger.error(`[ExecBridge] Error handling message from CLI: ${err.message}`);
      }
    });

    const cleanup = () => {
      if (assignedTaskId) {
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
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  public handleAgentStreamMessage(hostId: string, message: any): void {
    const { taskId, type } = message;
    if (!taskId) return;

    const session = this.activeSessions.get(taskId);
    if (!session || !session.cliWs || session.cliWs.readyState !== 1) {
      return;
    }

    if (type === 'cmd_stream_data') {
      try {
        const buf = Buffer.from(message.data, 'base64');
        session.cliWs.send(buf);
      } catch (err: any) {
        logger.warn(`[ExecBridge] Failed to write stream data to CLI [${taskId}]: ${err.message}`);
      }
      return;
    }

    if (type === 'cmd_stream_exit') {
      try {
        session.cliWs.send(JSON.stringify({
          type: 'exec_exit',
          exitCode: message.exitCode !== undefined ? message.exitCode : 0,
          signal: message.signal || null,
        }));
        session.cliWs.close(1000, 'Process exited');
      } catch {}
      this.activeSessions.delete(taskId);
      const set = this.hostToTasks.get(hostId);
      if (set) {
        set.delete(taskId);
        if (set.size === 0) this.hostToTasks.delete(hostId);
      }
    }
  }

  public handleAgentDisconnected(hostId: string): void {
    const tasks = this.hostToTasks.get(hostId);
    if (!tasks) return;

    for (const taskId of tasks) {
      const session = this.activeSessions.get(taskId);
      if (session && session.cliWs) {
        try {
          session.cliWs.send('\r\n\x1b[31m[Agent Disconnected] Remote host lost connection.\x1b[0m\r\n');
          session.cliWs.close(1006, 'Agent disconnected');
        } catch {}
      }
      this.activeSessions.delete(taskId);
    }
    this.hostToTasks.delete(hostId);
  }

  private sendToAgent(hostId: string, payload: any): void {
    const session = terminalHostManager.getSession(hostId);
    if (session) {
      session.write(`JSON:${JSON.stringify(payload)}`);
    }
  }
}

export const terminalExecBridge = new TerminalExecBridge();
export default terminalExecBridge;
