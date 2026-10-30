# Eliminate Web Terminal TUI Flicker (Claude Code / AGY) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate screen flickering, blank-line flashes, and tearing when running Ink/ANSI TUI tools (`claude`, `agy`) in the web terminal while preserving `0ms` interactive keystroke echo.

**Architecture:** We add TUI frame-completeness detection (`isTuiFrameStartOrErase`, `hasIncompleteTuiFrame`, and `findSafeAnsiSplitIndex`) to both `TerminalWriteScheduler` (`frontend/src/utils/terminalStreamHelper.ts`) and `StreamBatcher` (`src/shared/utils/streamBatcher.ts`) so that split TUI redraws (DEC Mode 2026 `\x1b[?2026h...\x1b[?2026l`, cursor-hide `\x1b[?25l...\x1b[?25h`, and multi-line erase sequences `\x1b[2K\x1b[1A`) never bypass batching via the `0ms` fast-path and are held up to `24ms` until the redraw payload arrives, then flushed atomically in a single `xterm.write()` call. We also guard `WebTerminalView.tsx` against redundant `scrollToBottomSafe` calls when already at the bottom and skip no-op `fitAddon.fit()` / full-screen `term.refresh()` when terminal dimensions (`cols × rows`) have not changed.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** In-chat root-cause analysis and bounded design (2026-10-30).

## Global Constraints

- Preserve all existing unit and integration tests in `tests/terminalPerformanceOptimization.test.ts`, `tests/streamBatcher.test.ts`, `tests/terminalNonFullscreenStability.test.ts`, `tests/terminalReconnectDuplicateFix.test.ts`, and `tests/terminalMobileKeyboard.test.ts`.
- Interactive plain-text keystroke echo (`<= immediateMaxBytes` without TUI redraw/erase control sequences) must still dispatch with `0ms` latency when the scheduler/batcher is idle.
- Holding an incomplete TUI frame must be strictly bounded by `maxFrameHoldMs` (`24ms` default) or `maxBatchBytes` (`64KB`) so a program that intentionally leaves the cursor hidden (`\x1b[?25l`) or crashes mid-sequence never stalls output indefinitely.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during iterative development.

## Review Focus

1. **Split Erase + Redraw Chunks (`\x1b[2K\x1b[1A` followed 2ms later by redraw text):** Must NOT dispatch the erase chunk alone on the `0ms` fast-path; both chunks must coalesce into a single `flushCallback` invocation.
2. **Split DEC Mode 2026 Synchronized Output (`\x1b[?2026h` across multiple timer ticks before `\x1b[?2026l`):** Must defer flushing across up to `maxFrameHoldMs` (`24ms`) until `\x1b[?2026l` arrives, then flush the entire synchronized frame atomically.
3. **Unclosed `\x1b[?25l` or `\x1b[?2026h` exceeding `maxFrameHoldMs` (`24ms`):** Must force-flush once the hold budget expires so interactive TUI spinners that keep the cursor hidden permanently still render smoothly at frame cadence.
4. **Large Burst Slicing (`> maxBatchBytes`) Mid-ANSI Escape Sequence:** `dequeueSlice` must not split in the middle of a trailing `\x1b[38;2;...` CSI/OSC sequence; it must slice before the incomplete `\x1b` so `xterm.js` never sees a corrupted sequence boundary.
5. **No-op `ResizeObserver` / `safeFit(false)` Calls During TUI Execution:** When `proposed.cols === term.cols && proposed.rows === term.rows` and `forceResize === false`, `safeFit` must not invoke `term.refresh(0, rows - 1)` to rebuild all DOM rows.

---

### Task 1: Frame-Aware Coalescing & Safe ANSI Slicing in `terminalStreamHelper.ts` and `streamBatcher.ts`

**Files:**
- Modify: `frontend/src/utils/terminalStreamHelper.ts`
- Modify: `src/shared/utils/streamBatcher.ts`
- Test: `tests/terminalPerformanceOptimization.test.ts`
- Test: `tests/streamBatcher.test.ts`

**Interfaces:**
- Produces in `frontend/src/utils/terminalStreamHelper.ts`:
  ```ts
  export function isTuiEraseOrSyncChunk(chunk: string): boolean;
  export function hasIncompleteTuiFrame(text: string): boolean;
  export function findSafeAnsiSplitIndex(text: string, maxChars: number): number;
  ```
