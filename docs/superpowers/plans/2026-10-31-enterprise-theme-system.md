# Enterprise Light & Dark Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the entire `gt-hub` frontend theme architecture into a unified, Linear/Vercel/GitHub-inspired enterprise design system with Indigo as the primary brand color and 100% consistent Light and Dark surfaces across all views, modals, drawers, Xterm terminal, Monaco editor, Markdown renderer, and ANSI log viewers.

**Architecture:** Establish a semantic CSS variable Design Token hierarchy in `frontend/src/index.css` and `frontend/tailwind.config.js` (covering canvas, surface, surface-sub, elevated, terminal, control, text, and borders), remove the brittle `:root:not(.dark)` utility-override hack, align Xterm/Monaco/Markdown/ANSI log palettes with the semantic tokens, and systematically migrate all 20+ React views, modals, and drawers off hardcoded dark hex/opacity classes (`#121316`, `#18181b`, `#0c1017`, `#090d16`, `#121214`, `bg-white/[0.04]`, `hover:text-white`).

**Tech Stack:** React 18, TypeScript, Tailwind CSS 3, Xterm.js (`@xterm/xterm`), Monaco Editor (`@monaco-editor/react`), Jest (`ts-jest`).

**Spec:** `docs/superpowers/specs/2026-10-31-enterprise-theme-system-design.md`

## Global Constraints

- Brand primary interactive color is Indigo (`#4F46E5` Light / `#6366F1` Dark); remove `indigo-to-purple` gradients in `.ui-btn-primary` and replace Emerald brand accents on `LoginView.tsx` and `App.tsx` with Indigo (`emerald` remains strictly for semantic online/success states).
- Remove the `:root:not(.dark)` block in `frontend/src/index.css` that overrides `.text-slate-100`, `.text-slate-200`, `.text-slate-300`, `.text-slate-400`, `.text-slate-500`, and `.border-white/*`.
- Eliminate hardcoded dark hex colors (`#121316`, `#18181b`, `#27272a`, `#0c1017`, `#090d16`, `#121214`, `#160E12`) across all UI views, modals, and drawers in favor of semantic tokens (`--bg-canvas`, `--bg-surface`, `--bg-surface-sub`, `--bg-elevated`, `--bg-terminal`, `--bg-control`, `--bg-control-hover`).
- Always run targeted Jest tests with `--detectOpenHandles --forceExit` (`npm test -- tests/<file>.test.ts`).

## Review Focus

- **Light-mode ANSI log legibility in `TaskLogModal` and `CronLogModal`:** `parseAnsiToSegments` returns classes like `text-emerald-400`, `text-amber-400`, and `text-slate-100` (which unit tests in `tests/ansiLogFormatter.test.ts` assert directly). In Light mode on a `#FFFFFF` `--bg-terminal` background, those 400/100 shades are unreadable unless `.ansi-log-container` scopes high-contrast light-mode overrides in `index.css` while keeping `parseAnsiToSegments` pure return values intact.
- **Xterm Light palette contrast for ANSI White (`37`) and Bright White (`97`):** CLI tools that output explicit ANSI white or yellow on a `#FFFFFF` terminal canvas become invisible if `white` is `#F1F5F9` or `yellow` is `#F59E0B`; `LIGHT_TERMINAL_THEME` must use darkened WCAG-compliant shades (`white: '#475569'`, `yellow: '#B45309'`, `brightWhite: '#0F172A'`).
- **Existing static source-regex tests in `tests/`:** Several existing Jest tests inspect component source code for specific substrings (e.g. `tests/frontendCronModals.test.ts:71`, `tests/terminalMobileFullscreenHeader.test.ts:20,36`, `tests/terminalFileManagerHiddenFiles.test.ts:46`, `tests/terminalAccessoryBar.test.ts:25,30`). Every task modifying those files must run and keep those tests green.
- **Secondary button hover invisibility in Light mode:** Replacing `bg-white/[0.04]` without also replacing `hover:text-white` causes buttons to turn white-on-white when hovered in Light mode; all secondary/icon controls must use `text-[var(--text-secondary)] hover:text-[var(--text-primary)]`.
- **Markdown inline code and table row hover in Light mode:** `markdownRenderer.ts` previously hardcoded `text-amber-300`, `bg-black/20`, `text-slate-200`, and `hover:bg-white/5`; in Light mode these must use semantic variables (`var(--code-bg)`, `var(--code-text)`, `var(--text-primary)`, `var(--bg-control-hover)`) without breaking `tests/markdownRenderer.test.ts`.

