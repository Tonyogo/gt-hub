# Web Terminal Input Freeze & Unresponsiveness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate web terminal input freezes, swallowed keystrokes, half-open zombie WebSocket sessions, silent backend input drops during agent reconnects, 1MB history replay head-of-line blocking, and accidental `Ctrl+S` (XOFF) terminal output lockups.

**Architecture:** Implement a three-layer closed-loop fix across Frontend Input/IME (`terminalImeHelper.ts`, `WebTerminalView.tsx`), Frontend WebSocket Lifecycle (`apiClient.ts`, `WebTerminalView.tsx`, `useTerminalWebSocket.ts`), and Backend Hub/Agent PTY (`terminalHostManager.ts`, `drivers.ts`, `daemon.ts`). All changes preserve backward compatibility with existing WebSocket protocols and test suites.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Node.js `ws`, Jest (`ts-jest`).

## Global Constraints

- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) rather than full test suites during iterative development.
- Preserve existing module exports (`useTerminalWebSocket`, `useTerminalSelection`, `useTerminalIme`) in `WebTerminalView.tsx`.
- Keep history replay synchronous and single-call when payload is `<= 64KB` so existing unit tests asserting `expect(ws.send).toHaveBeenCalledTimes(1)` continue to pass without modification.
- Ensure `requestAuthTicket` gracefully handles environments where `AbortController` is undefined or `fetch` is mocked with a 1-2 argument stub.

---

### Task 1: Fix IME Repeated-Char Swallowing & Composition Lock in `terminalImeHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalImeHelper.ts`
- Test: `tests/terminalInputFreezeFixes.test.ts`

**Interfaces:**
- Consumes: `TerminalImeOptions { textarea: HTMLTextAreaElement; onDirectInput: (data: string) => void }`
- Produces: `attachMobileImeHandler(options: TerminalImeOptions): TerminalImeController`

- [ ] **Step 1: Create `tests/terminalInputFreezeFixes.test.ts` with failing tests for IME repeated-character input and post-composition physical keystrokes**

```typescript
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts`
Expected: FAIL (`expect(sent).toEqual(['l', 'l'])` receives `['l']` and `expect(controller.isComposing()).toBe(false)` receives `true`).

- [ ] **Step 3: Update `frontend/src/utils/terminalImeHelper.ts` with paired-event deduplication and physical keydown composition unlock**

