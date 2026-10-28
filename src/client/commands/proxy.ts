import http from 'http';
import https from 'https';
import net from 'net';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { URL } from 'url';
import { resolveHost } from '../utils/terminalUI';
import { createWebSocketAdapter } from '../../shared/utils/wsAdapter';
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../../shared/protocol/binaryProtocol';
import { TargetProbeResult } from '../../agent/handlers/proxyHandler';

export { TargetProbeResult };

function getWebSocketCtor(): any {
  let wsImpl: any = null;
  try {
    wsImpl = require('ws');
  } catch {}
  if (!wsImpl) {
    wsImpl = createWebSocketAdapter();
  }
  return wsImpl;
}

export interface PortForwardSpec {
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

function parsePort(val: string, allowZero: boolean = false): number {
  if (!/^\d+$/.test(val)) {
    throw new Error(`Invalid port: "${val}"`);
  }
  const port = parseInt(val, 10);
  const min = allowZero ? 0 : 1;
  if (port < min || port > 65535) {
    throw new Error(`Port out of range (${min}-65535): ${port}`);
  }
  return port;
}

export function parseForwardMapping(spec: string, defaultBindAddress: string = '127.0.0.1'): PortForwardSpec {
  if (!spec || typeof spec !== 'string') {
    throw new Error(`Invalid port forward spec: "${spec}"`);
  }

  const parts = spec.trim().split(':');

  // Case 1: "3000" -> local: 3000, remote: 3000
  if (parts.length === 1) {
    const port = parsePort(parts[0], false);
    return {
      bindAddress: defaultBindAddress,
      localPort: port,
      remoteHost: '127.0.0.1',
      remotePort: port,
    };
  }

  // Case 2: "8080:3000" -> local: 8080, remote: 3000
  if (parts.length === 2) {
    const localPort = parsePort(parts[0], true);
    const remotePort = parsePort(parts[1], false);
    return {
      bindAddress: defaultBindAddress,
      localPort,
      remoteHost: '127.0.0.1',
      remotePort,
    };
  }

  // Case 3: 3 parts
  if (parts.length === 3) {
    // Check if parts[0] is port number: "8080:192.168.1.10:80" or "0:127.0.0.1:80"
    if (/^\d+$/.test(parts[0])) {
      const localPort = parsePort(parts[0], true);
      const remoteHost = parts[1];
      if (!remoteHost) throw new Error(`Invalid remote host in spec: "${spec}"`);
      const remotePort = parsePort(parts[2], false);
      return {
        bindAddress: defaultBindAddress,
        localPort,
        remoteHost,
        remotePort,
      };
    } else {
      // "0.0.0.0:8080:3000"
      const bindAddress = parts[0];
      const localPort = parsePort(parts[1], true);
      const remotePort = parsePort(parts[2], false);
      return {
        bindAddress,
        localPort,
        remoteHost: '127.0.0.1',
        remotePort,
      };
    }
  }

  // Case 4: "0.0.0.0:8080:127.0.0.1:3000"
  if (parts.length === 4) {
    const bindAddress = parts[0];
    const localPort = parsePort(parts[1], true);
    const remoteHost = parts[2];
    if (!remoteHost) throw new Error(`Invalid remote host in spec: "${spec}"`);
    const remotePort = parsePort(parts[3], false);
    return {
      bindAddress,
      localPort,
      remoteHost,
      remotePort,
    };
  }

  throw new Error(`Invalid port forward spec: "${spec}"`);
}

export function resolveProxyWebSocketUrl(serverUrl: string, hostId: string): string {
  let wsUrl = serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    wsUrl = `ws://${wsUrl}`;
  }
  wsUrl = wsUrl.replace(/\/+$/, '');
  return `${wsUrl}/api/terminal/proxy-ws?hostId=${encodeURIComponent(hostId)}`;
}

interface ActiveStreamState {
  onData: (chunk: Buffer) => void;
  onClose: (error?: string) => void;
  onConnected?: () => void;
  isConnected: boolean;
  pendingWrites: Buffer[];
}

export class CliTcpTunnelClient {
  private serverUrl: string;
  private apiKey: string;
  private hostId: string;
  private ws: any = null;
  private activeStreams = new Map<string, ActiveStreamState>();