---

### Task 1: Enterprise Design Tokens, Tailwind Semantic Config & Core `.ui-*` Components

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/tailwind.config.js`
- Create: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Produces:
  - CSS custom properties on `:root` and `:root.dark, :root[data-theme="dark"]`:
    `--bg-canvas`, `--bg-surface`, `--bg-surface-sub`, `--bg-elevated`, `--bg-terminal`, `--bg-control`, `--bg-control-hover`, `--bg-surface-hover`, `--bg-overlay`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border-subtle`, `--border-default`, `--border-hover`, `--border-focus`, `--code-bg`, `--code-text`, `--scrollbar-thumb`, `--scrollbar-thumb-hover`
  - Component classes in `frontend/src/index.css`: `.ui-card`, `.ui-card-sub`, `.ui-elevated`, `.ui-tab-container`, `.ui-tab-pill`, `.ui-tab-pill-active`, `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-icon-btn`, `.ui-input`, `.ansi-log-container`
  - Tailwind semantic theme extensions in `frontend/tailwind.config.js`

- [ ] **Step 1: Create `tests/enterpriseThemeSystem.test.ts` with failing tests for Design Tokens and CSS cleanup**

```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('Enterprise Light & Dark Theme System Architecture', () => {
  const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');
  const tailwindConfigPath = path.resolve(__dirname, '../frontend/tailwind.config.js');

  test('index.css defines complete Light and Dark semantic surface, text, and border tokens', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    const requiredTokens = [
      '--bg-canvas:',
      '--bg-surface:',
      '--bg-surface-sub:',
      '--bg-elevated:',
      '--bg-terminal:',
      '--bg-control:',
      '--bg-control-hover:',
      '--bg-overlay:',
      '--text-primary:',
      '--text-secondary:',
      '--text-muted:',
      '--border-subtle:',
      '--border-default:',
      '--border-hover:',
      '--border-focus:',
    ];
    for (const token of requiredTokens) {
      expect(css).toContain(token);
    }
    // Verify Dark canvas is #090D16 and Light canvas is #F8FAFC
    expect(css).toContain('#090D16');
    expect(css).toContain('#F8FAFC');
  });

  test('index.css removes the brittle :root:not(.dark) slate/border override hack and purple button gradient', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    expect(css).not.toContain('.border-white\\/\\[0\\.08\\]');
    expect(css).not.toContain('to-purple-600');
    expect(css).toContain('.ui-elevated');
    expect(css).toContain('.ui-icon-btn');
    expect(css).toContain('.ansi-log-container');
  });

  test('tailwind.config.js extends semantic colors mapped to CSS variables', () => {
    const config = fs.readFileSync(tailwindConfigPath, 'utf-8');
    expect(config).toContain('var(--bg-canvas)');
    expect(config).toContain('var(--bg-surface)');
    expect(config).toContain('var(--bg-elevated)');
    expect(config).toContain('var(--bg-terminal)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts`
Expected: FAIL (`--bg-elevated:` not found, `.border-white\/\[0\.08\]` still present)

- [ ] **Step 3: Update `frontend/tailwind.config.js` and `frontend/src/index.css` with the Spec Section 3 tokens and component classes**

In `frontend/tailwind.config.js`, extend `theme.extend.colors` with:
- `canvas: 'var(--bg-canvas)'`
- `surface: 'var(--bg-surface)'`
- `'surface-sub': 'var(--bg-surface-sub)'`
- `elevated: 'var(--bg-elevated)'`
- `terminal: 'var(--bg-terminal)'`
- `control: 'var(--bg-control)'`
- `'control-hover': 'var(--bg-control-hover)'`

