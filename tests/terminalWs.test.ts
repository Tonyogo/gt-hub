import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager } from '../src/terminal/services/terminalHostManager';
import { encodeControlJsonPacket } from '../src/shared/protocol/binaryProtocol';
import config from '../config/default';

describe('Terminal WebSocket Gateway', () => {
  let server: http.Server;
  let port: number;
  let wss: any;

  beforeAll((done) => {
    const app = express();
    server = http.createServer(app);
    wss = setupTerminalWebSocket(server);
    server.listen(0, () => {
      const addr = server.address() as any;
      port = addr.port;
      done();
    });
  });

  afterAll((done) => {
    if (wss) {
      try {
        wss.close();
      } catch {}
    }
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    server.close(done);
  });

  it('should reject connection when admin secret key is set but invalid', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'test-secret-key-123';

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/terminal/ws?x-admin-key=wrong-key`);

    ws.on('error', (err) => {
      expect(err.message).toContain('401');
    });

    ws.on('close', (code) => {
      expect([1006, 1008]).toContain(code);
      config.adminSecretKey = originalKey;
      done();
    });
  });

  it('should notify client and close 1008 when host is offline or not found', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=non-existent-host&key=valid-key`);
    let messageReceived = '';

    ws.on('message', (data) => {
      messageReceived += data.toString();
    });

    ws.on('close', (code) => {
      expect(code).toBe(1008);
      expect(messageReceived).toContain('[Host Offline]');
      config.adminSecretKey = originalKey;
      done();
    });
  });

  it('should connect agent, attach client to host, and relay terminal data', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';

    const testHostId = 'agent-ws-test';

    // 1. Connect agent
    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${testHostId}&name=TestNode&key=valid-key`
    );

    agentWs.on('open', () => {
      // 2. Connect client
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=${testHostId}&key=valid-key`
      );

      // Listen for data on agent side
      agentWs.on('message', (agentMsg) => {
        const str = agentMsg.toString();
        if (str.startsWith('JSON:')) {
          const control = JSON.parse(str.slice(5));
          if (control.type === 'resize') {
            expect(control.cols).toBe(100);
            expect(control.rows).toBe(30);
            return;
          }
        }
        if (str === 'hello-agent-shell\n') {
          // Agent replies back
          agentWs.send('reply-from-agent\n');
        }
      });

      clientWs.on('open', () => {
        clientWs.send(`JSON:${JSON.stringify({ type: 'resize', cols: 100, rows: 30 })}`);
        clientWs.send('hello-agent-shell\n');
      });

      clientWs.on('message', (msg) => {
        const text = msg.toString();
        if (text.includes('reply-from-agent')) {
          let closedCount = 0;
          const checkDone = () => {
            closedCount++;
            if (closedCount === 2) {
              setTimeout(() => {
                config.adminSecretKey = originalKey;
                done();
              }, 50);
            }
          };
          clientWs.on('close', checkDone);
          agentWs.on('close', checkDone);
          clientWs.close();
          agentWs.close();
        }
      });
    });
  }, 10000);

  it('should respond with prefixed JSON:{"type":"pong"} when agent sends ping', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';
    const testHostId = 'agent-ping-test';

    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${testHostId}&name=PingNode&key=valid-key`
    );

    agentWs.on('open', () => {
      agentWs.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
    });

    agentWs.on('message', (msg) => {
      const text = msg.toString();
      if (text.startsWith('JSON:')) {
        const payload = JSON.parse(text.slice(5));
        if (payload.type === 'pong') {
          expect(text).toBe('JSON:{"type":"pong"}');
          agentWs.close();
          config.adminSecretKey = originalKey;
          done();
        }
      }
    });
  });

  it('treats raw JSON output in binary or text frame as terminal output rather than control command', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';
    const testHostId = 'agent-raw-json-test';

    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${testHostId}&name=JsonNode&key=valid-key`
    );

    agentWs.on('open', () => {
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=${testHostId}&key=valid-key`
      );

      let receivedOnClient = '';
      clientWs.on('message', (msg) => {
        receivedOnClient += msg.toString();
        if (receivedOnClient.includes('{"type":"reset"}')) {
          agentWs.close();
          clientWs.close();
          config.adminSecretKey = originalKey;
          done();
        }
      });

      clientWs.on('open', () => {
        // Send raw JSON without JSON: prefix from agent as binary frame
        agentWs.send(Buffer.from('{"type":"reset"}'));
      });
    });
  });

  it('should respond with prefixed JSON:{"type":"pong"} when interactive client sends ping keepalive', (done) => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';
    const testHostId = 'client-ping-test';

    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${testHostId}&name=PingClientNode&key=valid-key`
    );

    agentWs.on('open', () => {
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=${testHostId}&key=valid-key`
      );

      clientWs.on('open', () => {
        clientWs.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
      });

      clientWs.on('message', (msg) => {
        const text = msg.toString();
        if (text.startsWith('JSON:')) {
          const payload = JSON.parse(text.slice(5));
          if (payload.type === 'pong') {
            expect(text).toBe('JSON:{"type":"pong"}');
            clientWs.close();
            agentWs.close();
            config.adminSecretKey = originalKey;
            done();
          }
        }
      });
    });
  });

  it('consumes cron response/error control frames without leaking to live web terminal or replay history', async () => {
    const originalKey = config.adminSecretKey;
    config.adminSecretKey = 'valid-key';
    const testHostId = 'agent-cron-leak-test';

    let agentWs: WebSocket | null = null;
    let client1: WebSocket | null = null;
    let client2: WebSocket | null = null;

    try {
      agentWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/agent-ws?hostId=${testHostId}&name=CronLeakNode&key=valid-key`
      );
      await new Promise<void>((resolve, reject) => {
        agentWs!.once('open', () => resolve());
        agentWs!.once('error', reject);
      });

      client1 = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=${testHostId}&key=valid-key`
      );
      await new Promise<void>((resolve, reject) => {
        client1!.once('open', () => resolve());
        client1!.once('error', reject);
      });

      let client1Output = '';
      const client1Done = new Promise<void>((resolve) => {
        client1!.on('message', (msg) => {
          const chunk = msg.toString();
          client1Output += chunk;
          if (client1Output.includes('REAL_PTY_OUTPUT_MARKER')) {
            resolve();
          }
        });
      });

      // Agent sends cron control response/error frames (text JSON: and binary CONTROL_JSON) plus real PTY output
      agentWs.send(`JSON:${JSON.stringify({ type: 'cron_sync_res', success: true, count: 1 })}`);
      agentWs.send(
        `JSON:${JSON.stringify({
          type: 'cron_trigger_res',
          success: true,
          record: { executionId: 'exec-1', jobId: 'job-1', status: 'completed' },
        })}`
      );
      agentWs.send(`JSON:${JSON.stringify({ type: 'cron_list_res', requestId: 'r1', summaries: [] })}`);
      agentWs.send(`JSON:${JSON.stringify({ type: 'cron_history_res', requestId: 'r2', history: [] })}`);
      agentWs.send(`JSON:${JSON.stringify({ type: 'cron_error', error: 'some error' })}`);
      agentWs.send(encodeControlJsonPacket({ type: 'cron_sync_res', success: true, count: 2 }, testHostId));
      agentWs.send('REAL_PTY_OUTPUT_MARKER\r\n');

      await client1Done;
      // Wait slightly beyond StreamBatcher 16ms window to ensure no delayed batch arrives
      await new Promise((r) => setTimeout(r, 40));

      expect(client1Output).toContain('REAL_PTY_OUTPUT_MARKER');
      expect(client1Output).not.toContain('cron_sync_res');
      expect(client1Output).not.toContain('cron_trigger_res');
      expect(client1Output).not.toContain('cron_list_res');
      expect(client1Output).not.toContain('cron_history_res');
      expect(client1Output).not.toContain('cron_error');

      const session = terminalHostManager.getSession(testHostId);
      expect(session).not.toBeNull();
      const history = session!.getHistory();
      expect(history).toBe('REAL_PTY_OUTPUT_MARKER\r\n');

      // Attach a second browser client to verify replayed history does not contain concatenated JSON:{...} frames
      client2 = new WebSocket(
        `ws://127.0.0.1:${port}/api/admin/terminal/ws?hostId=${testHostId}&key=valid-key`
      );
      const client2Output = await new Promise<string>((resolve, reject) => {
        let buf = '';
        client2!.on('message', (msg) => {
          buf += msg.toString();
          if (buf.includes('REAL_PTY_OUTPUT_MARKER')) {
            setTimeout(() => resolve(buf), 30);
          }
        });
        client2!.once('error', reject);
      });

      expect(client2Output).toBe('\x1b[0m\x1b[?25hREAL_PTY_OUTPUT_MARKER\r\n');
      expect(client2Output).not.toContain('JSON:');
      expect(client2Output).not.toContain('cron_');
    } finally {
      if (client1) try { client1.terminate(); } catch {}
      if (client2) try { client2.terminate(); } catch {}
      if (agentWs) try { agentWs.terminate(); } catch {}
      config.adminSecretKey = originalKey;
    }
  });
});
