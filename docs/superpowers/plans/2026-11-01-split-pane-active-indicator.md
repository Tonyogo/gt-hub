# Split-Pane Active Terminal Visual Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the currently focused terminal pane unmistakably clear in split-pane mode via a 2px top accent bar, high-contrast pane header with an "Active" capsule badge, unclipped inset focus ring, and iTerm2-style dimming + cursor blink pause on the inactive pane.

**Architecture:** Enhance the split pane headers and containers in `UnifiedTerminalView.tsx` with equal-height `border-t-2` top accent bars (`border-t-indigo-500` active vs. `border-t-transparent` inactive), brand-tinted header backgrounds, an active status badge (`webTerminal.activePaneBadge`), and `ring-inset` focus borders. In `WebTerminalView.tsx`, wire the existing `isFocusedPane` prop to toggle xterm `cursorBlink`, apply subtle dimming (`opacity-75`) to the inactive pane canvas, and notify `onFocusPaneRef.current?.()` when the xterm helper textarea receives focus.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Xterm.js, Jest

**Spec:** In-chat bounded design (Option A) approved in session (2026-11-01)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/frontendSplitPaneTerminal.test.ts`
- Active and inactive pane headers MUST maintain identical pixel height (`border-t-2 border-t-indigo-500` vs. `border-t-2 border-t-transparent`) so switching focus never triggers layout shift or PTY `resize`
- Use `ring-inset` on active pane containers so focus rings are not clipped by parent `overflow-hidden`
- Preserve all existing `data-testid` attributes (`split-terminal-btn`, `mobile-split-terminal-btn`, `terminal-split-divider`, `close-split-pane-btn`)

## Review Focus

- Switching focus between `main` and `split` panes must not change container height or trigger a ResizeObserver `safeFit` call
- When `isRefitting` is true in `WebTerminalView`, `opacity-40 select-none pointer-events-none` must still take precedence over focused/unfocused opacity classes
- Focusing the terminal via keyboard/textarea (`helperTextarea` `focus` event) must invoke `onFocusPaneRef.current?.()` so `activePane` stays synchronized with actual keyboard input focus
- Clicking on a pane header bar should switch `activePane` to that pane and focus its terminal instance

---

### Task 1: Add Active Pane Badge Translations & `WebTerminalView` Focus Synchronization

**Files:**
- Modify: `frontend/src/i18n/locales/zh.ts:25-31`
- Modify: `frontend/src/i18n/locales/en.ts:23-29`
- Modify: `frontend/src/components/WebTerminalView.tsx:912-924`, `1047-1051`, `2220-2230`, `2947-2961`
- Test: `tests/frontendSplitPaneTerminal.test.ts`

**Interfaces:**
- Consumes: `isFocusedPane?: boolean` (default `true`) and `onFocusPane?: () => void` props on `WebTerminalViewProps`
- Produces:
  - i18n key `webTerminal.activePaneBadge` (`"当前活动"` in `zh.ts`, `"Active"` in `en.ts`)
  - `useEffect` in `WebTerminalView` syncing `xtermRef.current.options.cursorBlink = Boolean(isFocusedPane)`
  - `onFocusPaneRef.current?.()` call inside `helperTextarea` `handleFocus` listener and container click handler
  - Inactive pane dimming class `opacity-75 hover:opacity-90` on the xterm canvas wrapper when `!isRefitting && !isFocusedPane`

- [x] **Step 1: Write the failing test in `tests/frontendSplitPaneTerminal.test.ts`**

Add assertions to `tests/frontendSplitPaneTerminal.test.ts` verifying `activePaneBadge` translations and `isFocusedPane` cursorBlink/dimming synchronization:

```typescript
  it('synchronizes cursorBlink and inactive pane dimming with isFocusedPane in WebTerminalView', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');
    expect(content).toContain('xtermRef.current.options.cursorBlink = Boolean(isFocusedPane)');
    expect(content).toContain('opacity-75');
  });
