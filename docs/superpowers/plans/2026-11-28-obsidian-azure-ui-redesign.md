# Obsidian Azure UI Redesign & App Hub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the entire `gt-hub` web frontend to the App Hub **Obsidian Azure** design system (4-layer light/dark depth, monochrome primary CTA vs. Azure/Cyan telemetry accent, self-hosted variable fonts, unified `ModalShell` Portal dialogs, Anti-FOUC + iframe embedded shell adaptation, and targeted view layout refinements) with zero regression to terminal I/O or mobile input mechanics.

**Architecture:** We introduce a thin Obsidian Azure CSS token and primitive layer in `frontend/src/index.css` paired with self-hosted `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` fonts, one focused `ModalShell` Portal component (`frontend/src/components/ui/ModalShell.tsx`) covering all 12 modals/drawers, and incremental enhancements to `index.html`, `ThemeContext.tsx`, and `AuthContext.tsx` for Anti-FOUC and iframe chrome collapsing. Existing views, `WebTerminalView`, `monacoTheme.ts`, and `markdownRenderer.ts` are updated to consume the semantic tokens and layout primitives without altering terminal transport, scroll isolation, or IME hooks.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS v3.4, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, `@xterm/xterm`, `@monaco-editor/react`, Lucide React, Jest (`ts-jest`, `testEnvironment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-11-28-obsidian-azure-ui-redesign-design.md`

## Global Constraints

- **Palette & 4-Layer Surfaces:** Dark `#07080a` (`--bg-canvas`) → `#0b0d11` (`--bg-sidebar` / `--bg-input` / `--code-bg`) → `#101216` (`--bg-surface`, top micro-gradient + `1px` specular highlight) → `#161920` (`--bg-surface-sub`); Light `#f5f6f8` → `#fafbfc` → `#ffffff` → `#f8f9fb`.
- **CTA vs. Accent Separation:** `.ui-btn-primary` uses monochrome high-contrast (`--cta-bg` / `--cta-text`: dark `#f4f6f9`/`#09090b`, light `#111318`/`#ffffff`) and MUST NEVER combine with `text-white`; Azure (`#3b82f6` / `#60a5fa` / `#2563eb`) and Cyan (`#38bdf8`) are reserved for active indicators, focus rings, links, switches, and telemetry.
- **Zero Forbidden Classes / Anti-Patterns:** Zero `indigo-*` classes, zero `slate-*` classes, zero Tailwind v3 CSS-variable opacity modifiers (`bg-[var(--*)]/95` — use `color-mix()` via `.ui-elevated-glass` / `.ui-surface-glass`), zero external Google Fonts CDN URLs, and zero residual `transform` entrance animations (`zoom-in-*`) on modal shells.
- **Typography & Radius:** UI chrome/labels/titles/tabs/headers use `--font-sans`; terminal/code/paths/IDs/cron/URLs/timestamps/aligned numbers use `--font-mono` (with `tabular-nums`). Three-tier radius: `rounded-xl` (`12px`, `sm:rounded-2xl` allowed on large desktop modals) for cards/panels/modals, `rounded-lg` (`8px`) for buttons/inputs/controls, `rounded-md` (`6px`) for badges/chips (`rounded-full` only for status dots, scroll-to-bottom button, and toggle sliders).
- **Terminal & Git Hygiene:** Do NOT alter `WebTerminalView` WebSocket framing, `TerminalWriteScheduler`, wheel/touch alt-screen isolation, or mobile IME/selection hooks. Always stage only explicit files belonging to each task (never `git add -A`, as unrelated working-tree changes may exist). Always run targeted Jest suites (`npm test -- tests/<file>.test.ts`).

## Review Focus

1. **Invisible white-on-white CTA text/spinner in dark mode:** Putting `text-white` on `.ui-btn-primary` makes labels invisible on `#f4f6f9` in dark mode — pinned by static source guard in Task 9 (`tests/enterpriseThemeSystem.test.ts`).
2. **Tailwind v3 silent-transparent CSS-variable opacity classes (`bg-[var(--*)]/95`):** Produces transparent toasts, dropzones, and floating toolbars — pinned by full-repo regex scan in Task 9 (`tests/enterpriseThemeSystem.test.ts`).
3. **Mobile xterm.js IME disruption from global `16px` input zoom guard:** Blindly targeting all `textarea` elements breaks `.xterm-helper-textarea` metrics on mobile — pinned by CSS selector assertion (`:not(.xterm-helper-textarea)`) in Task 1 (`tests/enterpriseThemeSystem.test.ts`).
4. **Iframe embedded double-chrome & accidental SSO logout:** Showing GitHub, independent theme toggle, or logout button inside an App Hub SSO iframe creates dual theme state and breaks SSO sessions — pinned by unit tests on `getEmbeddedShellVisibility` in Task 2 (`tests/autoHostThemeSync.test.ts`).
5. **Clipped non-Portal modals or `Escape` bypassing async submit lock:** Rendering modals inline inside scrollable/transformed containers clips dialogs, while ignoring `disableClose` lets `Escape` close an active mutation — pinned by unit tests in Task 3 (`tests/modalShell.test.ts`) and full-repo modal scan in Task 9.

---

## File Structure Map

- **Design System Foundation:**
  - `frontend/package.json` — add `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`.
  - `frontend/src/main.tsx` — import self-hosted variable font packages.
  - `frontend/src/index.css` — full Obsidian Azure light/dark CSS tokens, compatibility aliases, component primitives, `color-mix()` glass utilities, light ANSI overrides, `:not(.xterm-helper-textarea)` mobile 16px guard, `prefers-reduced-motion`.
  - `frontend/tailwind.config.js` — bind `fontFamily.sans`/`mono` and semantic surface/accent CSS variables.
- **Host Integration & Contexts:**
  - `frontend/index.html` — synchronous Anti-FOUC theme bootstrap script in `<head>`.
  - `frontend/src/theme/ThemeContext.tsx` — `app_hub_theme_mode` compatibility, `resolveThemeBackgroundColor`, `root.style.backgroundColor` sync, `isEmbedded` context field, `getEmbeddedShellVisibility` helper.
  - `frontend/src/auth/AuthContext.tsx` — track and expose `isSsoAuthenticated`.
- **Shared Modal Primitive:**
  - `frontend/src/components/ui/ModalShell.tsx` — Portal modal/drawer shell with `getModalShellClasses`, `role="dialog" aria-modal="true"`, `Escape` & backdrop handlers, `z-50`/`z-[60]`, `max-h-[88dvh]`, fixed header/footer, `overscroll-contain`.
- **Shell & Host Controls:**
  - `frontend/src/App.tsx`, `frontend/src/components/LoginView.tsx`, `frontend/src/components/UnifiedTerminalView.tsx`, `frontend/src/components/terminal/TerminalHostSelector.tsx`.
- **Terminal, Editor & Logs:**
  - `frontend/src/components/WebTerminalView.tsx`, `frontend/src/utils/monacoTheme.ts`, `frontend/src/components/TerminalLogsView.tsx`, `frontend/src/utils/ansiLogFormatter.ts`, `frontend/src/components/terminal/TerminalAccessoryBar.tsx`, `frontend/src/components/terminal/components/TerminalEmptyState.tsx`, `frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx`, `frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx`.
- **Standalone Modals & Drawers:**
  - `frontend/src/components/terminal/components/CreateTaskModal.tsx`, `CronJobModal.tsx`, `CronLogModal.tsx`, `TaskLogModal.tsx`, `frontend/src/components/terminal/TerminalScriptDrawer.tsx`, `TerminalImagePreviewModal.tsx`, `TerminalPdfPreviewModal.tsx`.
- **Core Business Views:**
  - `frontend/src/components/terminal/TerminalTaskView.tsx`, `TerminalCronView.tsx`, `TerminalFileManagerView.tsx`, `TerminalMarkdownViewer.tsx`, `frontend/src/utils/markdownRenderer.ts`, `frontend/src/components/terminal/TerminalProxyView.tsx`.
- **Tests:**
  - Create: `tests/modalShell.test.ts`
  - Modify: `tests/enterpriseThemeSystem.test.ts`, `tests/autoHostThemeSync.test.ts`, `tests/frontendAuthContext.test.ts`, `tests/frontendSplitPaneWorkspace.test.ts`, `tests/terminalMobileFullscreenHeader.test.ts`, `tests/frontendMobileCronAndTaskViews.test.ts`.

---

### Task 1: Self-Hosted Variable Fonts & Obsidian Azure Design System Tokens

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/index.css`
- Modify: `frontend/tailwind.config.js`
- Test: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Produces in `frontend/src/index.css`:
  - CSS variables: `--font-sans`, `--font-mono`, `--bg-canvas`, `--bg-sidebar`, `--bg-surface`, `--bg-surface-sub`, `--bg-input`, `--bg-surface-hover`, `--bg-elevated`, `--bg-terminal`, `--bg-control`, `--bg-control-hover`, `--bg-overlay`, `--border-subtle`, `--border-hover`, `--border-input`, `--border-default`, `--border-focus`, `--text-primary`, `--text-secondary`, `--text-muted`, `--cta-bg`, `--cta-hover`, `--cta-text`, `--accent-primary`, `--accent-fill`, `--accent-hover`, `--accent-text`, `--accent-soft-bg`, `--accent-soft-border`, `--status-{success,warning,danger,info}-{text,bg,border}`, `--code-bg`, `--code-text`, `--chart-grid`, `--chart-axis`, `--shadow-card`, `--shadow-card-hover`, `--shadow-input`, `--shadow-popover`, `--scrollbar-thumb`, `--scrollbar-thumb-hover`.
  - CSS component primitives: `.ui-card`, `.ui-card-interactive`, `.ui-card-sub`, `.ui-elevated`, `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-icon-btn`, `.ui-input`, `.ui-composer-shell`, `.ui-ambient-stage`, `.ui-row-indicator`, `.ui-modal-shell`, `.ui-tab-underline`, `.ui-tab-underline-active`, `.ui-badge-success`, `.ui-badge-warning`, `.ui-badge-danger`, `.ui-badge-info`, `.ui-badge-neutral`, `.ui-elevated-glass`, `.ui-surface-glass`.

- [ ] **Step 1: Write failing design-system foundation tests in `tests/enterpriseThemeSystem.test.ts`**

Replace the first three `index.css` / `tailwind.config.js` tests in `tests/enterpriseThemeSystem.test.ts` (keeping the view-specific tests intact until Task 9 updates them) with a `describe('Obsidian Azure Foundation Tokens & Fonts', ...)` block:
```ts
  describe('Obsidian Azure Foundation Tokens & Fonts', () => {
    test('index.css defines complete Obsidian Azure Light & Dark tokens and primitives', () => {
      const css = fs.readFileSync(indexCssPath, 'utf-8');
      const requiredTokens = [
        '--font-sans:', '--font-mono:',
        '--bg-canvas: #f5f6f8;', '--bg-sidebar: #fafbfc;', '--bg-surface: #ffffff;', '--bg-surface-sub: #f8f9fb;',
        '--bg-canvas: #07080a;', '--bg-sidebar: #0b0d11;', '--bg-surface: #101216;', '--bg-surface-sub: #161920;',
        '--cta-bg: #111318;', '--cta-bg: #f4f6f9;', '--cta-text: #09090b;',
        '--accent-primary: #2563eb;', '--accent-primary: #3b82f6;',
        '--status-success-text: #047857;', '--status-success-text: #34d399;',
        '--status-warning-text: #92400e;', '--status-warning-text: #fbbf24;',
        '--status-danger-text: #be123c;', '--status-danger-text: #fb7185;',
        '--status-info-text: #0369a1;', '--status-info-text: #38bdf8;',
        '--shadow-card:', '--shadow-popover:',
      ];
      for (const token of requiredTokens) {
        expect(css).toContain(token);
      }
      const requiredPrimitives = [
        '.ui-card', '.ui-card-interactive', '.ui-btn-primary', '.ui-btn-secondary',
        '.ui-ambient-stage', '.ui-row-indicator', '.ui-modal-shell', '.ui-composer-shell',
        '.ui-tab-underline', '.ui-tab-underline-active',
        '.ui-badge-success', '.ui-badge-warning', '.ui-badge-danger', '.ui-badge-info', '.ui-badge-neutral',
        '.ui-elevated-glass', '.ui-surface-glass',
      ];
      for (const cls of requiredPrimitives) {
        expect(css).toContain(cls);
      }
      expect(css).toContain('color-mix(in srgb');
      expect(css).toContain(':not(.xterm-helper-textarea)');
      expect(css).toContain('font-size: 16px !important');
      expect(css).toContain('prefers-reduced-motion: reduce');
      expect(css).not.toContain('indigo-');
      expect(css).not.toContain('slate-');
    });

    test('frontend self-hosts @fontsource-variable/inter and @fontsource-variable/jetbrains-mono', () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../frontend/package.json'), 'utf-8'));
      const mainTsx = fs.readFileSync(path.resolve(__dirname, '../frontend/src/main.tsx'), 'utf-8');
      const twConfig = fs.readFileSync(tailwindConfigPath, 'utf-8');
      expect(pkg.dependencies['@fontsource-variable/inter']).toBeDefined();
      expect(pkg.dependencies['@fontsource-variable/jetbrains-mono']).toBeDefined();
      expect(mainTsx).toContain("@fontsource-variable/inter");
      expect(mainTsx).toContain("@fontsource-variable/jetbrains-mono");
      expect(twConfig).toContain('var(--font-sans)');
      expect(twConfig).toContain('var(--font-mono)');
      expect(twConfig).toContain('var(--bg-sidebar)');
    });
  });
