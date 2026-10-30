# Prevent Post-Exit Scroll & Mouse Escape Leakage After Claude Code Exits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate garbage escape sequences (`^[[<64;1;1M`, `^[[<65;1;1M`, `^[[<35;...M`, `^[[5~`, `^[[6~`) leaking into the normal shell prompt during and after exiting Claude Code or other TUI applications.

**Architecture:** We enforce a strict environment boundary between full-screen TUI mode (`alternate` buffer with active remote session) and normal shell mode (`normal` buffer):
1. **Outbound Shell Filter (`terminalFilter.ts`):** Extend `isUnsolicitedShellDeviceReport` to match SGR mouse reports (`\x1b[<\d+;\d+;\d+[Mm]`), X10/VT200 mouse reports (`\x1b[M[\s\S]{3}`), and focus in/out reports (`\x1b\[[IO]`) so `term.onData` blocks any residual mouse/focus sequences whenever `term.buffer.active.type !== 'alternate'`. Also add a stream-level tracker `updateRemoteTuiModeFromStream(prevActive, chunk)` that detects `\x1b[?1049h`/`\x1b[?1047h`/`\x1b[?47h` vs `\x1b[?1049l`/`\x1b[?1047l`/`\x1b[?47l` immediately when WebSocket frames arrive (before `TerminalWriteScheduler` asynchronous flush delay).
2. **Wheel, Touch & Buffer Transition Guard (`WebTerminalView.tsx`):** Gate `stepAlternateScreenScroll` dispatch in `attachCustomWheelEventHandler` and `applyScrollDelta` on BOTH `term.buffer.active.type === 'alternate'` AND `isRemoteAltScreenRef.current === true` (immediately cleared on receiving `\x1b[?1049l`). When in `normal` buffer mode, if `term.modes?.mouseTrackingMode !== 'none'`, reset stale mouse tracking on the xterm instance (`term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l')` or `(term as any)._core?.coreMouseService?.reset?.()`) and handle the wheel event purely as local viewport scroll (`term.scrollLines(...)`) without sending anything over WebSocket. Also subscribe to `term.buffer.onBufferChange` to reset `altScrollState` and cancel any pending touch scroll on switching back to `normal` buffer.
3. **Replay Sanitizer (`terminalSanitizer.ts`):** Prepend mouse tracking & focus mode resets (`\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l`) to `stripTerminalQuerySequences` when the replayed history is not in alternate screen mode, ensuring reconnecting clients never inherit orphaned mouse tracking from historical chunks.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** In-chat root-cause analysis and environment isolation design (2026-10-30).

## Global Constraints

- Preserve all existing unit and integration tests in `tests/terminalSyntheticEchoProtection.test.ts`, `tests/terminalClaudeScrollback.test.ts`, `tests/terminalScrollHelper.test.ts`, and `tests/terminalPerformanceOptimization.test.ts`.
- Normal shell commands, arrow keys (`\x1b[A`, `\x1b[B`), and interactive TUI mouse clicks/wheel while inside an active `alternate` screen (`\x1b[?1049h`) must continue to work without interference.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during iterative development.

## Review Focus

1. **Trackpad Inertia / Wheel Events Arriving While `\x1b[?1049l` Is Queued in `TerminalWriteScheduler`:** As soon as the WebSocket receives a frame containing `\x1b[?1049l` (even if held 8–24ms in `TerminalWriteScheduler` before `term.write` updates `term.buffer.active.type`), `isRemoteAltScreenRef.current` becomes `false` immediately and blocks any wheel/touch scroll sequence from being sent to the shell.
2. **Orphaned `mouseTrackingMode` in Normal Buffer After TUI Exit/Kill:** If `term.buffer.active.type === 'normal'` but `term.modes.mouseTrackingMode !== 'none'`, moving the mouse, clicking, or scrolling the wheel must NOT send `\x1b[<64;...M` or `\x1b[<35;...M` to the backend; `isUnsolicitedShellDeviceReport` blocks it in `term.onData`, and `attachCustomWheelEventHandler` resets `coreMouseService` and scrolls the local viewport instead.
3. **Concatenated SGR Mouse Burst in `term.onData`:** Multiple concatenated SGR mouse sequences (e.g. `\x1b[<64;45;12M\x1b[<64;45;12M\x1b[<35;45;12M`) emitted in a single `onData` callback while in normal buffer must be matched and blocked completely by `isUnsolicitedShellDeviceReport`.
4. **Buffer Switch (`alternate` -> `normal`) State Cleanup:** Switching from `alternate` to `normal` buffer must zero out `altScrollState` (`accumulatedPx = 0`) and cancel any pending touch scroll frame so leftover scroll delta never carries over.
5. **Replaying History Containing Unclosed `\x1b[?1000h\x1b[?1006h`:** `stripTerminalQuerySequences` must preserve `\x1b[0m\x1b[?25h` at the start (matching existing test `output.startsWith('\x1b[0m\x1b[?25h')`) and strip or neutralize unclosed mouse-enable sequences when replaying normal buffer history.