```

And in the existing `'defines split pane translation keys in both zh and en locales'` test in `tests/frontendSplitPaneTerminal.test.ts`, add:
```typescript
    expect(zh).toContain('activePaneBadge:');
    expect(en).toContain('activePaneBadge:');
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendSplitPaneTerminal.test.ts`
Expected: FAIL with missing `activePaneBadge:` and `xtermRef.current.options.cursorBlink = Boolean(isFocusedPane)`

- [x] **Step 3: Add `activePaneBadge` to `zh.ts` and `en.ts` and wire `isFocusedPane` in `WebTerminalView.tsx`**

1. In `frontend/src/i18n/locales/zh.ts` under `webTerminal`:
   ```ts
   paneMain: "终端 #1",
   paneSplit: "终端 #2",
   activePaneBadge: "当前活动",
   ```
2. In `frontend/src/i18n/locales/en.ts` under `webTerminal`:
   ```ts
   paneMain: "Terminal #1",
   paneSplit: "Terminal #2",
   activePaneBadge: "Active",
   ```
3. In `frontend/src/components/WebTerminalView.tsx`:
   - In `handleFocus` (`~line 1047`): call `onFocusPaneRef.current?.();` before `setIsKeyboardOpen(true);`.
   - Add a `useEffect` near `resolvedTheme` effect (`~line 2226`):
     ```tsx
     useEffect(() => {
       if (xtermRef.current) {
         xtermRef.current.options.cursorBlink = Boolean(isFocusedPane);
       }
     }, [isFocusedPane]);
     ```
   - In the xterm canvas wrapper (`~line 2948`):
     - In `onClick`, also invoke `onFocusPaneRef.current?.();`.
     - Update the opacity class expression from:
       `${isRefitting ? 'opacity-40 select-none pointer-events-none' : 'opacity-100'}`
       to:
       `${isRefitting ? 'opacity-40 select-none pointer-events-none' : isFocusedPane ? 'opacity-100' : 'opacity-75 hover:opacity-90'}`

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/frontendSplitPaneTerminal.test.ts`
Expected: PASS

---

