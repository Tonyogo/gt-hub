# Terminal Transparent & Hidden Side Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the interactive web terminal's side scrollbar completely transparent and hidden by default while zeroing out `xterm.js`'s 15px scrollbar width reservation so terminal text is never occluded or clipped on the right edge.

**Architecture:**
1. In `frontend/src/utils/terminalScrollHelper.ts`:
   - Extend `patchXtermNoopSelectionRefresh(term: any)` (and export a dedicated `patchXtermTransparentScrollbar(term: any): void` invoked inside it) to set `core.viewport.scrollBarWidth = 0`, set `core._viewportElement.style.backgroundColor = 'transparent'`, and patch `core.viewport._handleThemeChange` so theme switches never re-apply an opaque background color to `.xterm-viewport`.
2. In `frontend/src/components/WebTerminalView.tsx`:
   - Pass `overviewRulerWidth: 0` in `new Terminal({ ... })` options and call `patchXtermTransparentScrollbar(term)` after `term.open(terminalContainerRef.current)`.
3. In `frontend/src/index.css`:
   - Strengthen `.xterm .xterm-viewport` and its scrollbar pseudo-elements (`::-webkit-scrollbar`, `-thumb`, `-thumb:hover`, `-thumb:active`, `-track`, `-corner`) plus `.xterm-decoration-overview-ruler` with `background: transparent !important; background-color: transparent !important; width: 0 !important; height: 0 !important; display: none !important; opacity: 0 !important; pointer-events: none;` so late-loaded `@xterm/xterm/css/xterm.css` or global `:root ::-webkit-scrollbar` rules can never render an opaque track, thumb, or overview ruler over terminal text.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm` 5.5.0, `@xterm/addon-fit`, Tailwind CSS, Jest.

**Spec:** In-chat bounded design (Option A) approved by user (conversation 2026-10-27).

## Global Constraints

- Preserve all existing assertions in `tests/terminalMobileResizeStability.test.ts`, `tests/terminalScrollHelper.test.ts`, and `tests/terminalTouchScroll.test.ts`.
- Ensure `@xterm/addon-fit` calculates columns using `scrollBarWidth = 0` rather than the `|| 15` fallback in `xterm.js` `Viewport` constructor.
- Theme changes (`dark` <-> `light`) must not reset `.xterm-viewport` inline `backgroundColor` back to an opaque color that obscures underlying or overlapping elements.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during iterative development.

## Review Focus

1. **`xterm.js` `Viewport` Constructor `|| 15` Fallback**: When CSS hides the scrollbar (`offsetWidth - scrollArea.offsetWidth === 0`), `xterm.js` evaluates `0 || 15` and sets `viewport.scrollBarWidth = 15`. Explicitly setting `viewport.scrollBarWidth = 0` after `term.open()` ensures `FitAddon.proposeDimensions()` uses the full container width.
2. **Runtime Theme Change Override (`Viewport._handleThemeChange`)**: `xterm.js` registers `onChangeColors` to set `this._viewportElement.style.backgroundColor = e.background.css`. Wrapping `_handleThemeChange` (and setting `background-color: transparent !important` in CSS) keeps `.xterm-viewport` transparent across theme toggles.
3. **Global `::-webkit-scrollbar-thumb:hover` Bleed-Through**: `index.css` defines global `::-webkit-scrollbar-thumb` and `::-webkit-scrollbar-thumb:hover` rules. Explicit `.xterm .xterm-viewport::-webkit-scrollbar-thumb:hover` and `:active` rules with `background: transparent !important` prevent hover states from appearing over the rightmost terminal column.
4. **Overview Ruler Occlusion (`.xterm-decoration-overview-ruler`)**: Setting `overviewRulerWidth: 0` in `Terminal` options and hiding `.xterm-decoration-overview-ruler` in CSS prevents any right-edge decoration canvas from covering characters.
5. **Null/Partial Mock Safety**: `patchXtermTransparentScrollbar` must safely no-op when called with `null`, `undefined`, or partial test mocks lacking `viewport` or `_viewportElement`.

---

### Task 1: Add `patchXtermTransparentScrollbar` Helper and Unit Tests

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:275-320`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Produces:
  - `export function patchXtermTransparentScrollbar(term: any): void` in `frontend/src/utils/terminalScrollHelper.ts` (also invoked automatically at the end of `patchXtermNoopSelectionRefresh(term)`).