---

### Task 1: Extend `terminalFilter.ts` with Normal-Shell Mouse/Focus Blocking and Real-Time Alt-Screen Stream Tracking

**Files:**
- Modify: `frontend/src/utils/terminalFilter.ts`
- Test: `tests/terminalSyntheticEchoProtection.test.ts`

**Interfaces:**
- Produces in `frontend/src/utils/terminalFilter.ts`:
  ```ts
  export function isSyntheticTerminalReport(data: string): boolean;
  export function isUnsolicitedShellDeviceReport(data: string): boolean;
  export function updateRemoteAltScreenState(prevInAltScreen: boolean, chunk: string): boolean;
  ```

- [x] **Step 1: Write the failing unit tests in `tests/terminalSyntheticEchoProtection.test.ts`**

Add tests in `tests/terminalSyntheticEchoProtection.test.ts`:
```ts
  describe('Normal Shell Mouse & Focus Leakage Protection', () => {
    it('blocks SGR mouse wheel and movement reports in normal shell via isUnsolicitedShellDeviceReport', () => {
      expect(isUnsolicitedShellDeviceReport('\x1b[<64;1;1M')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[<65;40;15M')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[<0;22;10M\x1b[<0;22;10m')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[<35;80;24M')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[<64;1;1M\x1b[<64;1;1M')).toBe(true);
    });

    it('blocks legacy X10/VT200 mouse reports and focus reports in normal shell', () => {
      expect(isUnsolicitedShellDeviceReport('\x1b[M !#')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[I')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[O')).toBe(true);
    });

    it('tracks remote alternate screen entry and exit in real time via updateRemoteAltScreenState', () => {
      const { updateRemoteAltScreenState } = require('../frontend/src/utils/terminalFilter');
      let state = false;
      state = updateRemoteAltScreenState(state, 'normal shell output\r\n');
      expect(state).toBe(false);

      state = updateRemoteAltScreenState(state, '\x1b[?1049h\x1b[?1000h\x1b[?1006hClaude TUI');
      expect(state).toBe(true);

      state = updateRemoteAltScreenState(state, 'still in TUI frame');
      expect(state).toBe(true);

      state = updateRemoteAltScreenState(state, 'exiting\x1b[?1049l\x1b[?1000luser@host:~$ ');
      expect(state).toBe(false);
    });
  });
```

