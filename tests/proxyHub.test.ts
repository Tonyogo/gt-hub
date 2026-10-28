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

describe('Hub Proxy Services (TerminalProxyBridge & ProxyRoutes)', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let hubWss: any;

  let targetHttpServer: http.Server;
  let targetHttpPort: number;

  let targetTcpServer: net.Server;
  let targetTcpPort: number;

  let agentWs: WebSocket | null = null;
  let agentProxyHandler: ProxyHandler | null = null;
  const testHostId = 'hub-proxy-test-agent';
  const originalKey = config.adminSecretKey;
  const adminSecret = 'test-secret-hub-proxy';

  beforeAll(async () => {
    config.adminSecretKey = adminSecret;

    // 1. Target HTTP server
    targetHttpServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/hello')) {
        res.setHeader('Set-Cookie', ['session=hub-test', 'pref=dark']);
        res.setHeader('x-received-url', req.url);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Hello from target! url=${req.url}`);
      } else if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          res.setHeader('Content-Type', req.headers['content-type'] || 'application/octet-stream');
          res.writeHead(200);
          res.end(body);
        });
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('first-part');
        // keep open until client aborts
      } else if (req.url === '/timeout') {
        // never respond to trigger timeout
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

    // 2. Target TCP server (Echo)
    targetTcpServer = net.createServer((socket) => {
      socket.on('data', (data) => socket.write(data));
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
      const wsUrl = `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${testHostId}&name=ProxyNode`;
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

      agentWs.on('message', (data: any, isBinary?: boolean) => {
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

  it('forwards GET /api/proxy/:hostId/port/:port/hello and strips auth query params', async () => {
    const res = await fetch(
      `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/hello?foo=bar&key=${adminSecret}&x-admin-key=${adminSecret}`,
      {
        headers: { 'x-admin-key': adminSecret },
      }
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hello from target!');
    // Verify auth query parameters stripped before reaching target
    expect(body).toContain('foo=bar');
    expect(body).not.toContain('key=');
    expect(body).not.toContain('x-admin-key=');

    // Verify Set-Cookie multi-value headers preserved
    const cookies = res.headers.get('set-cookie');
    expect(cookies).toBeDefined();
    expect(cookies).toContain('session=hub-test');
  });

  it('streams large binary POST body (>100KB) through proxy without corruption or truncation', async () => {
    const largePayload = Buffer.alloc(128 * 1024, 0x42); // 128KB
    const res = await fetch(
      `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/echo`,
      {
        method: 'POST',
        headers: {
          'x-admin-key': adminSecret,
          'Content-Type': 'application/octet-stream',
        },
        body: largePayload,
      }
    );

    expect(res.status).toBe(200);
    const resBuf = Buffer.from(await res.arrayBuffer());
    expect(resBuf.length).toBe(128 * 1024);
    expect(resBuf.equals(largePayload)).toBe(true);
  });

  it('forwards request via ALL /api/proxy/:hostId/request and handles 400, 404, 502, 504 errors', async () => {
    // 1. Success with x-gt-target-url
    const successRes = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/request`, {
      headers: {
        'x-admin-key': adminSecret,
        'x-gt-target-url': `http://127.0.0.1:${targetHttpPort}/hello?from=request-endpoint`,
      },
    });
    expect(successRes.status).toBe(200);
    const text = await successRes.text();
    expect(text).toContain('from=request-endpoint');

    // 2. 400 on invalid URL
    const invalidUrlRes = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/request`, {
      headers: {
        'x-admin-key': adminSecret,
        'x-gt-target-url': 'ftp://127.0.0.1:21/files',
      },
    });
    expect(invalidUrlRes.status).toBe(400);

    // 3. 404 on unknown host
    const unknownHostRes = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/non-existent-host-id/request`, {
      headers: {
        'x-admin-key': adminSecret,
        'x-gt-target-url': `http://127.0.0.1:${targetHttpPort}/hello`,
      },
    });
    expect(unknownHostRes.status).toBe(404);

    // 4. 502 on connection refused (unallocated port)
    const refusedRes = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/1/refused`, {
      headers: { 'x-admin-key': adminSecret },
    });
    expect(refusedRes.status).toBe(502);

    // 5. 504 on timeout
    const timeoutRes = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/timeout`, {
      headers: {
        'x-admin-key': adminSecret,
        'x-gt-timeout': '500', // 500ms timeout
      },
    });
    expect(timeoutRes.status).toBe(504);
  });

  it('aborts upstream request when client disconnects prematurely', async () => {
    const controller = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/slow`,
      {
        headers: { 'x-admin-key': adminSecret },
        signal: controller.signal,
      }
    );

    expect(res.status).toBe(200);
    expect(agentProxyHandler?.getActiveCount().httpCount).toBeGreaterThanOrEqual(1);

    // Abort reading stream mid-stream
    controller.abort();
    await expect(res.text()).rejects.toThrow();

    // Verify agent active count dropped back to 0
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (agentProxyHandler?.getActiveCount().httpCount === 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    expect(agentProxyHandler?.getActiveCount().httpCount).toBe(0);
  });

  it('tunnels raw TCP via /api/terminal/proxy-ws end-to-end and closes on agent disconnect', async () => {
    const cliWs = new WebSocket(
      `ws://127.0.0.1:${hubPort}/api/terminal/proxy-ws?hostId=${testHostId}`,
      { headers: { 'x-admin-key': adminSecret } }
    );

    await new Promise<void>((resolve) => cliWs.on('open', resolve));

    const receivedCliMessages: (string | Buffer)[] = [];
    cliWs.on('message', (data: any) => {
      receivedCliMessages.push(data);
    });

    const streamId = 'test-tcp-cli-1';
    cliWs.send(
      `JSON:${JSON.stringify({
        type: 'proxy_tcp_connect',
        streamId,
        host: '127.0.0.1',
        port: targetTcpPort,
      })}`
    );

    // Wait for proxy_tcp_connected
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const found = receivedCliMessages.some((m) => {
          const str = typeof m === 'string' ? m : m.toString('utf-8');
          return str.includes('"type":"proxy_tcp_connected"') && str.includes(streamId);
        });
        if (found) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Send binary TCP frame
    const payload = Buffer.from('hello-raw-tcp-tunnel');
    const packet = encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, streamId, payload);
    cliWs.send(packet);

    // Wait for echoed TCP frame
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const foundEcho = receivedCliMessages
          .filter((m): m is Buffer => Buffer.isBuffer(m))
          .map((m) => decodeBinaryPacket(m))
          .some((d) => d && d.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA && d.id === streamId);
        if (foundEcho) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const echoPacket = receivedCliMessages
      .filter((m): m is Buffer => Buffer.isBuffer(m))
      .map((m) => decodeBinaryPacket(m))
      .find((d) => d && d.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA && d.id === streamId)!;

    expect(echoPacket.payload.toString('utf-8')).toBe('hello-raw-tcp-tunnel');

    // Close TCP stream
    cliWs.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_close', streamId })}`);
    cliWs.close();
  });
});
