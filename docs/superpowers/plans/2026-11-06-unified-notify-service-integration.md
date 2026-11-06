# Unified Notify Service Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor terminal notification handling to dispatch directly to the external notify API (`https://www.yatao.cc.cd/api/admin/notify`) using `x-admin-key` header authentication and `{ type, title, message }` payload format, removing local browser notifications, audio chimes, floating UI toasts, and toggle buttons.

**Architecture:** Replace the local browser audio/notification handlers in `terminalNotificationHelper.ts` with `sendUnifiedNotification` which sends an asynchronous HTTP POST to the external notification endpoint. In `WebTerminalView.tsx`, wire OSC 9 / 777 / 99 and Bell detections to call `sendUnifiedNotification` directly while removing in-terminal Toast popups. Remove bell toggle buttons from `WebTerminalView.tsx` and `UnifiedTerminalView.tsx`.

**Tech Stack:** TypeScript, React 18, Jest, Fetch API

**Spec:** In-chat Bounded Design approved in brainstorming session.

## Global Constraints

- Target test execution during development: `npm test -- tests/terminalNotification.test.ts` (per `CLAUDE.md`).
- Notification endpoint: `https://www.yatao.cc.cd/api/admin/notify`.
- Request format: `POST`, Header `x-admin-key: <adminKey>`, Header `Content-Type: application/json`.
- Body payload schema: `{ type: "warning" | "info" | "error" | "success", title: string, message: string }`.
- Do NOT block terminal operations or throw on HTTP failure; use a 5-second timeout and swallow network errors gracefully.
- No in-app floating popups or browser Notification API prompts.

## Review Focus

- OSC 9 sequences (iTerm2 style emitted by Claude Code) send `{ type: "warning" | "info", title: "[<host>] ...", message: "..." }` with `x-admin-key`.
- Standalone BEL (`\x07`) signals send a notification with `type: "warning"` and default prompt message.
- Companion BEL emitted within 500ms after OSC 9/777 is suppressed by `TerminalBellCoordinator` (only 1 HTTP request sent).
- Network timeouts or non-200 responses from the notify API must not throw unhandled promise rejections or disrupt PTY stream.
- Replaying historical scrollback does not dispatch notifications to the external API.

---

### Task 1: Implement `sendUnifiedNotification` and Clean Up Local Notification Helpers

**Files:**
- Modify: `frontend/src/utils/terminalNotificationHelper.ts`
- Test: `tests/terminalNotification.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const DEFAULT_NOTIFY_API_URL = 'https://www.yatao.cc.cd/api/admin/notify';

  export interface UnifiedNotificationPayload {
    apiUrl?: string;
    adminKey: string;
    type?: 'info' | 'warning' | 'error' | 'success';
    title: string;
    message: string;
  }

  export async function sendUnifiedNotification(payload: UnifiedNotificationPayload): Promise<boolean>;
  ```

- [x] **Step 1: Write the failing tests in `tests/terminalNotification.test.ts`**

```typescript
  describe('sendUnifiedNotification', () => {
    beforeEach(() => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
    });

    afterEach(() => {
      delete (global as any).fetch;
    });

    it('sends POST request to https://www.yatao.cc.cd/api/admin/notify with x-admin-key and body', async () => {
      const res = await sendUnifiedNotification({
        adminKey: 'test-admin-key',
        type: 'warning',
        title: '[host-1] Claude Code',
        message: 'Claude needs your permission to run Bash',
      });

      expect(res).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://www.yatao.cc.cd/api/admin/notify');
      expect(opts.method).toBe('POST');
      expect(opts.headers['x-admin-key']).toBe('test-admin-key');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({
        type: 'warning',
        title: '[host-1] Claude Code',
        message: 'Claude needs your permission to run Bash',
      });
    });

    it('handles network failure gracefully without throwing', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('Network error'));
      const res = await sendUnifiedNotification({
        adminKey: 'key',
        title: 'Title',
        message: 'Message',
      });
      expect(res).toBe(false);
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: FAIL with `sendUnifiedNotification is not a function`

- [x] **Step 3: Implement `sendUnifiedNotification` in `frontend/src/utils/terminalNotificationHelper.ts`**

1. Define `DEFAULT_NOTIFY_API_URL = 'https://www.yatao.cc.cd/api/admin/notify'`.
2. Implement `sendUnifiedNotification(payload)` using `fetch`, `AbortController` (5s timeout), headers `{ 'Content-Type': 'application/json', 'x-admin-key': payload.adminKey }`, and body `{ type: payload.type || 'info', title: payload.title, message: payload.message }`.
3. Remove `dispatchBrowserNotification`, `playNotificationChime`, `requestBrowserNotificationPermission`, and `TERMINAL_NOTIFICATIONS_STORAGE_KEY` functions that are no longer needed.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalNotificationHelper.ts tests/terminalNotification.test.ts
git commit -m "feat(notify): implement sendUnifiedNotification to external notify service"
```

---

### Task 2: Connect WebTerminal to `sendUnifiedNotification` and Remove Local Popups/Toggles

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `tests/terminalNotification.test.ts`

**Interfaces:**
- Consumes: `sendUnifiedNotification`, `parseOsc9Notification`, `parseOsc777Notification`, `parseOsc99Notification`, `TerminalBellCoordinator` from `frontend/src/utils/terminalNotificationHelper.ts`.

- [x] **Step 1: Write the failing test in `tests/terminalNotification.test.ts`**

```typescript
  it('dispatches notifications to external notify API and does not render toast or bell toggle button in WebTerminal / UnifiedTerminal', () => {
    const webTerminalContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'),
      'utf-8'
    );
    const unifiedContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx'),
      'utf-8'
    );

    expect(webTerminalContent).toContain('sendUnifiedNotification(');
    expect(webTerminalContent).not.toContain('terminalToastNotification');
    expect(webTerminalContent).not.toContain('toggle-terminal-notifications-btn');
    expect(unifiedContent).not.toContain('unified-toggle-notifications-btn');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalNotification.test.ts`
Expected: FAIL (`expected content not to contain 'terminalToastNotification'`)

- [x] **Step 3: Update `WebTerminalView.tsx` and `UnifiedTerminalView.tsx`**

In `frontend/src/components/WebTerminalView.tsx`:
1. In `triggerNotification(title, body)`, call `sendUnifiedNotification({ adminKey, type, title, message: body })`. Determine `type = /warn|fail|error|alert|prompt|permission|confirm/i.test(body) ? 'warning' : 'info'`.
2. Remove `terminalToastNotification` state, timer, and JSX rendering.
3. Remove `toggle-terminal-notifications-btn` from the action bar.
4. Remove `toggleNotifications` / `isNotificationsEnabled` from `WebTerminalHandle`.

In `frontend/src/components/UnifiedTerminalView.tsx`:
1. Remove `unified-toggle-notifications-btn` from the top action bar.
2. Remove notifications button from the mobile dropdown menu.
3. Remove `notificationsEnabled` state and unused `Bell`/`BellOff` imports.

- [x] **Step 4: Run tests and verify all pass**

Run: `npm test -- tests/terminalNotification.test.ts tests/terminalUnifiedTopBarControls.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/components/UnifiedTerminalView.tsx tests/terminalNotification.test.ts
git commit -m "refactor(terminal): route terminal notifications to external notify service and remove local popups"
```
