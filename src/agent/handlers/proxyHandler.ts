import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import { exec } from 'child_process';
import { URL } from 'url';
import {
  BIN_MSG_TYPE,
  DecodedBinaryPacket,
  encodeBinaryPacket,
} from '../../shared/protocol/binaryProtocol';

const MAX_CHUNK_BYTES = 32 * 1024;
const DEFAULT_MAX_CONCURRENT = 128;
const HIGH_WATERMARK_BUFFERED_AMOUNT = 512 * 1024;
const LOW_WATERMARK_BUFFERED_AMOUNT = 128 * 1024;
const SPEEDTEST_MAX_BUFFERED_AMOUNT = 256 * 1024;
const SPEEDTEST_CHUNKS_PER_TICK = 2;

export interface ListeningPortInfo {
  port: number;
  address: string;
  pid?: number;
  process?: string;
}

export interface TargetProbeResult {
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export const DEFAULT_PROBE_TARGETS: string[] = [
  'https://1.1.1.1/cdn-cgi/trace',
  'https://api.github.com',
  'https://www.google.com/generate_204',
  'https://registry.npmjs.org/-/ping',
];

export async function probeOutboundTarget(
  targetUrl: string,
  timeoutMs: number = 8000
): Promise<TargetProbeResult> {
  const start = Date.now();
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        url: targetUrl,
        ok: false,
        latencyMs: Math.max(1, Date.now() - start),
        error: `Unsupported protocol: ${parsed.protocol}`,
      };
    }
  } catch (err: any) {
    return {
      url: targetUrl,
      ok: false,
      latencyMs: Math.max(1, Date.now() - start),
      error: `Invalid URL: ${err.message}`,
    };
  }

  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: TargetProbeResult) => {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    const req = transport.request(parsed, {
      method: 'GET',
      headers: {
        'User-Agent': 'gt-agent-probe/1.0',
        Accept: '*/*',
      },
    });

    timer = setTimeout(() => {
      req.destroy(new Error('Request timed out'));
      finish({
        url: targetUrl,
        ok: false,
        latencyMs: Math.max(1, Date.now() - start),
        error: 'Request timed out',
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    req.on('response', (res) => {
      const latencyMs = Math.max(1, Date.now() - start);
      const statusCode = res.statusCode;
      const ok = statusCode !== undefined && statusCode >= 200 && statusCode < 400;
      res.destroy();
      finish({
        url: targetUrl,
        ok,
        statusCode,
        latencyMs,
      });
    });

    req.on('error', (err: any) => {
      finish({
        url: targetUrl,
        ok: false,
        latencyMs: Math.max(1, Date.now() - start),
        error: err.message || 'Connection failed',
      });
    });

    req.end();
  });
}

export function parseProcNetTcp(content: string, isIpv6: boolean = false): ListeningPortInfo[] {
  const lines = content.split('\n');
  const results: ListeningPortInfo[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    // Col 1 is local_address: <hex_ip>:<hex_port>
    // Col 3 is st: connection state (0A = TCP_LISTEN)
    const localAddr = parts[1];
    const state = parts[3];
    if (state.toUpperCase() !== '0A') continue;

    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;

    const hexIp = localAddr.slice(0, lastColon);
    const hexPort = localAddr.slice(lastColon + 1);
    const port = parseInt(hexPort, 16);
    if (isNaN(port) || port < 1 || port > 65535) continue;

    let address = '0.0.0.0';
    if (isIpv6 || hexIp.length === 32) {
      if (/^0+$/.test(hexIp)) {
        address = '::';
      } else {
        try {
          const buf = Buffer.alloc(16);
          for (let j = 0; j < 4; j++) {
            const wordHex = hexIp.slice(j * 8, (j + 1) * 8);
            buf.writeUInt32LE(parseInt(wordHex, 16) || 0, j * 4);
          }
          let isIpv4Mapped = true;
          for (let j = 0; j < 10; j++) {
            if (buf[j] !== 0) { isIpv4Mapped = false; break; }
          }
          if (isIpv4Mapped && buf[10] === 0xff && buf[11] === 0xff) {
            address = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
          } else {
            let isLoopback = true;
            for (let j = 0; j < 15; j++) {
              if (buf[j] !== 0) { isLoopback = false; break; }
            }
            if (isLoopback && buf[15] === 1) {
              address = '::1';
            } else {
              const groups: string[] = [];
              for (let j = 0; j < 16; j += 2) {
                groups.push(buf.readUInt16BE(j).toString(16));
              }
              address = groups.join(':');
            }
          }
        } catch {
          address = '::';
        }
      }
    } else {
      if (hexIp.length === 8) {
        const octet1 = parseInt(hexIp.slice(6, 8), 16);
        const octet2 = parseInt(hexIp.slice(4, 6), 16);
        const octet3 = parseInt(hexIp.slice(2, 4), 16);
        const octet4 = parseInt(hexIp.slice(0, 2), 16);
        address = `${octet1}.${octet2}.${octet3}.${octet4}`;
      }
    }

    results.push({ port, address });
  }

  return results;
}

function deduplicateAndSortPorts(ports: ListeningPortInfo[]): ListeningPortInfo[] {
  const map = new Map<number, ListeningPortInfo>();
  for (const item of ports) {
    if (isNaN(item.port) || item.port < 1 || item.port > 65535) continue;
    const existing = map.get(item.port);
    if (!existing) {
      map.set(item.port, { ...item });
      continue;
    }
    const existingScore =
      (existing.process ? 10 : 0) +
      (existing.pid ? 5 : 0) +
      (!existing.address.includes(':') ? 2 : 0) +
      (existing.address === '127.0.0.1' ? 1 : 0);
    const itemScore =
      (item.process ? 10 : 0) +
      (item.pid ? 5 : 0) +
      (!item.address.includes(':') ? 2 : 0) +
      (item.address === '127.0.0.1' ? 1 : 0);

    if (itemScore > existingScore) {
      map.set(item.port, {
        port: item.port,
        address: item.address,
        pid: item.pid ?? existing.pid,
        process: item.process ?? existing.process,
      });
    } else {
      if (!existing.process && item.process) existing.process = item.process;
      if (!existing.pid && item.pid) existing.pid = item.pid;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.port - b.port);
}

export async function scanListeningTcpPorts(): Promise<ListeningPortInfo[]> {
  const discovered: ListeningPortInfo[] = [];

  const runCmd = (cmd: string): Promise<string> => {
    return new Promise((resolve) => {
      exec(cmd, { timeout: 3000 }, (error, stdout) => {
        if (error) {
          resolve('');
        } else {
          resolve(stdout || '');
        }
      });
    });
  };

  try {
    if (process.platform === 'linux') {
      const ssOutput = await runCmd('ss -tlnp');
      if (ssOutput) {
        const lines = ssOutput.split('\n');
        for (const line of lines) {
          if (!line.includes('LISTEN')) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            const localPart = parts[3];
            const lastColon = localPart.lastIndexOf(':');
            if (lastColon !== -1) {
              let addr = localPart.slice(0, lastColon);
              if (addr.startsWith('[') && addr.endsWith(']')) {
                addr = addr.slice(1, -1);
              }
              if (addr === '*') addr = '0.0.0.0';
              const port = parseInt(localPart.slice(lastColon + 1), 10);
              if (!isNaN(port) && port >= 1 && port <= 65535) {
                let procName: string | undefined;
                let pidNum: number | undefined;
                const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
                if (procMatch) {
                  procName = procMatch[1];
                  pidNum = parseInt(procMatch[2], 10);
                }
                discovered.push({
                  port,
                  address: addr,
                  pid: pidNum,
                  process: procName,
                });
              }
            }
          }
        }
      }

      try {
        const tcpContent = await fs.promises.readFile('/proc/net/tcp', 'utf-8');
        discovered.push(...parseProcNetTcp(tcpContent, false));
      } catch {}

      try {
        const tcp6Content = await fs.promises.readFile('/proc/net/tcp6', 'utf-8');
        discovered.push(...parseProcNetTcp(tcp6Content, true));
      } catch {}
    } else if (process.platform === 'darwin') {
      const lsofOutput = await runCmd('lsof -iTCP -sTCP:LISTEN -P -n');
      if (lsofOutput) {
        const lines = lsofOutput.split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || !line.includes('(LISTEN)')) continue;
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const procName = parts[0];
            const pidNum = parseInt(parts[1], 10);
            const match = line.match(/TCP\s+([^:]+|\[[^\]]+\]):(\d+)\s+\(LISTEN\)/);
            if (match) {
              let addr = match[1];
              if (addr.startsWith('[') && addr.endsWith(']')) {
                addr = addr.slice(1, -1);
              }
              if (addr === '*') addr = '0.0.0.0';
              const port = parseInt(match[2], 10);
              if (!isNaN(port) && port >= 1 && port <= 65535) {
                discovered.push({
                  port,
                  address: addr,
                  pid: isNaN(pidNum) ? undefined : pidNum,
                  process: procName,
                });
              }
            }
          }
        }
      }
    } else if (process.platform === 'win32') {
      const netstatOutput = await runCmd('netstat -ano -p tcp');
      if (netstatOutput) {
        const lines = netstatOutput.split('\n');
        for (const line of lines) {
          const match = line.match(/^\s*TCP\s+([^\s:]+|\[[^\]]+\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (match) {
            let addr = match[1];
            if (addr.startsWith('[') && addr.endsWith(']')) {
              addr = addr.slice(1, -1);
            }
            if (addr === '*') addr = '0.0.0.0';
            const port = parseInt(match[2], 10);
            const pidNum = parseInt(match[3], 10);
            if (!isNaN(port) && port >= 1 && port <= 65535) {
              discovered.push({
                port,
                address: addr,
                pid: isNaN(pidNum) ? undefined : pidNum,
              });
            }
          }
        }
      }
    }
  } catch {}

  return deduplicateAndSortPorts(discovered);
}

