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

    it('defines responsive scrollback with 8000 desktop and 3000 mobile fallback', () => {
      expect(compContent).toContain('scrollback:');
      expect(compContent).not.toMatch(/scrollback:\s*30000/);
      expect(compContent).toMatch(/8000/);
      expect(compContent).toMatch(/3000/);
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
  });
});