- Updates `TerminalWriteScheduler` in `frontend/src/utils/terminalStreamHelper.ts` and `StreamBatcher` in `src/shared/utils/streamBatcher.ts` to:
  1. Skip the `0ms` `immediateMaxBytes` fast-path when `isTuiEraseOrSyncChunk(chunk)` is true.
  2. When the flush timer fires, if `hasIncompleteTuiFrame(combinedBuffer)` is true, `bufferedLength < maxBatchBytes`, and total hold duration since the incomplete frame started is `< maxFrameHoldMs` (`24ms`), reschedule the timer once (`intervalMs`) instead of flushing a half-erased frame.
  3. In `TerminalWriteScheduler.dequeueSlice(maxChars)`, use `findSafeAnsiSplitIndex` so multi-batch slices never cut inside a trailing incomplete ANSI sequence.

- [x] **Step 1: Write the failing unit tests in `tests/terminalPerformanceOptimization.test.ts` and `tests/streamBatcher.test.ts`**

In `tests/terminalPerformanceOptimization.test.ts`, add tests inside `describe('TerminalWriteScheduler', ...)`:
```ts
      it('coalesces split TUI erase-and-redraw chunks instead of flushing the erase chunk on the 0ms fast-path', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              done();
            },
            8,
            64 * 1024,
            4096
          );

          // Chunk 1: Ink / Claude Code erases 3 lines and hides cursor
          scheduler.push('\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r');
          // Must NOT flush the blank erased state at 0ms
          expect(writtenBatches).toEqual([]);

          // Chunk 2 arrives 2ms later with the new rendered content and cursor restore
          jest.advanceTimersByTime(2);
          scheduler.push('Claude: Thinking...\r\nStatus: active\x1b[?25h');

          jest.advanceTimersByTime(8);
          expect(writtenBatches).toEqual([
            '\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\rClaude: Thinking...\r\nStatus: active\x1b[?25h',
          ]);
        } finally {
          jest.useRealTimers();
        }
      });

      it('holds unclosed DEC Mode 2026 synchronized output frame across timer ticks up to maxFrameHoldMs', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              done();
            },
            8,
            64 * 1024,
            4096
          );

          // Begin synchronized update + erase
          scheduler.push('\x1b[?2026h\x1b[H\x1b[2KHeader\r\n');
          jest.advanceTimersByTime(8);
          // Still unclosed at 8ms -> held
          expect(writtenBatches).toEqual([]);

          // Body arrives at 12ms and closes synchronized update
          jest.advanceTimersByTime(4);
          scheduler.push('\x1b[2KBody line\x1b[?2026l');

          jest.advanceTimersByTime(8);
          expect(writtenBatches).toEqual([
            '\x1b[?2026h\x1b[H\x1b[2KHeader\r\n\x1b[2KBody line\x1b[?2026l',
          ]);
        } finally {
          jest.useRealTimers();
        }
      });

      it('force-flushes unclosed TUI frame once maxFrameHoldMs (24ms) expires to prevent starvation', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              done();
            },
            8,
            64 * 1024,
            4096
          );

          scheduler.push('\x1b[?2026h\x1b[2KSpinner frame without close');
          jest.advanceTimersByTime(8);
          expect(writtenBatches.length).toBe(0);

          jest.advanceTimersByTime(24);
          expect(writtenBatches).toEqual(['\x1b[?2026h\x1b[2KSpinner frame without close']);
        } finally {
          jest.useRealTimers();
        }
      });

      it('does not split in the middle of a trailing ANSI escape sequence when slicing maxBatchBytes', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              done();
            },
            8,
            10, // maxBatchBytes = 10
            0
          );

          // 8 chars 'ABCDEFGH' + 5-char escape '\x1b[32m' + 'Z' = 14 chars
          // A naive 10-char cut would split '\x1b[32m' into '\x1b[' and '32mZ'
          scheduler.push('ABCDEFGH\x1b[32mZ');
          expect(writtenBatches[0]).toBe('ABCDEFGH');
          jest.advanceTimersByTime(8);
          expect(writtenBatches[1]).toBe('\x1b[32mZ');
        } finally {
          jest.useRealTimers();
        }
      });
```