In `frontend/src/index.css`:
- Set `:root` Light tokens and `:root.dark, :root[data-theme="dark"]` Dark tokens exactly to the Spec Section 3.1 values (`--bg-canvas: #F8FAFC` / `#090D16`, `--bg-surface: #FFFFFF` / `#0F1523`, `--bg-surface-sub: #F1F5F9` / `#151D2E`, `--bg-elevated: #FFFFFF` / `#182235`, `--bg-terminal: #FFFFFF` / `#090D16`, `--bg-control: rgba(15, 23, 42, 0.04)` / `rgba(255, 255, 255, 0.05)`, `--bg-control-hover: rgba(15, 23, 42, 0.08)` / `rgba(255, 255, 255, 0.10)`, `--bg-overlay: rgba(15, 23, 42, 0.45)` / `rgba(2, 6, 23, 0.72)`, `--border-subtle: #E2E8F0` / `rgba(255, 255, 255, 0.08)`, `--border-default: #CBD5E1` / `rgba(255, 255, 255, 0.14)`, `--border-hover: #94A3B8` / `rgba(255, 255, 255, 0.22)`, `--border-focus: #4F46E5` / `#6366F1`).
- Remove lines 81–97 (`:root:not(.dark)` override block).
- Add `.ansi-log-container` light-mode high-contrast rules (`:root:not(.dark) .ansi-log-container .text-emerald-400 { color: #047857; }`, `.text-rose-400 { color: #BE123C; }`, `.text-amber-400 { color: #B45309; }`, `.text-indigo-400 { color: #4338CA; }`, `.text-cyan-400 { color: #0E7490; }`, `.text-purple-400 { color: #6D28D9; }`, `.text-slate-100, .text-slate-200, .text-white { color: #0F172A; }`, `.text-slate-400 { color: #475569; }`).
- Update `@layer components` with `.ui-card`, `.ui-card-sub`, `.ui-elevated`, `.ui-tab-container`, `.ui-tab-pill`, `.ui-tab-pill-active`, `.ui-btn-primary` (solid `bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700`), `.ui-btn-secondary`, `.ui-icon-btn`, and `.ui-input` per Spec Section 3.2, preserving all `.terminal-select-mode` and `.xterm` rules intact.

