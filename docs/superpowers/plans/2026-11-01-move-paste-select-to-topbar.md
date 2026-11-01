# Move Paste & Select Mode from Accessory Bar to Top Title Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "Paste" and "Select Mode" buttons from `TerminalAccessoryBar` and display them exclusively in the top title bar (`UnifiedTerminalView` and `WebTerminalView`), keeping only "Paste" and "Select Mode" directly visible on the mobile title bar while placing all other actions inside the mobile dropdown menu.

**Architecture:** Strip the Paste button (`ClipboardPaste`) and Select Mode/Copy button (`TextSelect`/`Copy`) from `TerminalAccessoryBar.tsx` so the bottom bar only renders terminal keys and keyboard toggle/dismiss controls. Expose `pasteClipboard: () => void` on `WebTerminalHandle` in `WebTerminalView.tsx`, add a top-bar Paste button (`ClipboardPaste`, `data-testid="top-paste-btn"`) alongside the Select Mode button (`data-testid="top-select-mode-btn"`) in `UnifiedTerminalView.tsx` (and standalone `WebTerminalView.tsx`), and ensure both are directly visible on mobile while all other toolbar buttons remain collapsed into `mobile-more-menu`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide Icons, Jest

**Spec:** In-chat bounded design approved in session (2026-11-01)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/terminalAccessoryBar.test.ts tests/terminalMobileSelection.test.ts tests/terminalUnifiedTopBarControls.test.ts`
- `TerminalAccessoryBar.tsx` must NOT render the Paste button (`ClipboardPaste`) or the Select Mode / Copy button (`TextSelect` / `Copy`)
- The top bar Paste button must preserve native user gesture activation (do NOT call `e.preventDefault()` on `onTouchStart` or `onMouseDown`) so `navigator.clipboard.readText()` works in mobile browsers
- On mobile (`< 640px`), the only action buttons directly visible on the top title bar in `interactive` mode are **Paste** (`data-testid="top-paste-btn"`), **Select Mode** (`data-testid="top-select-mode-btn"`), and the **More** dropdown trigger (`data-testid="mobile-more-btn"`)

## Review Focus

- In split-pane mode, clicking the top-bar Paste button must paste into the currently focused pane (`getActiveTerminalRef()?.pasteClipboard()`)
- Top-bar Paste button must not suppress native click/touch user activation required by the browser Clipboard API
- Removing Paste and Select Mode from `TerminalAccessoryBar` must leave the right fixed controls (`Keyboard` toggle and `Check` Done button) intact and aligned

---

### Task 1: Remove Paste & Select Mode from `TerminalAccessoryBar` and Expose `pasteClipboard` on `WebTerminalView`

**Files:**
- Modify: `frontend/src/components/terminal/TerminalAccessoryBar.tsx`
- Modify: `frontend/src/components/WebTerminalView.tsx:148-163`, `2707-2747`, `2915-2932`
- Modify: `tests/terminalAccessoryBar.test.ts`
- Modify: `tests/terminalMobileSelection.test.ts`

**Interfaces:**
- Produces:
  - `pasteClipboard: () => void` on `WebTerminalHandle` in `WebTerminalView.tsx`
  - Clean `TerminalAccessoryBar` without `ClipboardPaste` or `TextSelect` buttons

- [x] **Step 1: Update unit tests in `tests/terminalAccessoryBar.test.ts` and `tests/terminalMobileSelection.test.ts`**

1. In `tests/terminalAccessoryBar.test.ts`, replace the `'Paste button preserves native touch and mouse events for clipboard user activation'` test with:
   ```typescript
   test('TerminalAccessoryBar does not render Paste or Select Mode buttons (moved to top title bar)', () => {
     const content = fs.readFileSync(accessoryBarPath, 'utf-8');
     expect(content).not.toContain('<ClipboardPaste');
     expect(content).not.toContain('<TextSelect');
     expect(content).not.toContain('onClick={onPaste}');
     expect(content).not.toContain('onClick={hasSelection ? onCopy : onToggleSelectMode}');
   });
   ```
2. In `tests/terminalMobileSelection.test.ts`, update the first test `'verifies TerminalAccessoryBar provides paste, copy, and select mode buttons in right fixed controls'` to verify that `TerminalAccessoryBar` no longer renders Paste or Select Mode buttons and instead `WebTerminalView` exposes `pasteClipboard` on `WebTerminalHandle` and renders Paste and Select Mode in the header:
   ```typescript
   it('verifies Paste and Select Mode are removed from TerminalAccessoryBar and exposed via WebTerminalView top bar / handle', () => {
     const accessoryContent = fs.readFileSync(accessoryBarPath, 'utf8');
     expect(accessoryContent).not.toContain('<ClipboardPaste');
     expect(accessoryContent).not.toContain('<TextSelect');

     const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf8');
     expect(webTerminalContent).toContain('pasteClipboard: () => void');
     expect(webTerminalContent).toContain('pasteClipboard: handlePasteClipboard');
   });
   ```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/terminalAccessoryBar.test.ts tests/terminalMobileSelection.test.ts`
Expected: FAIL because `TerminalAccessoryBar.tsx` still contains `<ClipboardPaste` and `<TextSelect`

- [x] **Step 3: Update `TerminalAccessoryBar.tsx` and `WebTerminalView.tsx`**

