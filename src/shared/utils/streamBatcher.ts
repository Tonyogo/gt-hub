export class StreamBatcher {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: NodeJS.Timeout | null = null;
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
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const combined = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
    this.buffer = [];
    this.bufferedLength = 0;
    try {
      this.flushCallback(combined);
    } catch {
      // Ignore callback errors during flush
    }
  }

  public size(): number {
    return this.bufferedLength;
  }

  public destroy(): void {
    this.flush();
  }
}