- [ ] **Step 4: Run tests to verify Task 1 passes alongside existing CSS tests**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts tests/terminalTouchScroll.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/tailwind.config.js tests/enterpriseThemeSystem.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): establish enterprise light and dark design tokens and core UI classes

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Brand Unification on App Entry, LoginView, Monaco Editor & Markdown Renderer

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/LoginView.tsx`
- Modify: `frontend/src/utils/monacoTheme.ts`
- Modify: `frontend/src/utils/markdownRenderer.ts`
- Modify: `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`
- Modify: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Consumes: CSS variables from Task 1 (`--bg-canvas`, `--bg-surface`, `--bg-surface-sub`, `--code-bg`, `--code-text`, `--text-primary`, `--text-secondary`, `--border-subtle`, `--border-default`)
- Produces:
  - `defineGeminiProxyTheme(monaco)` in `frontend/src/utils/monacoTheme.ts` with `gemini-proxy-dark` (`editor.background: '#090D16'`) and `gemini-proxy-light` (`editor.background: '#FFFFFF'`)
  - Dual-theme semantic HTML output in `renderMarkdownToHtml` (`frontend/src/utils/markdownRenderer.ts`)

- [ ] **Step 1: Add failing tests in `tests/enterpriseThemeSystem.test.ts` for LoginView Indigo brand unification, Monaco theme alignment, and Markdown semantic rendering**

```typescript
  test('App.tsx and LoginView.tsx use Indigo as primary brand accent instead of Emerald', () => {
    const appContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/App.tsx'), 'utf-8');
    const loginContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/LoginView.tsx'), 'utf-8');

    expect(appContent).toContain('text-indigo-500');
    expect(loginContent).toContain('bg-indigo-600');
    expect(loginContent).not.toContain('bg-emerald-600');
  });

  test('monacoTheme.ts aligns dark editor background with #090D16 and light editor background with #FFFFFF', () => {
    const monacoContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/monacoTheme.ts'), 'utf-8');
    expect(monacoContent).toContain('#090D16');
    expect(monacoContent).toContain('#FFFFFF');
  });

  test('markdownRenderer.ts uses semantic CSS variables instead of hardcoded dark slate classes', () => {
    const mdContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/markdownRenderer.ts'), 'utf-8');
    expect(mdContent).toContain('var(--text-primary)');
    expect(mdContent).toContain('var(--code-bg)');
    expect(mdContent).not.toContain('bg-black/20');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts`
Expected: FAIL (`LoginView.tsx` still contains `bg-emerald-600`, `monacoTheme.ts` has `#020617`, `markdownRenderer.ts` has `bg-black/20`)

- [ ] **Step 3: Update `App.tsx`, `LoginView.tsx`, `monacoTheme.ts`, `markdownRenderer.ts`, and `TerminalMarkdownViewer.tsx`**

1. `frontend/src/App.tsx`: Change `Loader2` class from `text-emerald-400` to `text-indigo-500`.
2. `frontend/src/components/LoginView.tsx`:
   - Logo badge (`gt`): `bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 dark:text-indigo-400`
   - Secret key input: `bg-[var(--bg-surface-sub)] border border-[var(--border-default)] focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30`
   - Error banner: `bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400`
   - Submit button: `bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-sm`
3. `frontend/src/utils/monacoTheme.ts`:
   - In `gemini-proxy-dark`: set `'editor.background': '#090D16'`, `'editor.lineHighlightBackground': '#151D2E80'`, `'editorLineNumber.foreground': '#475569'`, `'editorLineNumber.activeForeground': '#94A3B8'`.
   - In `gemini-proxy-light`: keep `'editor.background': '#FFFFFF'`, `'editor.lineHighlightBackground': '#F1F5F9'`, `'editorLineNumber.foreground': '#94A3B8'`, `'editorLineNumber.activeForeground': '#334155'`.
4. `frontend/src/utils/markdownRenderer.ts` & `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`:
   - Inline code: `bg-[var(--code-bg)] text-indigo-600 dark:text-amber-300 border border-[var(--border-subtle)]`
   - Links: `text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2`
   - Code block header: `bg-[var(--bg-surface-sub)] text-[var(--text-secondary)] border-b border-[var(--border-subtle)]`
   - Copy code button: `bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]`
   - Code `<pre>`: `bg-[var(--code-bg)] text-[var(--code-text)]`
   - Headings 1–6, paragraphs, lists, table cells, and blockquotes: replace `text-slate-100/200/300/400`, `bg-slate-800/20`, and `hover:bg-white/5` with `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, `bg-[var(--bg-surface-sub)]`, and `hover:bg-[var(--bg-control-hover)]`.

- [ ] **Step 4: Run tests to verify Task 2 passes**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts tests/frontendLoginView.test.ts tests/markdownRenderer.test.ts tests/fileManagerMarkdownAndPdf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/LoginView.tsx frontend/src/utils/monacoTheme.ts frontend/src/utils/markdownRenderer.ts frontend/src/components/terminal/TerminalMarkdownViewer.tsx tests/enterpriseThemeSystem.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): unify Indigo brand on LoginView and adapt Monaco and Markdown themes

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Unified Workbench Top Bar, Host Selector & Terminal Views (`UnifiedTerminalView`, `TerminalHostSelector`, `WebTerminalView`, `TerminalAccessoryBar`, `TerminalLogsView`, Sub-Components)

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `frontend/src/components/terminal/TerminalHostSelector.tsx`
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/components/terminal/TerminalAccessoryBar.tsx`
- Modify: `frontend/src/components/TerminalLogsView.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalEmptyState.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx`
- Modify: `tests/terminalMobileFullscreenHeader.test.ts`
- Modify: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Consumes: CSS variables from Task 1
- Produces:
  - Calibrated `DARK_TERMINAL_THEME` (`background: '#090D16'`) and `LIGHT_TERMINAL_THEME` (`background: '#FFFFFF'`, high-contrast WCAG ANSI colors) in `frontend/src/components/WebTerminalView.tsx`
  - Fully theme-adaptive Top Bar, More Menu, Host Selector Popover/Modal, and Terminal controls

- [ ] **Step 1: Add failing test in `tests/enterpriseThemeSystem.test.ts` for Xterm palettes and Top Bar / HostSelector theme tokens**

```typescript
  test('WebTerminalView defines calibrated DARK_TERMINAL_THEME (#090D16) and LIGHT_TERMINAL_THEME (#FFFFFF) and UnifiedTerminalView removes hardcoded #18181b menu', () => {
    const webTermContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    const unifiedContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx'), 'utf-8');

    expect(webTermContent).toContain("background: '#090D16'");
    expect(webTermContent).toContain("background: '#FFFFFF'");
    expect(webTermContent).not.toContain('bg-[#160E12]');
    expect(unifiedContent).not.toContain('bg-[#18181b]');
    expect(unifiedContent).not.toContain('border-[#27272a]');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts`
Expected: FAIL (`WebTerminalView.tsx` still has `#090A0F` and `bg-[#160E12]`, `UnifiedTerminalView.tsx` still has `bg-[#18181b]`)

- [ ] **Step 3: Migrate `UnifiedTerminalView.tsx`, `TerminalHostSelector.tsx`, `WebTerminalView.tsx`, `TerminalAccessoryBar.tsx`, `TerminalLogsView.tsx`, and terminal sub-components**

1. `frontend/src/components/WebTerminalView.tsx`:
   - Update `DARK_TERMINAL_THEME` and `LIGHT_TERMINAL_THEME` to Spec Section 5.1 exact hex values (`#090D16` dark background/black/cursorAccent, `cursor: '#6366F1'`, and high-contrast light ANSI palette with `white: '#475569'`, `yellow: '#B45309'`, `brightWhite: '#0F172A'`).
   - Replace hardcoded dark header buttons (`bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border-white/[0.06]`) with `bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]`.
   - Keep `standalone ? 'hidden sm:inline-flex bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border-indigo-500/30'` compatible with `tests/terminalMobileFullscreenHeader.test.ts` (update test assertion if needed so both light/dark classes are verified).
   - Replace offline floating banner `bg-[#160E12]/95 border-rose-500/40 text-rose-300` with `bg-[var(--bg-elevated)]/95 border-rose-500/40 text-rose-600 dark:text-rose-300`.
   - Replace copy toast `bg-slate-900/90` with `bg-[var(--bg-elevated)]/95 border border-[var(--border-default)] text-[var(--text-primary)]`.
2. `frontend/src/components/UnifiedTerminalView.tsx`:
   - Top header bar: `bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]`.
   - More menu dropdown (line 817): replace `bg-[#18181b] border border-[#27272a] ... divide-white/[0.06] text-slate-300` with `bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl shadow-xl py-1 z-50 divide-y divide-[var(--border-subtle)] text-xs text-[var(--text-primary)]`.
   - All toolbar icon buttons & status badges: use `bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]` and `text-emerald-700 dark:text-emerald-400`.
3. `frontend/src/components/terminal/TerminalHostSelector.tsx`:
   - Selector trigger, quick-add button, dropdown popover, and Add Node modal: replace `bg-slate-900`, `bg-black/60`, `bg-white/[0.04]`, `text-slate-200`, `text-white`, `border-white/[0.08]` with `bg-[var(--bg-elevated)]`, `bg-[var(--bg-surface-sub)]`, `bg-[var(--bg-control)]`, `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, `border-[var(--border-default)]`, `border-[var(--border-subtle)]`.
4. `frontend/src/components/terminal/TerminalAccessoryBar.tsx`:
   - Keep `bg-amber-600` for active Shift and `bg-emerald-500/15` for OK button (required by `tests/terminalAccessoryBar.test.ts`), and adapt text colors (`text-emerald-700 dark:text-emerald-300`, `text-rose-600 dark:text-rose-300`) and standard key caps (`bg-[var(--bg-control)] hover:bg-[var(--bg-control-hover)] text-[var(--text-primary)] border-[var(--border-subtle)]`).
5. `frontend/src/components/TerminalLogsView.tsx`, `TerminalEmptyState.tsx`, `TerminalMagnifierBubble.tsx`, `TerminalSelectionToolbar.tsx`:
   - Replace hardcoded dark backgrounds and `text-slate-200` / `text-white` with `bg-[var(--bg-elevated)]`, `bg-[var(--bg-surface)]`, `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, and `border-[var(--border-default)]`.
6. Update `tests/terminalMobileFullscreenHeader.test.ts` lines 20 and 36 if they match old `bg-white/[0.04]` / `text-indigo-300` strings to match the updated semantic classes.

- [ ] **Step 4: Run tests to verify Task 3 and all terminal header/accessory tests pass**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts tests/terminalMobileFullscreenHeader.test.ts tests/terminalAccessoryBar.test.ts tests/terminalHostSelector.test.ts tests/terminalEmptyState.test.ts tests/terminalUnifiedTopBarControls.test.ts tests/terminalUnifiedLayout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/UnifiedTerminalView.tsx frontend/src/components/terminal/TerminalHostSelector.tsx frontend/src/components/WebTerminalView.tsx frontend/src/components/terminal/TerminalAccessoryBar.tsx frontend/src/components/TerminalLogsView.tsx frontend/src/components/terminal/components/TerminalEmptyState.tsx frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx tests/terminalMobileFullscreenHeader.test.ts tests/enterpriseThemeSystem.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): adapt UnifiedTerminalView, HostSelector, Xterm palettes, and terminal controls to dual theme

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cron View, Task View, Modals & Script Drawer Migration (`TerminalCronView`, `TerminalTaskView`, `CronJobModal`, `CronLogModal`, `CreateTaskModal`, `TaskLogModal`, `TerminalScriptDrawer`)

**Files:**
- Modify: `frontend/src/components/terminal/TerminalCronView.tsx`
- Modify: `frontend/src/components/terminal/TerminalTaskView.tsx`
- Modify: `frontend/src/components/terminal/components/CronJobModal.tsx`
- Modify: `frontend/src/components/terminal/components/CronLogModal.tsx`
- Modify: `frontend/src/components/terminal/components/CreateTaskModal.tsx`
- Modify: `frontend/src/components/terminal/components/TaskLogModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalScriptDrawer.tsx`
- Modify: `tests/frontendCronModals.test.ts`
- Modify: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Consumes: `--bg-canvas`, `--bg-surface`, `--bg-surface-sub`, `--bg-elevated`, `--bg-terminal`, `--bg-control`, `--bg-control-hover`, `--bg-overlay`, `.ansi-log-container` from Task 1
- Produces: Fully theme-adaptive Cron/Task views, modals, ANSI log viewports, and Script Drawer

- [ ] **Step 1: Add failing test in `tests/enterpriseThemeSystem.test.ts` verifying removal of hardcoded dark hex backgrounds in Cron, Task, Modals, and Script Drawer**

```typescript
  test('Cron, Task views, Modals, and ScriptDrawer contain no hardcoded dark hex backgrounds (#121316, #18181b, #0c1017, #090d16, #121214)', () => {
    const filesToCheck = [
      '../frontend/src/components/terminal/TerminalCronView.tsx',
      '../frontend/src/components/terminal/TerminalTaskView.tsx',
      '../frontend/src/components/terminal/components/CronJobModal.tsx',
      '../frontend/src/components/terminal/components/CronLogModal.tsx',
      '../frontend/src/components/terminal/components/CreateTaskModal.tsx',
      '../frontend/src/components/terminal/components/TaskLogModal.tsx',
      '../frontend/src/components/terminal/TerminalScriptDrawer.tsx',
    ];

    for (const relPath of filesToCheck) {
      const content = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
      expect(content).not.toMatch(/#(121316|18181b|0c1017|090d16|121214)/i);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts`
Expected: FAIL (`TerminalCronView.tsx` has `#121316`, modals have `#18181b`, etc.)

- [ ] **Step 3: Migrate `TerminalCronView.tsx`, `TerminalTaskView.tsx`, all 4 Modals, and `TerminalScriptDrawer.tsx`**

1. `frontend/src/components/terminal/TerminalCronView.tsx` & `TerminalTaskView.tsx`:
   - Root container: `bg-[var(--bg-canvas)] text-[var(--text-primary)]` (replacing `bg-[#121316] text-slate-200`).
   - Top toolbar: `bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]` (replacing `bg-black/20 border-white/[0.08]`).
   - Desktop table & mobile cards: use `bg-[var(--bg-surface)]`, `bg-[var(--bg-surface-sub)]`, `border-[var(--border-subtle)]`, `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, `hover:bg-[var(--bg-control-hover)]`.
   - Semantic status badges: `text-emerald-700 dark:text-emerald-400`, `text-amber-700 dark:text-amber-400`, `text-rose-700 dark:text-rose-400`, `text-indigo-700 dark:text-indigo-400`.
   - Preserve `sm:hidden`, `hidden sm:block`, and `hidden sm:grid` responsive classes verified by `tests/frontendMobileCronAndTaskViews.test.ts`.
2. `frontend/src/components/terminal/components/CronJobModal.tsx` & `CreateTaskModal.tsx`:
   - Backdrop: `bg-[var(--bg-overlay)] backdrop-blur-xs`.
   - Dialog shell: `bg-[var(--bg-elevated)] border-t sm:border border-[var(--border-default)] rounded-t-2xl sm:rounded-2xl ... text-[var(--text-primary)] shadow-2xl` (preserving `items-end sm:items-center` and `rounded-t-2xl`).
   - Inputs/Textareas/Selects: `bg-[var(--bg-surface-sub)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-indigo-500`.
3. `frontend/src/components/terminal/components/CronLogModal.tsx` & `TaskLogModal.tsx`:
   - Dialog shell: `bg-[var(--bg-elevated)] border-t sm:border border-[var(--border-default)] ... text-[var(--text-primary)] shadow-2xl`.
   - Metadata bar: `bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)]`.
   - Log viewport container: `bg-[var(--bg-terminal)] text-[var(--text-primary)] ansi-log-container` (replacing `bg-[#090d16]` and `bg-[#0c1017]`).
   - Update `tests/frontendCronModals.test.ts:71` (`expect(cronLogModalContent).toMatch(/bg-\[var\(--bg-terminal\)\]/)`) to reflect the theme-adaptive terminal viewport class.
4. `frontend/src/components/terminal/TerminalScriptDrawer.tsx`:
   - Drawer container: `bg-[var(--bg-elevated)] border-l border-[var(--border-default)] text-[var(--text-primary)] shadow-2xl`.
   - Sidebar list pane: `bg-[var(--bg-surface-sub)] border-r border-[var(--border-subtle)]`.
   - Code editor `<textarea>` and preview `<pre>`: `bg-[var(--bg-terminal)] border border-[var(--border-default)] rounded-lg p-3 text-xs font-mono text-[var(--text-primary)]` (replacing `bg-[#121214]`).

- [ ] **Step 4: Run tests to verify Task 4 and all Cron/Task/Drawer tests pass**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts tests/frontendCronModals.test.ts tests/frontendMobileCronAndTaskViews.test.ts tests/frontendTerminalCronView.test.ts tests/terminalScriptDrawer.test.ts tests/ansiLogFormatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalCronView.tsx frontend/src/components/terminal/TerminalTaskView.tsx frontend/src/components/terminal/components/CronJobModal.tsx frontend/src/components/terminal/components/CronLogModal.tsx frontend/src/components/terminal/components/CreateTaskModal.tsx frontend/src/components/terminal/components/TaskLogModal.tsx frontend/src/components/terminal/TerminalScriptDrawer.tsx tests/frontendCronModals.test.ts tests/enterpriseThemeSystem.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): migrate Cron, Task views, Modals, and ScriptDrawer to enterprise semantic tokens

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: File Manager, Preview Modals & Proxy Speedtest Workbench Migration (`TerminalFileManagerView`, `TerminalImagePreviewModal`, `TerminalPdfPreviewModal`, `TerminalProxyView`)

