export class TerminalWriteScheduler {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: any = null;
  private inFlight: boolean = false;
  private readonly maxBatchBytes: number;
  private readonly intervalMs: number;
  private readonly immediateMaxBytes: number;
  private readonly maxQueueBytes: number;
  private flushCallback: (batch: string, done: () => void) => void;

  constructor(
    flushCallback: (batch: string, done: () => void) => void,
    intervalMs: number = 16,
    maxBatchBytes: number = 64 * 1024,
    immediateMaxBytes: number = 0,
    maxQueueBytes: number = 4 * 1024 * 1024
  ) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
    this.maxBatchBytes = maxBatchBytes;
    this.immediateMaxBytes = immediateMaxBytes;
    this.maxQueueBytes = Math.max(maxBatchBytes, maxQueueBytes);
  }

  public push(chunk: string): void {
    if (!chunk || chunk.length === 0) return;

    // Fast-path: when idle (no timer and no in-flight xterm write) and immediateMaxBytes > 0,
    // dispatch small interactive echo immediately with 0ms delay, and set a cooldown timer.
    if (
      this.immediateMaxBytes > 0 &&
      !this.inFlight &&
      !this.timer &&
      this.buffer.length === 0 &&
      chunk.length <= this.immediateMaxBytes
    ) {
      this.dispatchBatch(chunk);
      const getTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
      this.timer = getTimer(() => {
        this.timer = null;
        if (this.buffer.length > 0) {
          this.flushNextSlice();
        }
      }, this.intervalMs);
      return;
    }

    this.buffer.push(chunk);
    this.bufferedLength += chunk.length;

    // Cap maximum queued memory during extreme output floods (e.g. `yes` or `cat /dev/zero`)
    while (this.bufferedLength > this.maxQueueBytes && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferedLength -= dropped.length;
    }

    // If a write is currently in flight in xterm.js, wait for its completion callback
    // to apply natural backpressure and keep the browser main thread responsive.
    if (this.inFlight) {
      return;
    }

    if (this.bufferedLength >= this.maxBatchBytes) {
      this.flushNextSlice();
      return;
    }

    this.scheduleTimer();
  }

  private scheduleTimer(): void {
    if (this.timer || this.inFlight || this.buffer.length === 0) return;
    const getTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    this.timer = getTimer(() => {
      this.timer = null;
      this.flushNextSlice();
    }, this.intervalMs);
  }

  private clearScheduledTimer(): void {
    if (this.timer) {
      const clear = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
      clear(this.timer);
      this.timer = null;
    }
  }

  private dequeueSlice(maxChars: number): string {
    if (this.buffer.length === 0) return '';
    if (this.bufferedLength <= maxChars) {
      const all = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
      this.buffer = [];
      this.bufferedLength = 0;
      return all;
    }

    const parts: string[] = [];
    let collected = 0;
    while (this.buffer.length > 0 && collected < maxChars) {
      const head = this.buffer[0];
      const remaining = maxChars - collected;
      if (head.length <= remaining) {
        parts.push(this.buffer.shift()!);
        this.bufferedLength -= head.length;
        collected += head.length;
      } else {
        parts.push(head.slice(0, remaining));
        this.buffer[0] = head.slice(remaining);
        this.bufferedLength -= remaining;
        collected += remaining;
        break;
      }
    }
    return parts.length === 1 ? parts[0] : parts.join('');
  }

  private dispatchBatch(batch: string): void {
    if (!batch) return;
    const expectsAsyncDone = this.flushCallback.length >= 2;
    if (!expectsAsyncDone) {
      try {
        this.flushCallback(batch, () => {});
      } catch {}
      if (this.buffer.length > 0 && !this.timer) {
        this.scheduleTimer();
      }
      return;
    }

    this.inFlight = true;
    let doneCalled = false;
    const onDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      this.inFlight = false;
      if (this.buffer.length > 0) {
        this.scheduleTimer();
      }
    };

    try {
      this.flushCallback(batch, onDone);
    } catch {
      onDone();
    }
  }

  private flushNextSlice(): void {
    this.clearScheduledTimer();
    if (this.inFlight || this.buffer.length === 0) return;

    const expectsAsyncDone = this.flushCallback.length >= 2;
    const batch = expectsAsyncDone
      ? this.dequeueSlice(this.maxBatchBytes)
      : this.dequeueSlice(this.bufferedLength);
    this.dispatchBatch(batch);
  }

  public flush(): void {
    this.clearScheduledTimer();
    this.inFlight = false;
    if (this.buffer.length === 0) return;

    const combined = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
    this.buffer = [];
    this.bufferedLength = 0;
    try {
      this.flushCallback(combined, () => {});
    } catch {}
  }

  public clear(): void {
    this.clearScheduledTimer();
    this.inFlight = false;
    this.buffer = [];
    this.bufferedLength = 0;
  }

  public isBusy(): boolean {
    return this.inFlight;
  }

  public pendingBytes(): number {
    return this.bufferedLength;
  }

  public destroy(): void {
    this.flush();
  }
}

