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

/**
 * In-memory circular history ring buffer for terminal PTY output.
 * Maintained on each Agent node as the Single Source of Truth (SSoT) for scrollback history.
 * - Caps memory usage strictly at maxBytes (default 1MB).
 * - Isolates Alternate Screen (\x1b[?1049h ... \x1b[?1049l) TUI redraw floods so normal scrollback
 *   is never evicted by TUI animations and \x1b[?1049h state is always preserved across reconnects.
 * - Truncates obsolete history when user/shell issues clear screen / RIS reset commands.
 * - Survives Hub restarts and re-syncs history on reconnection.
 */
export class TerminalHistoryBuffer {
  private chunks: Buffer[] = [];
  private totalBytes: number = 0;
  private altChunks: Buffer[] = [];
  private altBytes: number = 0;
  private inAltScreen: boolean = false;
  private readonly maxBytes: number;
  private readonly maxAltBytes: number;
  private readonly clearOnEd3: boolean;

  constructor(maxBytes: number = 1 * 1024 * 1024, clearOnEd3: boolean = true) {
    this.maxBytes = Math.max(1, maxBytes);
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
      this.totalBytes = 0;
      const sliced = buf.subarray(lastEd3Idx);
      this.chunks.push(sliced);
      this.totalBytes = sliced.length;
    } else {
      this.chunks.push(buf);
      this.totalBytes += buf.length;
    }

    // Enforce maxBytes limit by evicting oldest chunks from the front
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (head.length <= excess) {
        this.totalBytes -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(excess);
        this.totalBytes -= excess;
        break;
      }
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
    this.totalBytes = 0;
    this.altChunks = [];
    this.altBytes = 0;
    this.inAltScreen = false;
  }
}