```

- [ ] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts -t "Obsidian Azure Foundation"`
Expected: FAIL (`--font-sans:` and `@fontsource-variable/inter` not found).

- [ ] **Step 3: Install self-hosted font packages in `frontend/` and import in `frontend/src/main.tsx`**

Run: `npm --prefix frontend install @fontsource-variable/inter @fontsource-variable/jetbrains-mono`
Then import `'@fontsource-variable/inter';` and `'@fontsource-variable/jetbrains-mono';` at the top of `frontend/src/main.tsx` before `'./index.css'`.

- [ ] **Step 4: Overhaul `frontend/src/index.css` and `frontend/tailwind.config.js`**

1. In `frontend/src/index.css`:
   - Define exact Light (`:root`) and Dark (`:root.dark, :root[data-theme="dark"]`) CSS variables from Spec §3.1.1, including `--font-sans`, `--font-mono`, compatibility aliases (`--bg-elevated`, `--bg-terminal`, `--bg-control`, `--bg-control-hover`, `--bg-overlay`, `--border-default`, `--border-focus`), and `color-scheme: light` / `color-scheme: dark`.
   - Set `body { font-family: var(--font-sans); background-color: var(--bg-canvas); color: var(--text-primary); }`.
   - Update `.ansi-log-container` light-mode rules to target `.text-blue-400` (`#1d4ed8`), `.text-zinc-100`/`.text-zinc-200`/`.text-white` (`#111318`), `.text-zinc-400` (`#4b5262`), removing all `.text-indigo-400` and `.text-slate-*` selectors.
   - Replace `@layer components` with all Obsidian Azure primitives from Spec §3.1.2 (`.ui-card` with `12px` radius + dark top specular micro-gradient, `.ui-card-interactive`, `.ui-card-sub`, `.ui-elevated`, monochrome `.ui-btn-primary` with `8px` radius, `.ui-btn-secondary`, `.ui-icon-btn`, `.ui-input`, `.ui-composer-shell`, `.ui-ambient-stage`, `.ui-row-indicator`, `.ui-modal-shell`, `.ui-tab-underline`, `.ui-tab-underline-active` with 2px Azure/Cyan bottom bar + dark glow, `.ui-badge-{success,warning,danger,info,neutral}`, `.ui-elevated-glass` using `color-mix(in srgb, var(--bg-elevated) 92%, transparent)`, `.ui-surface-glass` using `color-mix(in srgb, var(--bg-surface) 84%, transparent)`).
   - Add mobile input zoom guard:
     ```css
     @media screen and (max-width: 767px) {
       input:not(.xterm-helper-textarea),
       textarea:not(.xterm-helper-textarea),
       select {
         font-size: 16px !important;
       }
     }
     ```
   - Add `@media (prefers-reduced-motion: reduce)` disabling animations/transitions on `.ui-card-interactive`, `.ui-composer-shell`, `.animate-pulse-slow`.
   - Preserve all existing `.terminal-select-mode` and `.xterm` viewport/scrollbar rules verbatim.