**Files:**
- Modify: `frontend/src/components/terminal/TerminalFileManagerView.tsx`
- Modify: `frontend/src/components/terminal/TerminalImagePreviewModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalProxyView.tsx`
- Modify: `tests/terminalFileManagerHiddenFiles.test.ts`
- Modify: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Consumes: Semantic CSS variables and `.ui-*` component classes from Task 1
- Produces: Theme-adaptive File Manager, Image/PDF preview modals, and Proxy Speedtest workbench

- [ ] **Step 1: Add failing test in `tests/enterpriseThemeSystem.test.ts` checking File Manager, Preview Modals, and Proxy View for hardcoded dark-only dialog backgrounds**

```typescript
  test('FileManager, Image/PDF Preview Modals, and ProxyView use semantic surface/elevated tokens instead of hardcoded bg-slate-900/bg-zinc-900 modal shells', () => {
    const fileManagerContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx'),
      'utf-8'
    );
    const imageModalContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalImagePreviewModal.tsx'),
      'utf-8'
    );
    const pdfModalContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalPdfPreviewModal.tsx'),
      'utf-8'
    );
    const proxyContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalProxyView.tsx'),
      'utf-8'
    );

    expect(fileManagerContent).toContain('var(--bg-surface)');
    expect(imageModalContent).toContain('var(--bg-elevated)');
    expect(pdfModalContent).toContain('var(--bg-elevated)');
    expect(proxyContent).toContain('var(--bg-surface)');
    expect(proxyContent).not.toContain('bg-slate-950');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts`
