import http from 'http';
import { WebSocketServer } from 'ws';
// @ts-ignore
const gt = require('../scripts/gt.js');

describe('NativeWebSocketAdapter', () => {
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

  it('exports createWebSocketAdapter function', () => {
    expect(typeof gt.createWebSocketAdapter).toBe('function');
  });

  it('connects, sends and receives text and binary messages with EventEmitter interface', (done) => {
    wss.once('connection', (ws, req) => {
      expect(req.headers['x-admin-key']).toBe('test-secret');
      ws.send('server-hello');
      ws.send(Buffer.from([0x01, 0x02, 0x03]));
      ws.on('message', (data, isBinary) => {
        if (data.toString() === 'client-ping') {
          ws.send('server-pong');
        }
      });
    });

    const AdapterClass = gt.createWebSocketAdapter();
    expect(AdapterClass.OPEN).toBe(1);
    expect(AdapterClass.CLOSED).toBe(3);

    const client = new AdapterClass(`ws://127.0.0.1:${port}`, {
      headers: { 'x-admin-key': 'test-secret' },
    });

    expect(typeof client.on).toBe('function');
    expect(typeof client.once).toBe('function');
    expect(typeof client.off).toBe('function');
    expect(typeof client.terminate).toBe('function');

    const received: Array<{ data: any; isBinary: boolean }> = [];

    client.on('open', () => {
      expect(client.readyState).toBe(AdapterClass.OPEN);
      client.send('client-ping');
    });

    client.on('message', (data: any, isBinary: boolean) => {
      received.push({ data, isBinary });
      if (received.length === 3) {
        expect(received[0].data.toString()).toBe('server-hello');
        expect(received[0].isBinary).toBe(false);

        expect(Buffer.isBuffer(received[1].data)).toBe(true);
        expect(received[1].data).toEqual(Buffer.from([0x01, 0x02, 0x03]));
        expect(received[1].isBinary).toBe(true);

        expect(received[2].data.toString()).toBe('server-pong');

        client.close();
      }
    });

    client.on('close', () => {
      done();
    });
  });

  it('supports once and off listener methods', () => {
    const AdapterClass = gt.createWebSocketAdapter();
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    let calls = 0;
    client.once('custom', () => { calls++; });
    client._emit('custom');
    client._emit('custom');
    expect(calls).toBe(1);

    const handler = () => {};
    client.on('test', handler);
    expect(client._listeners.get('test').length).toBe(1);
    client.removeListener('test', handler);
    expect(client._listeners.get('test').length).toBe(0);
    client.close();
  });

  it('guards ws._socket safely if undefined', () => {
    const AdapterClass = gt.createWebSocketAdapter();
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    expect(client._socket).toBeUndefined();

    let fired = false;
    client.on('upgrade', () => {
      if (client && client._socket && typeof client._socket.setKeepAlive === 'function') {
        client._socket.setKeepAlive(true, 10000);
      }
      fired = true;
    });
    expect(() => client._emit('upgrade', {})).not.toThrow();
    expect(fired).toBe(true);
    client.close();
  });
});