- [x] **Step 1: Write failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add a test in `tests/terminalScrollHelper.test.ts` under `describe('mobile touch momentum & step helpers', ...)` verifying that `patchXtermTransparentScrollbar`:
1. Resets `term._core.viewport.scrollBarWidth` from `15` to `0`.
2. Sets `term._core._viewportElement.style.backgroundColor` to `'transparent'`.
3. Wraps `term._core.viewport._handleThemeChange` so subsequent theme updates keep `_viewportElement.style.backgroundColor` as `'transparent'`.

```typescript
    it('patchXtermTransparentScrollbar zeroes scrollBarWidth and keeps viewport background transparent across theme changes', () => {
      const viewportElement = {
        style: {
          backgroundColor: '#000000',
        },
      };
      const mockViewport: any = {
        scrollBarWidth: 15,
        _viewportElement: viewportElement,
        _handleThemeChange(colors: any) {
          this._viewportElement.style.backgroundColor = colors.background.css;
        },
      };
      const mockTerm = {
        _core: {
          _viewportElement: viewportElement,
          viewport: mockViewport,
        },
      };

      patchXtermTransparentScrollbar(mockTerm);

      expect(mockViewport.scrollBarWidth).toBe(0);
      expect(viewportElement.style.backgroundColor).toBe('transparent');

      // Simulate theme change callback firing inside xterm
      mockViewport._handleThemeChange({ background: { css: '#090A0F' } });
      expect(viewportElement.style.backgroundColor).toBe('transparent');
      expect(mockViewport.scrollBarWidth).toBe(0);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL (`patchXtermTransparentScrollbar` is not exported from `../frontend/src/utils/terminalScrollHelper`).

- [x] **Step 3: Implement `patchXtermTransparentScrollbar` in `frontend/src/utils/terminalScrollHelper.ts`**

In `frontend/src/utils/terminalScrollHelper.ts`, implement and export `patchXtermTransparentScrollbar(term: any): void` and call it inside `patchXtermNoopSelectionRefresh(term)`:

```typescript
/**
 * Hides xterm's side scrollbar reservation (zeroes out the default 15px scrollBarWidth fallback)
 * and keeps .xterm-viewport background transparent even after runtime theme changes.
 */
