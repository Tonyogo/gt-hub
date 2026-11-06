# Fix Tab Bell False Positives and Add Task Completion Notification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false-positive notifications on shell Tab completion by removing `term.onBell` external notification dispatch, enable native CLI OSC 777 notifications by setting `TERM_PROGRAM: 'ghostty'` in Agent PTYs, and add a universal zero-config `TerminalTaskCompletionDetector` that notifies when any long-running terminal command or Claude Code turn (`>= 10s`) finishes and becomes idle (`3s` quiet window).

**Architecture:** Remove `term.onBell` notification wiring in `WebTerminalView.tsx` so ASCII BEL (`\x07`) from shell Tab completion never triggers HTTP notifications. Update Agent PTY environments (`src/agent/daemon.ts` and `src/agent/pty/panePtyManager.ts`) to set `TERM_PROGRAM: 'ghostty'` so CLI tools like Claude Code natively emit `OSC 777` alerts. Implement `TerminalTaskCompletionDetector` in `frontend/src/utils/terminalNotificationHelper.ts` to track user command submissions (`\r`/`\n`), output activity duration, and idle settle windows, firing `sendUnifiedNotification` once when a long-running task finishes without requiring any external config files.

**Tech Stack:** TypeScript, React 18, Node.js, Jest

**Spec:** Approved in-chat Bounded design (`2026-11-06`)

## Global Constraints

- Targeted test execution during development: `npm test -- tests/terminalNotification.test.ts` (per `CLAUDE.md`).
- Do NOT modify `~/.claude/settings.json` or depend on external host configuration files.
- Never trigger `sendUnifiedNotification` on `BEL` (`\x07`) or `term.onBell`.
- Short commands (`< 10000ms` from Enter submission to last output) must NOT trigger completion notifications.
- If an explicit `OSC 9 / 777 / 99` notification is already sent during a command execution cycle, `TerminalTaskCompletionDetector` must suppress its own completion notification to prevent duplicates.
- Pressing `Ctrl+C` (`\x03`) cancels the current task tracking cycle without firing a completion notification.

## Review Focus

- Pressing Tab in bash/zsh emits `\x07` — must produce zero calls to `sendUnifiedNotification`.
- Running a short command like `ls` or `git status` (completes in `< 10s`) — must produce zero calls to `sendUnifiedNotification`.
- Running a long task (e.g. Claude Code turn or build taking `>= 10s` of output activity followed by `3s` of silence) — must trigger `sendUnifiedNotification` once with `type: 'info'`.
- If a long task emits an explicit `OSC 777` or `OSC 9` notification before settling — only the explicit OSC notification is sent; the idle completion detector does not fire a second duplicate notification.
- Aborting a long task with `\x03` (`Ctrl+C`) resets the detector and does not fire a completion notification.

---

### Task 1: Implement `TerminalTaskCompletionDetector` and Update Agent `TERM_PROGRAM`

**Files:**
- Modify: `frontend/src/utils/terminalNotificationHelper.ts`
- Modify: `src/agent/daemon.ts:885-893`
- Modify: `src/agent/pty/panePtyManager.ts:55-63`
- Test: `tests/terminalNotification.test.ts`

**Interfaces:**
- Produces in `frontend/src/utils/terminalNotificationHelper.ts`:
  ```typescript
  export interface TaskCompletionDetectorOptions {
    minTaskDurationMs?: number; // default 10000
    idleSettleMs?: number;      // default 3000
    onComplete: (info: { durationMs: number }) => void;
  }

  export class TerminalTaskCompletionDetector {
    constructor(options: TaskCompletionDetectorOptions);
    public recordUserInput(data: string, now?: number): void;
    public recordOutput(chunk: string, now?: number): void;
    public recordOscNotification(): void;
    public reset(): void;
    public dispose(): void;
  }
  ```

- [x] **Step 1: Write the failing tests in `tests/terminalNotification.test.ts`**

