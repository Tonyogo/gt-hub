export function createWebSocketAdapter(customWs?: any): any {
  const getWsCtor = () => {
    if (customWs !== undefined) return customWs;
    // In Node.js environment, prioritize the 'ws' package because it supports Node.js network options
    // such as custom HTTP headers ({ headers: { 'x-admin-key': '...' } }), permessage-deflate, and agent options.
    try {
      const wsModule = require('ws');
      if (wsModule) return wsModule;
    } catch {}
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).WebSocket === 'function') {
      return (globalThis as any).WebSocket;
    }
    return null;
  };

  class NativeWebSocketAdapter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    public CONNECTING = 0;
    public OPEN = 1;
    public CLOSING = 2;
    public CLOSED = 3;

    private _ws: any;
    private _listeners: Map<string, any[]>;

    constructor(url: string, options: any = {}) {
      const WsCtor = getWsCtor();
      if (!WsCtor) {
        throw new Error('WebSocket implementation not found (neither globalThis.WebSocket nor ws is available)');
      }
      const isNativeGlobalWs =
        typeof globalThis !== 'undefined' &&
        typeof (globalThis as any).WebSocket === 'function' &&
        WsCtor === (globalThis as any).WebSocket;
      if (isNativeGlobalWs) {
        // Native browser/Node 22+ WebSocket only accepts string | string[] as second argument.
        // Passing an options object with headers causes a TypeError in Node 22/24.
        // Fallback: If options.headers contains an admin key, append it to query params (?x-admin-key=...)
        let finalUrl = url;
        if (options && typeof options === 'object' && options.headers) {
          const headers = options.headers;
          const adminKey = headers['x-admin-key'] || headers['X-Admin-Key'] || headers['key'];
          if (adminKey && typeof adminKey === 'string') {
            try {
              const parsed = new URL(finalUrl);
              if (!parsed.searchParams.has('x-admin-key') && !parsed.searchParams.has('key')) {
                parsed.searchParams.set('x-admin-key', adminKey);
                finalUrl = parsed.toString();
              }
            } catch {
              const separator = finalUrl.includes('?') ? '&' : '?';
              finalUrl = `${finalUrl}${separator}x-admin-key=${encodeURIComponent(adminKey)}`;
            }
          }
        }

        const protocols = Array.isArray(options) || typeof options === 'string'
          ? options
          : (options && typeof options === 'object' && options.protocols ? options.protocols : undefined);

        if (protocols) {
          this._ws = new WsCtor(finalUrl, protocols);
        } else {
          this._ws = new WsCtor(finalUrl);
        }
      } else {
        this._ws = new WsCtor(url, options);
      }
      this._ws.binaryType = 'arraybuffer';
      this._listeners = new Map();

      if (typeof this._ws.addEventListener === 'function') {
        this._ws.addEventListener('open', (e: any) => this._emit('open', e));
        this._ws.addEventListener('close', (e: any) => this._emit('close', e.code, e.reason));
        this._ws.addEventListener('error', (e: any) => {
          this._emit('error', e.error || new Error(e.message || 'WebSocket error'));
        });
        this._ws.addEventListener('message', (e: any) => {
          let data = e.data;
          const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data) || Buffer.isBuffer(data);
          if (data instanceof ArrayBuffer) {
            data = Buffer.from(data);
          } else if (ArrayBuffer.isView(data) && !Buffer.isBuffer(data)) {
            data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          }
          this._emit('message', data, isBinary);
        });
      } else if (typeof this._ws.on === 'function') {
        this._ws.on('open', (e: any) => this._emit('open', e));
        this._ws.on('close', (code: any, reason: any) => this._emit('close', code, reason));
        this._ws.on('error', (err: any) => this._emit('error', err));
        this._ws.on('message', (data: any, isBinary: boolean) => this._emit('message', data, isBinary));
      }

      if (typeof this._ws.on === 'function') {
        this._ws.on('upgrade', (response: any) => this._emit('upgrade', response));
        this._ws.on('ping', (data: any) => this._emit('ping', data));
        this._ws.on('pong', (data: any) => this._emit('pong', data));
      }
    }

    get readyState(): number {
      return this._ws.readyState;
    }

    send(data: any, options?: any, cb?: any): any {
      if (typeof options === 'function') {
        cb = options;
        options = undefined;
      }
      try {
        const res = this._ws.send(data, options, cb);
        if (typeof cb === 'function' && typeof this._ws.terminate !== 'function') {
          process.nextTick(() => cb());
        }
        return res;
      } catch (err) {
        if (typeof cb === 'function') {
          process.nextTick(() => cb(err));
        } else {
          throw err;
        }
      }
    }

    close(code?: number, reason?: string): any {
      if (code !== undefined) {
        return this._ws.close(code, reason);
      }
      return this._ws.close();
    }

    terminate(): any {
      if (typeof this._ws.terminate === 'function') {
        return this._ws.terminate();
      }
      return this._ws.close();
    }

    on(event: string, handler: any): this {
      if (!this._listeners.has(event)) {
        this._listeners.set(event, []);
      }
      this._listeners.get(event)!.push(handler);
      return this;
    }

    addListener(event: string, handler: any): this {
      return this.on(event, handler);
    }

    once(event: string, handler: any): this {
      const onceWrapper = (...args: any[]) => {
        this.off(event, onceWrapper);
        handler(...args);
      };
      (onceWrapper as any).listener = handler;
      return this.on(event, onceWrapper);
    }

    off(event: string, handler: any): this {
      const list = this._listeners.get(event);
      if (list) {
        const idx = list.findIndex((h) => h === handler || h.listener === handler);
        if (idx !== -1) list.splice(idx, 1);
      }
      return this;
    }

    removeListener(event: string, handler: any): this {
      return this.off(event, handler);
    }

    removeAllListeners(event?: string): this {
      if (event) {
        this._listeners.delete(event);
      } else {
        this._listeners.clear();
      }
      return this;
    }

    emit(event: string, ...args: any[]): boolean {
      this._emit(event, ...args);
      return true;
    }

    private _emit(event: string, ...args: any[]): void {
      const handlers = (this._listeners.get(event) || []).slice();
      for (const h of handlers) {
        try {
          h(...args);
        } catch (err) {
          console.error(`[WebSocket error in ${event}]:`, err);
        }
      }
    }
  }

  (NativeWebSocketAdapter as any).prototype.CONNECTING = (NativeWebSocketAdapter as any).CONNECTING = 0;
  (NativeWebSocketAdapter as any).prototype.OPEN = (NativeWebSocketAdapter as any).OPEN = 1;
  (NativeWebSocketAdapter as any).prototype.CLOSING = (NativeWebSocketAdapter as any).CLOSING = 2;
  (NativeWebSocketAdapter as any).prototype.CLOSED = (NativeWebSocketAdapter as any).CLOSED = 3;

  return NativeWebSocketAdapter;
}