### Task 2: Enhance Active vs. Inactive Pane Headers and Inset Borders in `UnifiedTerminalView`

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:1022-1140`
- Test: `tests/frontendSplitPaneWorkspace.test.ts`

**Interfaces:**
- Consumes: `activePane: 'main' | 'split'`, `isSplitMode: boolean`, `t('webTerminal.activePaneBadge')`
- Produces:
  - Unclipped `ring-inset` focus border on active pane container
  - Equal-height `border-t-2` top accent bar (`border-t-indigo-500` when active, `border-t-transparent` when inactive)
  - High-contrast active header styling with `data-testid="active-pane-badge"` capsule badge
  - Clickable pane headers that switch `activePane` and focus the corresponding terminal ref

- [x] **Step 1: Write the failing test in `tests/frontendSplitPaneWorkspace.test.ts`**

Add a test case in `tests/frontendSplitPaneWorkspace.test.ts` verifying the active pane visual indicators:

```typescript
  it('renders high-contrast active pane indicators with border-t-2 accent bar, ring-inset, and active-pane-badge', () => {
    expect(content).toContain('border-t-2');
    expect(content).toContain('border-t-indigo-500');
    expect(content).toContain('border-t-transparent');
    expect(content).toContain('ring-inset');
    expect(content).toContain('data-testid="active-pane-badge"');
    expect(content).toContain('webTerminal.activePaneBadge');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts`
Expected: FAIL with missing `border-t-indigo-500` / `data-testid="active-pane-badge"`

- [x] **Step 3: Update main and split pane containers and headers in `frontend/src/components/UnifiedTerminalView.tsx`**

1. **Main Terminal Pane Container (`~line 1025`)**:
   ```tsx
   className={`h-full flex flex-col min-w-0 min-h-0 relative transition-colors duration-150 ${
     isSplitMode
       ? activePane === 'main'
         ? 'border-r border-indigo-500/40 ring-1 ring-inset ring-indigo-500/50'
         : 'border-r border-[var(--border-subtle)]'
       : 'w-full flex-1'
   }`}
   ```
2. **Main Terminal Pane Header (`~line 1033`)**:
   ```tsx
   {isSplitMode && (
     <div
       onClick={() => {
         setActivePane('main');
         terminalRef.current?.focus();
       }}
       className={`flex items-center justify-between px-2.5 py-1 border-t-2 border-b text-[11px] select-none shrink-0 cursor-pointer transition-colors duration-150 ${
         activePane === 'main'
           ? 'border-t-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/15 border-b-indigo-500/30 text-[var(--text-primary)]'
           : 'border-t-transparent bg-[var(--bg-surface-sub)] border-b-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
       }`}
     >
       <div className="flex items-center space-x-2">
         <span
           className={`w-2 h-2 rounded-full transition-all ${
             activePane === 'main'
               ? 'bg-emerald-400 ring-2 ring-emerald-400/30 shadow-xs'
               : 'bg-slate-500/50'
           }`}
         />
         <span className={activePane === 'main' ? 'font-semibold text-indigo-600 dark:text-indigo-300' : 'text-[var(--text-muted)]'}>
           {t('webTerminal.paneMain', '终端 #1')}
         </span>
         {activePane === 'main' && (
           <span
             data-testid="active-pane-badge"
             className="px-1.5 py-0.2 rounded-full text-[9px] font-semibold bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-500/30 leading-tight"
           >
             {t('webTerminal.activePaneBadge', '当前活动')}
           </span>
         )}
       </div>
       <span className="hidden sm:inline text-[10px] font-mono text-[var(--text-muted)]">Alt+←</span>
     </div>
   )}
   ```
3. **Secondary Split Terminal Pane Container (`~line 1089`)**:
   ```tsx
   className={`h-full flex flex-col min-w-0 min-h-0 relative transition-colors duration-150 ${
     activePane === 'split'
       ? 'ring-1 ring-inset ring-indigo-500/50'
       : ''
   }`}
   ```
4. **Secondary Split Terminal Pane Header (`~line 1095`)**:
   ```tsx
   <div
     onClick={() => {
       setActivePane('split');
       splitTerminalRef.current?.focus();
     }}
     className={`flex items-center justify-between px-2.5 py-1 border-t-2 border-b text-[11px] select-none shrink-0 cursor-pointer transition-colors duration-150 ${
       activePane === 'split'
         ? 'border-t-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/15 border-b-indigo-500/30 text-[var(--text-primary)]'
         : 'border-t-transparent bg-[var(--bg-surface-sub)] border-b-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
     }`}
   >
     <div className="flex items-center space-x-2">
       <span
         className={`w-2 h-2 rounded-full transition-all ${
           activePane === 'split'
             ? 'bg-emerald-400 ring-2 ring-emerald-400/30 shadow-xs'
             : 'bg-slate-500/50'
         }`}
       />
       <span className={activePane === 'split' ? 'font-semibold text-indigo-600 dark:text-indigo-300' : 'text-[var(--text-muted)]'}>
         {t('webTerminal.paneSplit', '终端 #2')}
       </span>
       {activePane === 'split' && (
         <span
           data-testid="active-pane-badge"
           className="px-1.5 py-0.2 rounded-full text-[9px] font-semibold bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-500/30 leading-tight"
         >
           {t('webTerminal.activePaneBadge', '当前活动')}
         </span>
       )}
     </div>
     <div className="flex items-center space-x-2">
       <span className="hidden sm:inline text-[10px] font-mono text-[var(--text-muted)]">Alt+→</span>
       <button
         type="button"
         data-testid="close-split-pane-btn"
         onClick={(e) => {
           e.stopPropagation();
           closeSplitPane(true);
         }}
         className="p-0.5 rounded hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
         title={t('webTerminal.closeSplitPane', '关闭分屏')}
       >
         <X className="w-3 h-3" />
       </button>
     </div>
   </div>
   ```

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/frontendSplitPaneTerminal.test.ts && npm run build:frontend`
Expected: PASS (all tests in both suites pass, frontend Vite build succeeds)
