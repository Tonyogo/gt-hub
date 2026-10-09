import { createWebSocketAdapter } from '../src/shared/utils/wsAdapter';
import { EventEmitter } from 'events';

describe('Shared WebSocket Adapter Tests', () => {
  it('throws an error if no WebSocket implementation is found', () => {
    const origWs = (globalThis as any).WebSocket;
    try {
      delete (globalThis as any).WebSocket;
      const Adapter = createWebSocketAdapter(null as any);
      expect(() => new Adapter('ws://localhost:9999')).toThrow('WebSocket implementation not found');
    } finally {
      if (origWs) {
        (globalThis as any).WebSocket = origWs;
      }
    }
  });

  it('exposes standard WebSocket readyState constants', () => {
    const MockWs = class extends EventEmitter {
      binaryType = 'blob';
      readyState = 0;
      constructor() {
        super();
      }
      addEventListener(type: string, listener: any) {
        this.on(type, listener);
      }
    };

    const Adapter = createWebSocketAdapter(MockWs as any);
    expect(Adapter.CONNECTING).toBe(0);
    expect(Adapter.OPEN).toBe(1);
    expect(Adapter.CLOSING).toBe(2);
    expect(Adapter.CLOSED).toBe(3);

    const instance = new Adapter('ws://localhost:8080');
    expect(instance.CONNECTING).toBe(0);
    expect(instance.OPEN).toBe(1);
    expect(instance.CLOSING).toBe(2);
    expect(instance.CLOSED).toBe(3);
  });

  it('handles events, message transformation, and send callback', (done) => {
    class MockWs extends EventEmitter {
      binaryType = 'blob';
      readyState = 1;
      sentData: any[] = [];
      constructor(public url: string, public options?: any) {
        super();
      }
      addEventListener(type: string, listener: any) {
        this.on(type, listener);
      }
      send(data: any, options: any, cb?: any) {
        this.sentData.push(data);
        return true;
      }
      close(code?: number, reason?: string) {
        this.emit('close', { code, reason });
      }
    }

    const Adapter = createWebSocketAdapter(MockWs as any);
    const adapter = new Adapter('ws://localhost:8080', { headers: { 'x-test': '1' } });

    expect(adapter.readyState).toBe(1);

    const openSpy = jest.fn();
    adapter.on('open', openSpy);
    (adapter as any)._ws.emit('open', {});
    expect(openSpy).toHaveBeenCalled();

    // Message event
    let messageReceived = false;
    adapter.on('message', (data: any, isBinary: boolean) => {
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(data.toString()).toBe('hello world');
      expect(isBinary).toBe(true);
      messageReceived = true;
    });

    const buf = Buffer.from('hello world');
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    (adapter as any)._ws.emit('message', { data: arrayBuffer });
    expect(messageReceived).toBe(true);

    // Send with callback
    adapter.send('test-msg', (err?: any) => {
      expect(err).toBeUndefined();
      expect((adapter as any)._ws.sentData).toContain('test-msg');
      done();
    });
  });

  it('supports event listener management (on, once, off, removeAllListeners)', () => {
    class MockWs extends EventEmitter {
      binaryType = 'blob';
      readyState = 1;
      addEventListener(type: string, listener: any) {
        this.on(type, listener);
      }
    }

    const Adapter = createWebSocketAdapter(MockWs as any);
    const adapter = new Adapter('ws://localhost:8080');

    let count = 0;
    const fn = () => { count++; };

    adapter.once('custom', fn);
    adapter.emit('custom');
    adapter.emit('custom');
    expect(count).toBe(1);

    const fn2 = () => { count += 10; };
    adapter.on('custom2', fn2);
    adapter.emit('custom2');
    expect(count).toBe(11);
    adapter.off('custom2', fn2);
    adapter.emit('custom2');
    expect(count).toBe(11);

    adapter.on('custom3', fn);
    adapter.removeAllListeners('custom3');
    adapter.emit('custom3');
    expect(count).toBe(11);
  });
});