```typescript
export interface TerminalImeOptions {
  textarea: HTMLTextAreaElement;
  onDirectInput: (data: string) => void;
}

export interface TerminalImeController {
  isComposing: () => boolean;
  dispose: () => void;
}

export function attachMobileImeHandler({
  textarea,
  onDirectInput,
}: TerminalImeOptions): TerminalImeController {
  let isComposing = false;
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledData = '';
  let lastHandledTime = 0;
  let pendingBeforeInputDedupe = false;
  let lastNonImeKeyDownTime = 0;

  const handleKeyDown = (e: KeyboardEvent) => {
    pendingBeforeInputDedupe = false;
    if (e.keyCode !== 229 && e.key !== 'Unidentified') {
      lastNonImeKeyDownTime = Date.now();
      if (compositionEndTimer) {
        clearTimeout(compositionEndTimer);
        compositionEndTimer = null;
        isComposing = false;
      }
    }
  };

  const handleCompositionStart = () => {
    if (compositionEndTimer) {
      clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
    }
    isComposing = true;
  };

  const handleCompositionEnd = () => {
    if (compositionEndTimer) {
      clearTimeout(compositionEndTimer);
    }
    // Delay resetting composing flag by 60ms to allow xterm's native
    // CompositionHelper._finalizeComposition to read and dispatch the selected word,
    // unless a physical keydown arrives earlier.
    compositionEndTimer = setTimeout(() => {
      isComposing = false;
      compositionEndTimer = null;
    }, 60);
  };

  const handleBeforeInput = (e: InputEvent) => {
    if (isComposing) {
      return;
    }

    if (Date.now() - lastNonImeKeyDownTime < 50) {
      return;
    }

    if (e.inputType === 'insertText' && e.data) {
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      lastHandledData = e.data;
      lastHandledTime = Date.now();
      pendingBeforeInputDedupe = true;

      textarea.value = '';
      onDirectInput(e.data);
    }
  };

  const handleInput = (e: Event) => {
    if (isComposing) {
      return;
    }

    if (Date.now() - lastNonImeKeyDownTime < 50) {
      return;
    }

    const inputEv = e as InputEvent;
    if (inputEv.inputType === 'insertText' && inputEv.data) {
      const now = Date.now();
      if (pendingBeforeInputDedupe && inputEv.data === lastHandledData && (now - lastHandledTime) < 60) {
        // Consume the single paired input event corresponding to the preceding beforeinput
        pendingBeforeInputDedupe = false;
        textarea.value = '';
        return;
      }

      pendingBeforeInputDedupe = false;
      lastHandledData = inputEv.data;
      lastHandledTime = now;
      textarea.value = '';
      onDirectInput(inputEv.data);
    }
  };

  textarea.addEventListener('keydown', handleKeyDown as EventListener, { capture: true });
  textarea.addEventListener('compositionstart', handleCompositionStart);
  textarea.addEventListener('compositionend', handleCompositionEnd);
  textarea.addEventListener('beforeinput', handleBeforeInput as EventListener, { capture: true });
  textarea.addEventListener('input', handleInput as EventListener, { capture: true });

  return {
    isComposing: () => isComposing,
    dispose: () => {
      if (compositionEndTimer) {
        clearTimeout(compositionEndTimer);
        compositionEndTimer = null;
      }
      textarea.removeEventListener('keydown', handleKeyDown as EventListener, { capture: true });
      textarea.removeEventListener('compositionstart', handleCompositionStart);
      textarea.removeEventListener('compositionend', handleCompositionEnd);
      textarea.removeEventListener('beforeinput', handleBeforeInput as EventListener, { capture: true });
      textarea.removeEventListener('input', handleInput as EventListener, { capture: true });
    },
  };
}
```