Expected: FAIL (`TerminalImagePreviewModal.tsx`, `TerminalPdfPreviewModal.tsx`, or `TerminalProxyView.tsx` lack `var(--bg-elevated)` / still contain `bg-slate-950` / `bg-slate-900`)

- [ ] **Step 3: Migrate `TerminalFileManagerView.tsx`, `TerminalImagePreviewModal.tsx`, `TerminalPdfPreviewModal.tsx`, and `TerminalProxyView.tsx`**

1. `frontend/src/components/terminal/TerminalFileManagerView.tsx`:
   - Replace dark-only classes (`bg-slate-900`, `bg-white/[0.04]`, `border-white/[0.08]`, `text-slate-200`, `text-slate-300`, `hover:text-white`) across the breadcrumb bar, file table, action buttons, New Folder / Rename / Delete modals, and bottom Monaco editor drawer with `bg-[var(--bg-surface)]`, `bg-[var(--bg-surface-sub)]`, `bg-[var(--bg-elevated)]`, `bg-[var(--bg-control)]`, `hover:bg-[var(--bg-control-hover)]`, `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, `border-[var(--border-subtle)]`, `border-[var(--border-default)]`.
   - For hidden files row styling: use `isHidden ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'` and update `tests/terminalFileManagerHiddenFiles.test.ts:46` to match.