export interface ProxyHandlerOptions {
  send: (data: string | Buffer, options?: { binary?: boolean; compress?: boolean }) => void;
  getBufferedAmount?: () => number;
  onActivity?: () => void;
  allowProxy?: boolean;
  maxConcurrentStreams?: number;
}

interface HttpRequestState {
  req?: http.ClientRequest;
  res?: http.IncomingMessage;
  pauseInterval?: NodeJS.Timeout;
  stepTimer?: NodeJS.Timeout;
  isSpeedtest?: boolean;
  speedtestAborted?: boolean;
  downstreamPaused?: boolean;
  resumeNext?: () => void;
  receivedBytes?: number;
  startTime?: number;
}

interface TcpSocketState {
  socket: net.Socket;
  pauseInterval?: NodeJS.Timeout;
}

export class ProxyHandler {
  private options: ProxyHandlerOptions;
  private activeHttpRequests = new Map<string, HttpRequestState>();
  private activeTcpSockets = new Map<string, TcpSocketState>();
  private randomSeedBuffer: Buffer;
  private randomChunkCounter: number = 0;

  constructor(options: ProxyHandlerOptions) {
    this.options = options;
    this.randomSeedBuffer = crypto.randomBytes(32 * 1024);
  }

  private getNextRandomChunk(size: number = 32 * 1024): Buffer {
    this.randomChunkCounter = (this.randomChunkCounter + 1) >>> 0;
    this.randomSeedBuffer.writeUInt32LE(
      (this.randomSeedBuffer.readUInt32LE(0) ^ this.randomChunkCounter) >>> 0,
      0
    );
    return Buffer.from(this.randomSeedBuffer.subarray(0, size));
  }

