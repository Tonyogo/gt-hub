import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
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
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
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

  it('supports addListener, emit, and removeAllListeners', () => {
    const AdapterClass = gt.createWebSocketAdapter();
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    let called = 0;
    const h1 = () => { called++; };
    const h2 = () => { called += 10; };

    client.addListener('evt1', h1);
    client.addListener('evt2', h2);
    expect(client.emit('evt1')).toBe(true);
    expect(called).toBe(1);

    client.removeAllListeners('evt1');
    expect(client._listeners.has('evt1')).toBe(false);

    client.removeAllListeners();
    expect(client._listeners.size).toBe(0);
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

  it('supports passing a custom WebSocket constructor', () => {
    const AdapterClass = gt.createWebSocketAdapter(WebSocket);
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    expect(client).toBeDefined();
    client.close();
  });

  it('falls back to ws package when globalThis.WebSocket is undefined', () => {
    const origWs = (globalThis as any).WebSocket;
    try {
      delete (globalThis as any).WebSocket;
      const AdapterClass = gt.createWebSocketAdapter();
      const client = new AdapterClass(`ws://127.0.0.1:${port}`);
      expect(client).toBeDefined();
      client.close();
    } finally {
      (globalThis as any).WebSocket = origWs;
    }
  });

  it('supports terminate() by delegating to underlying terminate or close', () => {
    const AdapterClass = gt.createWebSocketAdapter();
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    const originalTerminate = (client as any)._ws.terminate;
    let terminateCalled = false;
    (client as any)._ws.terminate = () => {
      terminateCalled = true;
      if (typeof originalTerminate === 'function') {
        originalTerminate.call((client as any)._ws);
      } else {
        (client as any)._ws.close();
      }
    };
    client.terminate();
    expect(terminateCalled).toBe(true);
  });

  it('throws a descriptive error when neither globalThis.WebSocket nor ws is available', () => {
    const AdapterClass = gt.createWebSocketAdapter(null);
    expect(() => new AdapterClass(`ws://127.0.0.1:${port}`)).toThrow(
      /WebSocket implementation not found \(neither globalThis\.WebSocket nor ws is available\)/
    );
  });

  it('handles send with callback safely', (done) => {
    const AdapterClass = gt.createWebSocketAdapter();
    const client = new AdapterClass(`ws://127.0.0.1:${port}`);
    client.on('open', () => {
      client.send('ping', () => {
        client.close();
        done();
      });
    });
  });
});
