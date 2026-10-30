import { StreamBatcher } from '../src/shared/utils/streamBatcher';

describe('StreamBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('batches rapid consecutive pushes into a single flush after 16ms', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16);

    batcher.push('hello ');
    batcher.push('world');
    batcher.push('!');

    expect(outputs).toEqual([]);

    jest.advanceTimersByTime(16);

    expect(outputs).toEqual(['hello world!']);
  });

  it('immediately flushes when batch size reaches 64KB threshold', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16, 100); // 100 bytes threshold for testing

    const chunk50 = 'a'.repeat(50);
    batcher.push(chunk50);
    expect(outputs.length).toBe(0);

    const chunk60 = 'b'.repeat(60);
    batcher.push(chunk60); // 50 + 60 = 110 >= 100

    expect(outputs.length).toBe(1);
    expect(outputs[0]).toBe(chunk50 + chunk60);
  });

  it('synchronously flushes pending data on destroy or manual flush', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 16);

    batcher.push('pending data');
    batcher.flush();

    expect(outputs).toEqual(['pending data']);

    batcher.push('tail data');
    batcher.destroy();

    expect(outputs).toEqual(['pending data', 'tail data']);
  });

  it('immediately flushes first small packet when immediateMaxBytes is set and batches subsequent burst within cooldown window', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 8, 64 * 1024, 4096);

    // First small packet (keystroke echo) is sent with 0ms delay
    batcher.push('a');
    expect(outputs).toEqual(['a']);

    // Subsequent burst chunks during the 8ms cooldown window are batched
    batcher.push('b');
    batcher.push('c');
    expect(outputs).toEqual(['a']);

    jest.advanceTimersByTime(8);
    expect(outputs).toEqual(['a', 'bc']);

    // Next packet after cooldown is again sent immediately
    batcher.push('d');
    expect(outputs).toEqual(['a', 'bc', 'd']);
  });

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

  it('handles DEC Mode 2026 sequences and split boundary chunks in StreamBatcher', () => {
    const outputs: string[] = [];
    const batcher = new StreamBatcher((data) => {
      outputs.push(data);
    }, 8, 64 * 1024, 4096);

    // Split \x1b[?2026h across chunks
    batcher.push('\x1b[?2026');
    expect(outputs).toEqual([]);
    batcher.push('h\x1b[2KHeader\r\n');
    expect(outputs).toEqual([]);
    expect(batcher.isSyncActive()).toBe(true);

    // Split \x1b[?2026l across chunks
    batcher.push('Content\x1b[?2026');
    expect(outputs).toEqual([]);
    batcher.push('l');
    // Immediate flush upon closing sync frame
    expect(outputs).toEqual(['\x1b[?2026h\x1b[2KHeader\r\nContent\x1b[?2026l']);
    expect(batcher.isSyncActive()).toBe(false);
  });
});
