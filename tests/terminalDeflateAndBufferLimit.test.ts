import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { TerminalHistoryBuffer } from '../src/agent/pty/terminalHistoryBuffer';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import config from '../config/default';

describe('Terminal Buffer 1MB Limit & WebSocket Deflate Compression', () => {
  describe('Buffer 1MB Sizing', () => {
    it('TerminalHistoryBuffer defaults to 1MB maxBytes', () => {
      const buf = new TerminalHistoryBuffer();
      // Push 1.2MB data
      const chunk = Buffer.alloc(1.2 * 1024 * 1024, 'x');
      buf.push(chunk);
      expect(buf.getSize()).toBe(1 * 1024 * 1024);
    });

    it('RemoteAgentTerminalSession defaults to 1MB maxBufferSize', () => {
      const session = new RemoteAgentTerminalSession('test-host-1mb');
      const chunk1 = 'A'.repeat(0.8 * 1024 * 1024);
      const chunk2 = 'B'.repeat(0.5 * 1024 * 1024);
      session.handleData(chunk1);
      session.handleData(chunk2);
      expect(session.getHistory().length).toBe(1 * 1024 * 1024);
      expect(session.getHistory().startsWith('A')).toBe(true);
      expect(session.getHistory().endsWith('B')).toBe(true);
    });
  });

  describe('WebSocket Permessage-Deflate Negotiation', () => {
    let server: http.Server;
    let port: number;
    let wss: any;
    let activeClient: WebSocket | null = null;
    const origSecretKey = config.adminSecretKey;

    beforeAll((done) => {
      config.adminSecretKey = '';
      const app = express();
      server = http.createServer(app);
      wss = setupTerminalWebSocket(server);
      server.listen(0, () => {
        const addr = server.address() as any;
        port = addr.port;
        done();
      });
    });

    afterEach(() => {
      if (activeClient) {
        try { activeClient.terminate(); } catch {}
        activeClient = null;
      }
    });

    afterAll((done) => {
      config.adminSecretKey = origSecretKey;
      if (wss) {
        try { wss.close(); } catch {}
      }
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      server.close(done);
    });

    it('negotiates permessage-deflate extension with connecting clients', (done) => {
      let called = false;
      const finish = (err?: any) => {
        if (called) return;
        called = true;
        done(err);
      };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=agent-deflate-test`, {
        perMessageDeflate: true,
      });
      activeClient = ws;

      ws.on('upgrade', (res) => {
        try {
          const extensions = res.headers['sec-websocket-extensions'] || '';
          expect(extensions).toContain('permessage-deflate');
        } catch (err) {
          try { ws.terminate(); } catch {}
          return finish(err);
        }
      });

      ws.on('open', () => {
        // Send a message larger than 1024 bytes to trigger compression
        const largePayload = 'JSON:' + JSON.stringify({
          type: 'cmd_stream_data',
          data: 'Z'.repeat(4096),
        });
        ws.send(largePayload);

        setTimeout(() => {
          ws.close();
          finish();
        }, 100);
      });

      ws.on('error', (err) => {
        finish(err);
      });
    });
  });
});
