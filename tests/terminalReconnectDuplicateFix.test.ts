import fs from 'fs';
import path from 'path';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('Terminal Reconnect Duplicate Information Fix Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let webTerminalContent: string;

  beforeAll(() => {
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  describe('Frontend WebTerminalView Reconnect Logic', () => {
    test('resets and clears xterm buffer on ws.onopen to prevent duplicate history replay', () => {
      const onOpenStart = webTerminalContent.indexOf('ws.onopen = () => {');
      const onOpenEnd = webTerminalContent.indexOf('ws.onmessage =', onOpenStart);
      const onOpenBlock = webTerminalContent.slice(onOpenStart, onOpenEnd);

      expect(onOpenBlock).toContain('xtermRef.current.clear()');
      expect(onOpenBlock).toContain('xtermRef.current.reset()');
    });

    test('unbinds event listeners on old WebSocket before closing in initWebSocket', () => {
      const initStart = webTerminalContent.indexOf('const initWebSocket = useCallback(() => {');
      const initEnd = webTerminalContent.indexOf('const ws = new WebSocket(wsUrl);', initStart);
      const initBlock = webTerminalContent.slice(initStart, initEnd);

      expect(initBlock).toContain('oldWs.onopen = null');
      expect(initBlock).toContain('oldWs.onmessage = null');
      expect(initBlock).toContain('oldWs.onerror = null');
      expect(initBlock).toContain('oldWs.onclose = null');
      expect(initBlock).toContain('oldWs.close()');
    });

    test('unbinds event listeners on old WebSocket before closing in unmount cleanup', () => {
      const unmountStart = webTerminalContent.indexOf('if (wsRef.current) {');
      const unmountEnd = webTerminalContent.indexOf('term.dispose();', unmountStart);
      const unmountBlock = webTerminalContent.slice(unmountStart, unmountEnd);

      expect(unmountBlock).toContain('oldWs.onopen = null');
      expect(unmountBlock).toContain('oldWs.onmessage = null');
      expect(unmountBlock).toContain('oldWs.onerror = null');
      expect(unmountBlock).toContain('oldWs.onclose = null');
      expect(unmountBlock).toContain('oldWs.close()');
    });

    test('ws.onerror does not trigger redundant triggerReconnect to avoid duplicate timers', () => {
      const onErrorStart = webTerminalContent.indexOf('ws.onerror =');
      const onErrorEnd = webTerminalContent.indexOf('}, [adminKey,', onErrorStart);
      const onErrorBlock = webTerminalContent.slice(onErrorStart, onErrorEnd);

      expect(onErrorBlock).not.toContain('triggerReconnect()');
    });

    test('executeReset performs both clear and reset on xtermRef', () => {
      const resetStart = webTerminalContent.indexOf('const executeReset = useCallback(() => {');
      const resetEnd = webTerminalContent.indexOf('const handleResetSession =', resetStart);
      const resetBlock = webTerminalContent.slice(resetStart, resetEnd);

      expect(resetBlock).toContain('xtermRef.current?.clear()');
      expect(resetBlock).toContain('xtermRef.current?.reset()');
    });
  });

  describe('Backend RemoteAgentTerminalSession Resize Deduplication', () => {
    test('deduplicates resize calls with identical dimensions to prevent duplicate SIGWINCH prompts', () => {
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('test-dedup-host', mockAgentWs);

      // First resize should be forwarded to agent PTY
      session.resize(100, 30);
      expect(mockAgentWs.send).toHaveBeenCalledTimes(1);
      expect(mockAgentWs.send).toHaveBeenCalledWith('JSON:{"type":"resize","cols":100,"rows":30}');

      // Subsequent identical resize must be suppressed
      session.resize(100, 30);
      expect(mockAgentWs.send).toHaveBeenCalledTimes(1);

      // Different dimensions must be forwarded
      session.resize(120, 35);
      expect(mockAgentWs.send).toHaveBeenCalledTimes(2);
      expect(mockAgentWs.send).toHaveBeenLastCalledWith('JSON:{"type":"resize","cols":120,"rows":35}');

      // Subsequent identical resize of 120x35 must be suppressed
      session.resize(120, 35);
      expect(mockAgentWs.send).toHaveBeenCalledTimes(2);
    });

    test('resets cached dimensions when agent socket is updated or session reset occurs', () => {
      const mockAgentWs1 = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('test-cache-reset-host', mockAgentWs1);

      session.resize(100, 30);
      expect(mockAgentWs1.send).toHaveBeenCalledTimes(1);

      // Update agent WS (reconnected agent process)
      const mockAgentWs2 = { readyState: 1, send: jest.fn() };
      session.updateAgentWs(mockAgentWs2);

      // Calling resize with 100, 30 should now send to new agent because dimensions were reset
      session.resize(100, 30);
      expect(mockAgentWs2.send).toHaveBeenCalledTimes(1);
      expect(mockAgentWs2.send).toHaveBeenCalledWith('JSON:{"type":"resize","cols":100,"rows":30}');

      // Calling session.reset() should also clear dimensions
      session.reset(false, false);
      session.resize(100, 30);
      expect(mockAgentWs2.send).toHaveBeenCalledTimes(2);
    });

    test('prunes stale or terminating client sockets during attach and handleData', () => {
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('test-stale-socket-host', mockAgentWs);

      const staleSocket = { readyState: 3, send: jest.fn() }; // CLOSED
      const activeSocket1 = { readyState: 1, send: jest.fn() };
      const activeSocket2 = { readyState: 1, send: jest.fn() };

      // Manually attach sockets
      session.attach(staleSocket as any);
      session.attach(activeSocket1 as any);

      // Attaching activeSocket2 should prune staleSocket (readyState === 3)
      session.attach(activeSocket2 as any);

      // Send data
      session.handleData('TEST_DATA_STREAM\r\n');

      expect(activeSocket1.send).toHaveBeenCalledWith('TEST_DATA_STREAM\r\n');
      expect(activeSocket2.send).toHaveBeenCalledWith('TEST_DATA_STREAM\r\n');
      expect(staleSocket.send).not.toHaveBeenCalled();
    });

    test('replays history buffer atomically to newly attached client without duplication', () => {
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('test-replay-atomic', mockAgentWs);

      session.handleData('line 1\r\n');
      session.handleData('line 2\r\n');

      const replayedMessages: string[] = [];
      const newClient = {
        readyState: 1,
        send: (data: string) => replayedMessages.push(data),
      };

      session.attach(newClient as any);

      // History is sent as a single combined stream
      expect(replayedMessages.length).toBe(1);
      expect(replayedMessages[0]).toContain('line 1\r\nline 2\r\n');
    });

    test('ignores non-positive dimensions in resize to avoid corrupting session state', () => {
      const mockAgentWs = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('test-resize-invalid', mockAgentWs);

      session.resize(0, 30);
      session.resize(-10, 30);
      session.resize(80, 0);
      session.resize(80, -5);

      expect(mockAgentWs.send).not.toHaveBeenCalled();
      expect(session.getCurrentDimensions()).toEqual({ cols: 0, rows: 0 });
    });
  });

  describe('Direct XTerm Buffer Behavioral Verification', () => {
    test('xterm buffer before and after reconnect with clear+reset renders pristine state without duplicate output', (done) => {
      const { Terminal } = require('../frontend/node_modules/@xterm/xterm');
      const term = new Terminal({ cols: 80, rows: 24 });
      const prompt = 'user@box:~$ ';
      const command = 'echo hello\r\nhello\r\n';

      // Initial session data before disconnect
      term.write(prompt + command + prompt, () => {
        const lineBefore0 = term.buffer.active.getLine(0)?.translateToString().trim();
        const lineBefore1 = term.buffer.active.getLine(1)?.translateToString().trim();
        const lineBefore2 = term.buffer.active.getLine(2)?.translateToString().trim();
        expect(lineBefore0).toBe('user@box:~$ echo hello');
        expect(lineBefore1).toBe('hello');
        expect(lineBefore2).toBe('user@box:~$');

        // On reconnect: frontend calls clear() and reset()
        term.clear();
        term.reset();

        // History replay is written to the reset terminal
        const replayedHistory = prompt + command + prompt;
        term.write(replayedHistory, () => {
          const lineAfter0 = term.buffer.active.getLine(0)?.translateToString().trim();
          const lineAfter1 = term.buffer.active.getLine(1)?.translateToString().trim();
          const lineAfter2 = term.buffer.active.getLine(2)?.translateToString().trim();
          const lineAfter3 = term.buffer.active.getLine(3)?.translateToString().trim();

          // Exactly identical to original state, no duplicate prompts or lines
          expect(lineAfter0).toBe('user@box:~$ echo hello');
          expect(lineAfter1).toBe('hello');
          expect(lineAfter2).toBe('user@box:~$');
          expect(lineAfter3).toBe('');
          done();
        });
      });
    });

    test('without clear+reset, reconnect causes duplicate output lines in xterm buffer', (done) => {
      const { Terminal } = require('../frontend/node_modules/@xterm/xterm');
      const term = new Terminal({ cols: 80, rows: 24 });
      const prompt = 'user@box:~$ ';
      const command = 'echo hello\r\nhello\r\n';

      term.write(prompt + command + prompt, () => {
        // Old buggy behavior: reconnect WITHOUT clear or reset
        const replayedHistory = prompt + command + prompt;
        term.write(replayedHistory, () => {
          const line0 = term.buffer.active.getLine(0)?.translateToString().trim();
          const line1 = term.buffer.active.getLine(1)?.translateToString().trim();
          const line2 = term.buffer.active.getLine(2)?.translateToString().trim();
          const line3 = term.buffer.active.getLine(3)?.translateToString().trim();
          const line4 = term.buffer.active.getLine(4)?.translateToString().trim();

          // Demonstrates duplication: prompt and output repeated
          expect(line0).toBe('user@box:~$ echo hello');
          expect(line1).toBe('hello');
          expect(line2).toContain('user@box:~$');
          expect(line3).toBe('hello');
          expect(line4).toBe('user@box:~$');
          done();
        });
      });
    });
  });
});

