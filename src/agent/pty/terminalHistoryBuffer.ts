import { stripTerminalQuerySequences } from '../../shared/utils/terminalSanitizer';

/**
 * Byte patterns for terminal reset / scrollback clear / alternate screen:
 * - \x1bc (RIS - Reset to Initial State): 0x1b, 0x63
 * - \x1b[3J (ED 3 - Clear scrollback buffer): 0x1b, 0x5b, 0x33, 0x4a
 * - \x1b[?1049h (DECSET 1049 - Enter Alternate Screen Buffer)
 * - \x1b[?1049l (DECRST 1049 - Exit Alternate Screen Buffer)
 */
const RIS_RESET_BUFFER = Buffer.from('\x1bc', 'binary');
const ED3_CLEAR_BUFFER = Buffer.from('\x1b[3J', 'binary');
const ALT_SCREEN_ENTER_BUFFER = Buffer.from('\x1b[?1049h', 'binary');
const ALT_SCREEN_EXIT_BUFFER = Buffer.from('\x1b[?1049l', 'binary');

export const DEFAULT_MAX_HISTORY_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_HISTORY_LINES = 1000;

function countBufferNewlines(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  return count;
}

function findNthBufferNewlineIndex(buf: Buffer, n: number): number {
  let seen = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      seen++;
      if (seen === n) return i;
    }
  }
  return -1;
}

/**
 * In-memory circular history ring buffer for terminal PTY output.
 * Maintained on each Agent node as the Single Source of Truth (SSoT) for scrollback history.
 * - Caps memory usage strictly at maxBytes (default 1MB) and line count at maxLines (default 1000 lines).
 * - Isolates Alternate Screen (\x1b[?1049h ... \x1b[?1049l) TUI redraw floods so normal scrollback
 *   is never evicted by TUI animations and \x1b[?1049h state is always preserved across reconnects.
 * - Truncates obsolete history when user/shell issues clear screen / RIS reset commands.
 * - Survives Hub restarts and re-syncs history on reconnection.
 */
export class TerminalHistoryBuffer {
  private chunks: Buffer[] = [];
  private chunkLineCounts: number[] = [];
  private totalBytes: number = 0;
  private totalLines: number = 0;
  private altChunks: Buffer[] = [];
  private altBytes: number = 0;
  private inAltScreen: boolean = false;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly maxAltBytes: number;
  private readonly clearOnEd3: boolean;

  constructor(
    maxBytes: number = DEFAULT_MAX_HISTORY_BYTES,
    clearOnEd3: boolean = true,
    maxLines: number = DEFAULT_MAX_HISTORY_LINES
  ) {
    this.maxBytes = Math.max(1, maxBytes);
    this.maxLines = Math.max(1, maxLines);
    this.maxAltBytes = Math.min(this.maxBytes, 64 * 1024);
    this.clearOnEd3 = clearOnEd3;
  }

  /**
   * Push newly received PTY output into the buffer.
   */
  public push(data: Buffer | string): void {
    if (!data || data.length === 0) return;
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    if (buf.length === 0) return;

    // Check for hardware RIS reset to purge all stale screen history
    const lastRisIdx = buf.lastIndexOf(RIS_RESET_BUFFER);
    if (lastRisIdx !== -1) {
      this.clear();
      buf = buf.subarray(lastRisIdx);
    }

    while (buf.length > 0) {
      if (!this.inAltScreen) {
        const enterIdx = buf.indexOf(ALT_SCREEN_ENTER_BUFFER);
        if (enterIdx === -1) {
          this.pushNormal(buf);
          break;
        }
        if (enterIdx > 0) {
          this.pushNormal(buf.subarray(0, enterIdx));
        }
        this.inAltScreen = true;
        this.altChunks = [];
        this.altBytes = 0;
        buf = buf.subarray(enterIdx + ALT_SCREEN_ENTER_BUFFER.length);
      } else {
        const exitIdx = buf.indexOf(ALT_SCREEN_EXIT_BUFFER);
        if (exitIdx === -1) {
          this.pushAlt(buf);
          break;
        }
        // Exiting alternate screen: discard transient alternate screen redraw frames
        this.inAltScreen = false;
        this.altChunks = [];
        this.altBytes = 0;
        buf = buf.subarray(exitIdx + ALT_SCREEN_EXIT_BUFFER.length);
      }
    }
  }

