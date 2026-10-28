import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';
import {
  BIN_MSG_TYPE,
  DecodedBinaryPacket,
  encodeBinaryPacket,
} from '../../shared/protocol/binaryProtocol';

const MAX_CHUNK_BYTES = 32 * 1024;
const DEFAULT_MAX_CONCURRENT = 128;
const HIGH_WATERMARK_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const LOW_WATERMARK_BUFFERED_AMOUNT = 1 * 1024 * 1024;

export interface ProxyHandlerOptions {
  send: (data: string | Buffer) => void;
  getBufferedAmount?: () => number;
  onActivity?: () => void;
  allowProxy?: boolean;
  maxConcurrentStreams?: number;
}

interface HttpRequestState {
  req: http.ClientRequest;
  res?: http.IncomingMessage;
  pauseInterval?: NodeJS.Timeout;
}

interface TcpSocketState {
  socket: net.Socket;
  pauseInterval?: NodeJS.Timeout;
}

export class ProxyHandler {
  private options: ProxyHandlerOptions;
  private activeHttpRequests = new Map<string, HttpRequestState>();
  private activeTcpSockets = new Map<string, TcpSocketState>();

  constructor(options: ProxyHandlerOptions) {
    this.options = options;
  }

  private sendControl(msg: any): void {
    this.options.send(`JSON:${JSON.stringify(msg)}`);
  }

  private sendChunked(msgType: number, id: string, payload: Buffer): void {
    if (payload.length <= MAX_CHUNK_BYTES) {
      this.options.send(encodeBinaryPacket(msgType, id, payload));
      return;
    }

    let offset = 0;
    while (offset < payload.length) {
      const end = Math.min(offset + MAX_CHUNK_BYTES, payload.length);
      const slice = payload.subarray(offset, end);
      this.options.send(encodeBinaryPacket(msgType, id, slice));
      offset = end;
    }
  }

  private getActiveTotal(): number {
    return this.activeHttpRequests.size + this.activeTcpSockets.size;
  }

  public getActiveCount(): { httpCount: number; tcpCount: number } {
    return {
      httpCount: this.activeHttpRequests.size,
      tcpCount: this.activeTcpSockets.size,
    };
  }

