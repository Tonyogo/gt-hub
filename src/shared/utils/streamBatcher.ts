const TUI_ERASE_OR_NAV_RE = /\x1b\[(?:\d*[JKAFGH]|\d+;\d+[Hf])/;
const INCOMPLETE_TUI_TAIL_RE = /(?:\x1b\[(?:\?25l|\?2026h|\d*[JKAFGH]|\d+;\d+[Hf])|\r)*\x1b\[(?:\?25l|\?2026h|\d*[JKAFGH]|\d+;\d+[Hf])\r*$/;

export function hasTrailingIncompleteAnsi(text: string): boolean {
  if (!text) return false;
  const searchStart = Math.max(0, text.length - 64);
  const lastEsc = text.lastIndexOf('\x1b');
  if (lastEsc === -1 || lastEsc < searchStart) return false;

  const remainder = text.slice(lastEsc);
  if (remainder === '\x1b') return true;

  if (remainder[1] === '[') {
    return /^\[[0-9;:?<>! "'*]*$/.test(remainder.slice(1));
  }

  if (remainder[1] === ']') {
    return !remainder.includes('\x07') && !remainder.includes('\x1b\\');
  }

  return false;
}

export function isTuiEraseOrSyncChunk(chunk: string): boolean {
  if (!chunk || !chunk.includes('\x1b')) return false;
  if (
    chunk.includes('\x1b[?2026h') ||
    chunk.includes('\x1b[?2026l') ||
    chunk.includes('\x1b[?25l') ||
    chunk.includes('\x1b[?25h')
  ) {
    return true;
  }
  if (TUI_ERASE_OR_NAV_RE.test(chunk)) {
    return true;
  }
  return hasTrailingIncompleteAnsi(chunk);
}

export function hasIncompleteTuiFrame(text: string): boolean {
  if (!text) return false;
  const decSyncStart = text.lastIndexOf('\x1b[?2026h');
  const decSyncEnd = text.lastIndexOf('\x1b[?2026l');
  if (decSyncStart > decSyncEnd) {
    return true;
  }
  if (hasTrailingIncompleteAnsi(text)) {
    return true;
  }
  // If a DEC 2026 sync frame just closed and no new erase sequence started after it,
  // the frame is complete and ready for immediate rendering.
  if (decSyncEnd >= 0 && decSyncEnd >= decSyncStart) {
    const afterSync = text.slice(decSyncEnd + 8);
    if (!/\x1b\[\d*[JK]/.test(afterSync)) {
      return false;
    }
  }
  if (text.includes('\x1b[') && INCOMPLETE_TUI_TAIL_RE.test(text)) {
    return true;
  }
  return false;
}

export function findSafeAnsiSplitIndex(text: string, maxChars: number): number {
  if (!text || text.length <= maxChars) {
    return text ? text.length : 0;
  }
  const candidate = text.slice(0, maxChars);
  if (hasTrailingIncompleteAnsi(candidate)) {
    const lastEsc = candidate.lastIndexOf('\x1b');
    if (lastEsc > 0) {
      return lastEsc;
    }
  }
  return maxChars;
}

export class StreamBatcher {
  private buffer: string[] = [];
  private bufferedLength: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private holdCount: number = 0;
  private inDecSyncMode: boolean = false;
  private readonly maxHoldCount: number;
  private readonly maxBatchBytes: number;
  private readonly intervalMs: number;
  private readonly immediateMaxBytes: number;
  private flushCallback: (batch: string) => void;

  constructor(
    flushCallback: (batch: string) => void,
    intervalMs: number = 16,
    maxBatchBytes: number = 64 * 1024,
    immediateMaxBytes: number = 0
  ) {
    this.flushCallback = flushCallback;
    this.intervalMs = intervalMs;
    this.maxBatchBytes = maxBatchBytes;
    this.immediateMaxBytes = immediateMaxBytes;
    this.maxHoldCount = Math.max(1, Math.ceil(24 / Math.max(1, intervalMs)));
  }

  public isSyncActive(): boolean {
    return this.inDecSyncMode;
  }

  private updateDecSyncState(chunk: string, prevTail: string = ''): void {
    const text = prevTail ? prevTail + chunk : chunk;
    if (!text || !text.includes('\x1b[?2026')) return;
    const lastH = text.lastIndexOf('\x1b[?2026h');
    const lastL = text.lastIndexOf('\x1b[?2026l');
    if (lastH !== -1 || lastL !== -1) {
      if (lastH > lastL) {
        this.inDecSyncMode = true;
      } else if (lastL > lastH) {
        this.inDecSyncMode = false;
      }
    }
  }

  public push(chunk: string): void {
    if (!chunk || chunk.length === 0) return;

    const wasInDecSync = this.inDecSyncMode;
    const prevTail = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].slice(-8) : '';
    this.updateDecSyncState(chunk, prevTail);

    // Fast-path: when idle (no active cooldown timer) and immediateMaxBytes is enabled,
    // flush small interactive packets (like keystroke echo) immediately with 0ms latency
    // and start the cooldown timer so subsequent burst chunks within intervalMs are coalesced.
    // Skip fast-path for TUI erase and sync chunks so they coalesce with subsequent redraw content.
    if (
      this.immediateMaxBytes > 0 &&
      !this.timer &&
      this.buffer.length === 0 &&
      chunk.length <= this.immediateMaxBytes &&
      !wasInDecSync &&
      !this.inDecSyncMode &&
      !isTuiEraseOrSyncChunk(chunk)
    ) {
      try {
        this.flushCallback(chunk);
      } catch {
        // Ignore callback errors
      }
      this.timer = setTimeout(() => {
        this.onTimerTick();
      }, this.intervalMs);
      return;
    }

    this.buffer.push(chunk);
    this.bufferedLength += chunk.length;

    // If synchronized update just closed (\x1b[?2026l), flush immediately
    if (wasInDecSync && !this.inDecSyncMode) {
      this.flush();
      return;
    }

    if (!this.inDecSyncMode && this.bufferedLength >= this.maxBatchBytes) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.onTimerTick(), this.intervalMs);
    }
  }

  private onTimerTick(): void {
    this.timer = null;
    if (this.buffer.length === 0) {
      this.holdCount = 0;
      return;
    }

    if (this.bufferedLength < this.maxBatchBytes && this.holdCount < this.maxHoldCount) {
      const preview = this.buffer.length === 1 ? this.buffer[0] : this.buffer.join('');
      const isIncomplete = this.inDecSyncMode || hasIncompleteTuiFrame(preview);

      if (isIncomplete) {
        this.holdCount++;
        this.timer = setTimeout(() => this.onTimerTick(), this.intervalMs);
        return;
      }
    }

    if (this.holdCount >= this.maxHoldCount) {
      this.inDecSyncMode = false;
    }
    this.holdCount = 0;
    this.flush();
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.holdCount = 0;
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
