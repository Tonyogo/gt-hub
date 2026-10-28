import http from 'http';
import { URL } from 'url';
import { Request, Response } from 'express';
import { RawData } from 'ws';
import logger from '../../utils/logger';
import { terminalHostManager } from './terminalHostManager';
import {
  BIN_MSG_TYPE,
  DecodedBinaryPacket,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../../shared/protocol/binaryProtocol';
import { ListeningPortInfo } from '../../agent/handlers/proxyHandler';

export { ListeningPortInfo };

export function stripProxySessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const headerStr = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const parts = headerStr.split(';').map((p) => p.trim()).filter(Boolean);
  const retained = parts.filter((p) => !p.startsWith('gt_proxy_session='));
  if (retained.length === 0) return undefined;
  return retained.join('; ');
}

const MAX_CHUNK_BYTES = 32 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export interface HttpProxyRequestOptions {
  hostId: string;
  targetUrl: string;
  timeoutMs?: number;
  insecure?: boolean;
}

interface ActiveHttpRequestState {
  reqId: string;
  hostId: string;
  req: Request;
  res: Response;
}

interface ActiveTcpStreamState {
  streamId: string;
  hostId: string;
  cliWs: any;
}

export class TerminalProxyBridge {
  private activeHttpRequests = new Map<string, ActiveHttpRequestState>();
  private hostToHttpRequests = new Map<string, Set<string>>();

  private activeTcpStreams = new Map<string, ActiveTcpStreamState>();
  private hostToTcpStreams = new Map<string, Set<string>>();
  private cliToTcpStreams = new Map<any, Set<string>>();

  private pendingPortListRpcs = new Map<
    string,
    {
      hostId: string;
      timer: NodeJS.Timeout;
      resolve: (res: { success: boolean; status?: number; ports?: ListeningPortInfo[]; error?: string }) => void;
    }
  >();

  private sendChunked(ws: any, msgType: number, id: string, payload: Buffer): void {
    if (payload.length <= MAX_CHUNK_BYTES) {
      ws.send(encodeBinaryPacket(msgType, id, payload));
      return;
    }

    let offset = 0;
    while (offset < payload.length) {
      const end = Math.min(offset + MAX_CHUNK_BYTES, payload.length);
      const slice = payload.subarray(offset, end);
      ws.send(encodeBinaryPacket(msgType, id, slice));
      offset = end;
    }
  }

  public handleHttpProxyRequest(req: Request, res: Response, options: HttpProxyRequestOptions): void {
    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(options.hostId);
    const host = canonicalHostId ? terminalHostManager.getHost(canonicalHostId) : null;
    const session = canonicalHostId ? terminalHostManager.getSession(canonicalHostId) : null;
    const agentWs = session?.getAgentWs();

    if (!canonicalHostId || !host) {
      res.status(404).json({ error: `Host '${options.hostId}' not found` });
      return;
    }

    if (host.status !== 'online' || !agentWs || agentWs.readyState !== 1) {
      res.status(502).json({ error: `Agent '${options.hostId}' is offline` });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.targetUrl);
    } catch (err: any) {
      res.status(400).json({ error: `Invalid target URL: ${err.message}` });
      return;
    }

