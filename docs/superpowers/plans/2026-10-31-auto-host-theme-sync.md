# Auto System & Embedded Host Theme Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `gt-hub` to automatically follow the OS color scheme in standalone mode and dynamically match/synchronize with the parent webpage's light/dark theme when embedded via `<iframe>` (like `zashboard`).

**Architecture:** Upgrade `frontend/src/theme/ThemeContext.tsx` from a static `'dark' | 'light'` state to a tri-mode `'system' | 'dark' | 'light'` engine (defaulting to `'system'`) with a 4-tier host/system theme detector: URL query parameters (`?theme=`), cross-origin `postMessage` events, same-origin parent DOM inspection + `MutationObserver` (classes, `data-theme`, `color-scheme`, and background luminance), and `window.matchMedia('(prefers-color-scheme: dark)')` (covering OS preferences and cross-origin iframe `color-scheme` inheritance).

**Tech Stack:** React 18, TypeScript, DOM `MutationObserver`, `matchMedia`, `postMessage` API, Jest (`ts-jest`).

**Spec:** `docs/superpowers/specs/2026-10-31-auto-host-theme-sync-design.md`

## Global Constraints

- `ResolvedTheme` must remain `'dark' | 'light'` so all consumers (`useTheme().resolvedTheme` in Xterm, Monaco, UnifiedTerminalView, LoginView) remain 100% backward-compatible.
- When embedded inside an `<iframe>` (`window.self !== window.top`) without an explicit URL `?theme=dark|light` override, `getInitialThemeMode` must default to `'system'` rather than reading stale `localStorage` from a prior standalone visit.
- Cross-origin access to `window.parent.document` throws a `DOMException` (`SecurityError`); all parent DOM reads and `MutationObserver` attachments must be wrapped in `try { ... } catch {}` and fall back gracefully to `matchMedia` and `postMessage`.
- Preserve `Sun` and `Moon` icon imports in `UnifiedTerminalView.tsx` and `LoginView.tsx` so `tests/terminalUnifiedTopBarControls.test.ts` and `tests/frontendLoginView.test.ts` continue to pass.

## Review Focus

- **Cross-origin `window.parent.document` SecurityError:** Accessing `window.parent.document` inside a cross-origin iframe throws synchronously. `detectParentDocumentTheme` must catch the error and return `null` so `resolveAutoTheme` falls through to `window.matchMedia('(prefers-color-scheme: dark)')`.
- **Transparent `rgba(0, 0, 0, 0)` background on parent `<html>` or `<body>`:** Many browsers report `rgba(0, 0, 0, 0)` (alpha `0`) as the default `computedStyle.backgroundColor`. `parseLuminanceTheme` must ignore colors with alpha `<= 0.1` instead of treating `0, 0, 0` as black (`'dark'`).
- **Unrelated `postMessage` traffic in embedded environments:** Host pages, browser extensions, and Monaco Editor send frequent `postMessage` payloads. `parseThemeFromMessage` must strictly validate theme message structure and ignore unrelated messages instead of accidentally flipping themes.
- **Stale `localStorage` locking embedded iframes:** A user who previously visited `gt-hub` standalone may have `gemini_proxy_theme='dark'` in `localStorage`. When `gt-hub` is later embedded in a light-themed host page (`window.self !== window.top`), `getInitialThemeMode` must ignore `localStorage` and start in `'system'` mode.
- **MatchMedia legacy Safari/WebView compatibility:** Some embedded WebViews only support `mediaQueryList.addListener` / `removeListener` rather than `addEventListener('change', ...)`. The listener setup in `ThemeContext.tsx` must support both.

---

### Task 1: 4-Tier Host & System Theme Detection Engine in `ThemeContext.tsx`

**Files:**
- Modify: `frontend/src/theme/ThemeContext.tsx`
- Create: `tests/autoHostThemeSync.test.ts`

