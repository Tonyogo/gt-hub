import http from 'http';
import net from 'net';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import app from '../src/server/app';
import config from '../config/default';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { ticketManager } from '../src/server/modules/auth/ticketManager';
import {
  parseProcNetTcp,
  scanListeningTcpPorts,
  ProxyHandler,
  ListeningPortInfo,
} from '../src/agent/handlers/proxyHandler';
import {
  terminalProxyBridge,
  stripProxySessionCookie,
} from '../src/terminal/services/terminalProxyBridge';
import {
  createProxySessionToken,
  verifyProxySessionToken,
} from '../src/terminal/routes/proxyRoutes';
import {
  BIN_MSG_TYPE,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';

describe('Agent Listening Port Scanner & proxy_list_ports RPC (Phase 2)', () => {
  describe('parseProcNetTcp', () => {
    it('accurately parses IPv4 /proc/net/tcp hex lines with state 0A', () => {
      const mockTcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 191081 1 0000000000000000 100 0 0 10 0
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22085 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0016 0100007F:1234 01 00000000:00000000 00:00000000 00000000     0        0 22059 1 0000000000000000 100 0 0 10 0
`;
      const result = parseProcNetTcp(mockTcp, false);
      expect(result).toHaveLength(2);
      expect(result).toEqual([
        { port: 3000, address: '127.0.0.1' },
        { port: 80, address: '0.0.0.0' },
      ]);
    });

    it('accurately parses IPv6 /proc/net/tcp6 hex lines with state 0A', () => {
      const mockTcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22087 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21854 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 21853 1 0000000000000000 100 0 0 10 0
`;
      const result = parseProcNetTcp(mockTcp6, true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ port: 8080, address: '::' });
      expect(result[1]).toEqual({ port: 9000, address: '::1' });
    });
  });

  describe('scanListeningTcpPorts', () => {
    let testServer: net.Server;
    let testPort: number;

    beforeAll(async () => {
      testServer = net.createServer(() => {});
      await new Promise<void>((resolve) => {
        testServer.listen(0, '127.0.0.1', () => {
          testPort = (testServer.address() as AddressInfo).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        testServer.close(() => resolve());
      });
    });

    it('detects active listening port on current host, deduplicated and sorted', async () => {
      const ports = await scanListeningTcpPorts();
      expect(Array.isArray(ports)).toBe(true);
      expect(ports.length).toBeGreaterThan(0);

      // Verify sorted ascending
      for (let i = 1; i < ports.length; i++) {
        expect(ports[i].port).toBeGreaterThan(ports[i - 1].port);
      }

      // Verify testServer port is discovered
      const match = ports.find((p: ListeningPortInfo) => p.port === testPort);
      expect(match).toBeDefined();
      expect(match?.port).toBe(testPort);
      expect(['127.0.0.1', '0.0.0.0', '::', '::1']).toContain(match?.address);
    });
  });

  describe('ProxyHandler proxy_list_ports control RPC', () => {
    it('responds with proxy_list_ports_res and ports list when allowProxy is true', async () => {
      const sent: string[] = [];
      const handler = new ProxyHandler({
        send: (data) => {
          if (typeof data === 'string') sent.push(data);
        },
        allowProxy: true,
      });

      const handled = handler.handleControlMessage({
        type: 'proxy_list_ports',
        reqId: 'req-port-test-1',
      });
      expect(handled).toBe(true);

      // Wait for scanListeningTcpPorts async resolution
      const start = Date.now();
      while (sent.length === 0 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(sent.length).toBe(1);
      const msgStr = sent[0];
      expect(msgStr.startsWith('JSON:')).toBe(true);
      const control = JSON.parse(msgStr.slice(5));
      expect(control.type).toBe('proxy_list_ports_res');
      expect(control.reqId).toBe('req-port-test-1');
      expect(control.success).toBe(true);
      expect(Array.isArray(control.ports)).toBe(true);
    });

    it('responds with error when allowProxy is false', async () => {
      const sent: string[] = [];
      const handler = new ProxyHandler({
        send: (data) => {
          if (typeof data === 'string') sent.push(data);
        },
        allowProxy: false,
      });

      const handled = handler.handleControlMessage({
        type: 'proxy_list_ports',
        reqId: 'req-port-test-2',
      });
      expect(handled).toBe(true);

      expect(sent.length).toBe(1);
      const msgStr = sent[0];
      const control = JSON.parse(msgStr.slice(5));
      expect(control.type).toBe('proxy_list_ports_res');
      expect(control.reqId).toBe('req-port-test-2');
      expect(control.success).toBe(false);
      expect(control.error).toMatch(/disabled/i);
    });
  });

  describe('stripProxySessionCookie helper', () => {
    it('strips gt_proxy_session from single and compound cookie headers', () => {
      expect(stripProxySessionCookie(undefined)).toBeUndefined();
      expect(stripProxySessionCookie('')).toBeUndefined();
      expect(stripProxySessionCookie('gt_proxy_session=token123')).toBeUndefined();
      expect(stripProxySessionCookie('gt_proxy_session=token123; user_pref=dark')).toBe('user_pref=dark');
      expect(stripProxySessionCookie('app_sid=abc; gt_proxy_session=token123; user_pref=dark')).toBe(
        'app_sid=abc; user_pref=dark'
      );
      expect(
        stripProxySessionCookie(['gt_proxy_session=token123', 'foo=bar'])
      ).toBe('foo=bar');
    });
  });

  describe('Proxy Session Token & Hub Proxy Routes (Phase 2)', () => {
    let hubServer: http.Server;
    let hubPort: number;
    let hubWss: any;

    let targetHttpServer: http.Server;
    let targetHttpPort: number;
    let lastTargetReceivedHeaders: http.IncomingHttpHeaders | null = null;
    let lastTargetReceivedUrl: string | null = null;

    let agentWs: WebSocket | null = null;
    let agentProxyHandler: ProxyHandler | null = null;
    const testHostId = 'hub-proxy-p2-agent';
    const adminSecret = 'test-secret-p2-hub';
    const originalSecret = config.adminSecretKey;

    beforeAll(async () => {
      config.adminSecretKey = adminSecret;

      // 1. Target server
      targetHttpServer = http.createServer((req, res) => {
        lastTargetReceivedHeaders = req.headers;
        lastTargetReceivedUrl = req.url || null;

        if (req.url?.startsWith('/page')) {
          res.setHeader('Content-Type', 'text/html');
          res.writeHead(200);
          res.end('<h1>Target Page</h1>');
        } else if (req.url?.startsWith('/asset.js')) {
          res.setHeader('Content-Type', 'application/javascript');
          res.writeHead(200);
          res.end('console.log("asset");');
        } else if (req.url?.startsWith('/test')) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ url: req.url }));
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

      // 2. Hub Server
      hubServer = http.createServer(app);
      hubWss = setupTerminalWebSocket(hubServer);

      await new Promise<void>((resolve) => {
        hubServer.listen(0, '127.0.0.1', () => {
          hubPort = (hubServer.address() as AddressInfo).port;
          resolve();
        });
      });

      // 3. Connect simulated Agent WS to Hub
      await new Promise<void>((resolve) => {
        const wsUrl = `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${testHostId}&name=ProxyP2Node`;
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
      config.adminSecretKey = originalSecret;
      if (agentWs) agentWs.close();
      if (hubWss) hubWss.close();
      await new Promise<void>((r) => hubServer.close(() => r()));
      await new Promise<void>((r) => targetHttpServer.close(() => r()));
    });

    it('verifies createProxySessionToken and verifyProxySessionToken', () => {
      const token = createProxySessionToken(adminSecret, 3600000);
      expect(verifyProxySessionToken(token, adminSecret)).toBe(true);
      expect(verifyProxySessionToken(token, 'wrong-secret')).toBe(false);

      // Expired token
      const expiredToken = createProxySessionToken(adminSecret, -1000);
      expect(verifyProxySessionToken(expiredToken, adminSecret)).toBe(false);

      // Malformed tokens
      expect(verifyProxySessionToken('not.a.token', adminSecret)).toBe(false);
      expect(verifyProxySessionToken('abc', adminSecret)).toBe(false);
    });

    it('GET /api/proxy/:hostId/ports returns 200 with ports, 404 for unknown host', async () => {
      // 1. Success on connected host
      const res = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/ports`, {
        headers: { 'x-admin-key': adminSecret },
      });
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(Array.isArray(data.ports)).toBe(true);
      expect(data.ports.length).toBeGreaterThan(0);
      const foundTarget = data.ports.find((p: any) => p.port === targetHttpPort);
      expect(foundTarget).toBeDefined();

      // 2. 404 for unknown host
      const res404 = await fetch(`http://127.0.0.1:${hubPort}/api/proxy/unknown-agent-xyz/ports`, {
        headers: { 'x-admin-key': adminSecret },
      });
      expect(res404.status).toBe(404);
    });

    it('Browser session cookie flow: ticket auth sets gt_proxy_session, cookie auth works and strips token upstream', async () => {
      const ticket = ticketManager.createTicket();

      // Request 1: Ticket in query -> sets gt_proxy_session cookie and strips ticket from upstream
      const res1 = await fetch(
        `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/page?ticket=${ticket}`
      );
      expect(res1.status).toBe(200);
      expect(await res1.text()).toContain('Target Page');
      expect(lastTargetReceivedUrl).toBe('/page'); // ticket stripped

      const setCookie = res1.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('gt_proxy_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/');

      const match = setCookie?.match(/gt_proxy_session=([^;]+)/);
      expect(match).toBeTruthy();
      const sessionToken = match![1];

      // Request 2: Next sub-resource request uses only Cookie: gt_proxy_session=...; user_pref=dark
      const res2 = await fetch(
        `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/asset.js`,
        {
          headers: {
            Cookie: `gt_proxy_session=${sessionToken}; user_pref=dark`,
          },
        }
      );
      expect(res2.status).toBe(200);
      expect(await res2.text()).toContain('console.log');
      expect(lastTargetReceivedUrl).toBe('/asset.js');
      // Upstream MUST receive user_pref=dark and NOT receive gt_proxy_session
      expect(lastTargetReceivedHeaders?.['cookie']).toBe('user_pref=dark');

      // Request 3: Tampered or expired cookie returns 401 Unauthorized
      const res3 = await fetch(
        `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/asset.js`,
        {
          headers: {
            Cookie: `gt_proxy_session=${sessionToken}tampered`,
          },
        }
      );
      expect(res3.status).toBe(401);
    });

    it('_gt_host and _gt_proto query parameters override target and are stripped upstream', async () => {
      const res = await fetch(
        `http://127.0.0.1:${hubPort}/api/proxy/${testHostId}/port/${targetHttpPort}/test?_gt_host=127.0.0.1&_gt_proto=http&foo=1`,
        {
          headers: { 'x-admin-key': adminSecret },
        }
      );
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.url).toBe('/test?foo=1'); // _gt_host and _gt_proto stripped
      expect(lastTargetReceivedUrl).toBe('/test?foo=1');
    });

    it('terminalProxyBridge handles agent disconnect while listListeningPorts is pending', async () => {
      // Disconnect simulation
      const disconnectedHostId = 'dc-test-agent';
      const dummyWs: any = { readyState: 1, send: () => {} };
      terminalHostManager.registerHost(
        {
          id: disconnectedHostId,
          hostname: 'dc-host',
          ip: '127.0.0.1',
        },
        dummyWs
      );

      const promise = terminalProxyBridge.listListeningPorts(disconnectedHostId, 5000);

      // Simulate disconnect
      setTimeout(() => {
        terminalProxyBridge.handleAgentDisconnected(disconnectedHostId);
      }, 50);

      const res = await promise;
      expect(res.success).toBe(false);
      expect(res.status).toBe(502);
      expect(res.error).toBe('Agent disconnected');
    });
  });
});