  constructor(options: { serverUrl: string; apiKey: string; hostId: string }) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.hostId = options.hostId;
  }

  public async connect(): Promise<void> {
    const WebSocketImpl = getWebSocketCtor();
    const wsUrl = resolveProxyWebSocketUrl(this.serverUrl, this.hostId);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocketImpl(wsUrl, {
        headers: { 'x-admin-key': this.apiKey },
      });
      this.ws = ws;

      let settled = false;

      ws.on('open', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('error', (err: any) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('message', (data: any) => {
        const isBuf = Buffer.isBuffer(data);
        const firstByte = isBuf && data.length > 0 ? data[0] : null;

        if (firstByte === BIN_MSG_TYPE.PROXY_TCP_DATA) {
          const buf = isBuf ? data : Buffer.from(data);
          const decoded = decodeBinaryPacket(buf);
          if (decoded) {
            const stream = this.activeStreams.get(decoded.id);
            if (stream) {
              stream.onData(decoded.payload);
            }
          }
          return;
        }

        const msgStr = typeof data === 'string' ? data : data.toString('utf-8');
        if (msgStr.startsWith('JSON:')) {
          try {
            const control = JSON.parse(msgStr.slice(5));
            if (control.type === 'proxy_tcp_connected') {
              const stream = this.activeStreams.get(control.streamId);
              if (stream) {
                stream.isConnected = true;
                if (stream.onConnected) {
                  try {
                    stream.onConnected();
                  } catch {}
                }
                for (const pending of stream.pendingWrites) {
                  this.sendTcpData(control.streamId, pending);
                }
                stream.pendingWrites = [];
              }
              return;
            }

            if (control.type === 'proxy_tcp_close') {
              const stream = this.activeStreams.get(control.streamId);
              if (stream) {
                this.activeStreams.delete(control.streamId);
                stream.onClose(control.error);
              }
              return;
            }
          } catch {}
        }
      });

      ws.on('close', () => {
        for (const [streamId, stream] of Array.from(this.activeStreams.entries())) {
          this.activeStreams.delete(streamId);
          stream.onClose('Tunnel connection closed');
        }
      });
    });
  }

  public openStream(
    remoteHost: string,
    remotePort: number,
    onData: (chunk: Buffer) => void,
    onClose: (error?: string) => void,
    onConnected?: () => void
  ): { streamId: string; write: (chunk: Buffer) => void; close: () => void } {
    const streamId = `tcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamState: ActiveStreamState = {
      onData,
      onClose,
      onConnected,
      isConnected: false,
      pendingWrites: [],
    };
    this.activeStreams.set(streamId, streamState);

    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (this.ws.constructor as any).OPEN)) {
      this.ws.send(
        `JSON:${JSON.stringify({
          type: 'proxy_tcp_connect',
          streamId,
          host: remoteHost,
          port: remotePort,
        })}`
      );
    }

    return {
      streamId,
      write: (chunk: Buffer) => {
        if (!streamState.isConnected) {
          streamState.pendingWrites.push(chunk);
        } else {
          this.sendTcpData(streamId, chunk);
        }
      },
      close: () => {
        if (this.activeStreams.has(streamId)) {
          this.activeStreams.delete(streamId);
          if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (this.ws.constructor as any).OPEN)) {
            try {
              this.ws.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_close', streamId })}`);
            } catch {}
          }
        }
      },
    };
  }

  private sendTcpData(streamId: string, chunk: Buffer): void {
    if (!this.ws || (this.ws.readyState !== 1 && this.ws.readyState !== (this.ws.constructor as any).OPEN)) {
      return;
    }

    const MAX_CHUNK = 32 * 1024;
    if (chunk.length <= MAX_CHUNK) {
      this.ws.send(encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, streamId, chunk));
      return;
    }

    let offset = 0;
    while (offset < chunk.length) {
      const end = Math.min(offset + MAX_CHUNK, chunk.length);
      const slice = chunk.subarray(offset, end);
      this.ws.send(encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, streamId, slice));
      offset = end;
    }
  }

  public close(): void {
    for (const [streamId, stream] of Array.from(this.activeStreams.entries())) {
      try {
        stream.onClose('Tunnel client closed');
      } catch {}
    }
    this.activeStreams.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export async function startPortForwardListeners(
  tunnel: CliTcpTunnelClient,
  mappings: PortForwardSpec[]
): Promise<{ servers: net.Server[]; closeAll: () => Promise<void> }> {
  const servers: net.Server[] = [];

  for (const m of mappings) {
    const server = net.createServer((socket) => {
      let streamHandle: { streamId: string; write: (chunk: Buffer) => void; close: () => void } | null = null;

      streamHandle = tunnel.openStream(
        m.remoteHost,
        m.remotePort,
        (chunk) => {
          if (!socket.destroyed) {
            socket.write(chunk);
          }
        },
        () => {
          if (!socket.destroyed) {
            socket.destroy();
          }
        }
      );

      socket.on('data', (d) => {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
        streamHandle?.write(buf);
      });

      socket.on('error', () => {
        streamHandle?.close();
      });

      socket.on('close', () => {
        streamHandle?.close();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(m.localPort, m.bindAddress, () => resolve());
      server.on('error', reject);
    });

    servers.push(server);
  }

  const closeAll = async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (typeof (s as any).closeAllConnections === 'function') {
              (s as any).closeAllConnections();
            }
            s.close(() => resolve());
          })
      )
    );
  };

  return { servers, closeAll };
}