**Interfaces:**
- Produces in `frontend/src/theme/ThemeContext.tsx`:
  - `export type ThemeMode = 'system' | 'dark' | 'light'`
  - `export type ResolvedTheme = 'dark' | 'light'`
  - `export function parseThemeToken(raw: unknown): ThemeMode | null`
  - `export function parseThemeFromUrl(search?: string, hash?: string): ThemeMode | null`
  - `export function parseThemeFromMessage(data: unknown): ThemeMode | null`
  - `export function parseLuminanceTheme(cssColor: string | null | undefined): ResolvedTheme | null`
  - `export function detectElementTheme(el: Element | null, computedStyle?: Partial<CSSStyleDeclaration> | null): ResolvedTheme | null`
  - `export function detectParentDocumentTheme(win?: any): ResolvedTheme | null`
  - `export function isEmbeddedIframe(win?: any): boolean`
  - `export function getInitialThemeMode(win?: any, storage?: Pick<Storage, 'getItem'> | null): ThemeMode`
  - `export function resolveAutoTheme(win?: any): ResolvedTheme`

- [x] **Step 1: Create `tests/autoHostThemeSync.test.ts` with unit tests for all 4 detection tiers and edge cases**

```typescript
import {
  parseThemeToken,
  parseThemeFromUrl,
  parseThemeFromMessage,
  parseLuminanceTheme,
  detectElementTheme,
  detectParentDocumentTheme,
  isEmbeddedIframe,
  getInitialThemeMode,
  resolveAutoTheme,
} from '../frontend/src/theme/ThemeContext';

describe('Auto System & Embedded Host Theme Sync Engine', () => {
  test('parseThemeToken normalizes dark, light, and system/auto tokens and rejects invalid input', () => {
    expect(parseThemeToken('dark')).toBe('dark');
    expect(parseThemeToken('NIGHT')).toBe('dark');
    expect(parseThemeToken('light')).toBe('light');
    expect(parseThemeToken('day')).toBe('light');
    expect(parseThemeToken('auto')).toBe('system');
    expect(parseThemeToken('system')).toBe('system');
    expect(parseThemeToken('invalid')).toBeNull();
    expect(parseThemeToken(null)).toBeNull();
  });

  test('parseThemeFromUrl extracts theme from query string or hash query', () => {
    expect(parseThemeFromUrl('?theme=light', '')).toBe('light');
    expect(parseThemeFromUrl('?foo=1&colorScheme=dark', '')).toBe('dark');
    expect(parseThemeFromUrl('', '#/terminal?theme=auto')).toBe('system');
    expect(parseThemeFromUrl('?other=1', '')).toBeNull();
  });

  test('parseThemeFromMessage parses zashboard/portal postMessage formats and ignores unrelated traffic', () => {
    expect(parseThemeFromMessage({ type: 'theme-change', theme: 'light' })).toBe('light');
    expect(parseThemeFromMessage({ type: 'zashboard-theme', value: 'dark' })).toBe('dark');
    expect(parseThemeFromMessage({ theme: 'light' })).toBe('light');
    expect(parseThemeFromMessage({ colorMode: 'dark' })).toBe('dark');
    expect(parseThemeFromMessage({ isDark: false })).toBe('light');
    expect(parseThemeFromMessage({ isDark: true })).toBe('dark');
    expect(parseThemeFromMessage(JSON.stringify({ type: 'set-theme', theme: 'light' }))).toBe('light');
    expect(parseThemeFromMessage('theme:light')).toBe('light');
    // Unrelated messages must return null
    expect(parseThemeFromMessage({ type: 'monaco-worker', data: 123 })).toBeNull();
    expect(parseThemeFromMessage('random-string')).toBeNull();
  });

  test('parseLuminanceTheme classifies dark/light backgrounds and ignores transparent rgba(0, 0, 0, 0)', () => {
    expect(parseLuminanceTheme('rgb(9, 13, 22)')).toBe('dark');
    expect(parseLuminanceTheme('rgb(255, 255, 255)')).toBe('light');
    expect(parseLuminanceTheme('#090d16')).toBe('dark');
    expect(parseLuminanceTheme('#f8fafc')).toBe('light');
    expect(parseLuminanceTheme('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseLuminanceTheme('rgba(15, 23, 42, 0.05)')).toBeNull();
    expect(parseLuminanceTheme('transparent')).toBeNull();
  });

  test('detectElementTheme inspects classList, data-theme attributes, colorScheme, and computed background luminance', () => {
    const mockDarkClassEl = {
      classList: { contains: (c: string) => c === 'dark' },
      getAttribute: () => null,
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockDarkClassEl)).toBe('dark');

    const mockDataThemeEl = {
      classList: { contains: () => false },
      getAttribute: (attr: string) => (attr === 'data-theme' ? 'light' : null),
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockDataThemeEl)).toBe('light');

    const mockBgEl = {
      classList: { contains: () => false },
      getAttribute: () => null,
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockBgEl, { backgroundColor: 'rgb(248, 250, 252)' })).toBe('light');
  });

  test('detectParentDocumentTheme handles cross-origin SecurityError gracefully and detects same-origin parent theme', () => {
    const crossOriginWin = {
      self: {},
      top: {},
      parent: {
        get document(): any {
          throw new Error('SecurityError: Blocked a frame with origin');
        },
      },
    };
    expect(detectParentDocumentTheme(crossOriginWin)).toBeNull();

    const sameOriginWin = {
      self: {},
      top: {},
      parent: {
        document: {
          documentElement: {
            classList: { contains: (c: string) => c === 'light' },
            getAttribute: () => null,
            style: {},
          },
          body: null,
        },
        getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', colorScheme: '' }),
      },
    };
    expect(detectParentDocumentTheme(sameOriginWin)).toBe('light');
  });

  test('getInitialThemeMode ignores stale localStorage when embedded in an iframe and defaults to system', () => {
    const mockStorage = {
      getItem: () => 'dark',
    };
    const embeddedWin = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
    };
    expect(isEmbeddedIframe(embeddedWin)).toBe(true);
    expect(getInitialThemeMode(embeddedWin, mockStorage)).toBe('system');

    const standaloneWin = {
      self: { id: 1 },
      top: undefined as any,
      location: { search: '', hash: '' },
    };
    standaloneWin.top = standaloneWin.self;
    expect(isEmbeddedIframe(standaloneWin)).toBe(false);
    expect(getInitialThemeMode(standaloneWin, mockStorage)).toBe('dark');
  });

  test('resolveAutoTheme prioritizes parent document theme over matchMedia and falls back to matchMedia', () => {
    const winWithLightParent = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
      parent: {
        document: {
          documentElement: {
            classList: { contains: () => false },
            getAttribute: (name: string) => (name === 'data-theme' ? 'light' : null),
            style: {},
          },
          body: null,
        },
        getComputedStyle: () => ({}),
      },
      matchMedia: () => ({ matches: true }), // OS is dark, but parent host is light
    };
    expect(resolveAutoTheme(winWithLightParent)).toBe('light');

    const crossOriginWinWithLightMedia = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
      parent: {
        get document(): any {
          throw new Error('Cross-origin');
        },
      },
      matchMedia: (q: string) => ({ matches: q.includes('dark') ? false : true }),
    };
    expect(resolveAutoTheme(crossOriginWinWithLightMedia)).toBe('light');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/autoHostThemeSync.test.ts`
