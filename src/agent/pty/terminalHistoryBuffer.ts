import { stripTerminalQuerySequences } from '../../shared/utils/terminalSanitizer';

/**
 * Byte patterns for terminal reset / scrollback clear:
 * - \x1bc (RIS - Reset to Initial State): 0x1b, 0x63
 * - \x1b[3J (ED 3 - Clear scrollback buffer): 0x1b, 0x5b, 0x33, 0x4a
 */
const RIS_RESET_BUFFER = Buffer.from('\x1bc', 'binary');
const ED3_CLEAR_BUFFER = Buffer.from('\x1b[3J', 'binary');

/**
 * In-memory circular history ring buffer for terminal PTY output.
 * Maintained on each Agent node as the Single Source of Truth (SSoT) for scrollback history.
 * - Caps memory usage strictly at maxBytes (default 1MB).
 * - Truncates obsolete history when user/shell issues clear screen / RIS reset commands.
 * - Survives Hub restarts and re-syncs history on reconnection.
 */
export class TerminalHistoryBuffer {
  private chunks: Buffer[] = [];
  private totalBytes: number = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 1 * 1024 * 1024) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  /**
   * Push newly received PTY output into the buffer.
   */
  public push(data: Buffer | string): void {
    if (!data || data.length === 0) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    if (buf.length === 0) return;

    // Check for hardware/screen clear resets to purge stale screen history
    const lastRisIdx = buf.lastIndexOf(RIS_RESET_BUFFER);
    const lastEd3Idx = buf.lastIndexOf(ED3_CLEAR_BUFFER);
    const resetIdx = Math.max(lastRisIdx, lastEd3Idx);

    if (resetIdx !== -1) {
      // Discard all historical chunks prior to this reset sequence
      this.chunks = [];
      this.totalBytes = 0;
      const sliced = buf.subarray(resetIdx);
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

  /**
   * Get concatenated history as a single Buffer.
   */
  public getBuffer(): Buffer {
    if (this.chunks.length === 0) {
      return Buffer.alloc(0);
    }
    if (this.chunks.length === 1) {
      return this.chunks[0];
    }
    return Buffer.concat(this.chunks, this.totalBytes);
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
    return this.totalBytes;
  }

  /**
   * Clear the entire buffer (e.g. on shell process exit).
   */
  public clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