  private sendControl(msg: any): void {
    this.options.send(`JSON:${JSON.stringify(msg)}`);
  }

  private sendChunked(msgType: number, id: string, payload: Buffer): void {
    if (payload.length <= MAX_CHUNK_BYTES) {
      this.options.send(encodeBinaryPacket(msgType, id, payload), { binary: true, compress: false });
      return;
    }

    let offset = 0;
    while (offset < payload.length) {
      const end = Math.min(offset + MAX_CHUNK_BYTES, payload.length);
      const slice = payload.subarray(offset, end);
      this.options.send(encodeBinaryPacket(msgType, id, slice), { binary: true, compress: false });
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
      case 'proxy_http_pause': {
        const state = this.activeHttpRequests.get(msg.reqId);
        if (state) {
          state.downstreamPaused = true;
          if (state.res) {
            try {
              state.res.pause();
            } catch {}
          }
        }
        return true;
      }
      case 'proxy_http_resume': {
        const state = this.activeHttpRequests.get(msg.reqId);
        if (state) {
          state.downstreamPaused = false;
          if (state.res && !state.pauseInterval) {
            try {
              state.res.resume();
            } catch {}
          }
          if (state.resumeNext) {
            state.resumeNext();
          }
        }
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
      case 'proxy_list_ports': {
        this.handleListPorts(msg);
        return true;
      }
      case 'proxy_net_ping': {
        this.handleNetPing(msg);
        return true;
      }
      case 'proxy_net_probe': {
        this.handleNetProbe(msg);
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
        if (state.isSpeedtest) {
          state.receivedBytes = (state.receivedBytes || 0) + decoded.payload.length;
        } else if (state.req) {
          try {
            state.req.write(decoded.payload);
          } catch {}
        }
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

    if (parsedUrl.hostname === 'internal.speedtest') {
      if (parsedUrl.pathname === '/download') {
        const rawBytes = parseInt(parsedUrl.searchParams.get('bytes') || '', 10);
        const totalBytes = Math.min(
          256 * 1024 * 1024,
          Math.max(64 * 1024, isNaN(rawBytes) ? 16 * 1024 * 1024 : rawBytes)
        );

        const state: HttpRequestState = {
          isSpeedtest: true,
          speedtestAborted: false,
        };
        this.activeHttpRequests.set(reqId, state);

        this.sendControl({
          type: 'proxy_http_headers',
          reqId,
          statusCode: 200,
          statusMessage: 'OK',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(totalBytes),
            'cache-control': 'no-store',
          },
        });

        let sentBytes = 0;
        let isScheduled = false;

        const scheduleNext = (delayMs: number = 1) => {
          if (isScheduled || !this.activeHttpRequests.has(reqId) || state.speedtestAborted) {
            return;
          }
          isScheduled = true;
          state.stepTimer = setTimeout(() => {
            isScheduled = false;
            state.stepTimer = undefined;
            sendNext();
          }, delayMs);
          if (typeof state.stepTimer.unref === 'function') {
            state.stepTimer.unref();
          }
        };

        const sendNext = () => {
          if (!this.activeHttpRequests.has(reqId) || state.speedtestAborted || state.downstreamPaused) {
            return;
          }

          let chunksSentThisTick = 0;
          while (sentBytes < totalBytes && chunksSentThisTick < SPEEDTEST_CHUNKS_PER_TICK) {
            if (!this.activeHttpRequests.has(reqId) || state.speedtestAborted || state.downstreamPaused) {
              return;
            }
            const buffered = this.options.getBufferedAmount ? this.options.getBufferedAmount() : 0;
            if (buffered >= SPEEDTEST_MAX_BUFFERED_AMOUNT) {
              scheduleNext(5);
              return;
            }

            const chunkSize = Math.min(MAX_CHUNK_BYTES, totalBytes - sentBytes);
            const chunk = this.getNextRandomChunk(chunkSize);
            this.options.onActivity?.();
            this.sendChunked(BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, reqId, chunk);
            sentBytes += chunkSize;
            chunksSentThisTick++;
          }

          if (sentBytes < totalBytes) {
            if (!state.downstreamPaused && !state.speedtestAborted && this.activeHttpRequests.has(reqId)) {
              const buffered = this.options.getBufferedAmount ? this.options.getBufferedAmount() : 0;
              scheduleNext(buffered > 64 * 1024 ? 2 : 0);
            }
            return;
          }

          if (this.activeHttpRequests.has(reqId) && !state.speedtestAborted) {
            this.options.onActivity?.();
            this.sendControl({
              type: 'proxy_http_end',
              reqId,
            });
            this.activeHttpRequests.delete(reqId);
          }
        };

        state.resumeNext = () => {
          scheduleNext(0);
        };

        scheduleNext(0);
        return;
      }

      if (parsedUrl.pathname === '/upload') {
        const state: HttpRequestState = {
          isSpeedtest: true,
          speedtestAborted: false,
          receivedBytes: 0,
          startTime: Date.now(),
        };
        this.activeHttpRequests.set(reqId, state);
        if (bodyEnd) {
          this.handleHttpReqEnd({ reqId });
        }
        return;
      }

      this.sendControl({
        type: 'proxy_http_end',
        reqId,
        error: `Unknown internal speedtest endpoint: ${parsedUrl.pathname}`,
        code: 'ENOENT',
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
      if (state.isSpeedtest) {
        const receivedBytes = state.receivedBytes || 0;
        const durationMs = Math.max(1, Date.now() - (state.startTime || Date.now()));
        const resBody = Buffer.from(
          JSON.stringify({ receivedBytes, agentDurationMs: durationMs })
        );
        this.sendControl({
          type: 'proxy_http_headers',
          reqId,
          statusCode: 200,
          statusMessage: 'OK',
          headers: {
            'content-type': 'application/json',
            'content-length': String(resBody.length),
            'cache-control': 'no-store',
          },
        });
        this.sendChunked(BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, reqId, resBody);
        this.sendControl({
          type: 'proxy_http_end',
          reqId,
        });
        this.activeHttpRequests.delete(reqId);
        return;
      }
      try {
        state.req?.end();
      } catch {}
    }
  }

  private handleHttpAbort(msg: any): void {
    const { reqId } = msg;
    const state = this.activeHttpRequests.get(reqId);
    if (state) {
      state.speedtestAborted = true;
      if (state.stepTimer) {
        clearTimeout(state.stepTimer);
        state.stepTimer = undefined;
      }
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      try {
        state.req?.destroy();
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

  private handleListPorts(msg: any): void {
    const reqId = msg?.reqId;
    if (!reqId) return;

    if (this.options.allowProxy === false) {
      this.sendControl({
        type: 'proxy_list_ports_res',
        reqId,
        success: false,
        error: 'Proxy disabled on this agent',
        ports: [],
      });
      return;
    }

    scanListeningTcpPorts()
      .then((ports) => {
        this.sendControl({
          type: 'proxy_list_ports_res',
          reqId,
          success: true,
          ports,
        });
      })
      .catch((err) => {
        this.sendControl({
          type: 'proxy_list_ports_res',
          reqId,
          success: false,
          error: err?.message || 'Failed to scan ports',
          ports: [],
        });
      });
  }

  private handleNetPing(msg: any): void {
    const reqId = msg?.reqId;
    if (!reqId) return;
    this.options.onActivity?.();
    this.sendControl({
      type: 'proxy_net_ping_res',
      reqId,
      agentTimestamp: Date.now(),
    });
  }

  private handleNetProbe(msg: any): void {
    const reqId = msg?.reqId;
    if (!reqId) return;

    if (this.options.allowProxy === false) {
      this.sendControl({
        type: 'proxy_net_probe_res',
        reqId,
        success: false,
        error: 'Proxy disabled on this agent',
        results: [],
      });
      return;
    }

    const rawTargets = Array.isArray(msg.targets) && msg.targets.length > 0
      ? msg.targets
      : DEFAULT_PROBE_TARGETS;
    const timeoutMs = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 8000;

    this.options.onActivity?.();
    Promise.all(rawTargets.map((t: string) => probeOutboundTarget(String(t), timeoutMs)))
      .then((results) => {
        this.sendControl({
          type: 'proxy_net_probe_res',
          reqId,
          success: true,
          results,
        });
      })
      .catch((err) => {
        this.sendControl({
          type: 'proxy_net_probe_res',
          reqId,
          success: false,
          error: err?.message || 'Outbound probe failed',
          results: [],
        });
      });
  }

  public destroyAll(): void {
    for (const [reqId, state] of this.activeHttpRequests.entries()) {
      state.speedtestAborted = true;
      if (state.stepTimer) {
        clearTimeout(state.stepTimer);
        state.stepTimer = undefined;
      }
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      try {
        state.req?.destroy();
      } catch {}
    }
    this.activeHttpRequests.clear();

    for (const [streamId, state] of this.activeTcpSockets.entries()) {
      if (state.pauseInterval) {
        clearInterval(state.pauseInterval);
        state.pauseInterval = undefined;
      }
      try {
        state.socket.destroy();
      } catch {}
    }
    this.activeTcpSockets.clear();
  }
}
