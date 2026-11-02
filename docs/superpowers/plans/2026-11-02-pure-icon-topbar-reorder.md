# Pure Icon Top Bar & Desktop High-Frequency Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the terminal top bar by converting all action buttons to pure icon buttons (removing embedded text labels) and reordering desktop buttons so that high-frequency actions ("Paste" and "Select Mode") appear first, matching their prominent placement on mobile.

**Architecture:** In `UnifiedTerminalView.tsx` (and `WebTerminalView.tsx`), reorder the interactive action buttons so that the high-frequency edit group (`[Paste]` and `[Select Mode]`) is rendered at the start of the action buttons container, followed by a subtle desktop divider (`hidden sm:block`), then window tools (`[Split]` and `[Scripts]`), session controls (`[Zoom Out]`, `[Zoom In]`, `[Reconnect]`, `[Reset]`), and global settings (`[Fullscreen]`, `[GitHub]`, `[Language]`, `[Theme]`, `[Logout]`). Remove embedded text `<span>` labels from the Scripts, Paste, and Select Mode buttons so all buttons are uniform 28x28px square icon buttons with descriptive `title` tooltips.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide Icons, Jest

**Spec:** In-chat bounded design approved in session (2026-11-02)

## Global Constraints

- Targeted test runs only during development: `npm test -- tests/terminalUnifiedTopBarControls.test.ts tests/terminalScriptIntegration.test.ts`
- All buttons must retain accurate `title` attributes for tooltips and accessibility
- All test IDs (`top-paste-btn`, `top-select-mode-btn`, `split-terminal-btn`, `unified-open-scripts-btn`, `fullscreen-toggle-btn`, `mobile-more-btn`) must be preserved
- On mobile (`< 640px`), only Paste, Select Mode, and the More menu trigger remain visible; secondary buttons remain `hidden sm:inline-flex`

## Review Focus

- The relative source code order in `UnifiedTerminalView.tsx` must place `top-paste-btn` and `top-select-mode-btn` before `split-terminal-btn` and `unified-open-scripts-btn`
- In `UnifiedTerminalView.tsx` and `WebTerminalView.tsx`, the action buttons (`top-paste-btn`, `top-select-mode-btn`, `unified-open-scripts-btn`, `open-scripts-btn`) must not contain embedded text `<span>` tags
- Button dimensions and spacing must remain visually balanced (`p-1 sm:p-1.5 rounded-lg flex items-center justify-center shrink-0`)
- Hover and active states (such as `isSelectMode` amber ring and `isSplitMode` indigo tint) must remain intact without layout distortion

---

### Task 1: Reorder Desktop Action Buttons & Strip Text Labels in `UnifiedTerminalView` and `WebTerminalView`

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:670-800`
- Modify: `frontend/src/components/WebTerminalView.tsx:2905-2945`
- Modify: `tests/terminalUnifiedTopBarControls.test.ts`

**Interfaces:**
- Consumes: `handlePasteClipboard`, `handleToggleSelectMode`, `isSelectMode`, `isSplitMode`, `openSplitPane`, `closeSplitPane`
- Produces:
  - High-frequency first order: `top-paste-btn` -> `top-select-mode-btn` -> desktop divider -> `split-terminal-btn` -> `unified-open-scripts-btn` -> session controls
  - Pure icon buttons (no `<span className="...">{t(...)}</span>` inside action buttons)

- [x] **Step 1: Write the failing tests in `tests/terminalUnifiedTopBarControls.test.ts`**

Update `tests/terminalUnifiedTopBarControls.test.ts` to assert that:
1. `top-paste-btn` and `top-select-mode-btn` appear before `split-terminal-btn` and `unified-open-scripts-btn` in `UnifiedTerminalView.tsx`.
2. Action buttons do not contain embedded text `<span>` labels.

```typescript
  it('UnifiedTerminalView reorders desktop action buttons with Paste and Select Mode first, and strips text labels for pure icon presentation', () => {
    // 1. Order verification: paste and select mode come before split and scripts
    const idxPaste = content.indexOf('data-testid="top-paste-btn"');
    const idxSelect = content.indexOf('data-testid="top-select-mode-btn"');
    const idxSplit = content.indexOf('data-testid="split-terminal-btn"');
    const idxScripts = content.indexOf('data-testid="unified-open-scripts-btn"');

    expect(idxPaste).toBeGreaterThan(0);
    expect(idxSelect).toBeGreaterThan(idxPaste);
    expect(idxSplit).toBeGreaterThan(idxSelect);
    expect(idxScripts).toBeGreaterThan(idxSplit);

    // 2. Pure icon check: buttons do not contain embedded text spans
    const pasteBlock = content.slice(idxPaste, idxSelect);
    expect(pasteBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);

    const selectBlock = content.slice(idxSelect, idxSplit);
    expect(selectBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);

    const scriptsBlock = content.slice(idxScripts, idxScripts + 350);
    expect(scriptsBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalUnifiedTopBarControls.test.ts`
Expected: FAIL because `top-paste-btn` is currently after `split-terminal-btn` and contains embedded `<span ...>` text tags.

- [x] **Step 3: Reorder and simplify buttons in `UnifiedTerminalView.tsx` and `WebTerminalView.tsx`**

1. In `frontend/src/components/UnifiedTerminalView.tsx`:
   - Move `{/* Paste Clipboard */}` and `{/* Select / Copy Mode Toggle */}` to the top of `subTab === 'interactive'` (immediately after `<>`).
   - Remove `<span className="text-[11px] hidden xl:inline">...</span>` from `top-paste-btn` and `top-select-mode-btn`.
   - Ensure both buttons have `flex items-center justify-center shrink-0` styling.
   - Insert desktop divider `<div className="h-3.5 w-px bg-[var(--border-subtle)] mx-0.5 hidden sm:block shrink-0" />` immediately following the Select Mode button.
   - Place `{/* Split Terminal Toggle Button */}` next.
   - Place `{/* Script Library Drawer Toggle */}` after Split Terminal, removing its `<span className="hidden xl:inline font-sans text-[11px]">{t('scripts.title', '常用脚本库')}</span>`.
   - Follow with Zoom Out, Zoom In, Reconnect, and Reset Terminal Session buttons.
2. In `frontend/src/components/WebTerminalView.tsx` (lines ~2905-2945):
   - Move the Paste button and Select Mode button before `open-scripts-btn`, Zoom, Reconnect, and Reset.
   - Remove `<span className="text-[11px] hidden xl:inline">...</span>` from the Paste button, Select Mode button, and `open-scripts-btn`.

- [x] **Step 4: Run tests and frontend build to verify everything passes**

Run: `npm test -- tests/terminalUnifiedTopBarControls.test.ts tests/terminalScriptIntegration.test.ts tests/terminalMobileSelection.test.ts && npm run build:frontend`
Expected: PASS (all tests pass, frontend Vite build succeeds)