  public handleControlMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return false;
    }

    switch (msg.type) {
      case 'proxy_http_start': {
        this.handleHttpStart(msg);
        return true;
      }
      case 'proxy_http_req_end': {
        this.handleHttpReqEnd(msg);
        return true;
      }
      case 'proxy_http_abort': {
        this.handleHttpAbort(msg);
        return true;
      }
      case 'proxy_tcp_connect': {
        this.handleTcpConnect(msg);
        return true;
      }
      case 'proxy_tcp_close': {
        this.handleTcpClose(msg);
        return true;
      }
      default:
        return false;
    }
  }

  public handleBinaryFrame(decoded: DecodedBinaryPacket): boolean {
    if (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY) {
      const state = this.activeHttpRequests.get(decoded.id);
      if (state) {
        this.options.onActivity?.();
        try {
          state.req.write(decoded.payload);
        } catch {}
      }
      return true;
    }

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA) {
      const state = this.activeTcpSockets.get(decoded.id);
      if (state) {
        this.options.onActivity?.();
        try {
          state.socket.write(decoded.payload);
        } catch {}
      }
      return true;
    }

    if (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY) {
      return true;
    }

    return false;
  }

  private handleHttpStart(msg: any): void {
    const { reqId, method = 'GET', url: targetUrl, headers = {}, timeoutMs = 60000, bodyEnd, insecure } = msg;

    if (this.options.allowProxy === false) {
      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: 'Proxy disabled on this agent',
        code: 'EACCES',
      });
      return;
    }

    const maxConcurrent = this.options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT;
    if (this.getActiveTotal() >= maxConcurrent) {
      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: 'Max concurrent proxy streams exceeded',
        code: 'EMFILE',
      });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err: any) {
      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: `Invalid URL: ${err.message}`,
        code: 'EINVAL',
      });
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: `Unsupported protocol: ${parsedUrl.protocol}`,
        code: 'EPROTONOSUPPORT',
      });
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    let agent: http.Agent | https.Agent | undefined = undefined;
    if (isHttps && insecure) {
      agent = new https.Agent({ rejectUnauthorized: false });
    }

    const outboundHeaders: Record<string, string | string[]> = { ...headers };
    if (!outboundHeaders.host) {
      outboundHeaders.host = parsedUrl.host;
    }

    const req = transport.request(parsedUrl, {
      method,
      headers: outboundHeaders,
      agent,
      timeout: timeoutMs,
    });

    const state: HttpRequestState = { req };
    this.activeHttpRequests.set(reqId, state);

    const cleanup = () => {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      this.activeHttpRequests.delete(reqId);
    };

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' }));
    });

    req.on('response', (res) => {
      state.res = res;
      this.options.onActivity?.();

      this.sendControl({
        type: 'proxy_http_headers',
        reqId,
        statusCode: res.statusCode || 200,
        statusMessage: res.statusMessage || '',
        headers: res.headers,
      });

      res.on('data', (chunk: Buffer) => {
        this.options.onActivity?.();
        this.sendChunked(BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, reqId, chunk);

        if (
          this.options.getBufferedAmount &&
          this.options.getBufferedAmount() > HIGH_WATERMARK_BUFFERED_AMOUNT
        ) {
          if (!state.pauseInterval) {
            res.pause();
            state.pauseInterval = setInterval(() => {
              if (
                !this.options.getBufferedAmount ||
                this.options.getBufferedAmount() < LOW_WATERMARK_BUFFERED_AMOUNT
              ) {
                if (state.pauseInterval) {
                  clearInterval(state.pauseInterval);
                  state.pauseInterval = undefined;
                }
                res.resume();
              }
            }, 50);
            if (typeof state.pauseInterval.unref === 'function') {
              state.pauseInterval.unref();
            }
          }
        }
      });

      res.on('end', () => {
        this.options.onActivity?.();
        this.sendControl({
          type: 'proxy_http_end',
          reqId,
        });
        cleanup();
      });

      res.on('error', (err: any) => {
        this.sendControl({
          type: 'proxy_http_end',
          reqId,
          error: err.message,
          code: err.code || 'ECONNRESET',
        });
        cleanup();
      });
    });

    req.on('error', (err: any) => {
      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: err.message,
        code: err.code || 'ECONNRESET',
      });
      cleanup();
    });

    if (bodyEnd) {
      req.end();
    }
  }

  private handleHttpReqEnd(msg: any): void {
    const { reqId } = msg;
    const state = this.activeHttpRequests.get(reqId);
    if (state) {
      this.options.onActivity?.();
      try {
        state.req.end();
      } catch {}
    }
  }

  private handleHttpAbort(msg: any): void {
    const { reqId } = msg;
    const state = this.activeHttpRequests.get(reqId);
    if (state) {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      try {
        state.req.destroy();
      } catch {}
      this.activeHttpRequests.delete(reqId);
    }
  }

  private handleTcpConnect(msg: any): void {
    const { streamId, host = '127.0.0.1', port, timeoutMs } = msg;

    if (this.options.allowProxy === false) {
      this.sendControl({
        type: 'proxy_tcp_close',
        streamId,
        error: 'Proxy disabled on this agent',
        code: 'EACCES',
      });
      return;
    }

    const maxConcurrent = this.options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT;
    if (this.getActiveTotal() >= maxConcurrent) {
      this.sendControl({
        type: 'proxy_tcp_close',
        streamId,
        error: 'Max concurrent proxy streams exceeded',
        code: 'EMFILE',
      });
      return;
    }

    const parsedPort = Number(port);
    const socket = net.createConnection({ host, port: parsedPort });
    const state: TcpSocketState = { socket };
    this.activeTcpSockets.set(streamId, state);

    let connectTimer: NodeJS.Timeout | null = null;
    if (timeoutMs) {
      connectTimer = setTimeout(() => {
        socket.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      if (typeof connectTimer.unref === 'function') {
        connectTimer.unref();
      }
    }

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      this.activeTcpSockets.delete(streamId);
    };

    socket.on('connect', () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      this.options.onActivity?.();
      this.sendControl({
        type: 'proxy_tcp_connected',
        streamId,
      });
    });

    socket.on('data', (chunk: Buffer) => {
      this.options.onActivity?.();
      this.sendChunked(BIN_MSG_TYPE.PROXY_TCP_DATA, streamId, chunk);

      if (
        this.options.getBufferedAmount &&
        this.options.getBufferedAmount() > HIGH_WATERMARK_BUFFERED_AMOUNT
      ) {
        if (!state.pauseInterval) {
          socket.pause();
          state.pauseInterval = setInterval(() => {
            if (
              !this.options.getBufferedAmount ||
              this.options.getBufferedAmount() < LOW_WATERMARK_BUFFERED_AMOUNT
            ) {
              if (state.pauseInterval) {
                clearInterval(state.pauseInterval);
                state.pauseInterval = undefined;
              }
              socket.resume();
            }
          }, 50);
          if (typeof state.pauseInterval.unref === 'function') {
            state.pauseInterval.unref();
          }
        }
      }
    });

    socket.on('error', (err: any) => {
      this.sendControl({
        type: 'proxy_tcp_close',
        streamId,
        error: err.message,
        code: err.code || 'ECONNRESET',
      });
      cleanup();
    });

    socket.on('close', () => {
      if (this.activeTcpSockets.has(streamId)) {
        this.sendControl({
          type: 'proxy_tcp_close',
          streamId,
        });
        cleanup();
      }
    });
  }

  private handleTcpClose(msg: any): void {
    const { streamId } = msg;
    const state = this.activeTcpSockets.get(streamId);
    if (state) {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      try {
        state.socket.destroy();
      } catch {}
      this.activeTcpSockets.delete(streamId);
    }
  }

  public destroyAll(): void {
    for (const [reqId, state] of this.activeHttpRequests.entries()) {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
      }
      try {
        state.req.destroy();
      } catch {}
    }
    this.activeHttpRequests.clear();

    for (const [streamId, state] of this.activeTcpSockets.entries()) {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
      }
      try {
        state.socket.destroy();
      } catch {}
    }
    this.activeTcpSockets.clear();
  }
}