  private pushNormal(buf: Buffer): void {
    if (buf.length === 0) return;
    const lastEd3Idx = this.clearOnEd3 ? buf.lastIndexOf(ED3_CLEAR_BUFFER) : -1;
    if (lastEd3Idx !== -1) {
      this.chunks = [];
      this.chunkLineCounts = [];
      this.totalBytes = 0;
      this.totalLines = 0;
      const sliced = buf.subarray(lastEd3Idx);
      const lines = countBufferNewlines(sliced);
      this.chunks.push(sliced);
      this.chunkLineCounts.push(lines);
      this.totalBytes = sliced.length;
      this.totalLines = lines;
    } else {
      const lines = countBufferNewlines(buf);
      this.chunks.push(buf);
      this.chunkLineCounts.push(lines);
      this.totalBytes += buf.length;
      this.totalLines += lines;
    }

    // 1. Enforce maxBytes limit by evicting oldest chunks from the front
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (head.length <= excess) {
        this.totalBytes -= head.length;
        this.totalLines -= this.chunkLineCounts.shift()!;
        this.chunks.shift();
      } else {
        const slicedHead = head.subarray(excess);
        const newHeadLines = countBufferNewlines(slicedHead);
        this.totalLines -= (this.chunkLineCounts[0] - newHeadLines);
        this.chunkLineCounts[0] = newHeadLines;
        this.chunks[0] = slicedHead;
        this.totalBytes -= excess;
        break;
      }
    }

    // 2. Enforce maxLines limit by evicting oldest lines from the front
    while (this.totalLines > this.maxLines && this.chunks.length > 0) {
      const head = this.chunks[0];
      const headLines = this.chunkLineCounts[0];
      const excessLines = this.totalLines - this.maxLines;

      if (headLines === 0) {
        // Prefix fragment belonging to the oldest line being evicted
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

      // headLines >= excessLines: locate the excessLines-th newline inside head
      const cutIdx = findNthBufferNewlineIndex(head, excessLines);
      if (cutIdx === -1 || cutIdx === head.length - 1) {
        this.totalBytes -= head.length;
        this.totalLines -= headLines;
        this.chunkLineCounts.shift();
        this.chunks.shift();
      } else {
        const remaining = head.subarray(cutIdx + 1);
        this.totalBytes -= (cutIdx + 1);
        this.totalLines -= excessLines;
        this.chunkLineCounts[0] = headLines - excessLines;
        this.chunks[0] = remaining;
      }
      break;
    }
  }

  private pushAlt(buf: Buffer): void {
    if (buf.length === 0) return;
    this.altChunks.push(buf);
    this.altBytes += buf.length;

    const effectiveMaxAlt = Math.max(1, this.maxAltBytes - ALT_SCREEN_ENTER_BUFFER.length);
    while (this.altBytes > effectiveMaxAlt && this.altChunks.length > 0) {
      const head = this.altChunks[0];
      const excess = this.altBytes - effectiveMaxAlt;
      if (head.length <= excess) {
        this.altBytes -= head.length;
        this.altChunks.shift();
      } else {
        this.altChunks[0] = head.subarray(excess);
        this.altBytes -= excess;
        break;
      }
    }
  }

  /**
   * Get concatenated history as a single Buffer.
   */
  public getBuffer(): Buffer {
    if (!this.inAltScreen) {
      if (this.chunks.length === 0) {
        return Buffer.alloc(0);
      }
      if (this.chunks.length === 1) {
        return this.chunks[0];
      }
      return Buffer.concat(this.chunks, this.totalBytes);
    }
    const allChunks = [...this.chunks, ALT_SCREEN_ENTER_BUFFER, ...this.altChunks];
    const totalLen = this.totalBytes + ALT_SCREEN_ENTER_BUFFER.length + this.altBytes;
    return Buffer.concat(allChunks, totalLen);
  }

  /**
   * Get concatenated history as a UTF-8 string.
   */
  public getString(): string {
    return this.getBuffer().toString('utf-8');
  }

  /**
   * Get sanitized history string with terminal query sequences stripped to prevent echo loops.
   */
  public getSanitizedString(): string {
    return stripTerminalQuerySequences(this.getString());
  }

  /**
   * Current byte size of the buffer.
   */
  public getSize(): number {
    return this.totalBytes + (this.inAltScreen ? ALT_SCREEN_ENTER_BUFFER.length + this.altBytes : 0);
  }

  /**
   * Clear the entire buffer (e.g. on shell process exit).
   */
  public clear(): void {
    this.chunks = [];
    this.chunkLineCounts = [];
    this.totalBytes = 0;
    this.totalLines = 0;
    this.altChunks = [];
    this.altBytes = 0;
    this.inAltScreen = false;
  }
}