2. In `frontend/tailwind.config.js`:
   - Add `fontFamily: { sans: ['var(--font-sans)'], mono: ['var(--font-mono)'] }` and extend `colors` with `sidebar: 'var(--bg-sidebar)'`, `input: 'var(--bg-input)'`, `accent: 'var(--accent-primary)'` alongside existing `canvas`, `surface`, `surface-sub`, `elevated`, `terminal`, `control`, `control-hover`.

- [ ] **Step 5: Run targeted test to verify Task 1 passes**

Run: `npm test -- tests/enterpriseThemeSystem.test.ts -t "Obsidian Azure Foundation"`
Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/main.tsx frontend/src/index.css frontend/tailwind.config.js tests/enterpriseThemeSystem.test.ts
git commit -m "feat(ui): add Obsidian Azure tokens, primitives, and self-hosted fonts"
```

---

### Task 2: Anti-FOUC Bootstrap Script & App Hub Host Bridge Enhancements

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/theme/ThemeContext.tsx`
- Modify: `frontend/src/auth/AuthContext.tsx`
- Test: `tests/autoHostThemeSync.test.ts`
- Test: `tests/frontendAuthContext.test.ts`

**Interfaces:**
- Produces in `frontend/src/theme/ThemeContext.tsx`:
  ```ts
  export interface ThemeContextType {
    theme: ThemeMode;
    resolvedTheme: ResolvedTheme;
    isEmbedded: boolean;
    setTheme: (theme: ThemeMode) => void;
    toggleTheme: () => void;
  }
  export interface EmbeddedShellVisibility {
    showGithub: boolean;
    showThemeToggle: boolean;
    showLogout: boolean;
    showLanguage: boolean;
    showFullscreen: boolean;
  }
  export function resolveThemeBackgroundColor(resolved: ResolvedTheme): '#07080a' | '#f5f6f8';
  export function getEmbeddedShellVisibility(opts: {
    isEmbedded: boolean;
    isSsoAuthenticated: boolean;
    hasLogout: boolean;
  }): EmbeddedShellVisibility;
  ```
- Produces in `frontend/src/auth/AuthContext.tsx`:
  ```ts
  export interface AuthContextValue {
    status: AuthStatus;
    authRequired: boolean;
    adminKey: string;
    isSsoAuthenticated: boolean;
    error: string | null;
    setError: (err: string | null) => void;
    login: (key: string) => Promise<boolean>;
    logout: () => void;
    checkAuth: () => Promise<void>;
  }
  ```

- [ ] **Step 1: Write failing tests in `tests/autoHostThemeSync.test.ts` and `tests/frontendAuthContext.test.ts`**

1. In `tests/autoHostThemeSync.test.ts`, add tests verifying:
   - `resolveThemeBackgroundColor('dark') === '#07080a'` and `resolveThemeBackgroundColor('light') === '#f5f6f8'`;
   - `detectParentDocumentTheme` reads `app_hub_theme_mode` from `parent.localStorage`;
   - `getEmbeddedShellVisibility`:
     - Standalone (`isEmbedded: false, isSsoAuthenticated: false, hasLogout: true`) → all `true`;
     - Embedded non-SSO (`isEmbedded: true, isSsoAuthenticated: false, hasLogout: true`) → `showGithub: false, showThemeToggle: false, showLogout: true, showLanguage: true, showFullscreen: true`;
     - Embedded SSO (`isEmbedded: true, isSsoAuthenticated: true, hasLogout: true`) → `showGithub: false, showThemeToggle: false, showLogout: false, showLanguage: true, showFullscreen: true`;
   - `frontend/index.html` contains synchronous Anti-FOUC script setting `#07080a`, `#f5f6f8`, `data-theme`, `app_hub_theme_mode`, and `gt_hub_theme_mode`, and contains no `fonts.googleapis.com`.