export async function startLocalHttpProxyServer(
  tunnel: CliTcpTunnelClient,
  options: { bindAddress?: string; port: number }
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const bindAddress = options.bindAddress || '127.0.0.1';

  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('http://')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: Proxy requires absolute HTTP URL');
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: Invalid target URL');
      return;
    }

    const targetHostname = targetUrl.hostname;
    const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 80;
    const targetPath = (targetUrl.pathname || '/') + (targetUrl.search || '');

    const streamHandle = tunnel.openStream(
      targetHostname,
      targetPort,
      (chunk) => {
        if (!req.socket.destroyed) {
          req.socket.write(chunk);
        }
      },
      () => {
        if (!req.socket.destroyed) {
          req.socket.end();
        }
      }
    );

    // Reconstruct request line
    let reqLine = `${req.method || 'GET'} ${targetPath} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1];
      const lower = key.toLowerCase();
      if (lower === 'proxy-connection' || lower === 'proxy-authorization') continue;
      if (lower === 'host') {
        reqLine += `Host: ${targetUrl.host}\r\n`;
      } else {
        reqLine += `${key}: ${val}\r\n`;
      }
    }
    reqLine += '\r\n';

    streamHandle.write(Buffer.from(reqLine, 'utf-8'));

    req.on('data', (chunk) => {
      streamHandle.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('error', () => streamHandle.close());
    req.socket.on('close', () => streamHandle.close());
  });

  // HTTPS CONNECT handler
  server.on('connect', (req, clientSocket, head) => {
    const urlParts = (req.url || '').split(':');
    const destHost = urlParts[0] || '127.0.0.1';
    const destPort = parseInt(urlParts[1] || '443', 10);

    let streamHandle: { streamId: string; write: (chunk: Buffer) => void; close: () => void } | null = null;

    streamHandle = tunnel.openStream(
      destHost,
      destPort,
      (chunk) => {
        if (!clientSocket.destroyed) {
          clientSocket.write(chunk);
        }
      },
      () => {
        if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
      },
      () => {
        // Connected callback
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length > 0) {
            streamHandle?.write(head);
          }
        }
      }
    );

    clientSocket.on('data', (chunk) => {
      streamHandle?.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    clientSocket.on('error', () => streamHandle?.close());
    clientSocket.on('close', () => streamHandle?.close());
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, bindAddress, () => resolve());
    server.on('error', reject);
  });

  const boundPort = (server.address() as AddressInfo).port;

  const close = async () => {
    await new Promise<void>((resolve) => {
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      server.close(() => resolve());
    });
  };

  return { server, port: boundPort, close };
}

export async function handleForwardCommand(options: {
  server: string;
  key: string;
  node: string;
  mappings: string[];
  bind?: string;
}): Promise<void> {
  const resolved = await resolveHost(options.server, options.key, options.node);
  const defaultBind = options.bind || '127.0.0.1';

  const specs = options.mappings.map((m) => parseForwardMapping(m, defaultBind));

  const tunnel = new CliTcpTunnelClient({
    serverUrl: options.server,
    apiKey: options.key,
    hostId: resolved.id,
  });

  console.log(`Connecting port forward tunnel to node ${resolved.name} (${resolved.id})...`);
  await tunnel.connect();

  const { closeAll } = await startPortForwardListeners(tunnel, specs);

  for (const s of specs) {
    console.log(
      `Forwarding from ${s.bindAddress}:${s.localPort} -> ${s.remoteHost}:${s.remotePort} (via ${resolved.name})`
    );
  }

  const cleanup = async () => {
    console.log('\nClosing port forward listeners...');
    await closeAll();
    tunnel.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export async function handleProxyCommand(options: {
  server: string;
  key: string;
  node: string;
  port?: number;
  bind?: string;
}): Promise<void> {
  const resolved = await resolveHost(options.server, options.key, options.node);
  const port = options.port || 1080;
  const bindAddress = options.bind || '127.0.0.1';

  const tunnel = new CliTcpTunnelClient({
    serverUrl: options.server,
    apiKey: options.key,
    hostId: resolved.id,
  });

  console.log(`Connecting proxy tunnel to node ${resolved.name} (${resolved.id})...`);
  await tunnel.connect();

  const { port: boundPort, close } = await startLocalHttpProxyServer(tunnel, {
    port,
    bindAddress,
  });

  console.log(
    `HTTP/HTTPS Proxy listening on ${bindAddress}:${boundPort} (routing via node ${resolved.name})`
  );
  console.log(`Example usage: export http_proxy=http://${bindAddress}:${boundPort}`);

  const cleanup = async () => {
    console.log('\nClosing local HTTP proxy server...');
    await close();
    tunnel.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export interface SpeedtestReport {
  hostId: string;
  latency: {
    samples: number;
    avgTotalRttMs: number;
    avgHubAgentRttMs: number;
    avgClientHubRttMs: number;
    minRttMs: number;
    maxRttMs: number;
    jitterMs: number;
  };
  download: {
    bytes: number;
    durationMs: number;
    mbps: number;
    mbPerSec: number;
  };
  upload: {
    bytes: number;
    durationMs: number;
    mbps: number;
    mbPerSec: number;
  };
  probes: TargetProbeResult[];
}

function sendBenchmarkRequest(
  parsedUrl: URL,
  options: http.RequestOptions,
  bodyData?: Buffer | string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request(parsedUrl, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

export async function runSpeedtestBenchmark(options: {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  sizeBytes?: number;
  pings?: number;
  targets?: string[];
  onProgress?: (phase: string, progress: number, currentMbps?: number) => void;
}): Promise<SpeedtestReport> {
  const { serverUrl, apiKey, hostId } = options;
  const pingsCount = Math.max(1, options.pings || 5);
  const rawSizeBytes = options.sizeBytes ?? 16 * 1024 * 1024;
  const sizeBytes = Math.min(256 * 1024 * 1024, Math.max(64 * 1024, rawSizeBytes));

  // 1. Latency & Jitter phase
  const totalRttSamples: number[] = [];
  const hubAgentSamples: number[] = [];
  const clientHubSamples: number[] = [];

  for (let i = 0; i < pingsCount; i++) {
    const pingUrl = new URL(
      `/api/proxy/${encodeURIComponent(hostId)}/speedtest/ping`,
      serverUrl
    );
    const clientStartNs = process.hrtime.bigint();
    const res = await sendBenchmarkRequest(pingUrl, {
      method: 'GET',
      headers: { 'x-admin-key': apiKey },
    });
    const clientEndNs = process.hrtime.bigint();

    if (res.statusCode !== 200) {
      throw new Error(`Ping failed (HTTP ${res.statusCode}): ${res.body.toString('utf-8')}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(res.body.toString('utf-8'));
    } catch {
      parsed = {};
    }

    const totalRttMs = Math.max(0.01, Number(clientEndNs - clientStartNs) / 1e6);
    const hubAgentRttMs = typeof parsed.hubAgentRttMs === 'number' ? parsed.hubAgentRttMs : 0;
    const clientHubRttMs = Math.max(0, totalRttMs - hubAgentRttMs);

    totalRttSamples.push(totalRttMs);
    hubAgentSamples.push(hubAgentRttMs);
    clientHubSamples.push(clientHubRttMs);
  }

  const avgTotalRttMs =
    totalRttSamples.reduce((a, b) => a + b, 0) / totalRttSamples.length;
  const avgHubAgentRttMs =
    hubAgentSamples.reduce((a, b) => a + b, 0) / hubAgentSamples.length;
  const avgClientHubRttMs =
    clientHubSamples.reduce((a, b) => a + b, 0) / clientHubSamples.length;
  const minRttMs = Math.min(...totalRttSamples);
  const maxRttMs = Math.max(...totalRttSamples);

  let jitterSum = 0;
  for (let j = 1; j < totalRttSamples.length; j++) {
    jitterSum += Math.abs(totalRttSamples[j] - totalRttSamples[j - 1]);
  }
  const jitterMs =
    totalRttSamples.length > 1 ? jitterSum / (totalRttSamples.length - 1) : 0;

  // 2. Download speedtest
  const dlUrl = new URL(
    `/api/proxy/${encodeURIComponent(hostId)}/speedtest/download?bytes=${sizeBytes}`,
    serverUrl
  );

  const dlResult = await new Promise<{ bytes: number; durationMs: number }>((resolve, reject) => {
    const isHttps = dlUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const dlStartNs = process.hrtime.bigint();
    let receivedBytes = 0;

    const req = transport.request(
      dlUrl,
      {
        method: 'GET',
        headers: {
          'x-admin-key': apiKey,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(
              new Error(
                `Download speedtest failed (${res.statusCode}): ${Buffer.concat(chunks).toString('utf-8')}`
              )
            );
          });
          return;
        }
        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (options.onProgress) {
            const currentElapsedSec = Math.max(0.001, Number(process.hrtime.bigint() - dlStartNs) / 1e9);
            const currentMbps = (receivedBytes * 8) / (currentElapsedSec * 1_000_000);
            options.onProgress('download', Math.min(1, receivedBytes / sizeBytes), Number(currentMbps.toFixed(2)));
          }
        });
        res.on('end', () => {
          const durationMs = Math.max(1, Number(process.hrtime.bigint() - dlStartNs) / 1e6);
          resolve({ bytes: receivedBytes, durationMs });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });

  const dlDurationSec = dlResult.durationMs / 1000;
  const dlMbps = Number(((dlResult.bytes * 8) / (dlDurationSec * 1_000_000)).toFixed(2));
  const dlMbPerSec = Number((dlResult.bytes / (dlDurationSec * 1024 * 1024)).toFixed(2));

  // 3. Upload speedtest
  const ulUrl = new URL(
    `/api/proxy/${encodeURIComponent(hostId)}/speedtest/upload`,
    serverUrl
  );

  const ulResult = await new Promise<{ bytes: number; durationMs: number }>((resolve, reject) => {
    const isHttps = ulUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const ulStartNs = process.hrtime.bigint();

    const req = transport.request(
      ulUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(sizeBytes),
          'x-admin-key': apiKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Upload speedtest failed (${res.statusCode}): ${Buffer.concat(chunks).toString('utf-8')}`
              )
            );
            return;
          }
          const durationMs = Math.max(1, Number(process.hrtime.bigint() - ulStartNs) / 1e6);
          resolve({ bytes: sizeBytes, durationMs });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);

    const randomBuf = crypto.randomBytes(32 * 1024);
    let sentBytes = 0;
    let counter = 0;
    const chunkSize = 32 * 1024;

    const sendNext = () => {
      let ok = true;
      while (sentBytes < sizeBytes && ok) {
        const remaining = sizeBytes - sentBytes;
        const currentChunkSize = Math.min(chunkSize, remaining);
        counter++;
        randomBuf.writeUInt32LE((randomBuf.readUInt32LE(0) ^ counter) >>> 0, 0);
        const chunk = randomBuf.subarray(0, currentChunkSize);
        sentBytes += currentChunkSize;

        if (options.onProgress) {
          const currentElapsedSec = Math.max(0.001, Number(process.hrtime.bigint() - ulStartNs) / 1e9);
          const currentMbps = (sentBytes * 8) / (currentElapsedSec * 1_000_000);
          options.onProgress('upload', Math.min(1, sentBytes / sizeBytes), Number(currentMbps.toFixed(2)));
        }

        if (sentBytes >= sizeBytes) {
          req.end(chunk);
          return;
        } else {
          ok = req.write(chunk);
        }
      }

      if (sentBytes < sizeBytes) {
        req.once('drain', sendNext);
      }
    };

    sendNext();
  });

  const ulDurationSec = ulResult.durationMs / 1000;
  const ulMbps = Number(((ulResult.bytes * 8) / (ulDurationSec * 1_000_000)).toFixed(2));
  const ulMbPerSec = Number((ulResult.bytes / (ulDurationSec * 1024 * 1024)).toFixed(2));

  // 4. Outbound Target Probes
  const probeUrl = new URL(
    `/api/proxy/${encodeURIComponent(hostId)}/speedtest/probe`,
    serverUrl
  );
  const probePayload = JSON.stringify({ targets: options.targets });
  const probeRes = await sendBenchmarkRequest(
    probeUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(probePayload)),
        'x-admin-key': apiKey,
      },
    },
    probePayload
  );

  let probes: TargetProbeResult[] = [];
  if (probeRes.statusCode === 200) {
    try {
      const parsed = JSON.parse(probeRes.body.toString('utf-8'));
      if (Array.isArray(parsed.results)) {
        probes = parsed.results;
      }
    } catch {}
  }

  return {
    hostId,
    latency: {
      samples: pingsCount,
      avgTotalRttMs: Number(avgTotalRttMs.toFixed(2)),
      avgHubAgentRttMs: Number(avgHubAgentRttMs.toFixed(2)),
      avgClientHubRttMs: Number(avgClientHubRttMs.toFixed(2)),
      minRttMs: Number(minRttMs.toFixed(2)),
      maxRttMs: Number(maxRttMs.toFixed(2)),
      jitterMs: Number(jitterMs.toFixed(2)),
    },
    download: {
      bytes: dlResult.bytes,
      durationMs: Number(dlResult.durationMs.toFixed(2)),
      mbps: dlMbps,
      mbPerSec: dlMbPerSec,
    },
    upload: {
      bytes: ulResult.bytes,
      durationMs: Number(ulResult.durationMs.toFixed(2)),
      mbps: ulMbps,
      mbPerSec: ulMbPerSec,
    },
    probes,
  };
}

