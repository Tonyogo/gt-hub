import * as fs from 'fs';
import * as path from 'path';
import { TerminalWriteScheduler, BackgroundBufferQueue } from '../frontend/src/utils/terminalStreamHelper';

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

          // 3. Complete first write -> schedules next slice after 8ms
          pendingDoneCallbacks.shift()!();
          expect(scheduler.isBusy()).toBe(false);

          jest.advanceTimersByTime(8);
          expect(writtenBatches.length).toBe(2);
          expect(writtenBatches[1]).toBe('0123456789'); // 10-byte slice
          expect(scheduler.pendingBytes()).toBe(15);

          // 4. Complete second write -> next 10-byte slice
          pendingDoneCallbacks.shift()!();
          jest.advanceTimersByTime(8);
          expect(writtenBatches.length).toBe(3);
          expect(writtenBatches[2]).toBe('abcdefghij');
          expect(scheduler.pendingBytes()).toBe(5);

          // 5. Complete third write -> final 5-byte slice
          pendingDoneCallbacks.shift()!();
          jest.advanceTimersByTime(8);
          expect(writtenBatches.length).toBe(4);
          expect(writtenBatches[3]).toBe('UVWXY');
          expect(scheduler.pendingBytes()).toBe(0);
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

    it('defines unified 1000-line scrollback cap for terminal performance', () => {
      expect(compContent).toContain('scrollback:');
      expect(compContent).not.toMatch(/scrollback:\s*30000/);
      expect(compContent).toContain('MAX_SCROLLBACK_LINES = 1000');
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
  });
});