export function patchXtermTransparentScrollbar(term: any): void {
  const core = term?._core;
  if (!core) return;

  const viewport = core.viewport;
  const viewportEl = core._viewportElement || viewport?._viewportElement;

  if (viewportEl && viewportEl.style) {
    viewportEl.style.backgroundColor = 'transparent';
  }

  if (viewport) {
    viewport.scrollBarWidth = 0;
    if (typeof viewport._handleThemeChange === 'function' && !viewport.__transparentScrollbarPatched) {
      const origHandleThemeChange = viewport._handleThemeChange.bind(viewport);
      viewport._handleThemeChange = (colors: any) => {
        origHandleThemeChange(colors);
        viewport.scrollBarWidth = 0;
        const el = core._viewportElement || viewport._viewportElement;
        if (el && el.style) {
          el.style.backgroundColor = 'transparent';
        }
      };
      viewport.__transparentScrollbarPatched = true;
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "feat(terminal): add patchXtermTransparentScrollbar to zero scrollBarWidth and keep viewport transparent"
```

---

### Task 2: Apply Transparent Hidden Scrollbar Rules in `index.css` and `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/index.css:214-235`
- Modify: `frontend/src/components/WebTerminalView.tsx:48-52,832-865`
- Test: `tests/terminalMobileResizeStability.test.ts`

**Interfaces:**
- Consumes:
  - `patchXtermTransparentScrollbar` from `../utils/terminalScrollHelper`
- Modifies:
  - `frontend/src/index.css`: `.xterm .xterm-viewport` transparent background + zero-width hidden scrollbar rules across default/hover/active/corner states and `.xterm-decoration-overview-ruler`.
  - `frontend/src/components/WebTerminalView.tsx`: sets `overviewRulerWidth: 0` in `Terminal` options and calls `patchXtermTransparentScrollbar(term)` after `term.open(terminalContainerRef.current)`.

- [x] **Step 1: Write failing assertions in `tests/terminalMobileResizeStability.test.ts`**

Update the `'Terminal Viewport Scrollbar Transparency & Safe Area Margin'` block in `tests/terminalMobileResizeStability.test.ts` to assert:
1. `index.css` sets `background-color: transparent !important` on `.xterm .xterm-viewport`, sets `width: 0 !important` and `display: none !important` on `.xterm .xterm-viewport::-webkit-scrollbar`, sets `background: transparent !important` on thumb/hover/track, and hides `.xterm-decoration-overview-ruler`.
2. `WebTerminalView.tsx` configures `overviewRulerWidth: 0` and invokes `patchXtermTransparentScrollbar(term)`.

```typescript
  it('index.css includes transparent/hidden scrollbar rules for .xterm .xterm-viewport', () => {
    const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');
    const indexCssContent = fs.readFileSync(indexCssPath, 'utf-8');

    expect(indexCssContent).toContain('.xterm .xterm-viewport');
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport[\s\S]*?scrollbar-width:\s*none/);
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport[\s\S]*?background-color:\s*transparent\s*!important/);
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport::-webkit-scrollbar[\s\S]*?background:\s*transparent/);
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport::-webkit-scrollbar-thumb:hover[\s\S]*?background:\s*transparent\s*!important/);
    expect(indexCssContent).toMatch(/\.xterm-decoration-overview-ruler[\s\S]*?display:\s*none\s*!important/);
  });

  it('WebTerminalView disables overviewRulerWidth and patches transparent zero-width scrollbar', () => {
    const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
    const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

    expect(webTerminalContent).toContain('overviewRulerWidth: 0');
    expect(webTerminalContent).toContain('patchXtermTransparentScrollbar(term)');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalMobileResizeStability.test.ts`
Expected: FAIL (`background-color: transparent !important` and `overviewRulerWidth: 0` are not yet present).

- [x] **Step 3: Update `frontend/src/index.css` and `frontend/src/components/WebTerminalView.tsx`**

1. In `frontend/src/index.css`, update the `.xterm .xterm-viewport` scrollbar block:
```css
/* Terminal Viewport: Transparent & Invisible Scrollbar to prevent text obstruction */
.xterm .xterm-viewport {
  background-color: transparent !important;
  background: transparent !important;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  touch-action: none !important;
  overscroll-behavior: none !important;
  -webkit-overflow-scrolling: auto !important;
}
.xterm .xterm-viewport::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  background: transparent !important;
  -webkit-appearance: none !important;
}
.xterm .xterm-viewport::-webkit-scrollbar-thumb,
.xterm .xterm-viewport::-webkit-scrollbar-thumb:hover,
.xterm .xterm-viewport::-webkit-scrollbar-thumb:active {
  background: transparent !important;
  background-color: transparent !important;
  border: none !important;
  box-shadow: none !important;
}
.xterm .xterm-viewport::-webkit-scrollbar-track,
.xterm .xterm-viewport::-webkit-scrollbar-corner {
  background: transparent !important;
  background-color: transparent !important;
  border: none !important;
  box-shadow: none !important;
}
.xterm .xterm-decoration-overview-ruler {
  display: none !important;
  width: 0 !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
```

2. In `frontend/src/components/WebTerminalView.tsx`:
   - Import `patchXtermTransparentScrollbar` from `../utils/terminalScrollHelper`.
   - Add `overviewRulerWidth: 0` to `new Terminal({ ... })`.
   - Call `patchXtermTransparentScrollbar(term);` right after `patchXtermNoopSelectionRefresh(term);`.

- [x] **Step 4: Run targeted tests and frontend build to verify everything passes**

Run: `npm test -- tests/terminalMobileResizeStability.test.ts tests/terminalScrollHelper.test.ts tests/terminalTouchScroll.test.ts && npm run build:frontend`
Expected: PASS and clean frontend build.

- [x] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/components/WebTerminalView.tsx tests/terminalMobileResizeStability.test.ts
git commit -m "fix(frontend): make terminal side scrollbar transparent and hidden by default"
```