export async function handleSpeedtestCommand(options: {
  server: string;
  key: string;
  node: string;
  sizeMb?: number;
  pings?: number;
  targets?: string[];
  json?: boolean;
}): Promise<void> {
  const resolved = await resolveHost(options.server, options.key, options.node);
  const sizeMb = options.sizeMb && options.sizeMb > 0 ? options.sizeMb : 16;
  const sizeBytes = Math.round(sizeMb * 1024 * 1024);
  const pings = options.pings && options.pings > 0 ? options.pings : 5;

  if (!options.json) {
    console.log(`Starting speedtest benchmark on node ${resolved.name} (${resolved.id})...`);
    console.log(`Parameters: pings=${pings}, payload=${sizeMb} MB (${sizeBytes.toLocaleString()} bytes)`);
  }

  const report = await runSpeedtestBenchmark({
    serverUrl: options.server,
    apiKey: options.key,
    hostId: resolved.id,
    sizeBytes,
    pings,
    targets: options.targets,
    onProgress: options.json
      ? undefined
      : (phase, progress, mbps) => {
          if (process.stdout.isTTY) {
            const pct = Math.round(progress * 100);
            const rate = mbps ? ` - ${mbps.toFixed(1)} Mbps` : '';
            process.stdout.write(`\r  [${phase}] ${pct}%${rate}   `);
            if (pct >= 100) {
              process.stdout.write('\n');
            }
          }
        },
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n============================================================`);
  console.log(` Speedtest Report: ${resolved.name} (${resolved.id})`);
  console.log(`============================================================`);
  console.log(`Latency & Jitter (${report.latency.samples} samples):`);
  console.log(`  Total RTT:    avg ${report.latency.avgTotalRttMs.toFixed(2)} ms (min: ${report.latency.minRttMs.toFixed(2)} ms, max: ${report.latency.maxRttMs.toFixed(2)} ms, jitter: ${report.latency.jitterMs.toFixed(2)} ms)`);
  console.log(`  Segmented:    Client↔Hub: ${report.latency.avgClientHubRttMs.toFixed(2)} ms | Hub↔Agent: ${report.latency.avgHubAgentRttMs.toFixed(2)} ms`);
  console.log(`Bandwidth:`);
  console.log(`  Download:     ${report.download.mbps.toFixed(2)} Mbps (${report.download.mbPerSec.toFixed(2)} MB/s) [${(report.download.bytes / (1024 * 1024)).toFixed(1)} MB in ${(report.download.durationMs / 1000).toFixed(2)}s]`);
  console.log(`  Upload:       ${report.upload.mbps.toFixed(2)} Mbps (${report.upload.mbPerSec.toFixed(2)} MB/s) [${(report.upload.bytes / (1024 * 1024)).toFixed(1)} MB in ${(report.upload.durationMs / 1000).toFixed(2)}s]`);
  if (report.probes && report.probes.length > 0) {
    console.log(`Outbound Connectivity Probes:`);
    for (const p of report.probes) {
      const statusStr = p.ok ? `[✓] ${p.statusCode || 200} OK` : `[✗] ${p.error || 'Failed'}`;
      console.log(`  ${statusStr.padEnd(20)} ${p.latencyMs} ms  ${p.url}`);
    }
  }
  console.log(`============================================================\n`);
}
