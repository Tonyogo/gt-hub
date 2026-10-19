export class TerminalWriteScheduler {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: any = null;
  private readonly maxBatchBytes: number;
  private readonly intervalMs: number;
  private flushCallback: (batch: string) => void;

  constructor(
    flushCallback: (batch: string) => void,
    intervalMs: number = 16,
    maxBatchBytes: number = 64 * 1024
  ) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
    this.maxBatchBytes = maxBatchBytes;
  }

  public push(chunk: string): void {
    if (!chunk || chunk.length === 0) return;
    this.buffer.push(chunk);
    this.bufferedLength += chunk.length;

    if (this.bufferedLength >= this.maxBatchBytes) {
      this.flush();
      return;
    }

    if (!this.timer) {
      const getTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      this.timer = getTimer(() => this.flush(), this.intervalMs);
    }
  }

  public flush(): void {
    if (this.timer) {
      const clear = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
      clear(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const combined = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
    this.buffer = [];
    this.bufferedLength = 0;
    try {
      this.flushCallback(combined);
    } catch {}
  }

  public destroy(): void {
    this.flush();
  }
}

export class BackgroundBufferQueue {
  private chunks: string[] = [];
  private totalBytes: number = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 2 * 1024 * 1024) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  public push(data: string | Uint8Array | ArrayBuffer): void {
    let str = '';
    if (typeof data === 'string') {
      str = data;
    } else if (data instanceof ArrayBuffer) {
      str = new TextDecoder().decode(data);
    } else if (data instanceof Uint8Array) {
      str = new TextDecoder().decode(data);
    }
    if (!str) return;

    this.chunks.push(str);
    this.totalBytes += str.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (head.length <= excess) {
        this.totalBytes -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.slice(excess);
        this.totalBytes -= excess;
        break;
      }
    }
  }

  public drain(): string {
    if (this.chunks.length === 0) return '';
    const combined = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    this.chunks = [];
    this.totalBytes = 0;
    return combined;
  }

  public size(): number {
    return this.totalBytes;
  }

  public clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
