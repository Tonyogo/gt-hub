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
});
