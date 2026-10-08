import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
const {
  parseControlMessage,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
} = require('../scripts/gt.js');

describe('Terminal Agent Keepalive & Control Protocol', () => {
  it('should export correct keepalive constants', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(20000);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(4000);
  });

  describe('parseControlMessage', () => {
    it('should parse JSON: prefixed control messages', () => {
      const msg = 'JSON:{"type":"ping"}';
      const parsed = parseControlMessage(msg);
      expect(parsed).toEqual({ type: 'ping' });
    });

    it('should reject bare JSON control messages to avoid stream confusion', () => {
      const msg = '{"type":"pong"}';
      const parsed = parseControlMessage(msg);
      expect(parsed).toBeNull();
    });

    it('should return null for non-control shell text', () => {
      expect(parseControlMessage('ls -la\n')).toBeNull();
      expect(parseControlMessage('{"invalid-type"')).toBeNull();
      expect(parseControlMessage('')).toBeNull();
      expect(parseControlMessage(null as any)).toBeNull();
    });
  });

  describe('Mock Server Heartbeat Cycle', () => {
    let server: http.Server;
    let wss: WebSocketServer;
    let port: number;

    beforeAll((done) => {
      server = http.createServer();
      wss = new WebSocketServer({ server });
      server.listen(0, () => {
        port = (server.address() as any).port;
        done();
      });
    });

    afterAll((done) => {
      wss.close(() => {
        server.close(done);
      });
    });

    it('should handle ping and return pong frame properly', (done) => {
      wss.once('connection', (ws) => {
        ws.on('message', (data) => {
          const str = data.toString();
          if (str.startsWith('JSON:')) {
            const control = JSON.parse(str.slice(5));
            if (control.type === 'ping') {
              ws.send('JSON:{"type":"pong"}');
            }
          }
        });
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('open', () => {
        client.send('JSON:{"type":"ping"}');
      });

      client.on('message', (data) => {
        const str = data.toString();
        const control = parseControlMessage(str);
        if (control && control.type === 'pong') {
          client.close();
          done();
        }
      });
    });

    it('should terminate and close with 1006 when server silently drops without FIN packet', (done) => {
      let serverSocket: any = null;
      wss.once('connection', (ws) => {
        serverSocket = ws;
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('open', () => {
        // Destroy server socket abruptly to simulate abrupt drop / crash
        setTimeout(() => {
          if (serverSocket) {
            serverSocket._socket.destroy();
          }
        }, 100);
      });

      client.on('close', (code) => {
        expect(code).toBe(1006);
        done();
      });
    });
  });
});