2. In `tests/frontendAuthContext.test.ts`, add assertion that `AuthContext.tsx` exposes `isSsoAuthenticated` on `AuthContextValue`, sets it `true` on hash/postMessage SSO auth, and resets it `false` on manual `login` and `logout`.

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/autoHostThemeSync.test.ts tests/frontendAuthContext.test.ts`
Expected: FAIL (`resolveThemeBackgroundColor` and `getEmbeddedShellVisibility` not exported; Anti-FOUC script missing).

- [ ] **Step 3: Add Anti-FOUC script to `frontend/index.html`**

Insert synchronous `<script>` inside `<head>` right after `<meta name="color-scheme" ... />`:
- Read `theme` / `colorScheme` from `URLSearchParams(window.location.search)` (and hash query if present);
- Fallback to `localStorage.getItem('gt_hub_theme_mode') || localStorage.getItem('app_hub_theme_mode')`;
- Fallback to `window.matchMedia('(prefers-color-scheme: dark)').matches` (default `true` → `'dark'`);
- Synchronously apply `root.classList.toggle('dark', isDark)`, `root.setAttribute('data-theme', resolved)`, `root.style.colorScheme = resolved`, `root.style.backgroundColor = isDark ? '#07080a' : '#f5f6f8'`.

- [ ] **Step 4: Enhance `frontend/src/theme/ThemeContext.tsx` and `frontend/src/auth/AuthContext.tsx`**

1. In `frontend/src/theme/ThemeContext.tsx`:
   - Put `'app_hub_theme_mode'` first in `PARENT_STORAGE_KEYS`;
   - Export `resolveThemeBackgroundColor(resolved: ResolvedTheme): '#07080a' | '#f5f6f8'` and set `root.style.backgroundColor = resolveThemeBackgroundColor(resolved)` in `applyThemeToRootDocument`;
   - Export `getEmbeddedShellVisibility`;
   - Compute `const [isEmbedded] = useState<boolean>(() => isEmbeddedIframe())` in `ThemeProvider` and expose `isEmbedded` in context value;
   - Also check `localStorage.getItem('app_hub_theme_mode')` as fallback in `getInitialThemeMode` when `gt_hub_theme_mode` is unset.
2. In `frontend/src/auth/AuthContext.tsx`:
   - Track initial hash SSO via a ref/state (`isSsoAuthenticated`), set `true` when `consumeHashAdminKey()` yields a key or when `parseAuthMessage(event.data)` receives an SSO key via `app-hub:auth-init`, and set `false` on manual `login()` success and `logout()`;
   - Expose `isSsoAuthenticated` in `AuthContext.Provider`.

- [ ] **Step 5: Run targeted tests to verify they pass**

Run: `npm test -- tests/autoHostThemeSync.test.ts tests/frontendAuthContext.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add frontend/index.html frontend/src/theme/ThemeContext.tsx frontend/src/auth/AuthContext.tsx tests/autoHostThemeSync.test.ts tests/frontendAuthContext.test.ts
git commit -m "feat(ui): add Anti-FOUC bootstrap and embedded host shell bridge helpers"
```

---

### Task 3: Create Shared Portal `ModalShell` Component

**Files:**
- Create: `frontend/src/components/ui/ModalShell.tsx`
- Create: `tests/modalShell.test.ts`

**Interfaces:**
- Produces in `frontend/src/components/ui/ModalShell.tsx`:
  ```ts
  export interface ModalShellProps {
    isOpen: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    icon?: React.ReactNode;
    headerExtra?: React.ReactNode;
    footer?: React.ReactNode;
    children: React.ReactNode;
    variant?: 'modal' | 'drawer';
    maxWidthClassName?: string;
    heightClassName?: string;
    zIndex?: 'base' | 'nested';
    closeOnBackdrop?: boolean;
    disableClose?: boolean;
    bodyClassName?: string;
    noHeader?: boolean;
    ariaLabel?: string;
  }
  export function getModalShellClasses(opts: {
    variant?: 'modal' | 'drawer';
    zIndex?: 'base' | 'nested';
    maxWidthClassName?: string;
    heightClassName?: string;
  }): {
    backdropClassName: string;
    panelClassName: string;
    bodyClassName: string;
  };
  export function shouldCloseOnModalKeyDown(key: string, disableClose?: boolean): boolean;
  export const ModalShell: React.FC<ModalShellProps>;
  ```

- [ ] **Step 1: Write failing unit & structure tests in `tests/modalShell.test.ts`**

Create `tests/modalShell.test.ts` asserting:
1. `getModalShellClasses({ variant: 'modal', zIndex: 'base' })`:
   - `backdropClassName` includes `fixed inset-0`, `z-50`, `items-end sm:items-center`, `backdrop-blur-xl`, `bg-zinc-950/35`, `dark:bg-black/60`;
   - `panelClassName` includes `ui-card`, `ui-modal-shell`, `max-h-[88dvh]`, `rounded-t-2xl sm:rounded-xl`, `flex flex-col`, `overflow-hidden`, and does NOT contain `zoom-in` or `scale-`;
   - `bodyClassName` includes `flex-1 min-h-0 overflow-y-auto overscroll-contain`.
2. `getModalShellClasses({ variant: 'modal', zIndex: 'nested', maxWidthClassName: 'max-w-5xl', heightClassName: 'h-[88dvh]' })`:
   - `backdropClassName` includes `z-[60]` and NOT `z-50`;
   - `panelClassName` includes `max-w-5xl` and `h-[88dvh]`.
3. `getModalShellClasses({ variant: 'drawer', zIndex: 'base' })`:
   - `backdropClassName` includes `justify-end`;
   - `panelClassName` includes `bg-[var(--bg-sidebar)]`, `h-full`, `ui-modal-shell`.
4. `shouldCloseOnModalKeyDown('Escape', false)` returns `true`; `shouldCloseOnModalKeyDown('Escape', true)` returns `false`; `shouldCloseOnModalKeyDown('Enter', false)` returns `false`.
5. Static source verification of `frontend/src/components/ui/ModalShell.tsx`: uses `createPortal(..., document.body)` guarded by `typeof document !== 'undefined'`, sets `role="dialog"`, `aria-modal="true"`, `shrink-0` on header/footer, `env(safe-area-inset-bottom)`, and contains zero `indigo-` / `slate-` / `zoom-in` classes.

- [ ] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/modalShell.test.ts`
Expected: FAIL (cannot find module `../frontend/src/components/ui/ModalShell`).

- [ ] **Step 3: Implement `frontend/src/components/ui/ModalShell.tsx`**

Implement `getModalShellClasses`, `shouldCloseOnModalKeyDown`, and `ModalShell` matching the Interfaces block and Spec §3.4.2:
- Use `useId()` to link `aria-labelledby` to the title element (or fall back to `aria-label={ariaLabel}` when `noHeader` or no `title`).
- Attach `window.addEventListener('keydown', ...)` while `isOpen` calling `onClose()` when `shouldCloseOnModalKeyDown(e.key, disableClose)` is true (with `e.stopPropagation()`).
- Handle backdrop click: if `closeOnBackdrop !== false && !disableClose`, call `onClose()`; stop propagation on panel container.
- Render mobile pull handle on `variant === 'modal'` (`sm:hidden w-10 h-1 bg-[var(--border-hover)] rounded-full mx-auto mt-2 mb-1 shrink-0`).
- Render header (`shrink-0 bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)]`) unless `noHeader`, scrollable body (`flex-1 min-h-0 overflow-y-auto overscroll-contain`), and optional footer (`shrink-0 bg-[var(--bg-surface-sub)] border-t border-[var(--border-subtle)] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3`).

- [ ] **Step 4: Run targeted test to verify it passes**

Run: `npm test -- tests/modalShell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add frontend/src/components/ui/ModalShell.tsx tests/modalShell.test.ts
git commit -m "feat(ui): add shared Portal ModalShell component with a11y and viewport constraints"
```

---

### Task 4: Redesign App Shell, `LoginView`, `UnifiedTerminalView`, and `TerminalHostSelector`

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/LoginView.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `frontend/src/components/terminal/TerminalHostSelector.tsx`
- Test: `tests/frontendSplitPaneWorkspace.test.ts`
- Test: `tests/frontendLoginView.test.ts`
- Test: `tests/terminalHostSelector.test.ts`
- Test: `tests/frontendUnifiedSubTabs.test.ts`

**Interfaces:**
- Consumes from Task 1: `.ui-card`, `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-icon-btn`, `.ui-ambient-stage`, `.ui-composer-shell`, `.ui-row-indicator`, `.ui-tab-underline`, `.ui-tab-underline-active`.
- Consumes from Task 2: `useTheme().isEmbedded`, `getEmbeddedShellVisibility`, `useAuth().isSsoAuthenticated`.
- Consumes from Task 3: `ModalShell`.