- [ ] **Step 4: Run both new and existing IME tests to verify they pass**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts tests/terminalImeHelper.test.ts`
Expected: PASS

---

### Task 2: Add `AbortController` Timeout to `requestAuthTicket` in `apiClient.ts`

**Files:**
- Modify: `frontend/src/utils/apiClient.ts`
- Test: `tests/terminalInputFreezeFixes.test.ts`

**Interfaces:**
- Produces: `requestAuthTicket(adminKey?: string, timeoutMs?: number): Promise<string | null>`

- [ ] **Step 1: Add failing test for `requestAuthTicket` timeout protection in `tests/terminalInputFreezeFixes.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts`
Expected: FAIL (test times out because `requestAuthTicket` has no abort signal).

- [ ] **Step 3: Implement `AbortController` timeout in `frontend/src/utils/apiClient.ts`**

```typescript
export async function requestAuthTicket(adminKey?: string, timeoutMs: number = 5000): Promise<string | null> {
  const key = adminKey || (typeof window !== 'undefined' ? localStorage.getItem('gt_admin_key') : '') || '';
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, timeoutMs)
    : null;

  try {
    const headers: Record<string, string> = {};
    if (key) {
      headers['x-admin-key'] = key;
    }
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
    };
    if (controller) {
      fetchOptions.signal = controller.signal;
    }
    const res = await fetch('/api/auth/ticket', fetchOptions);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data && data.success && data.ticket) {
      return data.ticket;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify `requestAuthTicket` timeout and existing ticket tests pass**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts tests/frontendTicketAuth.test.ts tests/frontendApiClient.test.ts`
Expected: PASS

---

### Task 3: Hub Agent Disconnect Client Notification, Short Input Buffer & 64KB Chunked History Replay

**Files:**
- Modify: `src/terminal/services/terminalHostManager.ts`
- Test: `tests/terminalInputFreezeFixes.test.ts`

**Interfaces:**
- Produces on `RemoteAgentTerminalSession`:
  - `notifyAgentDisconnected(): void`
  - `sendHistoryChunks(ws: any, sanitized: string): void`
  - `pendingInputBuffer` queue flushing on `updateAgentWs(agentWs)`

- [ ] **Step 1: Add failing tests for Hub disconnect notification, input buffering during brief agent reconnects, and 64KB chunked history replay in `tests/terminalInputFreezeFixes.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `pendingInputBuffer`, `notifyAgentDisconnected`, and `sendHistoryChunks` in `src/terminal/services/terminalHostManager.ts`**

Update `RemoteAgentTerminalSession` and `TerminalHostManager.unregisterAgent` in `src/terminal/services/terminalHostManager.ts`:
- Add `private pendingInputBuffer: string[] = [];`, `private pendingInputBytes: number = 0;`, `private readonly maxPendingInputBytes: number = 4 * 1024;`, and `private static readonly HISTORY_CHUNK_SIZE = 64 * 1024;`.
- In `updateAgentWs(agentWs: any)`: if `agentWs && agentWs.readyState === 1 && this.pendingInputBuffer.length > 0`, flush all queued inputs to `agentWs.send(...)` and clear `pendingInputBuffer` / `pendingInputBytes`.
- In `write(data: string)`: if `this.agentWs && this.agentWs.readyState === 1`, send immediately; otherwise append `data` to `pendingInputBuffer` (capping at `maxPendingInputBytes` by shifting oldest entries).
- Add `private sendHistoryChunks(ws: any, sanitized: string): void`: if `sanitized.length <= RemoteAgentTerminalSession.HISTORY_CHUNK_SIZE`, call `ws.send(sanitized)` once; otherwise slice into `64 * 1024` chunks and call `ws.send(chunk)` for each. Use `this.sendHistoryChunks(ws, sanitized)` in both `attach()` and `handleHistorySync()`.
- Add `public notifyAgentDisconnected(): void` on `RemoteAgentTerminalSession` which sends `JSON:${JSON.stringify({ type: 'agent_offline', hostId: this.hostId })}` and calls `ws.close?.(1012, 'Agent disconnected')` for each open socket in `this.activeSockets`, then clears `this.activeSockets`.
- Call `session.notifyAgentDisconnected()` inside `unregisterAgent()` when the active agent socket disconnects.
- Clear `pendingInputBuffer` and `pendingInputBytes` inside `reset()` and `destroy()`.

- [ ] **Step 4: Run tests to verify new and existing `terminalHostManager` tests pass**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts tests/terminalHostManager.test.ts tests/terminalAgentOfflineRaceFix.test.ts tests/terminalReconnectDuplicateFix.test.ts tests/terminalPersistence.test.ts tests/terminalAgentHistorySync.test.ts`
Expected: PASS

---

### Task 4: Frontend WebSocket Connection Sequence Guard, Pong Timeout Detection, Redundant Hook Removal & Focus Restoration

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`
- Test: `tests/terminalInputFreezeFixes.test.ts`

**Interfaces:**
- Preserves `WebTerminalViewProps` and `WebTerminalHandle`
- Adds `connectSeqRef` and `lastPongTimeRef` in `WebTerminalView.tsx` and `useTerminalWebSocket.ts`

- [ ] **Step 1: Add failing tests for `WebTerminalView.tsx` connection sequence token, pong timeout check, redundant hook removal, and copy focus restoration in `tests/terminalInputFreezeFixes.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `frontend/src/components/WebTerminalView.tsx` and `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`**

In `frontend/src/components/WebTerminalView.tsx`:
1. Add `const connectSeqRef = useRef<number>(0);` and `const lastPongTimeRef = useRef<number>(Date.now());`.
2. In `initWebSocket`:
   - Increment `const currentSeq = ++connectSeqRef.current;` at the top of `initWebSocket`.
   - Inside the async IIFE after `const ticket = adminKey ? await requestAuthTicket(adminKey) : null;`, check `if (!isMountedRef.current || currentSeq !== connectSeqRef.current) return;`.
   - In `ws.onopen`: set `lastPongTimeRef.current = Date.now();`. Inside the 15s `pingIntervalRef` callback, check:
     ```ts
     if (Date.now() - lastPongTimeRef.current > 35000) {
       console.warn('[WebTerminal] Heartbeat pong timeout (>35s), closing stale WebSocket');
       clearPingInterval();
       try {
         wsRef.current.close(4000, 'Heartbeat pong timeout');
       } catch {}
       triggerReconnect();
       return;
     }
     ```
   - In `ws.onmessage`: set `lastPongTimeRef.current = Date.now();` at the top. Also handle `if (parsed.type === 'agent_offline') { try { ws.close(1012, 'Agent disconnected'); } catch {} return; }`.
3. In the main `useEffect` (xterm initialization):
   - Add `visibilitychange` and `online` listeners so that when the page becomes visible or browser comes back online, if `activeHostIdRef.current` is set and `!wsRef.current || wsRef.current.readyState > WebSocket.OPEN`, it resets `reconnectAttemptRef.current = 0` and calls `initWebSocket()`; or if `wsRef.current.readyState === WebSocket.OPEN`, it sends a `ping` immediately.
   - In the unmount cleanup of the main `useEffect`, increment `connectSeqRef.current += 1;` and remove the `visibilitychange` and `online` listeners.
4. In `handleMouseUp` and `handleCopySelection` fallback `textarea` copy blocks: after `document.body.removeChild(textarea);`, call `xtermRef.current?.focus();`.
5. Remove the redundant `useTerminalSelection({ ... });` and `useTerminalIme({ ... });` calls at lines 2142–2158 while keeping their exports at the bottom of the file.
6. Apply the same `connectSeqRef` and `lastPongTimeRef` enhancements to `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts tests/terminalModularHooks.test.ts tests/terminalSluggishnessAndFileLoadFixes.test.ts tests/terminalReconnectDuplicateFix.test.ts`
Expected: PASS

---

### Task 5: Disable PTY `IXON` Software Flow Control Lockup in `drivers.ts` and `daemon.ts`

**Files:**
- Modify: `src/agent/pty/drivers.ts`
- Modify: `src/agent/daemon.ts`
- Test: `tests/terminalInputFreezeFixes.test.ts`

**Interfaces:**
- Disables `IXON` software flow control on spawned PTYs so pressing `Ctrl+S` (`\x13`) never freezes terminal output.

- [ ] **Step 1: Add failing test verifying `IXON` is disabled in `PosixPtyDriver` and `daemon.ts` in `tests/terminalInputFreezeFixes.test.ts`**

```typescript
  describe('5. Agent PTY IXON Flow Control Lockup Prevention', () => {
    const fs = require('fs');
    const path = require('path');

    test('PosixPtyDriver disables termios.IXON on slave PTY fd to prevent Ctrl+S output freeze', () => {
      const driversPath = path.resolve(__dirname, '../src/agent/pty/drivers.ts');
      const content = fs.readFileSync(driversPath, 'utf-8');
      expect(content).toContain('~termios.IXON');
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/agent/pty/drivers.ts` to disable `termios.IXON` on the PTY slave descriptor**

In `src/agent/pty/drivers.ts` inside `PosixPtyDriver`'s `pyScript` right after `master, slave = pty.openpty()`:
```python
master, slave = pty.openpty()
try:
    attrs = termios.tcgetattr(slave)
    attrs[0] &= ~termios.IXON
    termios.tcsetattr(slave, termios.TCSANOW, attrs)
except:
    pass
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except:
    pass
```

- [ ] **Step 4: Run tests to verify PTY fallback and new tests pass**

Run: `npm test -- tests/terminalInputFreezeFixes.test.ts tests/gtAgentPtyFallback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit all changes**

```bash
git add docs/superpowers/plans/2026-10-19-terminal-input-freeze-fix.md \
        frontend/src/utils/terminalImeHelper.ts \
        frontend/src/utils/apiClient.ts \
        frontend/src/components/WebTerminalView.tsx \
        frontend/src/components/terminal/hooks/useTerminalWebSocket.ts \
        src/terminal/services/terminalHostManager.ts \
        src/agent/pty/drivers.ts \
        tests/terminalInputFreezeFixes.test.ts
git commit -m "fix(terminal): resolve input freeze, IME char drop, half-open ws, and IXON lockup"
```
