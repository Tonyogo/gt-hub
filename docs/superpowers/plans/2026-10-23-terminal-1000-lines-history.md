# Terminal 1000-Line History Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify terminal scrollback history limit to at most 1000 lines across backend/agent `TerminalHistoryBuffer`, frontend `BackgroundBufferQueue`, and `WebTerminalView` (`xterm.js`) to improve real-time rendering, tab switching, and history replay responsiveness.

**Architecture:** We add incremental newline (`\n` / `0x0a`) tracking (`chunkLineCounts` and `totalLines`) alongside existing byte-size guards in both `TerminalHistoryBuffer` (shared by Agent daemon and Hub `RemoteAgentTerminalSession`) and `BackgroundBufferQueue` (frontend inactive tab buffer). Additionally, we cap `xterm.js` `scrollback` in `WebTerminalView.tsx` to `1000` lines across both desktop and mobile.

**Tech Stack:** TypeScript, Node.js (`Buffer`), React 18, `@xterm/xterm`, Jest.

## Global Constraints

- Default maximum history lines (`DEFAULT_MAX_HISTORY_LINES` / `MAX_SCROLLBACK_LINES`): `1000`.
- Default maximum history byte safety cap remains `1 * 1024 * 1024` (1MB) in `TerminalHistoryBuffer` and `2 * 1024 * 1024` (2MB) in `BackgroundBufferQueue` so single-line newline-less payloads remain bounded.
- Alternate screen (`\x1b[?1049h` ... `\x1b[?1049l`) isolation in `TerminalHistoryBuffer` must remain intact and unaffected by normal buffer line trimming.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

---

### Task 1: Add 1000-Line Incremental Cap to `TerminalHistoryBuffer`

**Files:**
- Modify: `src/agent/pty/terminalHistoryBuffer.ts:24-182`
- Test: `tests/terminalHistoryBuffer.test.ts`

**Interfaces:**
- Consumes: `stripTerminalQuerySequences` from `src/shared/utils/terminalSanitizer.ts`
- Produces:
  - `export const DEFAULT_MAX_HISTORY_BYTES = 1 * 1024 * 1024;`
  - `export const DEFAULT_MAX_HISTORY_LINES = 1000;`
  - `class TerminalHistoryBuffer { constructor(maxBytes?: number, clearOnEd3?: boolean, maxLines?: number) }`

- [x] **Step 1: Write the failing tests in `tests/terminalHistoryBuffer.test.ts`**

Add tests to `tests/terminalHistoryBuffer.test.ts` verifying default 1000-line eviction, custom `maxLines` eviction across single/multiple chunks, and prefix preservation when a chunk is split mid-line:

```typescript
  test('enforces default 1000-line history cap when more than 1000 lines are pushed', () => {
    const buf = new TerminalHistoryBuffer();
    for (let i = 1; i <= 1500; i++) {
      buf.push(`Line ${i}\r\n`);
    }
    const result = buf.getString();
    const lines = result.trimEnd().split('\r\n');
    expect(lines.length).toBe(1000);
    expect(lines[0]).toBe('Line 501');
    expect(lines[999]).toBe('Line 1500');
  });

  test('evicts oldest lines accurately across multi-line and partial-line chunks with custom maxLines', () => {
    const buf = new TerminalHistoryBuffer(1024 * 1024, true, 3);
    buf.push('part1-');
    buf.push('line1\nline2\npart2-');
    buf.push('line3\nline4\nline5\n');

    expect(buf.getString()).toBe('part2-line3\nline4\nline5\n');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalHistoryBuffer.test.ts`
Expected: FAIL — `expect(lines.length).toBe(1000)` receives `1500`.

- [x] **Step 3: Implement incremental line counting and trimming in `src/agent/pty/terminalHistoryBuffer.ts`**

Update `src/agent/pty/terminalHistoryBuffer.ts` with `DEFAULT_MAX_HISTORY_BYTES`, `DEFAULT_MAX_HISTORY_LINES`, `chunkLineCounts`, `totalLines`, and line-eviction logic inside `pushNormal` and `clear`:

```typescript
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

  public getString(): string {
    return this.getBuffer().toString('utf-8');
  }

  public getSanitizedString(): string {
    return stripTerminalQuerySequences(this.getString());
  }

  public getSize(): number {
    return this.totalBytes + (this.inAltScreen ? ALT_SCREEN_ENTER_BUFFER.length + this.altBytes : 0);
  }

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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalHistoryBuffer.test.ts tests/terminalDeflateAndBufferLimit.test.ts tests/terminalPersistence.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/agent/pty/terminalHistoryBuffer.ts tests/terminalHistoryBuffer.test.ts
git commit -m "feat(terminal): limit TerminalHistoryBuffer to 1000 lines by default

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Limit Frontend `BackgroundBufferQueue` and `WebTerminalView` Scrollback to 1000 Lines

**Files:**
- Modify: `frontend/src/utils/terminalStreamHelper.ts:193-251`
- Modify: `frontend/src/components/WebTerminalView.tsx:815-830`
- Test: `tests/terminalPerformanceOptimization.test.ts`

**Interfaces:**
- Consumes: `BackgroundBufferQueue` in `frontend/src/utils/terminalStreamHelper.ts`
- Produces:
  - `class BackgroundBufferQueue { constructor(maxBytes?: number, maxLines?: number) }` (default `maxLines = 1000`)
  - `MAX_SCROLLBACK_LINES = 1000` in `WebTerminalView.tsx`

- [x] **Step 1: Write the failing tests in `tests/terminalPerformanceOptimization.test.ts`**

Update `tests/terminalPerformanceOptimization.test.ts`:
1. Add unit tests under `describe('BackgroundBufferQueue')` for the 1000-line default cap and custom `maxLines` cap.
2. Update the `WebTerminalView Integration Specifications` test from checking `8000` / `3000` to checking the unified `1000` scrollback limit.

```typescript
      it('caps buffered lines to 1000 by default and trims oldest lines', () => {
        const queue = new BackgroundBufferQueue();
        for (let i = 1; i <= 1250; i++) {
          queue.push(`Line ${i}\n`);
        }
        const drained = queue.drain();
        const lines = drained.trimEnd().split('\n');
        expect(lines.length).toBe(1000);
        expect(lines[0]).toBe('Line 251');
        expect(lines[999]).toBe('Line 1250');
      });

      it('supports custom maxLines and preserves partial line prefix across chunks', () => {
        const queue = new BackgroundBufferQueue(1024 * 1024, 2);
        queue.push('old-prefix-');
        queue.push('1\nkeep-prefix-');
        queue.push('2\nkeep-3\n');
        expect(queue.drain()).toBe('keep-prefix-2\nkeep-3\n');
      });
```

And update line 180 in `tests/terminalPerformanceOptimization.test.ts`:
```typescript
    it('defines unified 1000-line scrollback cap for terminal performance', () => {
      expect(compContent).toContain('scrollback:');
      expect(compContent).not.toMatch(/scrollback:\s*30000/);
      expect(compContent).toContain('MAX_SCROLLBACK_LINES = 1000');
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalPerformanceOptimization.test.ts`
Expected: FAIL — `BackgroundBufferQueue` does not yet trim at 1000 lines and `WebTerminalView.tsx` does not contain `MAX_SCROLLBACK_LINES = 1000`.

- [x] **Step 3: Implement 1000-line cap in `BackgroundBufferQueue` and `WebTerminalView.tsx`**

In `frontend/src/utils/terminalStreamHelper.ts`, update `BackgroundBufferQueue`:

```typescript
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

  constructor(maxBytes: number = 2 * 1024 * 1024, maxLines: number = 1000) {
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
```

In `frontend/src/components/WebTerminalView.tsx` (lines 815-822), replace the `defaultScrollback` and `scrollback` calculation:

```typescript
    const MAX_SCROLLBACK_LINES = 1000;
    const defaultScrollback = MAX_SCROLLBACK_LINES;
    const configuredScrollback = typeof localStorage !== 'undefined'
      ? parseInt(localStorage.getItem('terminal_scrollback_lines') || '', 10)
      : NaN;
    const scrollback = !isNaN(configuredScrollback) && configuredScrollback > 0
      ? Math.min(configuredScrollback, MAX_SCROLLBACK_LINES)
      : defaultScrollback;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalPerformanceOptimization.test.ts tests/terminalNonFullscreenStability.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalStreamHelper.ts frontend/src/components/WebTerminalView.tsx tests/terminalPerformanceOptimization.test.ts
git commit -m "feat(frontend): cap xterm scrollback and background queue to 1000 lines

Co-Authored-By: Claude <noreply@anthropic.com>"
```