function countStringNewlines(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++;
  }
  return count;
}

function findNthStringNewlineIndex(str: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) {
      seen++;
      if (seen === n) return i;
    }
  }
  return -1;
}

export class BackgroundBufferQueue {
  private chunks: string[] = [];
  private chunkLineCounts: number[] = [];
  private totalBytes: number = 0;
  private totalLines: number = 0;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private decoder: TextDecoder = new TextDecoder('utf-8');

  constructor(maxBytes: number = 2 * 1024 * 1024, maxLines: number = 2000) {
    this.maxBytes = Math.max(1, maxBytes);
    this.maxLines = Math.max(1, maxLines);
  }

  public push(data: string | Uint8Array | ArrayBuffer): void {
    let str = '';
    if (typeof data === 'string') {
      str = data;
    } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      str = this.decoder.decode(data, { stream: true });
    }
    if (!str) return;

    const lines = countStringNewlines(str);
    this.chunks.push(str);
    this.chunkLineCounts.push(lines);
    this.totalBytes += str.length;
    this.totalLines += lines;

    // 1. Enforce maxBytes cap
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (head.length <= excess) {
        this.totalBytes -= head.length;
        this.totalLines -= this.chunkLineCounts.shift()!;
        this.chunks.shift();
      } else {
        const slicedHead = head.slice(excess);
        const newHeadLines = countStringNewlines(slicedHead);
        this.totalLines -= (this.chunkLineCounts[0] - newHeadLines);
        this.chunkLineCounts[0] = newHeadLines;
        this.chunks[0] = slicedHead;
        this.totalBytes -= excess;
        break;
      }
    }

    // 2. Enforce maxLines cap
    while (this.totalLines > this.maxLines && this.chunks.length > 0) {
      const head = this.chunks[0];
      const headLines = this.chunkLineCounts[0];
      const excessLines = this.totalLines - this.maxLines;

      if (headLines === 0) {
        this.totalBytes -= head.length;
        this.chunkLineCounts.shift();
        this.chunks.shift();
        continue;
      }

      if (headLines < excessLines) {
        this.totalBytes -= head.length;
        this.totalLines -= headLines;
        this.chunkLineCounts.shift();
        this.chunks.shift();
        continue;
      }

      const cutIdx = findNthStringNewlineIndex(head, excessLines);
      if (cutIdx === -1 || cutIdx === head.length - 1) {
        this.totalBytes -= head.length;
        this.totalLines -= headLines;
        this.chunkLineCounts.shift();
        this.chunks.shift();
      } else {
        const remaining = head.slice(cutIdx + 1);
        this.totalBytes -= (cutIdx + 1);
        this.totalLines -= excessLines;
        this.chunkLineCounts[0] = headLines - excessLines;
        this.chunks[0] = remaining;
      }
      break;
    }
  }

  public drain(): string {
    const tail = this.decoder.decode();
    if (tail) {
      this.push(tail);
    }
    if (this.chunks.length === 0) return '';
    const combined = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    this.chunks = [];
    this.chunkLineCounts = [];
    this.totalBytes = 0;
    this.totalLines = 0;
    return combined;
  }

  public size(): number {
    return this.totalBytes;
  }

  public clear(): void {
    this.decoder.decode();
    this.chunks = [];
    this.chunkLineCounts = [];
    this.totalBytes = 0;
    this.totalLines = 0;
  }
}