    const reqId = `hpx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const outboundHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue;
      if (lowerKey === 'x-admin-key' || lowerKey.startsWith('x-gt-')) continue;
      if (lowerKey === 'cookie') {
        const sanitized = stripProxySessionCookie(value);
        if (sanitized) {
          outboundHeaders['cookie'] = sanitized;
        }
        continue;
      }
      if (value !== undefined) {
        outboundHeaders[lowerKey] = value;
      }
    }
    outboundHeaders['host'] = parsedUrl.host;

    const reqState: ActiveHttpRequestState = {
      reqId,
      hostId: canonicalHostId,
      req,
      res,
    };
    this.activeHttpRequests.set(reqId, reqState);

    if (!this.hostToHttpRequests.has(canonicalHostId)) {
      this.hostToHttpRequests.set(canonicalHostId, new Set());
    }
    this.hostToHttpRequests.get(canonicalHostId)!.add(reqId);

    const cleanup = () => {
      this.activeHttpRequests.delete(reqId);
      const set = this.hostToHttpRequests.get(canonicalHostId);
      if (set) {
        set.delete(reqId);
        if (set.size === 0) this.hostToHttpRequests.delete(canonicalHostId);
      }
    };

    const onClientAbort = () => {
      if (!res.writableEnded && this.activeHttpRequests.has(reqId)) {
        cleanup();
        if (agentWs.readyState === 1) {
          try {
            agentWs.send(`JSON:${JSON.stringify({ type: 'proxy_http_abort', reqId })}`);
          } catch {}
        }
      }
    };

    res.on('close', () => {
      if (!res.writableEnded) {
        onClientAbort();
      }
    });

    req.on('aborted', onClientAbort);

    const method = (req.method || 'GET').toUpperCase();
    const isBodyless =
      method === 'GET' ||
      method === 'HEAD' ||
      (req.headers['content-length'] === '0' && !req.headers['transfer-encoding']);

    try {
      agentWs.send(
        `JSON:${JSON.stringify({
          type: 'proxy_http_start',
          reqId,
          method: req.method || 'GET',
          url: options.targetUrl,
          headers: outboundHeaders,
          timeoutMs: options.timeoutMs,
          bodyEnd: isBodyless,
          insecure: options.insecure,
        })}`
      );
    } catch (err: any) {
      cleanup();
      res.status(502).json({ error: `Failed to dispatch proxy request to agent: ${err.message}` });
      return;
    }

    if (!isBodyless) {
      req.on('data', (chunk: Buffer) => {
        if (agentWs.readyState === 1) {
          try {
            this.sendChunked(agentWs, BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY, reqId, chunk);
          } catch {}
        }
      });

      req.on('end', () => {
        if (agentWs.readyState === 1) {
          try {
            agentWs.send(`JSON:${JSON.stringify({ type: 'proxy_http_req_end', reqId })}`);
          } catch {}
        }
      });
    }
  }

  public handleAgentBinaryFrame(hostId: string, decoded: DecodedBinaryPacket): boolean {
    if (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY) {
      const state = this.activeHttpRequests.get(decoded.id);
      if (state && !state.res.writableEnded) {
        state.res.write(decoded.payload);
      }
      return true;
    }

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA) {
      const state = this.activeTcpStreams.get(decoded.id);
      if (state && state.cliWs && state.cliWs.readyState === 1) {
        try {
          state.cliWs.send(encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, decoded.id, decoded.payload));
        } catch {}
      }
      return true;
    }

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY) {
      return true;
    }

    return false;
  }

  public handleAgentControlMessage(hostId: string, control: any): boolean {
    if (!control || typeof control !== 'object' || typeof control.type !== 'string') {
      return false;
    }

    if (control.type === 'proxy_http_headers') {
      const state = this.activeHttpRequests.get(control.reqId);
      if (state) {
        const { res } = state;
        if (!res.headersSent) {
          if (control.headers && typeof control.headers === 'object') {
            for (const [k, v] of Object.entries(control.headers)) {
              const lower = k.toLowerCase();
              if (HOP_BY_HOP_HEADERS.has(lower)) continue;
              if (v !== undefined) {
                if (lower === 'set-cookie') {
                  const existing = res.getHeader('set-cookie');
                  if (existing) {
                    const existingArr = Array.isArray(existing) ? existing : [String(existing)];
                    const newArr = Array.isArray(v) ? v : [String(v)];
                    res.setHeader('Set-Cookie', [...existingArr, ...newArr]);
                    continue;
                  }
                }
                res.setHeader(k, v as any);
              }
            }
          }
          res.statusCode = control.statusCode || 200;
          if (control.statusMessage) {
            res.statusMessage = control.statusMessage;
          }
          res.flushHeaders();
        }
      }
      return true;
    }

    if (control.type === 'proxy_http_end') {
      const state = this.activeHttpRequests.get(control.reqId);
      if (state) {
        const { res } = state;
        this.activeHttpRequests.delete(control.reqId);
        const set = this.hostToHttpRequests.get(state.hostId);
        if (set) {
          set.delete(control.reqId);
          if (set.size === 0) this.hostToHttpRequests.delete(state.hostId);
        }

        if (control.error) {
          if (!res.headersSent) {
            let status = 502;
            if (control.code === 'ETIMEDOUT') status = 504;
            else if (control.code === 'EACCES') status = 403;
            res.status(status).json({ error: control.error, code: control.code });
          } else {
            res.destroy();
          }
        } else {
          res.end();
        }
      }
      return true;
    }

    if (control.type === 'proxy_tcp_connected') {
      const state = this.activeTcpStreams.get(control.streamId);
      if (state && state.cliWs && state.cliWs.readyState === 1) {
        try {
          state.cliWs.send(`JSON:${JSON.stringify(control)}`);
        } catch {}
      }
      return true;
    }

    if (control.type === 'proxy_tcp_close') {
      const state = this.activeTcpStreams.get(control.streamId);
      if (state) {
        if (state.cliWs && state.cliWs.readyState === 1) {
          try {
            state.cliWs.send(`JSON:${JSON.stringify(control)}`);
          } catch {}
        }
        this.cleanupTcpStream(control.streamId);
      }
      return true;
    }

    if (control.type === 'proxy_list_ports_res') {
      const pending = this.pendingPortListRpcs.get(control.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPortListRpcs.delete(control.reqId);
        if (control.success !== false) {
          pending.resolve({
            success: true,
            status: 200,
            ports: control.ports || [],
          });
        } else {
          pending.resolve({
            success: false,
            status: control.error && /disabled/i.test(control.error) ? 403 : 500,
            ports: [],
            error: control.error || 'Failed to list ports',
          });
        }
      }
      return true;
    }

    return false;
  }

  public handleCliConnection(ws: any, req: http.IncomingMessage): void {
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const rawHostId = (parsedUrl.searchParams.get('hostId') || parsedUrl.searchParams.get('id') || '').trim();

    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(rawHostId);
    const host = canonicalHostId ? terminalHostManager.getHost(canonicalHostId) : null;
    const session = canonicalHostId ? terminalHostManager.getSession(canonicalHostId) : null;
    const agentWs = session?.getAgentWs();

    if (!canonicalHostId || !host || host.status !== 'online' || !agentWs || agentWs.readyState !== 1) {
      try {
        ws.send(
          `JSON:${JSON.stringify({
            type: 'proxy_tcp_close',
            streamId: '',
            error: 'Host is offline or unavailable',
            code: 'EHOSTUNREACH',
          })}`
        );
        ws.close(1008, 'Host is offline or unavailable');
      } catch {}
      return;
    }

    this.cliToTcpStreams.set(ws, new Set());

    ws.on('message', (message: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
          const decoded = decodeBinaryPacket(buf);
          if (decoded && decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA) {
            if (agentWs.readyState === 1) {
              agentWs.send(buf);
            }
          }
          return;
        }

        const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
        if (msgStr.startsWith('JSON:')) {
          let control: any;
          try {
            control = JSON.parse(msgStr.slice(5));
          } catch {
            return;
          }

          if (control.type === 'proxy_tcp_connect') {
            const { streamId } = control;
            this.activeTcpStreams.set(streamId, {
              streamId,
              hostId: canonicalHostId,
              cliWs: ws,
            });

            if (!this.hostToTcpStreams.has(canonicalHostId)) {
              this.hostToTcpStreams.set(canonicalHostId, new Set());
            }
            this.hostToTcpStreams.get(canonicalHostId)!.add(streamId);
            this.cliToTcpStreams.get(ws)?.add(streamId);

            if (agentWs.readyState === 1) {
              agentWs.send(msgStr);
            }
            return;
          }

          if (control.type === 'proxy_tcp_close') {
            const { streamId } = control;
            if (agentWs.readyState === 1) {
              agentWs.send(msgStr);
            }
            this.cleanupTcpStream(streamId);
            return;
          }
        }
      } catch (err: any) {
        logger.error(`[TerminalProxyBridge] Error handling CLI WS message: ${err.message}`);
      }
    });

    const cleanupCli = () => {
      const streams = this.cliToTcpStreams.get(ws);
      if (streams) {
        for (const streamId of Array.from(streams)) {
          if (agentWs.readyState === 1) {
            try {
              agentWs.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_close', streamId })}`);
            } catch {}
          }
          this.cleanupTcpStream(streamId);
        }
        this.cliToTcpStreams.delete(ws);
      }
    };

    ws.on('close', cleanupCli);
    ws.on('error', cleanupCli);
  }

  private cleanupTcpStream(streamId: string): void {
    const state = this.activeTcpStreams.get(streamId);
    if (!state) return;

    this.activeTcpStreams.delete(streamId);

    const hostSet = this.hostToTcpStreams.get(state.hostId);
    if (hostSet) {
      hostSet.delete(streamId);
      if (hostSet.size === 0) this.hostToTcpStreams.delete(state.hostId);
    }

    const cliSet = this.cliToTcpStreams.get(state.cliWs);
    if (cliSet) {
      cliSet.delete(streamId);
    }
  }

  public handleAgentDisconnected(hostId: string): void {
    const reqIds = this.hostToHttpRequests.get(hostId);
    if (reqIds) {
      for (const reqId of Array.from(reqIds)) {
        const state = this.activeHttpRequests.get(reqId);
        if (state) {
          if (!state.res.headersSent) {
            state.res.status(502).json({
              error: 'Agent disconnected unexpectedly',
              code: 'ECONNRESET',
            });
          } else {
            state.res.destroy();
          }
          this.activeHttpRequests.delete(reqId);
        }
      }
      this.hostToHttpRequests.delete(hostId);
    }

    const streamIds = this.hostToTcpStreams.get(hostId);
    if (streamIds) {
      for (const streamId of Array.from(streamIds)) {
        const state = this.activeTcpStreams.get(streamId);
        if (state) {
          if (state.cliWs && state.cliWs.readyState === 1) {
            try {
              state.cliWs.send(
                `JSON:${JSON.stringify({
                  type: 'proxy_tcp_close',
                  streamId,
                  error: 'Agent disconnected',
                  code: 'ECONNRESET',
                })}`
              );
            } catch {}
          }
          this.cleanupTcpStream(streamId);
        }
      }
      this.hostToTcpStreams.delete(hostId);
    }

    for (const [reqId, pending] of Array.from(this.pendingPortListRpcs.entries())) {
      if (pending.hostId === hostId) {
        clearTimeout(pending.timer);
        this.pendingPortListRpcs.delete(reqId);
        pending.resolve({
          success: false,
          status: 502,
          error: 'Agent disconnected',
        });
      }
    }
  }

  public listListeningPorts(
    hostId: string,
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; status?: number; ports?: ListeningPortInfo[]; error?: string }> {
    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(hostId);
    const host = canonicalHostId ? terminalHostManager.getHost(canonicalHostId) : null;
    const session = canonicalHostId ? terminalHostManager.getSession(canonicalHostId) : null;
    const agentWs = session?.getAgentWs();

    if (!canonicalHostId || !host) {
      return Promise.resolve({
        success: false,
        status: 404,
        error: `Host '${hostId}' not found`,
      });
    }

    if (host.status !== 'online' || !agentWs || agentWs.readyState !== 1) {
      return Promise.resolve({
        success: false,
        status: 502,
        error: `Agent '${hostId}' is offline`,
      });
    }

    return new Promise((resolve) => {
      const reqId = `ports-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pendingPortListRpcs.delete(reqId);
        resolve({
          success: false,
          status: 504,
          error: 'Timeout waiting for port scan from agent',
        });
      }, timeoutMs);

      this.pendingPortListRpcs.set(reqId, {
        hostId: canonicalHostId,
        timer,
        resolve,
      });

      try {
        agentWs.send(`JSON:${JSON.stringify({ type: 'proxy_list_ports', reqId })}`);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingPortListRpcs.delete(reqId);
        resolve({
          success: false,
          status: 502,
          error: `Failed to send port list request: ${err.message}`,
        });
      }
    });
  }
}

export const terminalProxyBridge = new TerminalProxyBridge();
export default terminalProxyBridge;