```typescript
  describe('TerminalTaskCompletionDetector (Activity-to-Idle Completion)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not trigger completion for short commands (< 10s)', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('ls -la\r', 1000);
      detector.recordOutput('total 0\r\n', 1200);
      jest.advanceTimersByTime(3500);

      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });

    it('triggers completion once when a task runs >= 10s and then settles for 3s', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('claude prompt\r', 1000);
      detector.recordOutput('Thinking...', 5000);
      detector.recordOutput('Done writing code.\r\n', 12500); // 11.5s elapsed >= 10s

      jest.advanceTimersByTime(2900);
      expect(onComplete).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith({ durationMs: 11500 });
      detector.dispose();
    });

    it('suppresses idle completion notification if an explicit OSC notification already fired during the task', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('claude\r', 1000);
      detector.recordOutput('Working...', 12000);
      detector.recordOscNotification();

      jest.advanceTimersByTime(4000);
      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });

    it('cancels task tracking when user presses Ctrl+C (\\x03)', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('sleep 30\r', 1000);
      detector.recordOutput('running...', 12000);
      detector.recordUserInput('\x03', 12100);

      jest.advanceTimersByTime(4000);
      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: FAIL with `TerminalTaskCompletionDetector is not a constructor`

- [x] **Step 3: Implement `TerminalTaskCompletionDetector` in `frontend/src/utils/terminalNotificationHelper.ts` and set `TERM_PROGRAM: 'ghostty'` in Agent PTYs**

1. In `frontend/src/utils/terminalNotificationHelper.ts`, implement `TerminalTaskCompletionDetector`.
2. In `src/agent/daemon.ts` and `src/agent/pty/panePtyManager.ts`, set `TERM_PROGRAM: 'ghostty'`.
3. Update the Agent PTY environment test in `tests/terminalNotification.test.ts` to check `TERM_PROGRAM: 'ghostty'`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalNotificationHelper.ts src/agent/daemon.ts src/agent/pty/panePtyManager.ts tests/terminalNotification.test.ts
git commit -m "feat(notify): add TerminalTaskCompletionDetector and set TERM_PROGRAM=ghostty"
```

---

### Task 2: Remove `term.onBell` Notification Trigger and Wire `TerminalTaskCompletionDetector` in `WebTerminalView`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/i18n/locales/zh.ts`
- Modify: `frontend/src/i18n/locales/en.ts`
- Modify: `tests/terminalNotification.test.ts`

**Interfaces:**
- Consumes: `TerminalTaskCompletionDetector`, `sendUnifiedNotification`, `parseOsc9Notification`, `parseOsc777Notification`, `parseOsc99Notification` from `frontend/src/utils/terminalNotificationHelper.ts`.

- [x] **Step 1: Update integration test in `tests/terminalNotification.test.ts` to require no `term.onBell` and verify `TerminalTaskCompletionDetector` wiring**

```typescript
    it('registers OSC 9, 777, 99 and TerminalTaskCompletionDetector in WebTerminalView without triggering notifications on term.onBell', () => {
      const webTerminalContent = fs.readFileSync(
        path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'),
        'utf-8'
      );
      expect(webTerminalContent).toContain('registerOscHandler(9,');
      expect(webTerminalContent).toContain('registerOscHandler(777,');
      expect(webTerminalContent).toContain('registerOscHandler(99,');
      expect(webTerminalContent).toContain('TerminalTaskCompletionDetector');
      expect(webTerminalContent).not.toContain('term.onBell(');
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: FAIL (`expect(webTerminalContent).not.toContain('term.onBell(')`)

- [x] **Step 3: Update `WebTerminalView.tsx` and i18n locales**

In `frontend/src/components/WebTerminalView.tsx`:
1. Remove `term.onBell(...)` registration and `bellDisposable`.
2. Instantiate `TerminalTaskCompletionDetector` (`minTaskDurationMs: 10000`, `idleSettleMs: 3000`) and call `triggerNotification(t('webTerminal.taskCompletedTitle', '任务完成'), t('webTerminal.taskCompletedMessage', '长耗时终端任务已执行完毕，正在等待您的输入'), 'info')` inside `onComplete`.
3. Call `taskCompletionDetectorRef.current?.recordOscNotification()` inside OSC 9 / 777 / 99 handlers.
4. Call `taskCompletionDetectorRef.current?.recordOutput(text)` when live PTY output arrives in `ws.onmessage` (`!isReplayingRef.current`).
5. Call `taskCompletionDetectorRef.current?.recordUserInput(data)` in `term.onData`, `encodeModifierKey` send path, and `handleSendInput`.
6. Dispose/reset `taskCompletionDetectorRef.current` on unmount, session reset, and host change.

In `frontend/src/i18n/locales/zh.ts` and `en.ts`:
1. Add `taskCompletedTitle` and `taskCompletedMessage` under `webTerminal`.

- [x] **Step 4: Run tests and verify they pass**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/i18n/locales/zh.ts frontend/src/i18n/locales/en.ts tests/terminalNotification.test.ts
git commit -m "fix(terminal): remove bell notification false positives and wire task completion detector"
```
