import http from 'http';
import net from 'net';
import zlib from 'zlib';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import app from '../src/server/app';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { ProxyHandler } from '../src/agent/handlers/proxyHandler';
import {
  BIN_MSG_TYPE,
  decodeBinaryPacket,
} from '../src/shared/protocol/binaryProtocol';
import config from '../config/default';

describe('Agent Proxy Network Latency & Bandwidth Speedtest', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let hubWss: any;

  let localTestHttpServer: http.Server;
  let localTestHttpPort: number;

  let agentWs: WebSocket | null = null;
  let agentProxyHandler: ProxyHandler | null = null;
  let agentSentBytes = 0;
  const testHostId = 'speedtest-test-agent';
  const originalKey = config.adminSecretKey;
  const adminSecret = 'test-secret-speedtest';

  beforeAll(async () => {
    config.adminSecretKey = adminSecret;

    // 1. Local test target HTTP server for probe tests
    localTestHttpServer = http.createServer((req, res) => {
      if (req.url === '/probe-ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      localTestHttpServer.listen(0, '127.0.0.1', () => {
        localTestHttpPort = (localTestHttpServer.address() as AddressInfo).port;
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
      const wsUrl = `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${testHostId}&name=SpeedNode`;
      agentWs = new WebSocket(wsUrl, {
        headers: { 'x-admin-key': adminSecret },
      });

      agentWs.on('open', () => {
        agentProxyHandler = new ProxyHandler({
          send: (data: string | Buffer, opts?: { binary?: boolean; compress?: boolean }) => {
            if (agentWs && agentWs.readyState === WebSocket.OPEN) {
              if (Buffer.isBuffer(data)) {
                agentSentBytes += data.length;
                agentWs.send(data, { binary: true, compress: opts?.compress ?? false });
              } else {
                agentWs.send(data);
              }
            }
          },
          getBufferedAmount: () => (agentWs ? agentWs.bufferedAmount : 0),
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
      agentWs.close();
    }
    if (hubWss) {
      try {
        hubWss.close();
      } catch {}
    }
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    await new Promise<void>((resolve) => localTestHttpServer.close(() => resolve()));
  });

  function makeHubRequest(options: http.RequestOptions, bodyData?: Buffer | string): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: hubPort,
          ...options,
          headers: {
            'x-admin-key': adminSecret,
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
      );
      req.on('error', reject);
      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  describe('Task 1: Speedtest Engine (ping, download, upload, probe)', () => {
    it('1. GET /api/proxy/:hostId/speedtest/ping returns 200 with hubAgentRttMs and timestamp', async () => {
      const res = await makeHubRequest({
        path: `/api/proxy/${testHostId}/speedtest/ping`,
        method: 'GET',
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body.toString('utf-8'));
      expect(typeof json.hubAgentRttMs).toBe('number');
      expect(json.hubAgentRttMs).toBeGreaterThanOrEqual(0);
      expect(typeof json.timestamp).toBe('number');
    });

    it('2. GET /api/proxy/:hostId/speedtest/download streams high-entropy incompressible bytes and cleans up on client abort', async () => {
      const testBytes = 262144; // 256KB
      const res = await makeHubRequest({
        path: `/api/proxy/${testHostId}/speedtest/download?bytes=${testBytes}`,
        method: 'GET',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBe(testBytes);

      // Verify incompressibility
      const compressed = zlib.deflateSync(res.body);
      expect(compressed.length).toBeGreaterThan(250000);

      // Test mid-stream abort cleanup: ensure Agent does NOT dump all 64MB into the socket before abort is processed
      agentSentBytes = 0;
      await new Promise<void>((resolve, reject) => {
        let aborted = false;
        const abortReq = http.request(
          {
            hostname: '127.0.0.1',
            port: hubPort,
            path: `/api/proxy/${testHostId}/speedtest/download?bytes=67108864`, // 64MB
            method: 'GET',
            headers: { 'x-admin-key': adminSecret },
          },
          (abortRes) => {
            let received = 0;
            abortRes.on('data', (chunk) => {
              received += chunk.length;
              if (!aborted && received >= 131072) {
                aborted = true;
                // Abort after 128KB received
                abortReq.destroy();
                setTimeout(() => {
                  try {
                    expect(agentProxyHandler?.getActiveCount().httpCount).toBe(0);
                    // Agent should have sent only a small fraction (< 4MB), NOT all 64MB!
                    expect(agentSentBytes).toBeLessThan(4 * 1024 * 1024);
                    resolve();
                  } catch (err) {
                    reject(err);
                  }
                }, 80);
              }
            });
            abortRes.on('error', () => {
              // Destroy triggers abort
            });
          }
        );
        abortReq.on('error', () => {
          // Expected on client destroy
        });
        abortReq.end();
      });
    });

    it('3. POST /api/proxy/:hostId/speedtest/upload streams binary chunks and returns receivedBytes and agentDurationMs', async () => {
      const uploadBytes = 262144; // 256KB
      const uploadBuf = Buffer.alloc(uploadBytes, 0x5a);

      const res = await makeHubRequest(
        {
          path: `/api/proxy/${testHostId}/speedtest/upload`,
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(uploadBytes),
          },
        },
        uploadBuf
      );

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body.toString('utf-8'));
      expect(json.receivedBytes).toBe(uploadBytes);
      expect(typeof json.agentDurationMs).toBe('number');
      expect(json.agentDurationMs).toBeGreaterThanOrEqual(1);
    });

    it('4. POST /api/proxy/:hostId/speedtest/probe tests live target and unreachable target', async () => {
      const probePayload = JSON.stringify({
        targets: [
          `http://127.0.0.1:${localTestHttpPort}/probe-ok`,
          'http://127.0.0.1:1/unreachable', // Unused port
        ],
        timeoutMs: 3000,
      });

      const res = await makeHubRequest(
        {
          path: `/api/proxy/${testHostId}/speedtest/probe`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
        },
        probePayload
      );

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body.toString('utf-8'));
      expect(Array.isArray(json.results)).toBe(true);
      expect(json.results.length).toBe(2);

      const okTarget = json.results[0];
      expect(okTarget.ok).toBe(true);
      expect(okTarget.statusCode).toBe(200);
      expect(okTarget.latencyMs).toBeGreaterThanOrEqual(0);

      const failTarget = json.results[1];
      expect(failTarget.ok).toBe(false);
      expect(typeof failTarget.error).toBe('string');
    });

    it('5. terminalProxyBridge handles agent disconnect cleanly during pending ping or probe', async () => {
      const { terminalProxyBridge } = await import('../src/terminal/services/terminalProxyBridge');
      
      const pingPromise = terminalProxyBridge.pingAgent(testHostId, 10000);
      const probePromise = terminalProxyBridge.probeTargets(testHostId, ['http://127.0.0.1:1'], 10000);

      // Simulate unexpected agent disconnect
      terminalProxyBridge.handleAgentDisconnected(testHostId);

      const pingRes = await pingPromise;
      expect(pingRes.success).toBe(false);
      expect(pingRes.status).toBe(502);
      expect(pingRes.error).toBe('Agent disconnected');

      const probeRes = await probePromise;
      expect(probeRes.success).toBe(false);
      expect(probeRes.status).toBe(502);
      expect(probeRes.error).toBe('Agent disconnected');
    });
  });

  describe('Task 2: CLI runSpeedtestBenchmark', () => {
    it('executes full benchmark and returns valid structured metrics', async () => {
      const { runSpeedtestBenchmark } = await import('../src/client/commands/proxy');

      const report = await runSpeedtestBenchmark({
        serverUrl: `http://127.0.0.1:${hubPort}`,
        apiKey: adminSecret,
        hostId: testHostId,
        sizeBytes: 131072, // 128KB
        pings: 3,
        targets: [`http://127.0.0.1:${localTestHttpPort}/probe-ok`],
      });

      expect(report.hostId).toBe(testHostId);
      expect(report.latency.samples).toBe(3);
      expect(report.latency.avgTotalRttMs).toBeGreaterThanOrEqual(0);
      expect(report.latency.avgHubAgentRttMs).toBeGreaterThanOrEqual(0);
      expect(report.latency.avgClientHubRttMs).toBeGreaterThanOrEqual(0);
      expect(report.latency.minRttMs).toBeGreaterThanOrEqual(0);
      expect(report.latency.maxRttMs).toBeGreaterThanOrEqual(0);
      expect(report.latency.jitterMs).toBeGreaterThanOrEqual(0);

      expect(report.download.bytes).toBe(131072);
      expect(report.download.durationMs).toBeGreaterThanOrEqual(1);
      expect(report.download.mbps).toBeGreaterThan(0);
      expect(report.download.mbPerSec).toBeGreaterThan(0);

      expect(report.upload.bytes).toBe(131072);
      expect(report.upload.durationMs).toBeGreaterThanOrEqual(1);
      expect(report.upload.mbps).toBeGreaterThan(0);
      expect(report.upload.mbPerSec).toBeGreaterThan(0);

      expect(report.probes.length).toBe(1);
      expect(report.probes[0].ok).toBe(true);
      expect(report.probes[0].statusCode).toBe(200);
      expect(report.probes[0].latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('handleSpeedtestCommand outputs json when json option is true', async () => {
      const { handleSpeedtestCommand } = await import('../src/client/commands/proxy');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await handleSpeedtestCommand({
        server: `http://127.0.0.1:${hubPort}`,
        key: adminSecret,
        node: testHostId,
        sizeMb: 0.125, // 128KB
        pings: 1,
        targets: [`http://127.0.0.1:${localTestHttpPort}/probe-ok`],
        json: true,
      });

      expect(logSpy).toHaveBeenCalled();
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
      const parsed = JSON.parse(lastCall);
      expect(parsed.hostId).toBe(testHostId);
      expect(parsed.download.mbps).toBeGreaterThan(0);
      logSpy.mockRestore();
    });
  });
});
