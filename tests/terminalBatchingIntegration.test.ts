import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('Terminal Batching Integration (RemoteAgentTerminalSession)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flushes first small idle packet immediately (0ms) and batches subsequent burst within 8ms cooldown', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-batch-host', mockAgentWs);

    const clientSent: string[] = [];
    const mockClientWs = {
      readyState: 1,
      send: (data: string) => clientSent.push(data),
    };

    session.attach(mockClientWs as any);

    // First small non-TUI chunk takes the 0ms fast-path for instant keystroke echo
    session.handleData('part1 ');
    expect(clientSent).toEqual(['part1 ']);

    // Subsequent chunks arriving during the 8ms cooldown window are batched
    session.handleData('part2 ');
    session.handleData('part3\r\n');

    // History is updated synchronously
    expect(session.getHistory()).toBe('part1 part2 part3\r\n');
    expect(clientSent).toEqual(['part1 ']);

    // Advance 8ms
    jest.advanceTimersByTime(8);

    // Active sockets receive the combined batched frame
    expect(clientSent).toEqual(['part1 ', 'part2 part3\r\n']);
  });

  it('coalesces TUI erase chunk with redraw chunk instead of flushing erase at 0ms', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-tui-batch-host', mockAgentWs);

    const clientSent: string[] = [];
    const mockClientWs = {
      readyState: 1,
      send: (data: string) => clientSent.push(data),
    };

    session.attach(mockClientWs as any);

    session.handleData('\x1b[2K\r');
    expect(clientSent).toEqual([]);

    session.handleData('Redrawn line\r\n');
    jest.advanceTimersByTime(8);

    expect(clientSent).toEqual(['\x1b[2K\rRedrawn line\r\n']);
  });

  it('immediately flushes to client when batch reaches 64KB threshold', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-batch-threshold', mockAgentWs);

    const clientSent: string[] = [];
    const mockClientWs = {
      readyState: 1,
      send: (data: string) => clientSent.push(data),
    };

    session.attach(mockClientWs as any);

    const bigChunk35k = 'x'.repeat(35 * 1024);
    session.handleData(bigChunk35k);
    expect(clientSent.length).toBe(0);

    const bigChunk30k = 'y'.repeat(30 * 1024);
    session.handleData(bigChunk30k); // 35k + 30k = 65k >= 64k threshold

    expect(clientSent.length).toBe(1);
    expect(clientSent[0]).toBe(bigChunk35k + bigChunk30k);
  });

  it('synchronously delivers pending output when destroy or reset is called', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-batch-lifecycle', mockAgentWs);

    const clientSent: string[] = [];
    const mockClientWs = {
      readyState: 1,
      send: (data: string) => clientSent.push(data),
    };

    session.attach(mockClientWs as any);

    // Trigger cooldown with initial small frame so subsequent writes buffer
    session.handleData('init');
    expect(clientSent).toEqual(['init']);

    session.handleData('data before reset');
    expect(clientSent).toEqual(['init']);

    session.reset(true);
    expect(clientSent).toContain('data before reset');

    // Re-enter cooldown so next write stays buffered until destroy
    session.handleData('init2');
    session.handleData('data before destroy');
    expect(clientSent).not.toContain('data before destroy');

    session.destroy();
    expect(clientSent).toContain('data before destroy');
  });

  it('decodes multi-byte UTF-8 Buffer chunks split across frame boundaries without replacement characters', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-utf8-split', mockAgentWs);

    const clientSent: string[] = [];
    const mockClientWs = {
      readyState: 1,
      send: (data: string) => clientSent.push(data),
    };
    session.attach(mockClientWs as any);

    const fullBuf = Buffer.from('终端流畅度测试🚀', 'utf-8');
    // Split right in the middle of a 3-byte Chinese character and 4-byte emoji
    const chunk1 = fullBuf.subarray(0, 4);
    const chunk2 = fullBuf.subarray(4, 10);
    const chunk3 = fullBuf.subarray(10);

    session.handleData(chunk1);
    session.handleData(chunk2);
    session.handleData(chunk3);
    session.flush();

    expect(session.getHistory()).toBe('终端流畅度测试🚀');
    expect(clientSent.join('')).toBe('终端流畅度测试🚀');
  });
});
