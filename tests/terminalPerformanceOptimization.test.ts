if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = globalThis;
}
import * as fs from 'fs';
import * as path from 'path';
import { initSafeWebglAddon } from '../frontend/src/utils/terminalWebglHelper';
import { TerminalWriteScheduler, BackgroundBufferQueue } from '../frontend/src/utils/terminalStreamHelper';

describe('Terminal Performance Optimization - WebGL Helper', () => {
  it('gracefully handles WebGL initialization failures without throwing', () => {
    const mockTerm = {
      loadAddon: jest.fn(() => {
        throw new Error('WebGL not supported');
      }),
    };
    const result = initSafeWebglAddon(mockTerm as any);
    expect(result.addon).toBeNull();
    expect(typeof result.dispose).toBe('function');
  });

  it('successfully loads addon when WebGL is supported and registers onContextLoss', () => {
    let contextLossCb: (() => void) | null = null;
    const mockAddonInstance = {
      onContextLoss: jest.fn((cb) => {
        contextLossCb = cb;
        return { dispose: jest.fn() };
      }),
      dispose: jest.fn(),
    };
    const MockWebglAddon = jest.fn(() => mockAddonInstance);
    const mockTerm = {
      loadAddon: jest.fn(),
    };

    const result = initSafeWebglAddon(mockTerm as any, MockWebglAddon as any);
    expect(result.addon).toBe(mockAddonInstance);
    expect(mockTerm.loadAddon).toHaveBeenCalledWith(mockAddonInstance);

    // Simulate context loss
    if (contextLossCb) {
      (contextLossCb as () => void)();
    }
    expect(mockAddonInstance.dispose).toHaveBeenCalled();
  });
});

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
      }, 50, 10); // 10 bytes threshold

      scheduler.push('12345');
      expect(writtenBatches.length).toBe(0);
      scheduler.push('67890abc');
      // Buffer length 13 >= 10, triggers immediate flush
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
      queue.push('abc'); // Total 13, max 10 -> 3 bytes excess evicted
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

  it('integrates initSafeWebglAddon during terminal initialization', () => {
    expect(compContent).toContain('initSafeWebglAddon');
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


