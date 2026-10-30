import * as fs from 'fs';
import * as path from 'path';
import {
  TerminalWriteScheduler,
  BackgroundBufferQueue,
  isTuiEraseOrSyncChunk,
  hasIncompleteTuiFrame,
  findSafeAnsiSplitIndex,
  hasTrailingIncompleteAnsi,
} from '../frontend/src/utils/terminalStreamHelper';

describe('Terminal Performance Optimization', () => {
  describe('Terminal Stream & Batch Helpers', () => {
    describe('TerminalWriteScheduler', () => {
      it('batches rapid small writes into single callback execution', (done) => {
        const writtenBatches: string[] = [];
        const scheduler = new TerminalWriteScheduler((batch) => {
          writtenBatches.push(batch);
        }, 16);

        scheduler.push('hello ');
        scheduler.push('world ');
        scheduler.push('!');

        expect(writtenBatches.length).toBe(0);

        setTimeout(() => {
          expect(writtenBatches.length).toBe(1);
          expect(writtenBatches[0]).toBe('hello world !');
          scheduler.destroy();
          done();
        }, 30);
      });

      it('flushes immediately when buffer exceeds maxBatchBytes', () => {
        const writtenBatches: string[] = [];
        const scheduler = new TerminalWriteScheduler((batch) => {
          writtenBatches.push(batch);
        }, 50, 10);

        scheduler.push('12345');
        expect(writtenBatches.length).toBe(0);
        scheduler.push('67890abc');
        expect(writtenBatches.length).toBe(1);
        expect(writtenBatches[0]).toBe('1234567890abc');
        scheduler.destroy();
      });

      it('enforces inFlight backpressure and slices large bursts when async done callback is used', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const pendingDoneCallbacks: Array<() => void> = [];

          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              pendingDoneCallbacks.push(done);
            },
            8,
            10, // maxBatchBytes = 10
            4   // immediateMaxBytes = 4
          );

          // 1. Idle small write (<=4 bytes) dispatches immediately with 0ms delay
          scheduler.push('abc');
          expect(writtenBatches).toEqual(['abc']);
          expect(scheduler.isBusy()).toBe(true);

          // 2. While first write is still in-flight in xterm.js, flood 25 bytes
          scheduler.push('0123456789');
          scheduler.push('abcdefghij');
          scheduler.push('UVWXY');

          // Must NOT call xterm.write while busy (prevents main thread lockup)
          expect(writtenBatches.length).toBe(1);
          expect(scheduler.pendingBytes()).toBe(25);

          // 3. Complete first write -> immediately wakes up next slice without 8ms cooling timer delay
          pendingDoneCallbacks.shift()!();
          expect(writtenBatches.length).toBe(2);
          expect(writtenBatches[1]).toBe('0123456789'); // 10-byte slice
          expect(scheduler.isBusy()).toBe(true);
          expect(scheduler.pendingBytes()).toBe(15);

          // 4. Complete second write -> immediately wakes up next 10-byte slice
          pendingDoneCallbacks.shift()!();
          expect(writtenBatches.length).toBe(3);
          expect(writtenBatches[2]).toBe('abcdefghij');
          expect(scheduler.isBusy()).toBe(true);
          expect(scheduler.pendingBytes()).toBe(5);

          // 5. Complete third write -> immediately wakes up final 5-byte slice
          pendingDoneCallbacks.shift()!();
          expect(writtenBatches.length).toBe(4);
          expect(writtenBatches[3]).toBe('UVWXY');
          expect(scheduler.isBusy()).toBe(true);
          expect(scheduler.pendingBytes()).toBe(0);

          // 6. Complete fourth write -> buffer empty, scheduler becomes idle
          pendingDoneCallbacks.shift()!();
          expect(scheduler.isBusy()).toBe(false);
        } finally {
          jest.useRealTimers();
        }
      });

      it('flushes synchronized output frame immediately when closing ?2026l arrives without waiting for timer', () => {
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

          // Sync start + erase
          scheduler.push('\x1b[?2026h\x1b[2K');
          expect(writtenBatches).toEqual([]);

          // Middle content
          scheduler.push('Header line\r\n');
          expect(writtenBatches).toEqual([]);

          // Sync close arrives: immediately flushes entire frame atomically with 0ms delay!
          scheduler.push('Content\x1b[?2026l');
          expect(writtenBatches).toEqual(['\x1b[?2026h\x1b[2KHeader line\r\nContent\x1b[?2026l']);
        } finally {
          jest.useRealTimers();
        }
      });

      it('does not bypass inFlight backpressure when bufferedLength exceeds maxBatchBytes while idle', () => {
        jest.useFakeTimers();
        try {
          const writtenBatches: string[] = [];
          const pendingDoneCallbacks: Array<() => void> = [];

          const scheduler = new TerminalWriteScheduler(
            (batch, done) => {
              writtenBatches.push(batch);
              pendingDoneCallbacks.push(done);
            },
            8,
            10, // maxBatchBytes = 10
            4   // immediateMaxBytes = 4
          );

          // Push a 25-byte burst (> maxBatchBytes = 10) when idle
          scheduler.push('0123456789abcdefghijUVWXY');

          // Must only dispatch first 10-byte slice and remain busy (inFlight = true)
          expect(writtenBatches).toEqual(['0123456789']);
          expect(scheduler.isBusy()).toBe(true);
          expect(scheduler.pendingBytes()).toBe(15);

          // Subsequent push while busy must queue and NOT synchronously invoke callback
          scheduler.push('1234567890');
          expect(writtenBatches.length).toBe(1);
          expect(scheduler.pendingBytes()).toBe(25);
        } finally {
          jest.useRealTimers();
        }
      });

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

      it('handles DEC Mode 2026 sequences split across chunk boundaries correctly', () => {
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

          // Split \x1b[?2026h across chunks: chunk 1 has '\x1b[?2026', chunk 2 has 'h\x1b[2K'
          scheduler.push('\x1b[?2026');
          expect(writtenBatches).toEqual([]);
          scheduler.push('h\x1b[2KContent');
          expect(writtenBatches).toEqual([]);
          expect(scheduler.isSyncActive()).toBe(true);

          // Split \x1b[?2026l across chunks: chunk 3 has '\x1b[?2026', chunk 4 has 'l'
          scheduler.push('\x1b[?2026');
          expect(writtenBatches).toEqual([]);
          scheduler.push('l');
          // Immediately flushes upon closing split sequence
          expect(writtenBatches).toEqual(['\x1b[?2026h\x1b[2KContent\x1b[?2026l']);
          expect(scheduler.isSyncActive()).toBe(false);
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('TUI Frame Detection & ANSI Slicing Helpers', () => {
      it('isTuiEraseOrSyncChunk identifies erase, navigation, and sync sequences correctly', () => {
        expect(isTuiEraseOrSyncChunk('')).toBe(false);
        expect(isTuiEraseOrSyncChunk('hello world')).toBe(false);
        expect(isTuiEraseOrSyncChunk('\x1b[32mgreen text\x1b[0m')).toBe(false);

        expect(isTuiEraseOrSyncChunk('\x1b[?2026h')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[?2026l')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[?25l')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[?25h')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[2K')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[1A')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[H')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[1;1H')).toBe(true);
        expect(isTuiEraseOrSyncChunk('\x1b[1G')).toBe(true);
        expect(isTuiEraseOrSyncChunk('text\x1b[')).toBe(true);
      });

      it('hasIncompleteTuiFrame detects unclosed sync frames and incomplete tails', () => {
        expect(hasIncompleteTuiFrame('')).toBe(false);
        expect(hasIncompleteTuiFrame('normal text\r\n')).toBe(false);
        expect(hasIncompleteTuiFrame('\x1b[32mgreen text\x1b[0m\r\n')).toBe(false);

        // Unclosed DEC 2026
        expect(hasIncompleteTuiFrame('\x1b[?2026hheader')).toBe(true);
        expect(hasIncompleteTuiFrame('\x1b[?2026hheader\x1b[?2026l')).toBe(false);
        expect(hasIncompleteTuiFrame('\x1b[?2026hheader\x1b[?2026l\x1b[1G')).toBe(false);
        expect(hasIncompleteTuiFrame('\x1b[?2026hheader\x1b[?2026l\x1b[10;1H')).toBe(false);

        // Erase / cursor sequences at tail
        expect(hasIncompleteTuiFrame('\x1b[2K\r')).toBe(true);
        expect(hasIncompleteTuiFrame('\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\r')).toBe(true);
        expect(hasIncompleteTuiFrame('\x1b[2KRedrawn text\r\n')).toBe(false);
      });

      it('findSafeAnsiSplitIndex avoids slicing through mid-sequence ANSI escapes', () => {
        expect(findSafeAnsiSplitIndex('short', 10)).toBe(5);
        expect(findSafeAnsiSplitIndex('ABCDEFGHIJK', 10)).toBe(10);
        expect(findSafeAnsiSplitIndex('ABCDEFGH\x1b[32mZ', 10)).toBe(8);
        expect(findSafeAnsiSplitIndex('12345\x1b]0;Title\x07Z', 10)).toBe(5);
      });
    });

    describe('BackgroundBufferQueue', () => {
      it('stores data and flushes concatenated string', () => {
        const queue = new BackgroundBufferQueue(100);
        queue.push('chunk1;');
        queue.push('chunk2;');
        expect(queue.size()).toBe(14);
        expect(queue.drain()).toBe('chunk1;chunk2;');
        expect(queue.size()).toBe(0);
      });

      it('caps total buffered size and trims excess from head', () => {
        const queue = new BackgroundBufferQueue(10);
        queue.push('12345');
        queue.push('67890');
        queue.push('abc');
        expect(queue.size()).toBeLessThanOrEqual(10);
        const drained = queue.drain();
        expect(drained.endsWith('67890abc')).toBe(true);
        expect(drained.length).toBeLessThanOrEqual(10);
      });

      it('preserves multi-byte UTF-8 characters split across ArrayBuffer chunks', () => {
        const queue = new BackgroundBufferQueue(100);
        // '你好' in UTF-8 is 6 bytes: [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]
        const fullBytes = Buffer.from('你好', 'utf-8');
        const part1 = new Uint8Array(fullBytes.subarray(0, 2)); // incomplete first char
        const part2 = new Uint8Array(fullBytes.subarray(2));    // rest of first + second char

        queue.push(part1);
        queue.push(part2);

        expect(queue.drain()).toBe('你好');
      });

      it('caps buffered lines to 2000 by default and trims oldest lines', () => {
        const queue = new BackgroundBufferQueue();
        for (let i = 1; i <= 2250; i++) {
          queue.push(`Line ${i}\n`);
        }
        const drained = queue.drain();
        const lines = drained.trimEnd().split('\n');
        expect(lines.length).toBe(2000);
        expect(lines[0]).toBe('Line 251');
        expect(lines[1999]).toBe('Line 2250');
      });

      it('supports custom maxLines and preserves partial line prefix across chunks', () => {
        const queue = new BackgroundBufferQueue(1024 * 1024, 2);
        queue.push('old-prefix-');
        queue.push('1\nkeep-prefix-');
        queue.push('2\nkeep-3\n');
        expect(queue.drain()).toBe('keep-prefix-2\nkeep-3\n');
      });
    });
  });

  describe('WebTerminalView Integration Specifications', () => {
    const compPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
    const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
    let compContent: string;
    let unifiedContent: string;

    beforeAll(() => {
      compContent = fs.readFileSync(compPath, 'utf-8');
      unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
    });

    it('defines unified 2000-line scrollback cap for terminal performance', () => {
      expect(compContent).toContain('scrollback:');
      expect(compContent).not.toMatch(/scrollback:\s*30000/);
      expect(compContent).toContain('MAX_SCROLLBACK_LINES = 2000');
    });

    it('does not import or instantiate webgl addon', () => {
      expect(compContent).not.toContain('initSafeWebglAddon');
      expect(compContent).not.toContain('@xterm/addon-webgl');
      expect(compContent).not.toContain('webglCleanupRef');
    });

    it('accepts isActive prop in WebTerminalViewProps and passes it from UnifiedTerminalView', () => {
      expect(compContent).toContain('isActive?: boolean;');
      expect(unifiedContent).toContain('isActive={subTab === \'interactive\'}');
    });

    it('flushes backgroundQueue when transitioning from inactive to active', () => {
      expect(compContent).toContain('backgroundQueueRef');
      expect(compContent).toContain('writeSchedulerRef');
    });

    it('restores native alternate screen mode in daemon.ts by not forcing CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN to 1', () => {
      const daemonPath = path.resolve(__dirname, '../src/agent/daemon.ts');
      const daemonContent = fs.readFileSync(daemonPath, 'utf-8');
      expect(daemonContent).not.toMatch(/CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:\s*process\.env\.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN\s*\|\|\s*['"]1['"]/);
      expect(daemonContent).toContain('delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
    });

    it('safely loads @xterm/addon-canvas for 2D double-buffered rendering with fallback to DOM renderer', () => {
      expect(compContent).toContain("import { CanvasAddon } from '@xterm/addon-canvas';");
      expect(compContent).toContain('initSafeCanvasAddon(term)');
      expect(compContent).toContain('canvasAddonRef.current = canvasAddonHandle.canvasAddon;');
      expect(compContent).toContain('canvasAddonHandle.dispose();');
    });

    it('registers DECRQM and DEC Mode 2026 handlers to negotiate synchronized output', () => {
      expect(compContent).toContain("prefix: '?', intermediates: '$', final: 'p'");
      expect(compContent).toContain('mode === 2026');
      expect(compContent).toContain('\\x1b[?2026;');
      expect(compContent).toContain("prefix: '?', final: 'h'");
      expect(compContent).toContain("prefix: '?', final: 'l'");
      expect(compContent).toContain('decrqmDisposable.dispose();');
      expect(compContent).toContain('if (isReplayingRef.current)');
    });
  });
});