Expected: FAIL (`parseThemeToken` and other functions are not exported from `ThemeContext.tsx`)

- [x] **Step 3: Implement the 4-tier detection engine and reactive listeners in `frontend/src/theme/ThemeContext.tsx`**

In `frontend/src/theme/ThemeContext.tsx`:
- Update `ThemeMode` to `'system' | 'dark' | 'light'`.
- Implement and export `parseThemeToken`, `parseThemeFromUrl`, `parseThemeFromMessage`, `parseLuminanceTheme`, `detectElementTheme`, `detectParentDocumentTheme`, `isEmbeddedIframe`, `getInitialThemeMode`, and `resolveAutoTheme` per Spec Section 2.2.
- Inside `ThemeProvider`:
  - Initialize `theme` state via `getInitialThemeMode()`.
  - Track `autoResolvedTheme` state via `resolveAutoTheme()` and keep an `externalThemeOverride` state for explicit `postMessage` host broadcasts (`'dark' | 'light' | null`).
  - Compute `resolvedTheme: ResolvedTheme = externalThemeOverride ?? (theme === 'system' ? autoResolvedTheme : theme)`.
  - In `useEffect`, register and clean up:
    1. `window.matchMedia('(prefers-color-scheme: dark)')` change listener (`addEventListener` with fallback to `addListener`).
    2. Same-origin `window.parent.document` `MutationObserver` watching `documentElement` and `body` for `['class', 'style', 'data-theme', 'data-color-mode', 'data-color-scheme', 'data-bs-theme', 'theme']`.
    3. `window.addEventListener('message', ...)` using `parseThemeFromMessage(event.data)`: if `'system'`, clear `externalThemeOverride` and set `theme` to `'system'`; if `'dark'` or `'light'`, update `externalThemeOverride` and `autoResolvedTheme`.
    4. `window.addEventListener('popstate', ...)` and `hashchange` to re-evaluate `resolveAutoTheme()`.
  - When `setTheme(newTheme)` or `toggleTheme()` is called explicitly by the user:
    - Clear `externalThemeOverride` (`null`), update `theme`, and persist to `localStorage` (`THEME_STORAGE_KEY`).
    - In `toggleTheme()`, toggle cleanly between `'light'` and `'dark'` based on current `resolvedTheme` (`resolvedTheme === 'dark' ? 'light' : 'dark'`) so a single click immediately flips the visible theme.

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/autoHostThemeSync.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/theme/ThemeContext.tsx tests/autoHostThemeSync.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): implement 4-tier auto system and embedded host theme sync engine

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `toggleTheme` in `LoginView.tsx` & `UnifiedTerminalView.tsx` and Verify End-to-End Build

