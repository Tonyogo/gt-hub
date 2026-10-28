import http from 'http';
import net from 'net';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import app from '../src/server/app';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { ProxyHandler } from '../src/agent/handlers/proxyHandler';
import {
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';
import config from '../config/default';
import {
  parseForwardMapping,
  resolveProxyWebSocketUrl,
  CliTcpTunnelClient,
  startPortForwardListeners,
  startLocalHttpProxyServer,
} from '../src/client/commands/proxy';

describe('CLI Port Forwarding & HTTP Proxy (gt forward & gt proxy)', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let hubWss: any;

  let targetHttpServer: http.Server;
  let targetHttpPort: number;

  let targetTcpServer: net.Server;
  let targetTcpPort: number;

  let agentWs: WebSocket | null = null;
  let agentProxyHandler: ProxyHandler | null = null;
  const testHostId = 'cli-proxy-test-agent';
  const originalKey = config.adminSecretKey;
  const adminSecret = 'test-secret-cli-proxy';

  beforeAll(async () => {
    config.adminSecretKey = adminSecret;

    // 1. Target HTTP server
    targetHttpServer = http.createServer((req, res) => {
      if (req.url === '/test') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('target-http-ok');
      } else if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.concat(chunks));
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    await new Promise<void>((resolve) => {
      targetHttpServer.listen(0, '127.0.0.1', () => {
        targetHttpPort = (targetHttpServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 2. Target TCP Echo server
    targetTcpServer = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(d));
    });

    await new Promise<void>((resolve) => {
      targetTcpServer.listen(0, '127.0.0.1', () => {
        targetTcpPort = (targetTcpServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 3. Hub Server
    hubServer = http.createServer(app);
    hubWss = setupTerminalWebSocket(hubServer);

    await new Promise<void>((resolve) => {
      hubServer.listen(0, '127.0.0.1', () => {
        hubPort = (hubServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 4. Connect simulated Agent WS to Hub
    await new Promise<void>((resolve) => {
      const wsUrl = `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${testHostId}&name=CliProxyNode`;
      agentWs = new WebSocket(wsUrl, {
        headers: { 'x-admin-key': adminSecret },
      });

      agentWs.on('open', () => {
        agentProxyHandler = new ProxyHandler({
          send: (data: string | Buffer) => {
            if (agentWs && agentWs.readyState === WebSocket.OPEN) {
              agentWs.send(data);
            }
          },
          allowProxy: true,
        });
        resolve();
      });

      agentWs.on('message', (data: any) => {
        const isBuf = Buffer.isBuffer(data);
        const firstByte = isBuf && data.length > 0 ? data[0] : null;
        if (
          firstByte === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY ||
          firstByte === BIN_MSG_TYPE.PROXY_TCP_DATA ||
          firstByte === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY
        ) {
          const buf = isBuf ? data : Buffer.from(data);
          const decoded = decodeBinaryPacket(buf);
          if (decoded && agentProxyHandler) {
            agentProxyHandler.handleBinaryFrame(decoded);
          }
          return;
        }

        const msgStr = data.toString();
        if (msgStr.startsWith('JSON:')) {
          try {
            const control = JSON.parse(msgStr.slice(5));
            if (agentProxyHandler) {
              agentProxyHandler.handleControlMessage(control);
            }
          } catch {}
        }
      });
    });

    // Wait until registered in host manager
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const host = terminalHostManager.getHost(testHostId);
        if (host && host.status === 'online') {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });
  });

  afterAll(async () => {
    config.adminSecretKey = originalKey;
    if (agentProxyHandler) {
      agentProxyHandler.destroyAll();
    }
    if (agentWs) {
      try { agentWs.terminate(); } catch {}
    }
    if (hubWss) {
      try {
        if (typeof (hubWss as any).closeAllClients === 'function') {
          (hubWss as any).closeAllClients();
        }
        hubWss.close();
      } catch {}
    }
    if (typeof (hubServer as any).closeAllConnections === 'function') {
      (hubServer as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    await new Promise<void>((resolve) => targetHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => targetTcpServer.close(() => resolve()));
  });

  describe('parseForwardMapping & resolveProxyWebSocketUrl', () => {
    it('parses single port spec', () => {
      const res = parseForwardMapping('3000');
      expect(res).toEqual({
        bindAddress: '127.0.0.1',
        localPort: 3000,
        remoteHost: '127.0.0.1',
        remotePort: 3000,
      });
    });

    it('parses local:remote port spec', () => {
      const res = parseForwardMapping('8080:3000');
      expect(res).toEqual({
        bindAddress: '127.0.0.1',
        localPort: 8080,
        remoteHost: '127.0.0.1',
        remotePort: 3000,
      });
    });

    it('parses local:remoteHost:remotePort spec', () => {
      const res = parseForwardMapping('8080:192.168.1.10:80');
      expect(res).toEqual({
        bindAddress: '127.0.0.1',
        localPort: 8080,
        remoteHost: '192.168.1.10',
        remotePort: 80,
      });
    });

    it('parses bind:local:remoteHost:remotePort spec', () => {
      const res = parseForwardMapping('0.0.0.0:8080:127.0.0.1:3000');
      expect(res).toEqual({
        bindAddress: '0.0.0.0',
        localPort: 8080,
        remoteHost: '127.0.0.1',
        remotePort: 3000,
      });
    });

    it('throws on invalid port forward specs', () => {
      expect(() => parseForwardMapping('invalid')).toThrow();
      expect(() => parseForwardMapping('70000')).toThrow();
      expect(() => parseForwardMapping('0')).toThrow();
      expect(() => parseForwardMapping('8080:invalid:3000:extra:5000')).toThrow();
    });

    it('resolves proxy websocket URL correctly', () => {
      const wsUrl = resolveProxyWebSocketUrl('http://127.0.0.1:8000', 'node-1');
      expect(wsUrl).toBe('ws://127.0.0.1:8000/api/terminal/proxy-ws?hostId=node-1');

      const wssUrl = resolveProxyWebSocketUrl('https://example.com/', 'node-2');
      expect(wssUrl).toBe('wss://example.com/api/terminal/proxy-ws?hostId=node-2');
    });
  });

  describe('startPortForwardListeners', () => {
    it('forwards local TCP connections through tunnel, buffering early bytes', async () => {
      const tunnel = new CliTcpTunnelClient({
        serverUrl: `http://127.0.0.1:${hubPort}`,
        apiKey: adminSecret,
        hostId: testHostId,
      });

      await tunnel.connect();

      const mapping = parseForwardMapping(`0:127.0.0.1:${targetTcpPort}`);
      const { servers, closeAll } = await startPortForwardListeners(tunnel, [mapping]);

      expect(servers.length).toBe(1);
      const localPort = (servers[0].address() as AddressInfo).port;

      // Connect local socket and write immediately (buffering early bytes before proxy_tcp_connected)
      const socket = net.connect({ host: '127.0.0.1', port: localPort });
      const earlyPayload = Buffer.from('early-bytes-test-data');
      socket.write(earlyPayload);

      const receivedEcho = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', (d) => {
          chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
          const total = Buffer.concat(chunks);
          if (total.length >= earlyPayload.length) {
            resolve(total);
          }
        });
        socket.on('error', reject);
      });

      expect(receivedEcho.toString('utf-8')).toBe('early-bytes-test-data');

      socket.destroy();
      await closeAll();
      tunnel.close();
    });
  });

  describe('startLocalHttpProxyServer', () => {
    it('handles standard HTTP proxy requests and CONNECT tunnels', async () => {
      const tunnel = new CliTcpTunnelClient({
        serverUrl: `http://127.0.0.1:${hubPort}`,
        apiKey: adminSecret,
        hostId: testHostId,
      });

      await tunnel.connect();

      const { port: proxyPort, close } = await startLocalHttpProxyServer(tunnel, {
        port: 0,
        bindAddress: '127.0.0.1',
      });

      // 1. Standard HTTP proxy request (GET http://127.0.0.1:<targetPort>/test)
      const getRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${targetHttpPort}/test`,
            headers: {
              Host: `127.0.0.1:${targetHttpPort}`,
              'Proxy-Connection': 'Keep-Alive',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(getRes).toBe('target-http-ok');

      // 2. Standard HTTP proxy POST echo request
      const postPayload = Buffer.from('cli-proxy-post-payload');
      const postRes = await new Promise<Buffer>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'POST',
            path: `http://127.0.0.1:${targetHttpPort}/echo`,
            headers: {
              Host: `127.0.0.1:${targetHttpPort}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(postPayload.length),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          }
        );
        req.on('error', reject);
        req.end(postPayload);
      });

      expect(postRes.equals(postPayload)).toBe(true);

      // 3. HTTPS/TCP CONNECT tunnel (CONNECT 127.0.0.1:<targetTcpPort>)
      const connectSocket = await new Promise<net.Socket>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'CONNECT',
          path: `127.0.0.1:${targetTcpPort}`,
        });
        req.on('connect', (res, socket, head) => {
          expect(res.statusCode).toBe(200);
          resolve(socket);
        });
        req.on('error', reject);
        req.end();
      });

      const connectPayload = Buffer.from('hello-via-connect-tunnel');
      connectSocket.write(connectPayload);

      const connectEcho = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        connectSocket.on('data', (c) => {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          if (Buffer.concat(chunks).length >= connectPayload.length) {
            resolve(Buffer.concat(chunks));
          }
        });
      });

      expect(connectEcho.toString('utf-8')).toBe('hello-via-connect-tunnel');

      connectSocket.destroy();
      await close();
      tunnel.close();
    });
  });
});
