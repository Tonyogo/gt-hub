# Mobile Title Bar Actions Collapse into Dropdown Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up the mobile title bar so that only the "Select Mode" (`TextSelect`) button remains directly visible on the top bar on mobile (alongside the `...` More button), while all other buttons (split toggle, subtab refresh, and fullscreen toggle) are hidden on mobile (`hidden sm:inline-flex`) and accessible via the mobile dropdown menu (`mobile-more-menu`).

**Architecture:** In `UnifiedTerminalView.tsx`, update the desktop action buttons (split screen, subtab refreshes for files/cron/tasks/proxy, and fullscreen toggle) to use `hidden sm:inline-flex` so they only appear on desktop/tablet (`sm:` breakpoint and above). In the mobile more actions dropdown (`data-testid="mobile-more-menu"`), add a Fullscreen toggle button (`data-testid="mobile-fullscreen-btn"`), and when not in interactive mode, add a Refresh button (`data-testid="mobile-refresh-btn"`) that triggers the active subtab ref's `refresh()`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide Icons, Jest

**Spec:** In-chat bounded design approved in session (2026-11-01)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/terminalUnifiedTopBarControls.test.ts tests/terminalMobileDirectFullscreen.test.ts`
- On mobile (`< 640px` / sm breakpoint), the only directly visible action button on the title bar in interactive mode must be the Select Mode button (`handleToggleSelectMode`) and the More menu trigger (`mobile-more-btn`)
- Fullscreen and Split Screen functionalities must remain 100% accessible on mobile via the mobile dropdown menu
- Subtab refresh must remain accessible on mobile via the dropdown menu for files, cron, tasks, and proxy views

## Review Focus

- When switching between subtabs on mobile (`interactive`, `files`, `cron`, `tasks`, `proxy`), title bar height and layout must remain completely stable without button wrapping
- Clicking "Fullscreen" (`mobile-fullscreen-btn`) or "Refresh" (`mobile-refresh-btn`) in the mobile dropdown must close the dropdown menu (`setIsMoreMenuOpen(false)`)
- Desktop layout (`sm:` and above) must remain completely unaffected, displaying all toolbar buttons as before

---

### Task 1: Update Top Bar Mobile Visibility & Expand Mobile More Menu

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:730-845`, `850-960`
- Modify: `tests/terminalUnifiedTopBarControls.test.ts`
- Modify: `tests/terminalMobileDirectFullscreen.test.ts`

**Interfaces:**
- Consumes: `isSplitMode`, `isBrowserFullscreen`, `subTab`, `handleFullscreenToggle`, `handleToggleSelectMode`, refs for each subtab
- Produces:
  - `hidden sm:inline-flex` on `split-terminal-btn`, subtab refresh buttons, and `fullscreen-toggle-btn`
  - `mobile-fullscreen-btn` inside `data-testid="mobile-more-menu"`
  - `mobile-refresh-btn` inside `data-testid="mobile-more-menu"` for non-interactive subtabs

- [x] **Step 1: Write the failing tests in `tests/terminalUnifiedTopBarControls.test.ts` and `tests/terminalMobileDirectFullscreen.test.ts`**

Update `tests/terminalUnifiedTopBarControls.test.ts` to assert that:
1. `split-terminal-btn` and `fullscreen-toggle-btn` are hidden on mobile using `hidden sm:inline-flex`:
   ```typescript
   it('UnifiedTerminalView keeps only Select Mode directly on mobile title bar while collapsing others to sm:inline-flex', () => {
     expect(content).toMatch(/data-testid="split-terminal-btn"[^>]*hidden\s+sm:inline-flex/);
     expect(content).toMatch(/data-testid="fullscreen-toggle-btn"[^>]*hidden\s+sm:inline-flex/);
   });
   ```
2. The mobile dropdown menu contains `mobile-fullscreen-btn` and `mobile-refresh-btn`:
   ```typescript
   it('UnifiedTerminalView renders mobile fullscreen and subtab refresh inside mobile more menu', () => {
     expect(content).toContain('data-testid="mobile-fullscreen-btn"');
     expect(content).toContain('data-testid="mobile-refresh-btn"');
   });
   ```

Update `tests/terminalMobileDirectFullscreen.test.ts` to verify `mobile-fullscreen-btn` is rendered inside `UnifiedTerminalView`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/terminalUnifiedTopBarControls.test.ts tests/terminalMobileDirectFullscreen.test.ts`
Expected: FAIL with missing `data-testid="mobile-fullscreen-btn"` and `hidden sm:inline-flex` on `split-terminal-btn`

- [x] **Step 3: Update `UnifiedTerminalView.tsx`**

1. **Hide desktop buttons on mobile**:
   - `data-testid="split-terminal-btn"`: Add `hidden sm:inline-flex` to its `className`:
     ```tsx
     className={`hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg border transition-all ${ ... }`}
     ```
   - Refresh buttons for `files`, `cron`, `tasks`, and `proxy`:
     Update each button from `p-1 sm:p-1.5 ...` to:
     ```tsx
     className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-all"
     ```
   - `data-testid="fullscreen-toggle-btn"`:
     Update `className` to:
     ```tsx
     className={`hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg border transition-all ${ ... }`}
     ```
2. **Expand mobile dropdown menu (`data-testid="mobile-more-menu"`)**:
   - In non-interactive subtabs (`subTab !== 'interactive'`), add a refresh button:
     ```tsx
     {subTab !== 'interactive' && (
       <div className="py-1">
         <button
           type="button"
           data-testid="mobile-refresh-btn"
           onClick={() => {
             if (subTab === 'files') fileManagerRef.current?.refresh();
             else if (subTab === 'cron') cronRef.current?.refresh();
             else if (subTab === 'tasks') taskRef.current?.refresh();
             else if (subTab === 'proxy') proxyRef.current?.refresh();
             setIsMoreMenuOpen(false);
           }}
           className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-[var(--bg-control-hover)] text-left transition-colors"
         >
           <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
           <span>{t('files.refresh', '刷新')}</span>
         </button>
       </div>
     )}
     ```
   - In the general section of the menu (alongside Language, Theme, and GitHub), add the Fullscreen toggle:
     ```tsx
     <button
       type="button"
       data-testid="mobile-fullscreen-btn"
       onClick={() => {
         handleFullscreenToggle();
         setIsMoreMenuOpen(false);
       }}
       className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-[var(--bg-control-hover)] text-left transition-colors"
     >
       {isBrowserFullscreen ? (
         <Minimize2 className="w-3.5 h-3.5 text-indigo-400" />
       ) : (
         <Maximize2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
       )}
       <span>{isBrowserFullscreen ? t('webTerminal.exitFullscreen') : t('webTerminal.fullscreen')}</span>
     </button>
     ```

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/terminalUnifiedTopBarControls.test.ts tests/terminalMobileDirectFullscreen.test.ts tests/frontendSplitPaneWorkspace.test.ts && npm run build:frontend`
Expected: PASS (all tests pass, frontend Vite build succeeds)