1. In `frontend/src/components/terminal/TerminalAccessoryBar.tsx`:
   - Remove the `{/* Action: Paste */}` button block and its preceding `<div className="h-4 w-[1px] bg-[var(--border-subtle)] mx-0.5" />` (keep a single divider before the Mode Toggle button if appropriate, or keep the Mode Toggle button directly after the navigation keys).
   - In `{/* Right Fixed Controls */}`, remove the `{/* Select Mode / Copy Button */}` block (`<button ... onClick={hasSelection ? onCopy : onToggleSelectMode} ...>`), leaving only the `Keyboard` toggle button and the `Check` (`webTerminal.done`) dismiss button.
   - Remove unused `Copy`, `ClipboardPaste`, `TextSelect` icon imports from `lucide-react`.
2. In `frontend/src/components/WebTerminalView.tsx`:
   - Import `ClipboardPaste` from `'lucide-react'`.
   - Add `pasteClipboard: () => void;` to `export interface WebTerminalHandle`.
   - In `useImperativeHandle(ref, () => ({ ... }))`, add `pasteClipboard: handlePasteClipboard,` and include `handlePasteClipboard` in the dependency array.
   - In `WebTerminalView`'s own header (`!hideHeader`, right before the Select Mode button at `~line 2915`), add a Paste button calling `handlePasteClipboard` with `<ClipboardPaste className="w-3.5 h-3.5" />`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalAccessoryBar.test.ts tests/terminalMobileSelection.test.ts`
Expected: PASS

---

### Task 2: Add Paste Button to `UnifiedTerminalView` Top Bar & Verify Mobile Visibility

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `tests/terminalUnifiedTopBarControls.test.ts`

**Interfaces:**
- Consumes: `getActiveTerminalRef()?.pasteClipboard()`, `handleToggleSelectMode`
- Produces:
  - `data-testid="top-paste-btn"` and `data-testid="top-select-mode-btn"` in `UnifiedTerminalView.tsx` visible on both mobile and desktop when `subTab === 'interactive'`
  - All other top-bar buttons hidden on mobile (`hidden sm:inline-flex` / `hidden lg:inline-flex`) and available in `data-testid="mobile-more-menu"`

- [x] **Step 1: Write the failing test in `tests/terminalUnifiedTopBarControls.test.ts`**

Update `'UnifiedTerminalView keeps only Select Mode directly on mobile title bar while collapsing others to sm:inline-flex'` in `tests/terminalUnifiedTopBarControls.test.ts` to verify both `top-paste-btn` and `top-select-mode-btn` are present and directly visible on mobile while other buttons use `hidden sm:inline-flex`:

```typescript
  it('UnifiedTerminalView keeps only Paste and Select Mode directly on mobile title bar while collapsing others to sm:inline-flex', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bClipboardPaste\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toContain('data-testid="top-paste-btn"');
    expect(content).toContain('data-testid="top-select-mode-btn"');
    expect(content).toContain('getActiveTerminalRef()?.pasteClipboard()');

    // Paste and Select Mode buttons must NOT have hidden sm:inline-flex
    expect(content).not.toMatch(/data-testid="top-paste-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).not.toMatch(/data-testid="top-select-mode-btn"[^>]*hidden\s+sm:inline-flex/);

    // Desktop secondary buttons have hidden sm:inline-flex
    expect(content).toMatch(/data-testid="unified-open-scripts-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toMatch(/data-testid="split-terminal-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toMatch(/data-testid="fullscreen-toggle-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toContain('data-testid="mobile-more-btn"');
    expect(content).toContain('sm:hidden');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalUnifiedTopBarControls.test.ts`
Expected: FAIL with missing `ClipboardPaste` / `data-testid="top-paste-btn"`

- [x] **Step 3: Add Paste button and `data-testid`s to `UnifiedTerminalView.tsx`**

1. In `frontend/src/components/UnifiedTerminalView.tsx`:
   - Import `ClipboardPaste` from `'lucide-react'`.
   - Add handler:
     ```tsx
     const handlePasteClipboard = useCallback(() => {
       getActiveTerminalRef()?.pasteClipboard();
     }, [getActiveTerminalRef]);
     ```
   - In the `subTab === 'interactive'` action buttons section (`~line 750`), render the Paste button right beside the Select Mode button:
     ```tsx
     {/* Paste Clipboard */}
     <button
       type="button"
       data-testid="top-paste-btn"
       onClick={handlePasteClipboard}
       className="p-1 sm:p-1.5 rounded-lg bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] active:scale-95 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-all flex items-center space-x-1 shrink-0"
       title={t('webTerminal.paste', '粘贴')}
     >
       <ClipboardPaste className="w-3.5 h-3.5" />
       <span className="text-[11px] hidden xl:inline">
         {t('webTerminal.paste', '粘贴')}
       </span>
     </button>

     {/* Select / Copy Mode Toggle */}
     <button
       type="button"
       data-testid="top-select-mode-btn"
       onClick={handleToggleSelectMode}
       className={`p-1 sm:p-1.5 rounded-lg border transition-all flex items-center space-x-1 shrink-0 ${
         isSelectMode
           ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40 shadow-sm ring-1 ring-amber-500/30'
           : 'bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]'
       }`}
       title={isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
     >
       <TextSelect className="w-3.5 h-3.5" />
       <span className="text-[11px] hidden xl:inline">
         {isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
       </span>
     </button>
     ```

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/terminalAccessoryBar.test.ts tests/terminalMobileSelection.test.ts tests/terminalUnifiedTopBarControls.test.ts && npm run build:frontend`
Expected: PASS (all tests in the 3 suites pass, frontend Vite build succeeds)