2. `frontend/src/components/terminal/TerminalImagePreviewModal.tsx` & `TerminalPdfPreviewModal.tsx`:
   - Replace modal shell `bg-slate-900` / `bg-zinc-900` and header/button dark classes with `bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)]` and `bg-[var(--bg-surface-sub)]`.
3. `frontend/src/components/terminal/TerminalProxyView.tsx`:
   - Replace hardcoded `bg-slate-900`, `bg-slate-950`, `bg-black/20`, `bg-white/[0.04]`, `text-slate-200`, `text-white`, `border-white/[0.08]` across the Port Discovery cards, HTTP Request debugger, and Speedtest metrics/progress panels with `bg-[var(--bg-surface)]`, `bg-[var(--bg-surface-sub)]`, `bg-[var(--bg-terminal)]`, `bg-[var(--bg-control)]`, `text-[var(--text-primary)]`, `text-[var(--text-secondary)]`, and `border-[var(--border-subtle)]`.
   - Preserve all `data-testid` attributes required by `tests/proxyUi.test.ts`.

- [ ] **Step 4: Run tests and full frontend build to verify everything passes**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts tests/terminalFileManagerHiddenFiles.test.ts tests/fileManagerMarkdownAndPdf.test.ts tests/proxyUi.test.ts tests/frontendFileManagerToast.test.ts && npm run build:frontend`
Expected: PASS and clean Vite build in `dist/frontend`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalFileManagerView.tsx frontend/src/components/terminal/TerminalImagePreviewModal.tsx frontend/src/components/terminal/TerminalPdfPreviewModal.tsx frontend/src/components/terminal/TerminalProxyView.tsx tests/terminalFileManagerHiddenFiles.test.ts tests/enterpriseThemeSystem.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): migrate FileManager, preview modals, and ProxyView to enterprise dual theme

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```