**Files:**
- Modify: `frontend/src/components/LoginView.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Modify: `tests/autoHostThemeSync.test.ts`

**Interfaces:**
- Consumes: `useTheme()` (`{ theme, resolvedTheme, setTheme, toggleTheme }`) from Task 1
- Produces: Clean theme toggle wiring in `LoginView` and `UnifiedTerminalView`

- [x] **Step 1: Add a test in `tests/autoHostThemeSync.test.ts` verifying `ThemeContext`, `LoginView`, and `UnifiedTerminalView` integration**

```typescript
  test('ThemeContext wires MutationObserver, matchMedia, and postMessage listeners', () => {
    const fs = require('fs');
    const path = require('path');
    const contextCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/theme/ThemeContext.tsx'),
      'utf-8'
    );
    expect(contextCode).toContain('MutationObserver');
    expect(contextCode).toContain('prefers-color-scheme: dark');
    expect(contextCode).toContain("addEventListener('message'");
  });
```

- [x] **Step 2: Update `LoginView.tsx` and `UnifiedTerminalView.tsx` to use `toggleTheme` and descriptive titles**

In `frontend/src/components/LoginView.tsx` and `frontend/src/components/UnifiedTerminalView.tsx`:
- Destructure `toggleTheme` and `theme` alongside `setTheme` and `resolvedTheme` from `useTheme()`.
- Wire the theme switcher buttons to call `toggleTheme()` (which flips `resolvedTheme === 'dark' ? 'light' : 'dark'` and clears any external override), and keep `Sun` and `Moon` icons intact.

- [x] **Step 3: Run targeted tests and frontend build**

Run: `npm test -- tests/autoHostThemeSync.test.ts tests/frontendLoginView.test.ts tests/terminalUnifiedTopBarControls.test.ts tests/enterpriseThemeSystem.test.ts && npm run build:frontend`
Expected: PASS and clean Vite build

- [x] **Step 4: Commit**

```bash
git add frontend/src/components/LoginView.tsx frontend/src/components/UnifiedTerminalView.tsx tests/autoHostThemeSync.test.ts docs/superpowers/specs/2026-10-31-auto-host-theme-sync-design.md docs/superpowers/plans/2026-10-31-auto-host-theme-sync.md
git commit -m "$(cat <<'EOF'
feat(theme): wire auto host theme sync across LoginView and UnifiedTerminalView

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```