In `tests/streamBatcher.test.ts`, add a test:
```ts
  it('coalesces TUI erase chunk with subsequent redraw chunk instead of flushing erase on 0ms fast-path', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 8, 64 * 1024, 4096);

    batcher.push('\x1b[2K\x1b[1A\x1b[2K\r');
    expect(outputs).toEqual([]);

    batcher.push('Redrawn line\r\n');
    jest.advanceTimersByTime(8);
    expect(outputs).toEqual(['\x1b[2K\x1b[1A\x1b[2K\rRedrawn line\r\n']);
  });
```

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/terminalPerformanceOptimization.test.ts tests/streamBatcher.test.ts`
Expected: FAIL (erase chunk is flushed immediately on the 0ms fast-path).

- [x] **Step 3: Implement frame-aware coalescing and safe ANSI boundary slicing in `frontend/src/utils/terminalStreamHelper.ts` and `src/shared/utils/streamBatcher.ts`**

1. In `frontend/src/utils/terminalStreamHelper.ts`, implement:
   - `isTuiEraseOrSyncChunk(chunk: string): boolean`:
     Returns `true` if `chunk` contains `\x1b` and matches any of:
     - DEC Mode 2026 sync markers (`\x1b[?2026h` or `\x1b[?2026l`)
     - Cursor visibility toggles (`\x1b[?25l` or `\x1b[?25h`)
     - Erase in Line / Erase in Display / Cursor Up / Cursor Home sequences (`/\x1b\[(?:\d*[JKAFGH]|\d+;\d+[Hf])/`)
     - Trailing incomplete escape sequence (`hasTrailingIncompleteAnsi(chunk)`)
   - `hasTrailingIncompleteAnsi(text: string): boolean`:
     Inspects the last up to 32 chars for the last `\x1b`. If found:
     - If `\x1b` is the final character, returns `true`.
     - If followed by `[` (CSI), returns `true` if the remaining substring matches `/^\[[0-9;:?<>! "']*$/` (no final byte `0x40..0x7E` yet).
     - If followed by `]` (OSC), returns `true` if neither `\x07` nor `\x1b\\` appears after it.
   - `hasIncompleteTuiFrame(text: string): boolean`:
     Returns `true` if:
     - `text.lastIndexOf('\x1b[?2026h') > text.lastIndexOf('\x1b[?2026l')` (unclosed DEC 2026 sync block), OR
     - `hasTrailingIncompleteAnsi(text)` is `true`, OR
     - `text` ends with an erase/cursor-reposition sequence with no printable characters following it (`/(?:\x1b\[(?:\?25l|\?2026h|\d*[JKAFGH]|\d+;\d+[Hf])|\r)+$/` when `text.includes('\x1b[')`).
   - `findSafeAnsiSplitIndex(text: string, maxChars: number): number`:
     If `text.length <= maxChars`, returns `text.length`. Otherwise slices `candidate = text.slice(0, maxChars)`; if `hasTrailingIncompleteAnsi(candidate)`, returns the index of the last `\x1b` in `candidate` (if `> 0`), else `maxChars`.
   - Update `TerminalWriteScheduler`:
     - Only take the `immediateMaxBytes` fast-path when `!isTuiEraseOrSyncChunk(chunk)`.
     - Track `holdCount: number = 0` and `maxHoldCount = Math.max(1, Math.ceil(24 / Math.max(1, this.intervalMs)))` (e.g. 3 ticks of 8ms = 24ms).
     - In the timer callback before calling `flushNextSlice()`, inspect the current buffered text: if `this.bufferedLength < this.maxBatchBytes && this.holdCount < maxHoldCount && hasIncompleteTuiFrame(combinedPreview)`, increment `this.holdCount` and reschedule the timer for `this.intervalMs`. Reset `this.holdCount = 0` whenever a batch is dispatched, flushed, or cleared.
     - In `dequeueSlice(maxChars)`, use `findSafeAnsiSplitIndex` when slicing a chunk so multi-batch flushes never split inside an incomplete ANSI escape sequence.
2. Mirror the same `isTuiEraseOrSyncChunk` and `hasIncompleteTuiFrame` logic in `src/shared/utils/streamBatcher.ts` so the Agent and Hub `StreamBatcher` instances also coalesce TUI erase+redraw frames rather than splitting them on the `0ms` fast-path.

- [x] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/terminalPerformanceOptimization.test.ts tests/streamBatcher.test.ts`
Expected: PASS.

---

### Task 2: Guard Redundant `scrollToBottomSafe` and No-Op `safeFit` Refreshes in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:530-560,660-675,1004-1021`
- Test: `tests/terminalClaudeScrollback.test.ts`

**Interfaces:**
- Consumes: `TerminalWriteScheduler` from `../utils/terminalStreamHelper`
- Modifies `WebTerminalView.tsx`:
  1. In `writeSchedulerRef.current = new TerminalWriteScheduler(...)` (and fallback `term.write` callbacks), only invoke `scrollToBottomSafe(t)` when `isReplayingRef.current || (t.buffer.active.viewportY < t.buffer.active.baseY)` so in-place TUI redraws that are already at the bottom (`viewportY >= baseY`) do not trigger redundant synchronous + `rAF` scroll mutations on every frame.
  2. In `safeFit`: after `const proposed = fitAddonRef.current.proposeDimensions();` and the mobile keyboard shrink guard, if `!forceResize && proposed.cols === term.cols && proposed.rows === term.rows && lastSentColsRef.current === proposed.cols && lastSentRowsRef.current === proposed.rows`, return `true` immediately without calling `fitAddonRef.current.fit()` or `term.refresh(0, Math.max(0, rows - 1))`.

- [x] **Step 1: Write the failing unit tests in `tests/terminalClaudeScrollback.test.ts`**

Add tests in `tests/terminalClaudeScrollback.test.ts`:
```ts
  it('WebTerminalView writeScheduler callback skips scrollToBottomSafe when viewportY is already at baseY', () => {
    const schedulerIdx = webTerminalContent.indexOf('writeSchedulerRef.current = new TerminalWriteScheduler');
    const schedulerBlock = webTerminalContent.slice(schedulerIdx, schedulerIdx + 700);
    expect(schedulerBlock).toContain('t.buffer.active.viewportY < t.buffer.active.baseY');
  });

  it('WebTerminalView safeFit skips fitAddon.fit and full-screen term.refresh when dimensions are unchanged and not forced', () => {
    const safeFitStart = webTerminalContent.indexOf('const safeFit = useCallback');
    const safeFitEnd = webTerminalContent.indexOf('const safeFitRef =', safeFitStart);
    const safeFitBlock = webTerminalContent.slice(safeFitStart, safeFitEnd);
    expect(safeFitBlock).toContain('!forceResize && proposed.cols === term.cols && proposed.rows === term.rows');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalClaudeScrollback.test.ts`
Expected: FAIL.

- [x] **Step 3: Update `frontend/src/components/WebTerminalView.tsx`**

1. In `safeFit` (`frontend/src/components/WebTerminalView.tsx` around line 547, right before `fitAddonRef.current.fit();`):
   ```ts
      if (
        !forceResize &&
        proposed.cols === term.cols &&
        proposed.rows === term.rows &&
        lastSentColsRef.current === proposed.cols &&
        lastSentRowsRef.current === proposed.rows
      ) {
        return true;
      }
   ```
2. In `writeSchedulerRef.current = new TerminalWriteScheduler(...)` (`frontend/src/components/WebTerminalView.tsx` around line 1013):
   ```ts
        if (
          !isRefittingRef.current &&
          shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: t?.buffer.active.type }) &&
          (isReplayingRef.current || t.buffer.active.viewportY < t.buffer.active.baseY)
        ) {
          scrollToBottomSafe(t);
        }
   ```

- [x] **Step 4: Run all related test suites and full build to verify**

Run:
- `npm test -- tests/terminalClaudeScrollback.test.ts tests/terminalPerformanceOptimization.test.ts tests/streamBatcher.test.ts tests/terminalNonFullscreenStability.test.ts tests/terminalReconnectDuplicateFix.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalMobileResizeStability.test.ts`
- `npm run build`
Expected: All tests PASS and build succeeds with zero errors.