- [ ] **Step 1: Update assertions in `tests/frontendSplitPaneWorkspace.test.ts` and `tests/frontendLoginView.test.ts`**

1. In `tests/frontendSplitPaneWorkspace.test.ts:61`, update `expect(content).toContain('border-t-indigo-500')` to `expect(content).toContain('border-t-[var(--accent-primary)]')`.
2. In `tests/frontendLoginView.test.ts`, add assertions that `LoginView.tsx` uses `.ui-ambient-stage`, `.ui-card`, `.ui-btn-primary`, `getEmbeddedShellVisibility`, and contains zero `indigo-` or `slate-` classes.
3. In `tests/terminalHostSelector.test.ts`, add assertions that `TerminalHostSelector.tsx` uses `ModalShell` for the add-node modal, uses `ui-row-indicator` for the active host row, and contains zero `indigo-` or `slate-` classes.

- [ ] **Step 2: Run targeted tests to verify the new assertions fail**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/frontendLoginView.test.ts tests/terminalHostSelector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Redesign `App.tsx`, `LoginView.tsx`, `UnifiedTerminalView.tsx`, and `TerminalHostSelector.tsx`**

1. **`frontend/src/App.tsx`**:
   - Change loading `Loader2` color from `text-indigo-500` to `text-[var(--accent-primary)]`.
   - Pass `isSsoAuthenticated={isSsoAuthenticated}` (or read from `useAuth()` inside `UnifiedTerminalView`; passing optional `isSsoAuthenticated?: boolean` prop keeps `UnifiedTerminalView` easy to test in isolation).
2. **`frontend/src/components/LoginView.tsx`**:
   - Call `const { isEmbedded } = useTheme()` and `const visibility = getEmbeddedShellVisibility({ isEmbedded, isSsoAuthenticated: false, hasLogout: false })`.
   - Hide GitHub link when `!visibility.showGithub` and theme toggle when `!visibility.showThemeToggle`; keep language toggle.
   - Apply `ui-ambient-stage` to the outer canvas wrapper; replace card wrapper with `ui-card p-6 sm:p-8` (12px radius); upgrade `gt` brand emblem to `bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)]`; wrap password input with `ui-composer-shell`; upgrade error box to `--status-danger-*` tokens; upgrade submit button to `ui-btn-primary` (zero `text-white`, `Loader2` inherits `text-current`).
3. **`frontend/src/components/UnifiedTerminalView.tsx`**:
   - Remove `font-mono text-xs` from root container (`font-sans text-xs` or default `font-sans`); remove outer `shadow-2xl` / `md:rounded-2xl` when `isStandalone || isEmbedded`.
   - Replace the 5 SubTab buttons with `.ui-tab-underline` + `.ui-tab-underline-active` (keeping `handleSubTabChange(...)`, `data-testid="subtab-proxy"`, icons, labels, and all existing `data-testid` attributes).
   - Compute `const shellVisibility = getEmbeddedShellVisibility({ isEmbedded, isSsoAuthenticated: Boolean(isSsoAuthenticated), hasLogout: Boolean(onLogout) })` and gate GitHub, Theme toggle, and Logout in both desktop header and mobile More menu (remove `animate-in zoom-in-95` on mobile dropdown, use opacity fade only).
   - Replace all `indigo-*` and `slate-*` classes across toolbar buttons, mobile More menu icons, split-pane active ring/border (`border-t-[var(--accent-primary)]`, `bg-[var(--accent-soft-bg)]`, `border-b-[var(--accent-soft-border)]`, `text-[var(--accent-text)]`), and splitter handle (replace `hover:bg-indigo-500/50` with `hover:bg-[var(--accent-primary)]`). Keep all `data-testid`, `!isMobile`, `Minimize2`, and split keyboard shortcut handlers untouched.
4. **`frontend/src/components/terminal/TerminalHostSelector.tsx`**:
   - Keep `hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-[var(--bg-control)]` and `max-w-[72px] sm:max-w-[130px]` (verified by `tests/terminalMobileFullscreenHeader.test.ts`).
   - Keep `createPortal(popoverContent, document.body)` for the dropdown popover; upgrade popover surface to `bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl shadow-[var(--shadow-popover)]`, add `<span className="ui-row-indicator" />` on the currently selected host row (`relative`), and eliminate all `indigo-*`/`slate-*`.
   - Replace the Add Intranet Node Guide modal with `<ModalShell isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} ...>` (keeping `createPortal` via `ModalShell`, removing `zoom-in-95`, replacing `bg-indigo-600` copy buttons with `.ui-btn-primary` / `.ui-icon-btn` and the info callout with `--accent-soft-bg` / `--accent-soft-border` / `--accent-text`).

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/frontendSplitPaneWorkspace.test.ts tests/frontendSplitPaneTerminal.test.ts tests/frontendLoginView.test.ts tests/terminalHostSelector.test.ts tests/frontendUnifiedSubTabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add frontend/src/App.tsx frontend/src/components/LoginView.tsx frontend/src/components/UnifiedTerminalView.tsx frontend/src/components/terminal/TerminalHostSelector.tsx tests/frontendSplitPaneWorkspace.test.ts tests/frontendLoginView.test.ts tests/terminalHostSelector.test.ts
git commit -m "feat(ui): migrate App shell, LoginView, UnifiedTerminalView, and HostSelector to Obsidian Azure"
```

---

### Task 5: Sync Terminal (`WebTerminalView`), Monaco (`monacoTheme.ts`), `TerminalLogsView`, `TerminalEmptyState`, and Terminal Overlays

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx`
- Modify: `frontend/src/utils/monacoTheme.ts`
- Modify: `frontend/src/components/TerminalLogsView.tsx`
- Modify: `frontend/src/utils/ansiLogFormatter.ts`
- Modify: `frontend/src/components/terminal/TerminalAccessoryBar.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalEmptyState.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx`
- Modify: `frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx`
- Test: `tests/terminalMobileFullscreenHeader.test.ts`
- Test: `tests/terminalClaudeScrollback.test.ts`
- Test: `tests/terminalPerformanceOptimization.test.ts`

**Interfaces:**
- Consumes from Task 1: `.ui-ambient-stage`, `.ui-btn-primary`, `.ui-elevated-glass`, `.ui-surface-glass`, `--accent-*`, `--status-*`.
- Preserves verbatim: all WebSocket/scheduler/scroll/IME/selection logic in `WebTerminalView.tsx`.

- [ ] **Step 1: Update `tests/terminalMobileFullscreenHeader.test.ts` for Azure standalone button styling**

Update line 36 of `tests/terminalMobileFullscreenHeader.test.ts` from `bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border-indigo-500/30` to `bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border-[var(--accent-soft-border)]`.

