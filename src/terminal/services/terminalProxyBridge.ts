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
  decodeControlJsonPacket,
  isBinaryMessageFrame,
  sendControlFrame,
  sendWsSafe,
} from '../../shared/protocol/binaryProtocol';
import { ListeningPortInfo, TargetProbeResult } from '../../agent/handlers/proxyHandler';

export { ListeningPortInfo, TargetProbeResult };

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
  downstreamPaused?: boolean;
  reqPauseTimer?: NodeJS.Timeout;
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

  private pendingPingRpcs = new Map<
    string,
    {
      hostId: string;
      startNs: bigint;
      timer: NodeJS.Timeout;
      resolve: (res: {
        success: boolean;
        status?: number;
        hubAgentRttMs?: number;
        agentTimestamp?: number;
        error?: string;
      }) => void;
    }
  >();

  private pendingProbeRpcs = new Map<
    string,
    {
      hostId: string;
      timer: NodeJS.Timeout;
      resolve: (res: {
        success: boolean;
        status?: number;
        results?: TargetProbeResult[];
        error?: string;
      }) => void;
    }
  >();

  private tcpStreamKey(hostId: string, streamId: string): string {
    return `${hostId}\0${streamId}`;
  }

  private resolveCanonicalHost(hostId: string): string {
    return terminalHostManager.resolveCanonicalHostId(hostId) || hostId;
  }

  private getTcpStream(hostId: string, streamId: string): ActiveTcpStreamState | undefined {
    if (!streamId || typeof streamId !== 'string') return undefined;
    const canonicalHostId = this.resolveCanonicalHost(hostId);
    const direct = this.activeTcpStreams.get(this.tcpStreamKey(canonicalHostId, streamId));
    if (direct && (direct.hostId === canonicalHostId || direct.hostId === hostId)) {
      return direct;
    }
    if (canonicalHostId !== hostId) {
      const rawMatch = this.activeTcpStreams.get(this.tcpStreamKey(hostId, streamId));
      if (rawMatch && (rawMatch.hostId === hostId || rawMatch.hostId === canonicalHostId)) {
        return rawMatch;
      }
    }
    return undefined;
  }

  private sendChunked(ws: any, msgType: number, id: string, payload: Buffer): void {
    if (payload.length <= MAX_CHUNK_BYTES) {
      sendWsSafe(ws, encodeBinaryPacket(msgType, id, payload), { binary: true, compress: false });
      return;
    }

    let offset = 0;
    while (offset < payload.length) {
      const end = Math.min(offset + MAX_CHUNK_BYTES, payload.length);
      const slice = payload.subarray(offset, end);
      sendWsSafe(ws, encodeBinaryPacket(msgType, id, slice), { binary: true, compress: false });
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
      if (reqState.reqPauseTimer) {
        clearInterval(reqState.reqPauseTimer);
        reqState.reqPauseTimer = undefined;
      }
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
        const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId) || agentWs;
        if (currentAgentWs && currentAgentWs.readyState === 1) {
          try {
            sendControlFrame(currentAgentWs, { type: 'proxy_http_abort', reqId }, canonicalHostId);
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
    req.on('close', () => {
      if (!req.complete && !res.writableEnded) {
        onClientAbort();
      }
    });

    const method = (req.method || 'GET').toUpperCase();
    const isBodyless =
      method === 'GET' ||
      method === 'HEAD' ||
      (req.headers['content-length'] === '0' && !req.headers['transfer-encoding']);

    try {
      sendControlFrame(
        agentWs,
        {
          type: 'proxy_http_start',
          reqId,
          method: req.method || 'GET',
          url: options.targetUrl,
          headers: outboundHeaders,
          timeoutMs: options.timeoutMs,
          bodyEnd: isBodyless,
          insecure: options.insecure,
        },
        canonicalHostId
      );
    } catch (err: any) {
      cleanup();
      res.status(502).json({ error: `Failed to dispatch proxy request to agent: ${err.message}` });
      return;
    }

    if (!isBodyless) {
      req.on('data', (chunk: Buffer) => {
        if (!this.activeHttpRequests.has(reqId)) return;
        const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId) || agentWs;
        if (currentAgentWs && currentAgentWs.readyState === 1) {
          try {
            this.sendChunked(currentAgentWs, BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY, reqId, chunk);
            const isStreamEnded = req.readableEnded || Boolean((req as any)._readableState?.ended);
            if (
              !isStreamEnded &&
              typeof currentAgentWs.bufferedAmount === 'number' &&
              currentAgentWs.bufferedAmount >= 512 * 1024
            ) {
              if (!reqState.reqPauseTimer) {
                req.pause();
                reqState.reqPauseTimer = setInterval(() => {
                  const activeWs = terminalHostManager.getAgentWs(canonicalHostId) || currentAgentWs;
                  if (!this.activeHttpRequests.has(reqId) || !activeWs || activeWs.readyState !== 1) {
                    if (reqState.reqPauseTimer) {
                      clearInterval(reqState.reqPauseTimer);
                      reqState.reqPauseTimer = undefined;
                    }
                    return;
                  }
                  if (typeof activeWs.bufferedAmount !== 'number' || activeWs.bufferedAmount < 128 * 1024) {
                    if (reqState.reqPauseTimer) {
                      clearInterval(reqState.reqPauseTimer);
                      reqState.reqPauseTimer = undefined;
                    }
                    req.resume();
                  }
                }, 10);
                if (typeof reqState.reqPauseTimer.unref === 'function') {
                  reqState.reqPauseTimer.unref();
                }
              }
            }
          } catch {}
        }
      });

      req.on('end', () => {
        if (!this.activeHttpRequests.has(reqId)) return;
        const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId) || agentWs;
        if (currentAgentWs && currentAgentWs.readyState === 1) {
          try {
            sendControlFrame(currentAgentWs, { type: 'proxy_http_req_end', reqId }, canonicalHostId);
          } catch {}
        }
      });
    }
  }

  public handleAgentBinaryFrame(hostId: string, decoded: DecodedBinaryPacket): boolean {
    const canonicalHostId = this.resolveCanonicalHost(hostId);
    const matchesHost = (entryHostId: string) => entryHostId === hostId || entryHostId === canonicalHostId;

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY) {
      const state = this.activeHttpRequests.get(decoded.id);
      if (state && matchesHost(state.hostId) && !state.res.writableEnded) {
        const canContinue = state.res.write(decoded.payload);
        if (!canContinue || state.res.writableLength >= 256 * 1024) {
          if (!state.downstreamPaused) {
            state.downstreamPaused = true;
            const session = terminalHostManager.getSession(state.hostId);
            const agentWs = session?.getAgentWs();
            if (agentWs && agentWs.readyState === 1) {
              try {
                sendControlFrame(agentWs, { type: 'proxy_http_pause', reqId: state.reqId }, state.hostId);
              } catch {}
            }
            state.res.once('drain', () => {
              state.downstreamPaused = false;
              if (!this.activeHttpRequests.has(state.reqId)) return;
              const sess = terminalHostManager.getSession(state.hostId);
              const ws = sess?.getAgentWs();
              if (ws && ws.readyState === 1) {
                try {
                  sendControlFrame(ws, { type: 'proxy_http_resume', reqId: state.reqId }, state.hostId);
                } catch {}
              }
            });
          }
        }
      }
      return true;
    }

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA) {
      const state = this.getTcpStream(canonicalHostId, decoded.id);
      if (state && matchesHost(state.hostId) && state.cliWs && state.cliWs.readyState === 1) {
        try {
          sendWsSafe(
            state.cliWs,
            encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, decoded.id, decoded.payload),
            {
              binary: true,
              compress: false,
            }
          );
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
    const canonicalHostId = this.resolveCanonicalHost(hostId);
    const matchesHost = (entryHostId: string) => entryHostId === hostId || entryHostId === canonicalHostId;

    if (control.type === 'proxy_http_headers') {
      const state = typeof control.reqId === 'string' ? this.activeHttpRequests.get(control.reqId) : undefined;
      if (state && matchesHost(state.hostId)) {
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
      const state = typeof control.reqId === 'string' ? this.activeHttpRequests.get(control.reqId) : undefined;
      if (state && matchesHost(state.hostId)) {
        if (state.reqPauseTimer) {
          clearInterval(state.reqPauseTimer);
          state.reqPauseTimer = undefined;
        }
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
      const state = typeof control.streamId === 'string' ? this.getTcpStream(canonicalHostId, control.streamId) : undefined;
      if (state && matchesHost(state.hostId) && state.cliWs && state.cliWs.readyState === 1) {
        try {
          sendControlFrame(state.cliWs, control, state.hostId);
        } catch {}
      }
      return true;
    }

    if (control.type === 'proxy_tcp_close') {
      const state = typeof control.streamId === 'string' ? this.getTcpStream(canonicalHostId, control.streamId) : undefined;
      if (state && matchesHost(state.hostId)) {
        if (state.cliWs && state.cliWs.readyState === 1) {
          try {
            sendControlFrame(state.cliWs, control, state.hostId);
          } catch {}
        }
        this.cleanupTcpStream(state.hostId, control.streamId);
      }
      return true;
    }

    if (control.type === 'proxy_list_ports_res') {
      const pending = typeof control.reqId === 'string' ? this.pendingPortListRpcs.get(control.reqId) : undefined;
      if (pending && matchesHost(pending.hostId)) {
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

    if (control.type === 'proxy_net_ping_res') {
      const pending = typeof control.reqId === 'string' ? this.pendingPingRpcs.get(control.reqId) : undefined;
      if (pending && matchesHost(pending.hostId)) {
        clearTimeout(pending.timer);
        this.pendingPingRpcs.delete(control.reqId);
        const endNs = process.hrtime.bigint();
        const elapsedMs = Number(endNs - pending.startNs) / 1e6;
        pending.resolve({
          success: true,
          status: 200,
          hubAgentRttMs: Number(elapsedMs.toFixed(2)),
          agentTimestamp: control.agentTimestamp,
        });
      }
      return true;
    }

    if (control.type === 'proxy_net_probe_res') {
      const pending = typeof control.reqId === 'string' ? this.pendingProbeRpcs.get(control.reqId) : undefined;
      if (pending && matchesHost(pending.hostId)) {
        clearTimeout(pending.timer);
        this.pendingProbeRpcs.delete(control.reqId);
        if (control.success !== false) {
          pending.resolve({
            success: true,
            status: 200,
            results: control.results || [],
          });
        } else {
          pending.resolve({
            success: false,
            status: control.error && /disabled/i.test(control.error) ? 403 : 500,
            error: control.error || 'Failed to probe targets',
            results: [],
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
    const binaryControlParam = parsedUrl.searchParams.get('binaryControl');
    if (binaryControlParam === '1' || binaryControlParam === 'true') {
      (ws as any)._binaryControl = true;
    }

    const canonicalHostId = terminalHostManager.resolveCanonicalHostId(rawHostId);
    const host = canonicalHostId ? terminalHostManager.getHost(canonicalHostId) : null;
    const session = canonicalHostId ? terminalHostManager.getSession(canonicalHostId) : null;
    const initialAgentWs = session?.getAgentWs();

    if (!canonicalHostId || !host || host.status !== 'online' || !initialAgentWs || initialAgentWs.readyState !== 1) {
      try {
        sendControlFrame(
          ws,
          {
            type: 'proxy_tcp_close',
            streamId: '',
            error: 'Host is offline or unavailable',
            code: 'EHOSTUNREACH',
          },
          canonicalHostId || rawHostId
        );
        ws.close(1008, 'Host is offline or unavailable');
      } catch {}
      return;
    }

    this.cliToTcpStreams.set(ws, new Set());

    ws.on('message', (message: RawData, isBinary: boolean) => {
      try {
        const binaryFrame = isBinaryMessageFrame(message, isBinary);
        let control: any = null;

        if (binaryFrame) {
          const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
          const firstByte = buf.length > 0 ? buf[0] : -1;
          const decoded =
            firstByte === BIN_MSG_TYPE.CONTROL_JSON || firstByte === BIN_MSG_TYPE.PROXY_TCP_DATA
              ? decodeBinaryPacket(buf)
              : null;
          if (decoded && decoded.msgType === BIN_MSG_TYPE.CONTROL_JSON) {
            control = decodeControlJsonPacket(buf);
          } else if (decoded && decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA) {
            const streamState = this.getTcpStream(canonicalHostId, decoded.id);
            if (!streamState || streamState.cliWs !== ws || streamState.hostId !== canonicalHostId) {
              return;
            }
            const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId);
            if (currentAgentWs && currentAgentWs.readyState === 1) {
              sendWsSafe(currentAgentWs, buf, { binary: true, compress: false });
            }
            return;
          } else if (isBinary === true) {
            return;
          }
        }

        if (!control && isBinary !== true) {
          const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
          if (msgStr.startsWith('JSON:')) {
            try {
              control = JSON.parse(msgStr.slice(5));
            } catch {
              return;
            }
          }
        }

        if (!control || typeof control !== 'object' || typeof control.type !== 'string') {
          return;
        }

        if (control.type === 'ping') {
          sendControlFrame(ws, { type: 'pong' }, canonicalHostId);
          return;
        }

        const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId);

        if (control.type === 'proxy_tcp_connect') {
          const { streamId, host: targetHost = '127.0.0.1', port } = control;
          const validStreamId =
            typeof streamId === 'string' &&
            streamId.length > 0 &&
            !streamId.includes('\0') &&
            Buffer.byteLength(streamId, 'ascii') <= 255;
          const parsedPort = Number(port);
          const validPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
          const validHost = typeof targetHost === 'string' && targetHost.trim().length > 0;

          if (!validStreamId || !validPort || !validHost) {
            sendControlFrame(
              ws,
              {
                type: 'proxy_tcp_close',
                streamId: typeof streamId === 'string' ? streamId : '',
                error: 'Invalid proxy_tcp_connect parameters',
                code: 'EINVAL',
              },
              canonicalHostId
            );
            return;
          }

          if (!currentAgentWs || currentAgentWs.readyState !== 1) {
            sendControlFrame(
              ws,
              {
                type: 'proxy_tcp_close',
                streamId,
                error: 'Agent is offline or unavailable',
                code: 'EHOSTUNREACH',
              },
              canonicalHostId
            );
            return;
          }

          const streamKey = this.tcpStreamKey(canonicalHostId, streamId);
          if (this.activeTcpStreams.has(streamKey)) {
            sendControlFrame(
              ws,
              {
                type: 'proxy_tcp_close',
                streamId,
                error: 'Duplicate streamId already active',
                code: 'EEXIST',
              },
              canonicalHostId
            );
            return;
          }

          this.activeTcpStreams.set(streamKey, {
            streamId,
            hostId: canonicalHostId,
            cliWs: ws,
          });

          if (!this.hostToTcpStreams.has(canonicalHostId)) {
            this.hostToTcpStreams.set(canonicalHostId, new Set());
          }
          this.hostToTcpStreams.get(canonicalHostId)!.add(streamId);
          this.cliToTcpStreams.get(ws)?.add(streamId);

          sendControlFrame(currentAgentWs, control, canonicalHostId);
          return;
        }

        if (control.type === 'proxy_tcp_close') {
          const { streamId } = control;
          const streamState = typeof streamId === 'string' ? this.getTcpStream(canonicalHostId, streamId) : undefined;
          if (!streamState || streamState.cliWs !== ws || streamState.hostId !== canonicalHostId) {
            return;
          }
          if (currentAgentWs && currentAgentWs.readyState === 1) {
            sendControlFrame(currentAgentWs, control, canonicalHostId);
          }
          this.cleanupTcpStream(canonicalHostId, streamId);
          return;
        }
      } catch (err: any) {
        logger.error(`[TerminalProxyBridge] Error handling CLI WS message: ${err.message}`);
      }
    });

    const cleanupCli = () => {
      const streams = this.cliToTcpStreams.get(ws);
      if (streams) {
        const currentAgentWs = terminalHostManager.getAgentWs(canonicalHostId);
        for (const streamId of Array.from(streams)) {
          if (currentAgentWs && currentAgentWs.readyState === 1) {
            try {
              sendControlFrame(currentAgentWs, { type: 'proxy_tcp_close', streamId }, canonicalHostId);
            } catch {}
          }
          this.cleanupTcpStream(canonicalHostId, streamId);
        }
        this.cliToTcpStreams.delete(ws);
      }
    };

    ws.on('close', cleanupCli);
    ws.on('error', cleanupCli);
  }

  private cleanupTcpStream(hostId: string, streamId: string): void {
    const key = this.tcpStreamKey(hostId, streamId);
    const state = this.activeTcpStreams.get(key);
    if (!state) return;

    this.activeTcpStreams.delete(key);

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
    const canonicalHostId = this.resolveCanonicalHost(hostId);
    const hostKeys = canonicalHostId !== hostId ? [hostId, canonicalHostId] : [hostId];

    for (const targetHostId of hostKeys) {
      const reqIds = this.hostToHttpRequests.get(targetHostId);
      if (reqIds) {
        for (const reqId of Array.from(reqIds)) {
          const state = this.activeHttpRequests.get(reqId);
          if (state) {
            if (state.reqPauseTimer) {
              clearInterval(state.reqPauseTimer);
              state.reqPauseTimer = undefined;
            }
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
        this.hostToHttpRequests.delete(targetHostId);
      }

      const streamIds = this.hostToTcpStreams.get(targetHostId);
      if (streamIds) {
        for (const streamId of Array.from(streamIds)) {
          const state = this.getTcpStream(targetHostId, streamId);
          if (state) {
            if (state.cliWs && state.cliWs.readyState === 1) {
              sendControlFrame(
                state.cliWs,
                {
                  type: 'proxy_tcp_close',
                  streamId,
                  error: 'Agent disconnected',
                  code: 'ECONNRESET',
                },
                targetHostId
              );
            }
            this.cleanupTcpStream(state.hostId, streamId);
          }
        }
        this.hostToTcpStreams.delete(targetHostId);
      }
    }

    const matchesDisconnectedHost = (entryHostId: string) =>
      entryHostId === hostId || entryHostId === canonicalHostId;

    for (const [reqId, pending] of Array.from(this.pendingPortListRpcs.entries())) {
      if (matchesDisconnectedHost(pending.hostId)) {
        clearTimeout(pending.timer);
        this.pendingPortListRpcs.delete(reqId);
        pending.resolve({
          success: false,
          status: 502,
          error: 'Agent disconnected',
        });
      }
    }

    for (const [reqId, pending] of Array.from(this.pendingPingRpcs.entries())) {
      if (matchesDisconnectedHost(pending.hostId)) {
        clearTimeout(pending.timer);
        this.pendingPingRpcs.delete(reqId);
        pending.resolve({
          success: false,
          status: 502,
          error: 'Agent disconnected',
        });
      }
    }

    for (const [reqId, pending] of Array.from(this.pendingProbeRpcs.entries())) {
      if (matchesDisconnectedHost(pending.hostId)) {
        clearTimeout(pending.timer);
        this.pendingProbeRpcs.delete(reqId);
        pending.resolve({
          success: false,
          status: 502,
          error: 'Agent disconnected',
        });
      }
    }
  }

  public pingAgent(
    hostId: string,
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; status?: number; hubAgentRttMs?: number; agentTimestamp?: number; error?: string }> {
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
      const reqId = `ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startNs = process.hrtime.bigint();
      const timer = setTimeout(() => {
        this.pendingPingRpcs.delete(reqId);
        resolve({
          success: false,
          status: 504,
          error: 'Timeout waiting for ping response from agent',
        });
      }, timeoutMs);

      this.pendingPingRpcs.set(reqId, {
        hostId: canonicalHostId,
        startNs,
        timer,
        resolve,
      });

      try {
        sendControlFrame(agentWs, { type: 'proxy_net_ping', reqId }, canonicalHostId);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingPingRpcs.delete(reqId);
        resolve({
          success: false,
          status: 502,
          error: `Failed to send ping request: ${err.message}`,
        });
      }
    });
  }

  public probeTargets(
    hostId: string,
    targets?: string[],
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; status?: number; results?: TargetProbeResult[]; error?: string }> {
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
      const reqId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pendingProbeRpcs.delete(reqId);
        resolve({
          success: false,
          status: 504,
          error: 'Timeout waiting for probe response from agent',
        });
      }, timeoutMs);

      this.pendingProbeRpcs.set(reqId, {
        hostId: canonicalHostId,
        timer,
        resolve,
      });

      try {
        sendControlFrame(
          agentWs,
          {
            type: 'proxy_net_probe',
            reqId,
            targets,
            timeoutMs: Math.max(1000, timeoutMs - 1000),
          },
          canonicalHostId
        );
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingProbeRpcs.delete(reqId);
        resolve({
          success: false,
          status: 502,
          error: `Failed to send probe request: ${err.message}`,
        });
      }
    });
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
        sendControlFrame(agentWs, { type: 'proxy_list_ports', reqId }, canonicalHostId);
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
