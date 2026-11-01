# Per-Host Split-Pane Terminal Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate web terminal split-pane state (`isSplitMode`) per connected host node (`activeHostId`) so enabling split screen on one node does not force all other nodes into split screen or spawn unwanted secondary PTY sessions on node switch.

**Architecture:** Replace the global boolean `isSplitMode` in `UnifiedTerminalView.tsx` with a per-host dictionary `splitHostsMap: Record<string, boolean>` persisted in `localStorage` under `terminal_split_hosts`. Derive `isSplitMode = Boolean(activeHostId && splitHostsMap[activeHostId])`, update `openSplitPane` / `closeSplitPane` to mutate only the active host's entry, and reset `activePane` to `'main'` when switching hosts (`handleHostChange`).

**Tech Stack:** React 18, TypeScript, Jest

**Spec:** In-chat bounded design approved in session (2026-11-01)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/frontendSplitPaneWorkspace.test.ts`
- Persist per-host split state in `localStorage` key `terminal_split_hosts` as JSON object `Record<string, boolean>`
- Keep existing `splitRatio` (`terminal_split_ratio`), keyboard shortcuts (`Alt+D`, `Alt+W`, `Alt+ArrowLeft/Right`), and `data-testid` attributes intact
- Switching from a split host to a non-split host must unmount the split `WebTerminalView` without sending `pane_close` (preserving the previous host's background split PTY session), and reset `activePane` to `'main'`

## Review Focus

- Corrupted or non-object JSON in `localStorage.getItem('terminal_split_hosts')` should safely fall back to `{}` without throwing during component initialization
- Calling `openSplitPane` when `activeHostId` is empty (`''`) must be a no-op and not write an empty-key entry into `splitHostsMap`
- Switching hosts via `handleHostChange` must reset `activePane` to `'main'` so toolbar actions (`getActiveTerminalRef`) never target an unmounted split pane

---

### Task 1: Isolate Split-Pane State Per Host in `UnifiedTerminalView`

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:93-105`, `292-334`
- Test: `tests/frontendSplitPaneWorkspace.test.ts`

**Interfaces:**
- Consumes: `activeHostId: string` state in `UnifiedTerminalView`
- Produces:
  - `splitHostsMap: Record<string, boolean>` state initialized from `localStorage.getItem('terminal_split_hosts')`
  - `isSplitMode: boolean` derived via `Boolean(activeHostId && splitHostsMap[activeHostId])`
  - `updateHostSplitMode(hostId: string, enabled: boolean): void` callback

- [x] **Step 1: Write the failing test in `tests/frontendSplitPaneWorkspace.test.ts`**

Add a test case in `tests/frontendSplitPaneWorkspace.test.ts` verifying per-host split state storage and host-switch focus reset:

```typescript
  it('isolates split mode state per activeHostId using terminal_split_hosts map and resets activePane on host switch', () => {
    expect(content).toContain('terminal_split_hosts');
    expect(content).toContain('splitHostsMap');
    expect(content).toMatch(/const\s+isSplitMode\s*=\s*Boolean\(\s*activeHostId\s*&&\s*splitHostsMap\[activeHostId\]\s*\)/);
    expect(content).toContain('updateHostSplitMode');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts`
Expected: FAIL with `Expected substring: "terminal_split_hosts"`

- [x] **Step 3: Implement per-host `splitHostsMap` and `updateHostSplitMode` in `frontend/src/components/UnifiedTerminalView.tsx`**

1. In `frontend/src/components/UnifiedTerminalView.tsx:93-95`, replace the `useState` for `isSplitMode` with `splitHostsMap: Record<string, boolean>` reading `localStorage.getItem('terminal_split_hosts')` (falling back to `{}` on invalid JSON or non-object values), and derive:
   ```tsx
   const isSplitMode = Boolean(activeHostId && splitHostsMap[activeHostId]);
   ```
2. In `handleHostChange` (`frontend/src/components/UnifiedTerminalView.tsx:292-295`), also call `setActivePane('main')`.
3. Define `updateHostSplitMode = useCallback((hostId: string, enabled: boolean) => { ... }, [])` that returns early if `!hostId`, sets `next[hostId] = true` when `enabled` or `delete next[hostId]` when `!enabled`, and persists `JSON.stringify(next)` to `localStorage` under `'terminal_split_hosts'`.
4. Update `openSplitPane` (`frontend/src/components/UnifiedTerminalView.tsx:311-320`) to guard `if (!activeHostId) return;` and call `updateHostSplitMode(activeHostId, true)`.
5. Update `closeSplitPane` (`frontend/src/components/UnifiedTerminalView.tsx:322-333`) to call `if (activeHostId) { updateHostSplitMode(activeHostId, false); }`.

- [x] **Step 4: Run tests and frontend build to verify they pass**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/frontendSplitPaneTerminal.test.ts && npm run build:frontend`
Expected: PASS (2 test suites passed, frontend Vite build succeeds)