- [ ] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/terminalMobileFullscreenHeader.test.ts`
Expected: FAIL.

- [ ] **Step 3: Sync `WebTerminalView.tsx`, `monacoTheme.ts`, `TerminalLogsView.tsx`, `ansiLogFormatter.ts`, and terminal overlay components**

1. **`frontend/src/components/WebTerminalView.tsx`**:
   - Update `DARK_TERMINAL_THEME`: `background: '#07080a'`, `foreground: '#f4f6f9'`, `cursor: '#60a5fa'`, `selectionBackground: 'rgba(59, 130, 246, 0.32)'`, `blue: '#3b82f6'`, `brightBlue: '#60a5fa'`, `cyan: '#06b6d4'`, `brightCyan: '#38bdf8'`.
   - Update `LIGHT_TERMINAL_THEME`: `background: '#ffffff'`, `foreground: '#111318'`, `cursor: '#2563eb'`, `selectionBackground: 'rgba(37, 99, 235, 0.2)'`.
   - Replace the 3 invalid Tailwind v3 classes (`bg-[var(--bg-elevated)]/95` at disconnect banner & toast pill, `bg-[var(--bg-surface)]/95` at scroll-to-bottom button) with `ui-elevated-glass` / `ui-surface-glass`.
   - Replace all remaining `indigo-*` and `slate-*` styling in `WebTerminalView.tsx` (including the standalone fullscreen toggle class asserted by `terminalMobileFullscreenHeader.test.ts`), touching NO WebSocket, scroll, IME, or resize logic.
2. **`frontend/src/utils/monacoTheme.ts`**:
   - `gemini-proxy-dark`: `'editor.background': '#0b0d11'`, `'editor.lineHighlightBackground': '#161920'`, `'editorLineNumber.foreground': '#646b7a'`, `'editorLineNumber.activeForeground': '#a1a8b8'`.
   - `gemini-proxy-light`: `'editor.background': '#ffffff'`, `'editor.lineHighlightBackground': '#f8f9fb'`, `'editorLineNumber.foreground': '#858d9e'`, `'editorLineNumber.activeForeground': '#111318'`.
3. **`frontend/src/components/terminal/components/TerminalEmptyState.tsx`**:
   - Add `ui-ambient-stage` to container; upgrade icon box to `bg-[var(--accent-soft-bg)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] dark:shadow-[0_0_24px_rgba(59,130,246,0.18)]`; upgrade add-node button to `ui-btn-primary` (no `text-white`).
4. **`frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx` & `TerminalMagnifierBubble.tsx`**:
   - Replace `bg-[var(--bg-elevated)]/95` with `ui-elevated-glass`, remove any `indigo-*`/`slate-*`, align radius to `rounded-xl`.
5. **`frontend/src/components/terminal/TerminalAccessoryBar.tsx`**:
   - Replace all `indigo-*`/`slate-*` modifier/key states with `--accent-soft-bg` / `--accent-soft-border` / `--accent-text` and `--bg-control` / `--text-secondary`.
6. **`frontend/src/components/TerminalLogsView.tsx` & `frontend/src/utils/ansiLogFormatter.ts`**:
   - In `ansiLogFormatter.ts`, replace `text-slate-400`/`text-slate-100`/`text-indigo-400` with `text-zinc-400`/`text-zinc-100`/`text-blue-400` (matching the updated `.ansi-log-container` light-mode rules in `index.css`).
   - In `TerminalLogsView.tsx`, eliminate all `slate-*` and `indigo-*` classes, use `--text-primary`/`--text-secondary`/`--text-muted`, Azure tokens for active auto-scroll/filter/fullscreen highlights, and `font-mono` strictly on log rows & counters while keeping toolbar chrome in `font-sans`.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/terminalMobileFullscreenHeader.test.ts tests/terminalClaudeScrollback.test.ts tests/terminalPerformanceOptimization.test.ts tests/terminalUnifiedLayout.test.ts tests/terminalMobileFixedHeader.test.ts tests/terminalTouchScroll.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/utils/monacoTheme.ts frontend/src/components/TerminalLogsView.tsx frontend/src/utils/ansiLogFormatter.ts frontend/src/components/terminal/TerminalAccessoryBar.tsx frontend/src/components/terminal/components/TerminalEmptyState.tsx frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx tests/terminalMobileFullscreenHeader.test.ts
git commit -m "feat(ui): sync terminal, Monaco, logs, empty state, and glass overlays to Obsidian Azure"
```

---

### Task 6: Migrate Standalone Modals & Drawers to `ModalShell`

**Files:**
- Modify: `frontend/src/components/terminal/components/CreateTaskModal.tsx`
- Modify: `frontend/src/components/terminal/components/CronJobModal.tsx`
- Modify: `frontend/src/components/terminal/components/CronLogModal.tsx`
- Modify: `frontend/src/components/terminal/components/TaskLogModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalScriptDrawer.tsx`
- Modify: `frontend/src/components/terminal/TerminalImagePreviewModal.tsx`
- Modify: `frontend/src/components/terminal/TerminalPdfPreviewModal.tsx`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`
- Test: `tests/frontendCronModals.test.ts`

**Interfaces:**
- Consumes from Task 3: `ModalShell`.
- Consumes from Task 1: `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-icon-btn`, `.ui-input`, `.ui-badge-*`.

- [ ] **Step 1: Update bottom-sheet modal assertions in `tests/frontendMobileCronAndTaskViews.test.ts`**

Update the `Responsive Modals as Bottom Sheets` describe block in `tests/frontendMobileCronAndTaskViews.test.ts` so it verifies:
- `ModalShell.tsx` implements `items-end sm:items-center` and `rounded-t-2xl`;
- `CronJobModal.tsx`, `CronLogModal.tsx`, `CreateTaskModal.tsx`, and `TaskLogModal.tsx` all import and render `<ModalShell`.

- [ ] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- tests/frontendMobileCronAndTaskViews.test.ts -t "Responsive Modals"`
Expected: FAIL (`<ModalShell` not yet used in those 4 modals).

- [ ] **Step 3: Refactor all 7 standalone modals/drawers to `ModalShell` and Obsidian Azure tokens**

1. **`CreateTaskModal.tsx` & `CronJobModal.tsx`**:
   - Wrap dialog in `<ModalShell isOpen={isOpen} onClose={onClose} disableClose={isLoading/isSubmitting} title={...} icon={...} footer={...} maxWidthClassName="max-w-lg">` (or `max-w-xl` for `CronJobModal`).
   - Keep `<form id="...">` wired to footer submit button (`form="..."` or wrap form cleanly so header/footer stay fixed `shrink-0` while fields scroll in `flex-1 min-h-0`).
   - Replace all `indigo-*`/`slate-*` with Obsidian Azure tokens, `.ui-btn-primary` (no `text-white`), `.ui-btn-secondary`, `.ui-input`, `.ui-badge-*`. Preserve all cron presets, dual `command`/`hub` mode, validation, `concurrency`, `timeoutMs`.
2. **`CronLogModal.tsx` & `TaskLogModal.tsx`**:
   - Wrap dialog in `<ModalShell ... maxWidthClassName="max-w-4xl" heightClassName="h-[88dvh]">`.
   - Preserve `bg-[var(--bg-terminal)]` on the ANSI log output well (required by `tests/frontendCronModals.test.ts`) and keep `.ansi-log-container`.
   - Replace all `indigo-*`/`slate-*`, upgrade status/exitCode badges to `.ui-badge-*`, use `font-mono tabular-nums` for timestamps/durations.
