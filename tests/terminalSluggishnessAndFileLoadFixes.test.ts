import * as fs from 'fs';
import * as path from 'path';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { RpcDispatcher } from '../src/terminal/services/rpcDispatcher';
import { scrollToBottomSafe } from '../frontend/src/utils/terminalScrollHelper';

describe('Terminal Sluggishness & File Loading Bug Fixes', () => {
  describe('1. WebTerminalView Duplicate WebSocket & RAF Flood Prevention', () => {
    const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(webTerminalPath, 'utf-8');
    });

    test('does not invoke useTerminalWebSocket inside WebTerminalView to prevent dual-socket flood', () => {
      // Must not call useTerminalWebSocket({
      expect(content).not.toMatch(/useTerminalWebSocket\s*\(\s*\{/);
      // Re-export is still preserved for external modular use
      expect(content).toContain('useTerminalWebSocket,');
    });

    test('guards scheduleCursorShift to early-return when virtual keyboard is inactive', () => {
      expect(content).toContain('if (!isKeyboardShowingRef.current && !isKeyboardOpen) return;');
    });

    test('debounces setIsAtBottom in term.onScroll to prevent rapid React re-render thrashing', () => {
      expect(content).toContain('let scrollDebounceTimer: NodeJS.Timeout | null = null;');
      expect(content).toContain('scrollDebounceTimer = setTimeout(');
      expect(content).toContain('setIsAtBottom((prev) => (prev !== isAtBottomRef.current ? isAtBottomRef.current : prev));');
      expect(content).toContain('clearTimeout(scrollDebounceTimer);');
    });
  });

  describe('2. TerminalFileManagerView Tab Activation & Auto-Refresh', () => {
    const fileViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx');
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(fileViewPath, 'utf-8');
    });

    test('tracks wasActiveRef and currentPathRef to refresh directory when tab becomes active', () => {
      expect(content).toContain('const wasActiveRef = useRef<boolean>(false);');
      expect(content).toContain('const currentPathRef = useRef<string>(\'\');');
      expect(content).toContain('justBecameActive');
      expect(content).toContain('loadFiles(currentPathRef.current || undefined);');
    });
  });

  describe('3. scrollToBottomSafe Animation Frame Coalescing', () => {
    it('coalesces multiple scrollToBottomSafe calls within the same frame', () => {
      let rafCallCount = 0;
      let lastCallback: (() => void) | null = null;
      (globalThis as any).requestAnimationFrame = (cb: () => void) => {
        rafCallCount++;
        lastCallback = cb;
        return rafCallCount;
      };

      const mockTerm = {
        scrollToBottom: jest.fn(),
        buffer: {
          active: {
            viewportY: 0,
            baseY: 10,
            type: 'normal',
          },
        },
      };

      // Call 5 times rapidly
      scrollToBottomSafe(mockTerm);
      scrollToBottomSafe(mockTerm);
      scrollToBottomSafe(mockTerm);
      scrollToBottomSafe(mockTerm);
      scrollToBottomSafe(mockTerm);

      // Synchronous scrollToBottom called 5 times
      expect(mockTerm.scrollToBottom).toHaveBeenCalledTimes(5);
      // RAF scheduled exactly once (coalesced)
      expect(rafCallCount).toBe(1);

      // Trigger animation frame callback
      if (lastCallback) {
        (lastCallback as () => void)();
      }
      expect(mockTerm.scrollToBottom).toHaveBeenCalledTimes(6);

      // Subsequent call in next frame can schedule a new RAF
      scrollToBottomSafe(mockTerm);
      expect(rafCallCount).toBe(2);
    });

    it('does not throw when term.scrollToBottom throws during disposal', () => {
      const brokenTerm = {
        scrollToBottom: () => {
          throw new Error('Terminal already disposed');
        },
        buffer: { active: { viewportY: 0, baseY: 10, type: 'normal' } },
      };

      expect(() => {
        scrollToBottomSafe(brokenTerm as any);
      }).not.toThrow();
    });
  });

  describe('4. RemoteAgentTerminalSession Buffer Eviction & Backpressure Safety', () => {
    test('slices excess without wiping entire 1MB buffer chunk', () => {
      const session = new RemoteAgentTerminalSession('test-node');
      const max = 1 * 1024 * 1024;

      // Push 0.6MB chunk
      const chunk1Len = Math.floor(0.6 * 1024 * 1024);
      const chunk1 = 'a'.repeat(chunk1Len);
      session.handleData(chunk1);
      expect(session.getHistory().length).toBe(chunk1Len);

      // Push another 0.7MB chunk (total 1.3MB -> excess)
      const chunk2Len = Math.floor(0.7 * 1024 * 1024);
      const chunk2 = 'b'.repeat(chunk2Len);
      session.handleData(chunk2);

      // Should maintain exactly maxBufferSize
      expect(session.getHistory().length).toBe(max);
      // Head should have been trimmed by excess, so still starts with 'a'
      expect(session.getHistory().startsWith('a')).toBe(true);
      expect(session.getHistory().endsWith('b')).toBe(true);
    });

    test('compacts buffer on RIS hardware reset sequence (\\x1bc)', () => {
      const session = new RemoteAgentTerminalSession('test-node');
      session.handleData('lots of historical output...\r\nline2\r\nline3\r\n');
      expect(session.getHistory()).toContain('historical output');

      // Shell issues hardware reset sequence which emits \x1bc followed by new prompt
      session.handleData('reset\r\n\x1bcuser@host:~$ ');
      expect(session.getHistory()).toBe('\x1bcuser@host:~$ ');
    });

    test('drops frame for client socket with high backpressure (>2MB bufferedAmount)', () => {
      const session = new RemoteAgentTerminalSession('test-node');
      const mockWs = {
        readyState: 1,
        bufferedAmount: 3 * 1024 * 1024, // 3MB queued
        send: jest.fn(),
      };

      session.attach(mockWs);
      session.handleData('test stream data');
      session.flush();

      // Send should be skipped due to backpressure
      expect(mockWs.send).not.toHaveBeenCalledWith('test stream data');
    });
  });

  describe('5. RpcDispatcher Immediate Offline Failure', () => {
    test('fails immediately when agent socket is closed/null instead of timing out 30s', async () => {
      const dispatcher = new RpcDispatcher();
      const mockSession = {
        getAgentWs: () => null,
        write: jest.fn(),
      };

      const start = Date.now();
      const res = await dispatcher.executeFileRpc(mockSession, 'offline-node', { action: 'list', path: '/' });
      const elapsed = Date.now() - start;

      expect(res.success).toBe(false);
      expect(res.error).toContain('not connected');
      expect(elapsed).toBeLessThan(100);
      expect(mockSession.write).not.toHaveBeenCalled();
    });
  });

  describe('6. fileRpcHandler Directory Symlink Resolution', () => {
    const testDir = path.resolve(__dirname, '../tests/tmp-symlink-test-' + Date.now());
    const realSubDir = path.join(testDir, 'real-subdir');
    const symlinkDir = path.join(testDir, 'symlink-dir');

    beforeAll(() => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.mkdirSync(realSubDir, { recursive: true });
      try {
        fs.symlinkSync(realSubDir, symlinkDir, 'dir');
      } catch {
        // Fallback for environments where symlink creation is restricted
      }
    });

    afterAll(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    test('identifies directory symlinks as directories using entryStat', async () => {
      const { handleFileRpc } = require('../src/agent/handlers/fileRpcHandler');
      let responsePayload: any = null;
      const mockWs = {
        readyState: 1,
        send: jest.fn((msg: string) => {
          if (msg.startsWith('JSON:')) {
            responsePayload = JSON.parse(msg.slice(5));
          }
        }),
      };

      await handleFileRpc(
        {
          type: 'file_rpc',
          reqId: 'test-symlink-1',
          action: 'list',
          path: testDir,
        },
        mockWs
      );

      expect(responsePayload).not.toBeNull();
      expect(responsePayload.success).toBe(true);
      const files = responsePayload.data.files;
      const foundReal = files.find((f: any) => f.name === 'real-subdir');
      expect(foundReal).toBeDefined();
      expect(foundReal.isDirectory).toBe(true);

      const foundSymlink = files.find((f: any) => f.name === 'symlink-dir');
      if (foundSymlink) {
        expect(foundSymlink.isDirectory).toBe(true);
      }
    });
  });
});
