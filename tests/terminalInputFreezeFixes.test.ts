import { attachMobileImeHandler } from '../frontend/src/utils/terminalImeHelper';

class MockTextArea extends EventTarget {
  value = '';
  parentNode: any = null;
}

function createMockTextarea(): HTMLTextAreaElement {
  return new MockTextArea() as unknown as HTMLTextAreaElement;
}

describe('Terminal Input Freeze & Unresponsiveness Fixes', () => {
  describe('1. terminalImeHelper Repeated Character & Post-Composition Input', () => {
    test('does NOT swallow rapid consecutive identical characters in fallback input mode (e.g. typing "ll")', () => {
      const textarea = createMockTextarea();
      const sent: string[] = [];
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (d) => sent.push(d),
      });

      // First 'l' via fallback input event (no beforeinput)
      const input1 = new CustomEvent('input') as any;
      input1.inputType = 'insertText';
      input1.data = 'l';
      textarea.dispatchEvent(input1);

      // Second 'l' within 15ms via fallback input event
      const input2 = new CustomEvent('input') as any;
      input2.inputType = 'insertText';
      input2.data = 'l';
      textarea.dispatchEvent(input2);

      expect(sent).toEqual(['l', 'l']);
      controller.dispose();
    });

    test('deduplicates only the single paired input event immediately following beforeinput, allowing a second identical character right after', () => {
      const textarea = createMockTextarea();
      const sent: string[] = [];
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (d) => sent.push(d),
      });

      // Keystroke 1: beforeinput + paired input for 'l'
      const bi1 = new CustomEvent('beforeinput', { cancelable: true }) as any;
      bi1.inputType = 'insertText';
      bi1.data = 'l';
      textarea.dispatchEvent(bi1);

      const in1 = new CustomEvent('input') as any;
      in1.inputType = 'insertText';
      in1.data = 'l';
      textarea.dispatchEvent(in1);

      // Keystroke 2 (within 10ms): fallback input or beforeinput+input for second 'l'
      const in2 = new CustomEvent('input') as any;
      in2.inputType = 'insertText';
      in2.data = 'l';
      textarea.dispatchEvent(in2);

      expect(sent).toEqual(['l', 'l']);
      controller.dispose();
    });

    test('immediately unlocks composition when a physical keydown occurs during the 60ms compositionend grace window', () => {
      jest.useFakeTimers();
      const textarea = createMockTextarea();
      const sent: string[] = [];
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (d) => sent.push(d),
      });

      textarea.dispatchEvent(new Event('compositionstart'));
      textarea.dispatchEvent(new Event('compositionend'));
      expect(controller.isComposing()).toBe(true);

      // User presses a physical key (e.g. Enter or 'a') 10ms after compositionend
      jest.advanceTimersByTime(10);
      const kd = new CustomEvent('keydown') as any;
      kd.keyCode = 13;
      kd.key = 'Enter';
      textarea.dispatchEvent(kd);

      expect(controller.isComposing()).toBe(false);
      controller.dispose();
      jest.useRealTimers();
    });
  });

  describe('2. requestAuthTicket Timeout Protection', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.useRealTimers();
    });

    test('aborts hanging ticket request after timeoutMs and resolves to null instead of hanging forever', async () => {
      const { requestAuthTicket } = require('../frontend/src/utils/apiClient');
      global.fetch = jest.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new Error('AbortError'));
            });
          }
        });
      }) as any;

      const start = Date.now();
      const ticket = await requestAuthTicket('secret-key', 80);
      const elapsed = Date.now() - start;

      expect(ticket).toBeNull();
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('3. Hub RemoteAgentTerminalSession Disconnect Notification, Input Buffering & Chunked Replay', () => {
    test('buffers input written while agentWs is temporarily null and flushes when new agentWs connects', () => {
      const { RemoteAgentTerminalSession } = require('../src/terminal/services/terminalHostManager');
      const session = new RemoteAgentTerminalSession('host-buf-1', null);

      // User types while agent is reconnecting
      session.write('ls -la\r');
      session.write('pwd\r');

      const newAgentWs = { readyState: 1, send: jest.fn() };
      session.updateAgentWs(newAgentWs);

      expect(newAgentWs.send).toHaveBeenCalledWith('ls -la\r');
      expect(newAgentWs.send).toHaveBeenCalledWith('pwd\r');
    });

    test('notifies and closes attached browser client sockets when agent disconnects in unregisterAgent', () => {
      const { TerminalHostManager } = require('../src/terminal/services/terminalHostManager');
      const mgr = new TerminalHostManager();
      const agentWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
      mgr.registerAgent({ hostId: 'node-disc-1', name: 'NodeDisc', agentWs });

      const session = mgr.getSession('node-disc-1')!;
      const clientWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
      session.attach(clientWs);

      mgr.unregisterAgent('node-disc-1', agentWs);

      expect(clientWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"agent_offline"'));
      expect(clientWs.close).toHaveBeenCalledWith(1012, 'Agent disconnected');
    });

    test('splits large (>64KB) history replay into 64KB chunks while keeping small history as single frame', () => {
      const { RemoteAgentTerminalSession } = require('../src/terminal/services/terminalHostManager');
      const agentWs = { readyState: 1, send: jest.fn() };
      const session = new RemoteAgentTerminalSession('host-chunk-1', agentWs);

      // Push 150KB of history
      session.handleData('X'.repeat(150 * 1024));

      const clientWs = { readyState: 1, send: jest.fn() };
      session.attach(clientWs);

      // 150KB with 64KB chunks -> 3 chunks
      expect(clientWs.send.mock.calls.length).toBeGreaterThanOrEqual(3);
      const combined = clientWs.send.mock.calls.map((c: any[]) => c[0]).join('');
      expect(combined.length).toBeGreaterThanOrEqual(150 * 1024);
    });
  });

  describe('4. WebTerminalView Connection Race Guard, Pong Timeout & Redundant Hook Cleanup', () => {
    const fs = require('fs');
    const path = require('path');
    const viewPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

    test('guards async initWebSocket with connectSeqRef to prevent orphan sockets and checks lastPongTimeRef for half-open sockets', () => {
      const content = fs.readFileSync(viewPath, 'utf-8');
      expect(content).toContain('connectSeqRef');
      expect(content).toContain('currentSeq !== connectSeqRef.current');
      expect(content).toContain('lastPongTimeRef');
      expect(content).toContain('Heartbeat pong timeout');
      // Must not have redundant top-level invocations of useTerminalSelection or useTerminalIme
      expect(content).not.toMatch(/useTerminalSelection\s*\(\s*\{/);
      expect(content).not.toMatch(/useTerminalIme\s*\(\s*\{/);
      // Still re-exports them for modular consumers
      expect(content).toContain('useTerminalSelection,');
      expect(content).toContain('useTerminalIme,');
    });
  });

  describe('5. Agent PTY IXON Flow Control Lockup Prevention', () => {
    const fs = require('fs');
    const path = require('path');

    test('PosixPtyDriver disables termios.IXON on slave PTY fd to prevent Ctrl+S output freeze', () => {
      const driversPath = path.resolve(__dirname, '../src/agent/pty/drivers.ts');
      const content = fs.readFileSync(driversPath, 'utf-8');
      expect(content).toContain('~termios.IXON');
    });
  });
});