3. **`TerminalScriptDrawer.tsx`**:
   - Wrap drawer in `<ModalShell variant="drawer" isOpen={isOpen} onClose={onClose} maxWidthClassName="max-w-md" ...>`.
   - If the drawer contains any inline confirmation modal on top, wrap that confirmation in `<ModalShell zIndex="nested" ...>`.
   - Replace all `indigo-*`/`slate-*`, upgrade primary save/create CTA to `.ui-btn-primary` (no `text-white`).
4. **`TerminalImagePreviewModal.tsx` & `TerminalPdfPreviewModal.tsx`**:
   - Wrap in `<ModalShell ... maxWidthClassName="max-w-5xl" heightClassName="h-[88dvh]" bodyClassName="p-0 flex flex-col">`.
   - Replace all `indigo-*`/`slate-*`, use `bg-[var(--bg-elevated)]` / `--bg-surface-sub` semantic tokens (keeping `var(--bg-elevated)` reference for theme guard tests), remove any `backdrop-blur-xs` inline overlay divs.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/frontendMobileCronAndTaskViews.test.ts tests/frontendCronModals.test.ts tests/frontendCronTimezone.test.ts tests/frontendI18nScripts.test.ts tests/fileManagerMarkdownAndPdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add frontend/src/components/terminal/components/CreateTaskModal.tsx frontend/src/components/terminal/components/CronJobModal.tsx frontend/src/components/terminal/components/CronLogModal.tsx frontend/src/components/terminal/components/TaskLogModal.tsx frontend/src/components/terminal/TerminalScriptDrawer.tsx frontend/src/components/terminal/TerminalImagePreviewModal.tsx frontend/src/components/terminal/TerminalPdfPreviewModal.tsx tests/frontendMobileCronAndTaskViews.test.ts
git commit -m "feat(ui): migrate all 7 standalone modals and drawers to ModalShell and Obsidian Azure"
```

---

### Task 7: Redesign `TerminalTaskView` & `TerminalCronView` (4-Column Seamless KPI Strip, SWR Refresh, Ambient Empty States)

**Files:**
- Modify: `frontend/src/components/terminal/TerminalTaskView.tsx`
- Modify: `frontend/src/components/terminal/TerminalCronView.tsx`
- Test: `tests/frontendTaskSubTab.test.ts`
- Test: `tests/frontendTerminalCronView.test.ts`
- Test: `tests/frontendMobileCronAndTaskViews.test.ts`

**Interfaces:**
- Consumes from Task 1: `.ui-card`, `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-input`, `.ui-ambient-stage`, `.ui-badge-*`, `.ui-elevated-glass`.

- [ ] **Step 1: Add layout & SWR assertions to `tests/frontendTaskSubTab.test.ts` and `tests/frontendTerminalCronView.test.ts`**

1. In `tests/frontendTaskSubTab.test.ts`, assert `TerminalTaskView.tsx` renders the single-container 4-column seamless KPI bar (`divide-x`), `tabular-nums`, `ui-ambient-stage`, `ui-btn-primary`, `ui-elevated-glass`, and zero `indigo-` / `slate-` / `bg-[var(--bg-elevated)]/95`.
2. In `tests/frontendTerminalCronView.test.ts`, assert `TerminalCronView.tsx` uses `ui-ambient-stage`, `ui-btn-primary`, `ui-elevated-glass`, `tabular-nums`, and zero `indigo-` / `slate-` / `bg-[var(--bg-elevated)]/95`.

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/frontendTaskSubTab.test.ts tests/frontendTerminalCronView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Redesign `TerminalTaskView.tsx` and `TerminalCronView.tsx`**

1. **`frontend/src/components/terminal/TerminalTaskView.tsx`**:
   - Merge the 4 stat cards into a single `<div className="ui-card overflow-hidden grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[var(--border-subtle)] shrink-0">`, with `text-[26px] leading-tight font-semibold tracking-tight font-mono tabular-nums` values and low-saturation Tinted icon chips.
   - Implement Stale-While-Revalidate refresh: only show full-area loading spinner when `isLoading && tasks.length === 0`; when `isLoading && tasks.length > 0`, show a top `h-0.5` Azure indeterminate/pulse progress bar and apply `opacity-70 transition-opacity` to the list container.
   - Replace status filter pills active state with `bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border-[var(--accent-soft-border)]`; upgrade all status badges to `.ui-badge-*`; upgrade primary Create Task buttons to `.ui-btn-primary` (no `text-white`); add `.ui-ambient-stage` to empty state; replace `bg-[var(--bg-elevated)]/95` toast with `ui-elevated-glass`; preserve `sm:hidden space-y-3 shrink-0 pb-4` on mobile card list.
2. **`frontend/src/components/terminal/TerminalCronView.tsx`**:
   - Implement SWR refresh (`isLoading && jobs.length === 0` vs top `h-0.5` Azure bar + `opacity-70` when `jobs.length > 0`).
   - Upgrade search input to `.ui-input`, primary Add Job buttons to `.ui-btn-primary` (no `text-white`), table shell to `.ui-card overflow-hidden` with `--bg-surface-sub` header, cron/duration/next-run cells to `font-mono tabular-nums`, `hub:` script chips to `--accent-soft-bg` / `--accent-text`, status badges to `.ui-badge-*`, empty state to `.ui-ambient-stage`, and toast `bg-[var(--bg-elevated)]/95` to `ui-elevated-glass`. Eliminate all `indigo-*` and `slate-*`.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/frontendTaskSubTab.test.ts tests/frontendTerminalCronView.test.ts tests/frontendMobileCronAndTaskViews.test.ts tests/frontendTaskI18n.test.ts tests/frontendCronI18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add frontend/src/components/terminal/TerminalTaskView.tsx frontend/src/components/terminal/TerminalCronView.tsx tests/frontendTaskSubTab.test.ts tests/frontendTerminalCronView.test.ts
git commit -m "feat(ui): redesign TaskView and CronView with seamless KPI strip, SWR refresh, and Obsidian Azure"
```

---

### Task 8: Redesign `TerminalFileManagerView`, `TerminalMarkdownViewer`, `markdownRenderer.ts`, and `TerminalProxyView`

**Files:**
- Modify: `frontend/src/components/terminal/TerminalFileManagerView.tsx`
- Modify: `frontend/src/components/terminal/TerminalMarkdownViewer.tsx`
- Modify: `frontend/src/utils/markdownRenderer.ts`
- Modify: `frontend/src/components/terminal/TerminalProxyView.tsx`
- Test: `tests/fileManagerMarkdownAndPdf.test.ts`
- Test: `tests/frontendFileManagerToast.test.ts`
- Test: `tests/proxyUi.test.ts`
- Test: `tests/proxySpeedtest.test.ts`

**Interfaces:**
- Consumes from Task 1: `.ui-card`, `.ui-btn-primary`, `.ui-btn-secondary`, `.ui-input`, `.ui-ambient-stage`, `.ui-badge-*`, `.ui-elevated-glass`, `.ui-surface-glass`.
- Consumes from Task 3: `ModalShell`.

- [ ] **Step 1: Add Obsidian Azure & ModalShell assertions to `tests/fileManagerMarkdownAndPdf.test.ts` and `tests/proxyUi.test.ts`**

