import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';
import { URL } from 'url';
import { resolveHost } from '../utils/terminalUI';
import { createWebSocketAdapter } from '../../shared/utils/wsAdapter';
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../../shared/protocol/binaryProtocol';

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
