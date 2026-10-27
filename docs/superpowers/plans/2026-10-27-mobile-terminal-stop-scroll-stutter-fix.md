# Mobile Terminal Stop-Scroll Stutter & Detached Span Touch Loss Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the stutter and touch-stream dropout that occur when stopping or pausing finger movement during mobile terminal scrolling.

**Architecture:**
1. **Prevent Detached `<span>` Touch Target Loss & Long-Press Callouts (`frontend/src/index.css`)**: `@xterm/xterm`'s `DomRenderer.renderRows` calls `rowElement.replaceChildren(...)` on every scrolled line, detaching the `<span>` nodes under the user's finger. By setting `pointer-events: none` on `.xterm .xterm-rows, .xterm .xterm-rows *` (except hoverable `a` links on desktop) and `user-select: none; -webkit-user-select: none; -webkit-touch-callout: none` on `.xterm, .xterm .xterm-viewport, .xterm .xterm-screen, .xterm .xterm-rows, .xterm .xterm-rows *`, every touch event's `Touch.target` binds to the persistent `.xterm-screen` container and never detaches mid-gesture or triggers OS word-selection callouts when the finger pauses.
2. **Eliminate Layout Thrashing & Trailing `amount: 0` Full-Screen Redraws (`frontend/src/utils/terminalScrollHelper.ts`)**: Update `flushXtermScrollFrameSync` so `viewport._innerRefresh()` (which reads `offsetHeight`/`scrollTop`) runs *before* `debouncer._innerRefresh()` (which mutates DOM rows), avoiding forced synchronous layout reflows. In `patchXtermNoopSelectionRefresh`, also guard `term._core.scrollLines(disp, suppressScrollEvent, source)` so that when `source === 1` (`Viewport` scroll event) and `disp === 0` (fired asynchronously after `_ignoreNextScrollEvent` when scroll stops), the redundant `this.refresh(0, this.rows - 1)` full-screen DOM rebuild is skipped.
3. **Prevent Synthetic Mouse Hijack & React Re-Render Stutter on Stop (`frontend/src/components/WebTerminalView.tsx`)**: Call `e.preventDefault()` in `handleTouchEnd` when ending a drag (`isDragging`) or a long-press pause (`elapsed >= 350`), stop calling `syncAtBottomAfterTouchScroll()` synchronously inside `handleTouchStart` (which triggered a 2900-line React re-render right as the finger touched down to stop momentum), and replace `backdrop-blur-md` / `animate-pulse` on the floating scroll-to-bottom button with a lightweight GPU-friendly surface style.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm` 5.5.0, Tailwind CSS, Jest.

**Spec:** Approved 4-point root-cause diagnosis and fix design in chat (2026-10-27).

## Global Constraints

- Preserve all existing assertions in `tests/terminalTouchScroll.test.ts`, `tests/terminalScrollHelper.test.ts`, `tests/terminalMobileKeyboard.test.ts`, `tests/terminalCopyOnSelectAndTouchFix.test.ts`, and `tests/terminalMobileSelection.test.ts`.
- Do NOT apply `translate3d` or `transform` to `.xterm-screen`.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard without calling `e.preventDefault()` on that branch.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during iterative development.

## Review Focus

1. **Detached `<span>` Touch Target Dropout**: When a finger touches down on terminal text, `e.target` is a child `<span>` inside `.xterm-rows`. Without `pointer-events: none` on `.xterm-rows`, the first `renderRows()` call destroys that `<span>` via `replaceChildren()`, causing the browser to stop bubbling subsequent `touchmove`/`touchend` events to `terminalContainerRef`.
2. **Forced Synchronous Layout in `flushXtermScrollFrameSync`**: Executing `debouncer._innerRefresh()` (DOM writes) before `viewport._innerRefresh()` (DOM geometry reads of `_viewportElement.offsetHeight` and `scrollTop`) forces a synchronous layout reflow on every scrolled frame. Running `viewport._innerRefresh()` first reads clean layout before DOM mutations.
3. **Trailing Native `scroll` Event Redraw When Stopping**: When `viewport._innerRefresh()` sets `_ignoreNextScrollEvent = true` and writes `_viewportElement.scrollTop = e`, the browser queues an async `scroll` event that arrives right as scrolling stops. `Viewport._handleScroll` sees `_ignoreNextScrollEvent === true` and fires `_onRequestScrollLines.fire({ amount: 0, suppressScrollEvent: true })`, which calls `core.scrollLines(0, true, 1)` -> `this.refresh(0, this.rows - 1)`. Skipping `core.scrollLines(0, true, 1)` eliminates this post-stop full-screen rebuild.
4. **Synthetic Mouse & Focus Hijack After Drag or Hold-to-Stop**: If a user drags or holds their finger down for `>= 350ms` to stop momentum and lifts it without `e.preventDefault()` in `handleTouchEnd`, mobile browsers emit synthetic `mousedown`/`mouseup`/`click` events that trigger `xterm`'s `SelectionService.handleMouseDown` and `this.focus()`.
5. **`handleTouchStart` Synchronous React Re-render & Backdrop-Blur Cost**: Catching an active momentum scroll with a finger (`handleTouchStart`) previously called `syncAtBottomAfterTouchScroll()` -> `setIsAtBottom(false)`, forcing a full React re-render and mounting a `backdrop-blur-md` layer on the exact frame the user touched the screen.

---

### Task 1: Fix Layout Thrashing in `flushXtermScrollFrameSync` and Suppress `amount === 0` Viewport Scroll Redraws in `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:273-333`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Modifies:
  - `export function patchXtermNoopSelectionRefresh(term: any): void` — in addition to guarding `_renderService.handleSelectionChanged`, wraps `term._core.scrollLines(disp: number, suppressScrollEvent?: boolean, source?: number)` so calls with `disp === 0 && source === 1` return early without triggering `this.refresh(0, this.rows - 1)`.
  - `export function flushXtermScrollFrameSync(term: any): void` — flushes `core.viewport._innerRefresh()` *before* `core._renderService._renderDebouncer._innerRefresh()` so layout reads happen before DOM row replacements.

- [x] **Step 1: Write failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add tests in `tests/terminalScrollHelper.test.ts` under `describe('mobile touch momentum & step helpers', ...)` verifying:
1. `flushXtermScrollFrameSync` invokes `viewport._innerRefresh()` before `_renderDebouncer._innerRefresh()`.
2. `patchXtermNoopSelectionRefresh` suppresses `term._core.scrollLines(0, true, 1)` (noop viewport scroll sync) while forwarding non-zero `disp` or non-viewport `source` calls.

```typescript
    it('flushXtermScrollFrameSync runs viewport._innerRefresh before _renderDebouncer._innerRefresh to avoid layout thrashing', () => {
      const callOrder: string[] = [];
      const mockTerm = {
        _core: {
          _renderService: {
            _renderDebouncer: {
              _animationFrame: 11,
              _innerRefresh: () => callOrder.push('debouncer'),
            },
          },
          viewport: {
            _refreshAnimationFrame: 22,
            _innerRefresh: () => callOrder.push('viewport'),
          },
        },
      };

      flushXtermScrollFrameSync(mockTerm);
      expect(callOrder).toEqual(['viewport', 'debouncer']);
    });

    it('patchXtermNoopSelectionRefresh skips noop core.scrollLines(0, true, 1) from ignored viewport scroll events', () => {
      const origScrollLines = jest.fn();
      const mockTerm = {
        _core: {
          scrollLines: origScrollLines,
          _renderService: {
            handleSelectionChanged: jest.fn(),
          },
        },
      };

      patchXtermNoopSelectionRefresh(mockTerm);

      // Noop viewport scroll event (amount=0, source=1) -> skipped!
      mockTerm._core.scrollLines(0, true, 1);
      expect(origScrollLines).not.toHaveBeenCalled();

      // Real viewport scroll (amount=2, source=1) -> forwarded!
      mockTerm._core.scrollLines(2, true, 1);
      expect(origScrollLines).toHaveBeenCalledWith(2, true, 1);

      // Programmatic scrollLines (amount=0, source=0/undefined) -> forwarded!
      mockTerm._core.scrollLines(0, false);
      expect(origScrollLines).toHaveBeenCalledTimes(2);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL (`callOrder` is `['debouncer', 'viewport']` and `origScrollLines` is called on `(0, true, 1)`).

- [x] **Step 3: Update `patchXtermNoopSelectionRefresh` and `flushXtermScrollFrameSync` in `frontend/src/utils/terminalScrollHelper.ts`**

1. In `patchXtermNoopSelectionRefresh(term: any)`:
   - Keep the existing `renderService.handleSelectionChanged` guard.
   - Also check `const core = term?._core;`: if `core && typeof core.scrollLines === 'function' && !core.__noopViewportScrollPatched`, wrap `core.scrollLines`:
     ```typescript
     const origScrollLines = core.scrollLines.bind(core);
     core.scrollLines = (disp: number, suppressScrollEvent?: boolean, source?: number) => {
       if (disp === 0 && source === 1) {
         return;
       }
       return origScrollLines(disp, suppressScrollEvent, source);
     };
     core.__noopViewportScrollPatched = true;
     ```
2. In `flushXtermScrollFrameSync(term: any)`:
   - Flush `core.viewport` (`_refreshAnimationFrame` cancel + `viewport._innerRefresh()`) **first**, and flush `core._renderService._renderDebouncer` (`_animationFrame` cancel + `debouncer._innerRefresh()`) **second**.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "perf(terminal): prevent layout thrashing in scroll flush and skip noop viewport redraws"
```

---

### Task 2: Prevent Detached `<span>` Touch Target Loss, Long-Press Selection Hijack, and Stop-Scroll React Jank

**Files:**
- Modify: `frontend/src/index.css:181-215`
- Modify: `frontend/src/components/WebTerminalView.tsx:1380-1526,2798-2812`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Modifies:
  - `frontend/src/index.css`: adds `pointer-events: none` on `.xterm .xterm-rows` (while keeping `.xterm .xterm-rows a { pointer-events: auto; }` for clickable links) and disables native `user-select` / `-webkit-touch-callout` across `.xterm, .xterm .xterm-viewport, .xterm .xterm-screen, .xterm .xterm-rows, .xterm .xterm-rows *`.
  - `frontend/src/components/WebTerminalView.tsx`:
    - `handleTouchStart`: sets `isTouchScrollingActiveRef.current = true` after `stopMomentumScroll()` instead of calling `syncAtBottomAfterTouchScroll()` (deferring React state sync until touch interaction finishes).
    - `handleTouchEnd`: calls `if (e.cancelable) { e.preventDefault(); }` both inside `if (isDragging)` and when `!isDragging && elapsed >= 350` so ending a drag or pausing a finger never emits synthetic `mousedown`/`click` events.
    - Floating Scroll-to-Bottom button (`!isAtBottom`): replaces `backdrop-blur-md` and `animate-pulse` with solid/semi-opaque `bg-[var(--bg-surface)]/95` and static icon styling.

- [x] **Step 1: Write failing tests in `tests/terminalTouchScroll.test.ts`**

Add tests in `tests/terminalTouchScroll.test.ts` verifying:
1. `index.css` sets `pointer-events: none` on `.xterm .xterm-rows` so `DomRenderer.replaceChildren()` never detaches the active `Touch.target` `<span>` during scrolling.
2. `handleTouchStart` does not call `syncAtBottomAfterTouchScroll()` (avoiding synchronous React re-render on touch down).
3. `handleTouchEnd` calls `e.preventDefault()` when `isDragging` is true and when `elapsed >= 350` (long-press pause), while preserving tap-to-focus on the cursor line when `!isDragging && elapsed < 350`.
4. The floating scroll-to-bottom button does not use expensive `backdrop-blur-md` over the terminal canvas.

```typescript
  test('index.css disables pointer-events on .xterm-rows so DomRenderer replaceChildren never detaches active Touch.target spans', () => {
    const cssPath = path.resolve(__dirname, '../frontend/src/index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toMatch(/\.xterm\s+\.xterm-rows[\s\S]*?pointer-events:\s*none/);
  });

  test('handleTouchStart does not trigger synchronous syncAtBottomAfterTouchScroll React re-render on touch-down', () => {
    const touchStartIdx = content.indexOf('const handleTouchStart =');
    const touchMoveIdx = content.indexOf('const handleTouchMove =', touchStartIdx);
    const touchStartBlock = content.slice(touchStartIdx, touchMoveIdx);
    expect(touchStartBlock).not.toContain('syncAtBottomAfterTouchScroll()');
  });

  test('handleTouchEnd prevents synthetic mouse/click events after drag or long-press stop', () => {
    const touchEndIdx = content.indexOf('const handleTouchEnd =');
    const touchCancelIdx = content.indexOf('const handleTouchCancel =', touchEndIdx);
    const touchEndBlock = content.slice(touchEndIdx, touchCancelIdx);

    const isDraggingIdx = touchEndBlock.indexOf('if (isDragging)');
    const notDraggingIdx = touchEndBlock.indexOf('if (!isDragging && elapsed < 350)');
    const draggingBlock = touchEndBlock.slice(isDraggingIdx, notDraggingIdx);
    expect(draggingBlock).toContain('e.preventDefault()');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL (`index.css` lacks `.xterm .xterm-rows` `pointer-events: none`, `handleTouchStart` contains `syncAtBottomAfterTouchScroll()`, and `draggingBlock` lacks `e.preventDefault()`).

- [x] **Step 3: Update `frontend/src/index.css` and `frontend/src/components/WebTerminalView.tsx`**

1. In `frontend/src/index.css`, add rules ensuring `.xterm-rows` children never become transient `Touch.target` elements and never trigger native mobile text-selection callouts:
   ```css
   /* Prevent DomRenderer row replaceChildren() from detaching active Touch.target spans mid-scroll */
   .xterm,
   .xterm .xterm-viewport,
   .xterm .xterm-screen,
   .xterm .xterm-rows,
   .xterm .xterm-rows * {
     user-select: none !important;
     -webkit-user-select: none !important;
     -webkit-touch-callout: none !important;
   }

   .xterm .xterm-rows,
   .xterm .xterm-rows * {
     pointer-events: none !important;
   }

   .xterm .xterm-rows a {
     pointer-events: auto !important;
   }
   ```
2. In `frontend/src/components/WebTerminalView.tsx`:
   - In `handleTouchStart`: remove `syncAtBottomAfterTouchScroll();` right after `stopMomentumScroll();` (so touching down to stop momentum does not trigger a React re-render on touchstart).
   - In `handleTouchEnd`:
     - Inside `if (isDragging)`: add `if (e.cancelable) { e.preventDefault(); }` before returning.
     - In the tap/hold branch after `if (isDragging)`: if `elapsed >= 350` (user held finger down to stop scroll/read), call `if (e.cancelable) { e.preventDefault(); } syncAtBottomAfterTouchScroll(); return;`; and at the end of the `elapsed < 350` branch, call `syncAtBottomAfterTouchScroll();` when not focusing the cursor line.
   - On the floating scroll-to-bottom `<button>` (`!isAtBottom && activeHostId && !isSelectMode ...`): remove `backdrop-blur-md` and `animate-pulse` (use `bg-[var(--bg-surface)]/95` and `<ArrowDown className="w-4 h-4 text-indigo-400" />`).

- [x] **Step 4: Run tests to verify all scroll, selection, and keyboard suites pass**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalMobileSelection.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/components/WebTerminalView.tsx tests/terminalTouchScroll.test.ts
git commit -m "fix(frontend): prevent detached span touch loss and stop-scroll stutter on mobile"
```