1. In `tests/fileManagerMarkdownAndPdf.test.ts`, assert `TerminalFileManagerView.tsx` imports `ModalShell`, uses `ui-surface-glass` (zero `bg-[var(--bg-surface)]/80`), and `markdownRenderer.ts` contains `var(--accent-text)` / `var(--accent-primary)` with zero `indigo-` / `slate-`.
2. In `tests/proxyUi.test.ts`, assert `TerminalProxyView.tsx` uses `ui-btn-primary`, `ui-elevated-glass`, `tabular-nums`, and zero `indigo-` / `slate-` / `bg-[var(--bg-elevated)]/95`.

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `npm test -- tests/fileManagerMarkdownAndPdf.test.ts tests/proxyUi.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `TerminalFileManagerView.tsx`, `TerminalMarkdownViewer.tsx`, `markdownRenderer.ts`, and `TerminalProxyView.tsx`**

1. **`frontend/src/components/terminal/TerminalFileManagerView.tsx`**:
   - Make top action & breadcrumb bar edge-to-edge (`bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] px-3 py-2`, removing nested `.ui-card` and `mb-2`).
   - Add `ui-ambient-stage` to empty state and upgrade primary CTA buttons to `.ui-btn-primary` (no `text-white`).
   - Replace drag-and-drop overlay `bg-[var(--bg-surface)]/80` with `ui-surface-glass` and toast with `ui-elevated-glass`.
   - Change code file icon from `text-indigo-400` to `text-blue-500 dark:text-blue-400`; apply `font-mono tabular-nums` on sizes and timestamps.
   - Migrate all 4 internal modals (New Folder, Rename, Delete Confirmation, Text/Code/Markdown Editor) to `ModalShell` (`maxWidthClassName="max-w-sm"` for the 3 small dialogs; `maxWidthClassName="max-w-5xl" heightClassName="h-[88dvh]"` for Editor modal), replacing `bg-indigo-600` on Markdown Preview/Edit active toggle with `bg-[var(--accent-soft-bg)] text-[var(--accent-text)] border border-[var(--accent-soft-border)]` and eliminating all `indigo-*` / `slate-*`.
2. **`frontend/src/components/terminal/TerminalMarkdownViewer.tsx` & `frontend/src/utils/markdownRenderer.ts`**:
   - Replace `text-indigo-600 dark:text-indigo-400`, `border-indigo-500`, `text-indigo-600` in `markdownRenderer.ts` with `text-[var(--accent-text)]`, `border-[var(--accent-primary)]`, `accent-[var(--accent-primary)]`, and remove any `slate-*` classes.
3. **`frontend/src/components/terminal/TerminalProxyView.tsx`**:
   - Align top discovered ports bar (`bg-[var(--bg-surface)]`), request/response/speedtest panels (`ui-card`), code/JSON/CLI slots (`bg-[var(--code-bg)] font-mono`), and toast (`ui-elevated-glass` replacing `bg-[var(--bg-elevated)]/95`).
   - Replace all `indigo-*` and `slate-*` classes; upgrade primary Send Request and Start Speedtest CTA buttons to `.ui-btn-primary` (no `text-white`, spinner `text-current`); format latency & bandwidth counters with `font-mono tabular-nums`.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/fileManagerMarkdownAndPdf.test.ts tests/frontendFileManagerToast.test.ts tests/proxyUi.test.ts tests/proxySpeedtest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add frontend/src/components/terminal/TerminalFileManagerView.tsx frontend/src/components/terminal/TerminalMarkdownViewer.tsx frontend/src/utils/markdownRenderer.ts frontend/src/components/terminal/TerminalProxyView.tsx tests/fileManagerMarkdownAndPdf.test.ts tests/proxyUi.test.ts
git commit -m "feat(ui): redesign FileManager, Markdown renderer, and ProxyView to Obsidian Azure"
```

---

### Task 9: Complete Obsidian Azure Architecture Guard Tests & Full Verification

**Files:**
- Modify: `tests/enterpriseThemeSystem.test.ts`

**Interfaces:**
- Verifies all deliverables across Tasks 1–8.

- [ ] **Step 1: Finalize full-repo Obsidian Azure architecture guard in `tests/enterpriseThemeSystem.test.ts`**

Update `tests/enterpriseThemeSystem.test.ts` to replace all legacy Slate/Indigo expectations (`#090D16`, `#F8FAFC`, `text-indigo-500`, `bg-indigo-600`) with comprehensive Obsidian Azure guardrails:
1. All Obsidian Azure tokens, primitives, `:not(.xterm-helper-textarea)` mobile `16px` guard, `prefers-reduced-motion`, and self-hosted `@fontsource-variable/*` fonts.
2. `index.html` Anti-FOUC script present and zero Google Fonts CDN links anywhere in `frontend/`.
3. Recursive scan of all `.ts`, `.tsx`, `.css` files under `frontend/src/`:
   - Zero `indigo-` classes (`/\bindigo-\d+/`);
   - Zero `slate-` classes (`/\bslate-\d+/`);
   - Zero Tailwind v3 CSS-variable opacity modifiers (`/(?:bg|border|text)-\[var\(--[^\]]+\)\]\//`);
   - Zero `.ui-btn-primary` class strings combined with `text-white` on the same element (scan both `className="..."` and template-literal `className={`...`}` attributes).
4. `WebTerminalView.tsx` uses `background: '#07080a'` and `background: '#ffffff'` (case-insensitive), `monacoTheme.ts` uses `'#0b0d11'` and `'#ffffff'`.
5. All 9 modal-bearing component files (`CreateTaskModal`, `CronJobModal`, `CronLogModal`, `TaskLogModal`, `TerminalScriptDrawer`, `TerminalImagePreviewModal`, `TerminalPdfPreviewModal`, `TerminalHostSelector`, `TerminalFileManagerView`) import `ModalShell` and contain zero raw modal overlay `fixed inset-0 z-50` wrappers.

- [ ] **Step 2: Run full frontend & theme test matrix**

Run:
```bash
npm test -- tests/enterpriseThemeSystem.test.ts tests/modalShell.test.ts tests/autoHostThemeSync.test.ts tests/frontendAuthContext.test.ts tests/frontendLoginView.test.ts tests/frontendCronModals.test.ts tests/frontendUnifiedSubTabs.test.ts tests/frontendSplitPaneTerminal.test.ts tests/frontendSplitPaneWorkspace.test.ts tests/frontendMobileCronAndTaskViews.test.ts tests/frontendTaskSubTab.test.ts tests/frontendTerminalCronView.test.ts tests/terminalHostSelector.test.ts tests/terminalMobileFullscreenHeader.test.ts tests/proxyUi.test.ts tests/fileManagerMarkdownAndPdf.test.ts tests/frontendFileManagerToast.test.ts
```
Expected: All suites PASS (fix any residual `indigo-`/`slate-`/`bg-[var(--*)]/` hit immediately if the repo-wide scanner flags one).

- [ ] **Step 3: Run TypeScript typecheck and full production build, verifying offline font bundle**

Run:
```bash
npm run typecheck && npm run build && ls dist/frontend/assets/*.woff2
```
Expected: Typecheck exits 0, build succeeds with zero errors, and `.woff2` files for Inter Variable and JetBrains Mono Variable exist inside `dist/frontend/assets/`.

- [ ] **Step 4: Commit Task 9**

```bash
git add tests/enterpriseThemeSystem.test.ts
git commit -m "test(ui): enforce Obsidian Azure tokens, anti-pattern scans, and ModalShell guards"
```
