import { stripTerminalQuerySequences } from '../../shared/utils/terminalSanitizer';

/**
 * Byte patterns for terminal reset / scrollback clear / alternate screen:
 * - \x1bc (RIS - Reset to Initial State): 0x1b, 0x63
 * - \x1b[3J (ED 3 - Clear scrollback buffer): 0x1b, 0x5b, 0x33, 0x4a
 * - \x1b[?1049h / \x1b[?1047h / \x1b[?47h (Enter Alternate Screen Buffer)
 * - \x1b[?1049l / \x1b[?1047l / \x1b[?47l (Exit Alternate Screen Buffer)
 */
const RIS_RESET_BUFFER = Buffer.from('\x1bc', 'binary');
const ED3_CLEAR_BUFFER = Buffer.from('\x1b[3J', 'binary');
const TUI_HOME_CLEAR_BUFFER = Buffer.from('\x1b[H\x1b[2K', 'binary');
const TUI_LINE_CLEAR_BUFFER = Buffer.from('\x1b[2K\x1b[1B', 'binary');
const ALT_SCREEN_MODES = new Set(['1049', '1047', '47']);
const ORDERED_ALT_MOUSE_MODES = ['9', '1000', '1002', '1003', '1004', '1006', '1007', '1016'];
const TRACKED_ALT_MOUSE_MODES = new Set(ORDERED_ALT_MOUSE_MODES);

