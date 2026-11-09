# Remove Terminal Notification Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove all terminal notification code, OSC 9/777/99 notification handlers, `TerminalTaskCompletionDetector`, external notification webhook calls, and related tests/docs/locale keys.

**Architecture:** Delete `frontend/src/utils/terminalNotificationHelper.ts`, `tests/terminalNotification.test.ts`, and the two prior notification plan documents. Strip all notification hooks and refs from `frontend/src/components/WebTerminalView.tsx`, remove notification translation keys from `en.ts` and `zh.ts`, and revert the notification-specific PTY environment variables and stream sanitizer rules in `src/agent/daemon.ts`, `src/agent/pty/panePtyManager.ts`, and `src/shared/utils/terminalSanitizer.ts`.

**Tech Stack:** TypeScript, React 18, xterm.js, Node.js, Jest

**Spec:** Approved bounded in-chat design (2026-11-09)

## Global Constraints

- Preserve all mobile keyboard and touch-scrolling fixes from commits `83ebb21` and `9e49d8e`.
- Do not remove existing toast notifications in non-terminal modules (`TerminalFileManagerView`, `TerminalCronView`, `TerminalProxyView`).
- Run targeted Jest tests with `--detectOpenHandles --forceExit`.

## Review Focus

- Ensure `WebTerminalView.tsx` has zero remaining references to `terminalNotificationHelper`, `taskCompletionDetectorRef`, `triggerNotification`, `osc9Disposable`, `osc777Disposable`, `osc99Disposable`, or `adminKeyRef`.
- Ensure `stripTerminalQuerySequences` in `src/shared/utils/terminalSanitizer.ts` still strips standard terminal queries (OSC 4/10/11/12, DA, CPR, DECRQM, XTVERSION) and neutralizes unclosed mouse/focus modes.
- Ensure `src/agent/daemon.ts` and `src/agent/pty/panePtyManager.ts` restore `TERM_PROGRAM: 'gemini-proxy-agent'` and remove `LC_TERMINAL: 'iTerm2'`.

---

### Task 1: Remove Notification Helper, Notification Tests, and Notification Plan Docs

**Files:**
- Delete: `frontend/src/utils/terminalNotificationHelper.ts`
- Delete: `tests/terminalNotification.test.ts`
- Delete: `docs/superpowers/plans/2026-11-06-unified-notify-service-integration.md`
- Delete: `docs/superpowers/plans/2026-11-06-fix-tab-bell-and-task-completion-notify.md`
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/i18n/locales/en.ts:60-65`
- Modify: `frontend/src/i18n/locales/zh.ts:62-67`
- Modify: `src/agent/daemon.ts:886-887`
- Modify: `src/agent/pty/panePtyManager.ts:59-60`
- Modify: `src/shared/utils/terminalSanitizer.ts:9-13`

**Interfaces:**
- Consumes: none
- Produces: clean `WebTerminalView`, `stripTerminalQuerySequences(stream: string): string`

- [x] **Step 1: Delete `frontend/src/utils/terminalNotificationHelper.ts`, `tests/terminalNotification.test.ts`, and obsolete notification plans**

```bash
rm -f frontend/src/utils/terminalNotificationHelper.ts \
      tests/terminalNotification.test.ts \
      docs/superpowers/plans/2026-11-06-unified-notify-service-integration.md \
      docs/superpowers/plans/2026-11-06-fix-tab-bell-and-task-completion-notify.md
```

- [x] **Step 2: Remove all notification imports, refs, OSC handlers, and detector calls from `frontend/src/components/WebTerminalView.tsx`**

Remove:
- `import { parseOsc9Notification, parseOsc777Notification, parseOsc99Notification, TerminalTaskCompletionDetector, sendUnifiedNotification } from '../utils/terminalNotificationHelper';`
- `adminKeyRef` and `taskCompletionDetectorRef` declarations
- `triggerNotification`, `new TerminalTaskCompletionDetector(...)`, `osc9Disposable`, `osc777Disposable`, `osc99Disposable` registrations and `.dispose()` calls
- All `taskCompletionDetectorRef.current?.recordOutput(...)`, `recordUserInput(...)`, and `reset()` calls

- [x] **Step 3: Remove notification translation keys from `frontend/src/i18n/locales/en.ts` and `frontend/src/i18n/locales/zh.ts`**

Remove `notificationsOn`, `notificationsOff`, `defaultBellMessage`, `terminalNotificationTitle`, `taskCompletedTitle`, and `taskCompletedMessage` from `webTerminal` in both locale files.

- [x] **Step 4: Revert notification-specific PTY environment variables and sanitizer regex**

In `src/agent/daemon.ts` and `src/agent/pty/panePtyManager.ts`, replace:
```ts
      TERM_PROGRAM: 'ghostty',
      LC_TERMINAL: 'iTerm2',
```
with:
```ts
      TERM_PROGRAM: 'gemini-proxy-agent',
```

In `src/shared/utils/terminalSanitizer.ts`, restore lines 9-13 to:
```ts
  let stripped = stream.replace(
    /\x1b(?:\](?:4|10|11|12);\?(?:\x1b\\|\x07)|\[[>?=]?(?:0)?c|\[\??6n|\[\??\d+\$p|\[>0?q|\[(?:14|18|19|20|21)t)/g,
    ''
  );
```

- [x] **Step 5: Run tests and builds to verify clean removal**

Run: `npm test -- tests/terminalMobileKeyboard.test.ts tests/terminalHistoryBuffer.test.ts && npm run build:backend && npm run build:frontend`
Expected: PASS with zero TypeScript or Vite build errors

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(terminal): remove all terminal notification code"
```