- [x] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/terminalSyntheticEchoProtection.test.ts`
Expected: FAIL (`isUnsolicitedShellDeviceReport('\x1b[<64;1;1M')` returns `false`, `updateRemoteAltScreenState` is not defined).

- [x] **Step 3: Implement mouse/focus filtering and `updateRemoteAltScreenState` in `frontend/src/utils/terminalFilter.ts`**

1. In `isUnsolicitedShellDeviceReport(data: string): boolean`:
   Extend the regex to also strip:
   - SGR mouse sequences: `\x1b\[<\d+;\d+;\d+[Mm]`
   - Legacy X10/VT200 mouse sequences: `\x1b\[M[\s\S]{3}`
   - Focus in/out reports: `\x1b\[[IO]`
   ```ts
   export function isUnsolicitedShellDeviceReport(data: string): boolean {
     if (!data || typeof data !== 'string') {
       return false;
     }
     const stripped = data.replace(
       /\x1b(?:\[[>?=]\d+(?:;\d+)*c|\](?:4|10|11|12);[^\x1b\x07]+(?:\x1b\\|\x07)|\[\??\d+(?:;\d+)*\$y|\[<\d+;\d+;\d+[Mm]|\[M[\s\S]{3}|\[[IO])/g,
       ''
     );
     return stripped.length === 0;
   }
   ```
2. Implement `updateRemoteAltScreenState(prevInAltScreen: boolean, chunk: string): boolean`:
   - If `!chunk || !chunk.includes('\x1b[?')`, return `prevInAltScreen`.
   - Find the last match of `/\x1b\[\?(?:1049|1047|47)([hl])/g` in `chunk`.
   - If a match is found, return `lastMatch[1] === 'h'`.
   - Otherwise return `prevInAltScreen`.

- [x] **Step 4: Run targeted test to verify it passes**

Run: `npm test -- tests/terminalSyntheticEchoProtection.test.ts`
Expected: PASS.

---

### Task 2: Gate Alternate-Screen Scroll Dispatch & Reset Orphaned Mouse Tracking in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Test: `tests/terminalClaudeScrollback.test.ts`

**Interfaces:**
- Consumes: `updateRemoteAltScreenState`, `isUnsolicitedShellDeviceReport` from `../utils/terminalFilter`
- Modifies `WebTerminalView.tsx`:
  1. Add `const isRemoteAltScreenRef = useRef<boolean>(false);`.
  2. Reset `isRemoteAltScreenRef.current = false` on `ws.onopen`, `reset` control message, and `executeReset`.
  3. In `ws.onmessage`, whenever a string or decoded `ArrayBuffer` text chunk arrives, immediately update `isRemoteAltScreenRef.current = updateRemoteAltScreenState(isRemoteAltScreenRef.current, textChunk)` BEFORE pushing to `writeSchedulerRef.current`.
  4. In `term.attachCustomWheelEventHandler`:
     - Check `if (term.buffer.active.type === 'alternate' && isRemoteAltScreenRef.current)` before running `stepAlternateScreenScroll`.
     - In the `else` branch (when in `normal` buffer or after `\x1b[?1049l` has arrived):
       - Reset `altScrollState = { accumulatedPx: 0, lastEventTimeMs: 0, lastDispatchTimeMs: 0 };`.
       - If `term.buffer.active.type !== 'alternate' && term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'`, reset orphaned mouse tracking on xterm via `(term as any)._core?.coreMouseService?.reset?.()` so xterm does not convert wheel/mouse movement into escape sequences in the normal shell.
       - Return `true` only when `term.buffer.active.type !== 'alternate'`, and return `false` if `term.buffer.active.type === 'alternate'` while `!isRemoteAltScreenRef.current` (during the 8–24ms exit transition window so xterm's built-in wheel handler doesn't fire arrow/mouse keys either).
  5. In `applyScrollDelta(deltaPx: number)`:
     - Check `if (term.buffer?.active?.type === 'alternate')`:
       - If `!isRemoteAltScreenRef.current`, reset `altScrollState` and `return true` (do not send any scroll sequences during the exit transition window).
  6. Register `const bufferChangeDisposable = term.buffer.onBufferChange((buf) => { ... })`:
     - When `buf.type !== 'alternate'`, reset `altScrollState = { accumulatedPx: 0, lastEventTimeMs: 0, lastDispatchTimeMs: 0 }`, call `stopMomentumScroll()`, and if `term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none'`, call `(term as any)._core?.coreMouseService?.reset?.()`.
     - Dispose `bufferChangeDisposable` in the `useEffect` cleanup.

- [x] **Step 1: Write the failing unit tests in `tests/terminalClaudeScrollback.test.ts`**

Add tests in `tests/terminalClaudeScrollback.test.ts`:
```ts
  it('WebTerminalView tracks real-time alt-screen state via updateRemoteAltScreenState and gates wheel/touch scroll on isRemoteAltScreenRef', () => {
    expect(webTerminalContent).toContain('updateRemoteAltScreenState');
    expect(webTerminalContent).toContain('isRemoteAltScreenRef.current');
    const wheelHandlerIdx = webTerminalContent.indexOf('term.attachCustomWheelEventHandler');
    const wheelHandlerBlock = webTerminalContent.slice(wheelHandlerIdx, wheelHandlerIdx + 1200);
    expect(wheelHandlerBlock).toContain('isRemoteAltScreenRef.current');
    expect(wheelHandlerBlock).toContain('coreMouseService?.reset');
  });

  it('WebTerminalView resets altScrollState and orphaned mouse tracking on buffer change to normal', () => {
    expect(webTerminalContent).toContain('term.buffer.onBufferChange');
    expect(webTerminalContent).toContain('bufferChangeDisposable.dispose()');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalClaudeScrollback.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the real-time alt-screen gate and buffer transition cleanup in `frontend/src/components/WebTerminalView.tsx`**

1. Import `updateRemoteAltScreenState` from `../utils/terminalFilter`.
2. Add `const isRemoteAltScreenRef = useRef<boolean>(false);`.
3. Reset `isRemoteAltScreenRef.current = false;` in `ws.onopen`, `parsed.type === 'reset'`, and `executeReset`.
4. In `ws.onmessage`, update `isRemoteAltScreenRef.current = updateRemoteAltScreenState(isRemoteAltScreenRef.current, data)` (for string frames) and `isRemoteAltScreenRef.current = updateRemoteAltScreenState(isRemoteAltScreenRef.current, text)` (for `ArrayBuffer` frames) immediately upon arrival.
5. Update `term.attachCustomWheelEventHandler`, `applyScrollDelta`, and register `term.buffer.onBufferChange` as specified in Interfaces above, and dispose `bufferChangeDisposable` on unmount.

- [x] **Step 4: Run all related test suites and full build to verify**

Run:
- `npm test -- tests/terminalSyntheticEchoProtection.test.ts tests/terminalClaudeScrollback.test.ts tests/terminalScrollHelper.test.ts tests/terminalPerformanceOptimization.test.ts tests/terminalNonFullscreenStability.test.ts`
- `npm run build`
Expected: All tests PASS and build succeeds with zero errors.