export const DEFAULT_MAX_HISTORY_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_HISTORY_LINES = 2000;

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
 * - Caps memory usage strictly at maxBytes (default 1MB) and line count at maxLines (default 2000 lines).
 * - Isolates Alternate Screen (\x1b[?1049h ... \x1b[?1049l) TUI redraw floods so normal scrollback
 *   is never evicted by TUI animations and alternate screen / mouse tracking state is preserved across reconnects.
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
  private altScreenMode: '1049' | '1047' | '47' = '1049';
  private altMouseModes: Set<string> = new Set();
  private inAltScreen: boolean = false;
  private pendingEsc: Buffer = Buffer.alloc(0);
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

    if (this.pendingEsc.length > 0) {
      buf = Buffer.concat([this.pendingEsc, buf], this.pendingEsc.length + buf.length);
      this.pendingEsc = Buffer.alloc(0);
    }

    if (!buf.includes(0x1b)) {
      if (this.inAltScreen) {
        this.pushAlt(buf);
      } else {
        this.pushNormal(buf);
      }
      return;
    }

    // Check for hardware RIS reset to purge all stale screen history
    const lastRisIdx = buf.lastIndexOf(RIS_RESET_BUFFER);
    if (lastRisIdx !== -1) {
      this.clear();
      buf = buf.subarray(lastRisIdx);
    }

    // Hold trailing incomplete ESC / CSI sequence (<= 32 bytes) so split DECSET/DECRST never escapes parsing
    if (this.maxBytes >= 64) {
      const searchStart = Math.max(0, buf.length - 32);
      const lastEsc = buf.lastIndexOf(0x1b);
      if (lastEsc !== -1 && lastEsc >= searchStart) {
        const tailStr = buf.subarray(lastEsc).toString('binary');
        if (tailStr === '\x1b' || /^\x1b\[[0-9;:?<>! "'*]*$/.test(tailStr)) {
          this.pendingEsc = Buffer.from(buf.subarray(lastEsc));
          buf = buf.subarray(0, lastEsc);
        }
      }
    }

    if (buf.length === 0) {
      return;
    }

    const text = buf.toString('binary');
    const modeRegex = /\x1b\[\?([0-9;]+)([hl])/g;
    let cursor = 0;
    let match: RegExpExecArray | null = null;

    while ((match = modeRegex.exec(text)) !== null) {
      const seqStart = match.index;
      const seqEnd = seqStart + match[0].length;
      const params = match[1].split(';');
      const action = match[2];

      let altParam: '1049' | '1047' | '47' | null = null;
      for (const p of params) {
        if (ALT_SCREEN_MODES.has(p)) {
          altParam = p as '1049' | '1047' | '47';
        } else if (TRACKED_ALT_MOUSE_MODES.has(p)) {
          if (action === 'h') {
            this.altMouseModes.add(p);
          } else {
            this.altMouseModes.delete(p);
          }
        }
      }

      if (altParam !== null) {
        if (action === 'h') {
          if (!this.inAltScreen) {
            if (seqStart > cursor) {
              this.pushNormal(buf.subarray(cursor, seqStart));
            }
            this.inAltScreen = true;
            this.altScreenMode = altParam;
            this.altChunks = [];
            this.altBytes = 0;
            cursor = seqEnd;
          } else {
            if (seqEnd > cursor) {
              this.pushAlt(buf.subarray(cursor, seqEnd));
            }
            cursor = seqEnd;
          }
        } else {
          if (this.inAltScreen) {
            this.inAltScreen = false;
            this.altChunks = [];
            this.altBytes = 0;
            cursor = seqEnd;
          } else {
            if (seqEnd > cursor) {
              this.pushNormal(buf.subarray(cursor, seqEnd));
            }
            cursor = seqEnd;
          }
        }
      }
    }

    if (cursor < buf.length) {
      const rem = buf.subarray(cursor);
      if (this.inAltScreen) {
        this.pushAlt(rem);
      } else {
        this.pushNormal(rem);
      }
    }
  }

  private pushNormal(buf: Buffer): void {
    if (buf.length === 0) return;
    const isTuiRedraw = buf.includes(TUI_HOME_CLEAR_BUFFER) || buf.includes(TUI_LINE_CLEAR_BUFFER);
    const lastEd3Idx = this.clearOnEd3 ? buf.lastIndexOf(ED3_CLEAR_BUFFER) : -1;
    if (lastEd3Idx !== -1) {
      this.chunks = [];
      this.chunkLineCounts = [];
      this.totalBytes = 0;
      this.totalLines = 0;
      const sliced = buf.subarray(lastEd3Idx);
      const lines = isTuiRedraw ? 0 : countBufferNewlines(sliced);
      this.chunks.push(sliced);
      this.chunkLineCounts.push(lines);
      this.totalBytes = sliced.length;
      this.totalLines = lines;
    } else {
      const lines = isTuiRedraw ? 0 : countBufferNewlines(buf);
      this.chunks.push(buf);
      this.chunkLineCounts.push(lines);
      this.totalBytes += buf.length;
      this.totalLines += lines;
    }

    // 1. Enforce maxBytes limit by evicting oldest chunks from the front
    const effectiveMaxNormalBytes = Math.max(1, this.maxBytes - this.pendingEsc.length);
    while (this.totalBytes > effectiveMaxNormalBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.totalBytes - effectiveMaxNormalBytes;
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

  private getAltHeaderBuffer(): Buffer {
    let headerStr = `\x1b[?${this.altScreenMode}h`;
    for (const mode of ORDERED_ALT_MOUSE_MODES) {
      if (this.altMouseModes.has(mode)) {
        headerStr += `\x1b[?${mode}h`;
      }
    }
    return Buffer.from(headerStr, 'binary');
  }

  private pushAlt(buf: Buffer): void {
    if (buf.length === 0) return;
    this.altChunks.push(buf);
    this.altBytes += buf.length;

    const headerLen = this.getAltHeaderBuffer().length;
    const effectiveMaxAlt = Math.max(1, this.maxAltBytes - headerLen - this.pendingEsc.length);
    while (this.altBytes > effectiveMaxAlt && this.altChunks.length > 0) {
      const head = this.altChunks[0];
      const excess = this.altBytes - effectiveMaxAlt;
      if (head.length <= excess) {
        this.altBytes -= head.length;
        this.altChunks.shift();
      } else {
        let cut = excess;
        let skipped = 0;
        while (cut < head.length && skipped < 3 && (head[cut] & 0xc0) === 0x80) {
          cut++;
          skipped++;
        }
        if (cut >= head.length) {
          this.altBytes -= head.length;
          this.altChunks.shift();
        } else {
          this.altChunks[0] = head.subarray(cut);
          this.altBytes -= cut;
        }
        break;
      }
    }
  }

  /**
   * Get concatenated history as a single Buffer.
   */
  public getBuffer(): Buffer {
    if (!this.inAltScreen) {
      if (this.chunks.length === 0 && this.pendingEsc.length === 0) {
        return Buffer.alloc(0);
      }
      if (this.chunks.length === 1 && this.pendingEsc.length === 0) {
        return this.chunks[0];
      }
      const parts = this.pendingEsc.length > 0 ? [...this.chunks, this.pendingEsc] : this.chunks;
      return Buffer.concat(parts, this.totalBytes + this.pendingEsc.length);
    }
    const altHeader = this.getAltHeaderBuffer();
    const allChunks = [
      ...this.chunks,
      altHeader,
      ...this.altChunks,
      ...(this.pendingEsc.length > 0 ? [this.pendingEsc] : []),
    ];
    const totalLen = this.totalBytes + altHeader.length + this.altBytes + this.pendingEsc.length;
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
    return (
      this.totalBytes +
      (this.inAltScreen ? this.getAltHeaderBuffer().length + this.altBytes : 0) +
      this.pendingEsc.length
    );
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
    this.altScreenMode = '1049';
    this.altMouseModes.clear();
    this.inAltScreen = false;
    this.pendingEsc = Buffer.alloc(0);
  }
}
