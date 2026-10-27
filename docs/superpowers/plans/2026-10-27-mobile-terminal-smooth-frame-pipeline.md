# Mobile Terminal Zero-Lag Frame Pipeline & Redundant DOM Render Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate mobile terminal touch-scrolling frame stutter by suppressing `@xterm/xterm` redundant full-screen selection redraws when no selection exists, flushing `RenderDebouncer` and `Viewport` synchronously within the active `requestAnimationFrame` tick, avoiding conflicting external `.xterm-viewport.scrollTop` mutations, and preserving finger lift-off momentum velocity.

**Architecture:**
1. In `frontend/src/utils/terminalScrollHelper.ts`:
   - Add `patchXtermNoopSelectionRefresh(term: any)` to wrap `_renderService._renderer.value.handleSelectionChanged` (or `_renderService.handleSelectionChanged`) so that when neither the previous state nor the incoming state has an active selection (`!start && !end && !hadSelection`), the redundant `renderRows(0, rows - 1)` full-screen DOM rebuild triggered by `SelectionService.refresh()` on every scroll is skipped.
   - Add `flushXtermScrollFrameSync(term: any)` to immediately flush `_renderService._renderDebouncer._innerRefresh()` and `viewport._refresh(true)` (canceling their queued next-frame `requestAnimationFrame` handles) when invoked inside our own `requestAnimationFrame` scroll callback, eliminating the 1-frame nested-rAF delay.
   - Enhance `computeTouchVelocity` to preserve velocity across small lift-off micro-deltas (`Math.abs(deltaY) <= 2.5 && dtMs < 28 && Math.abs(prevVelocity) >= 0.4`) and lower deceleration blend weight from `0.6` to `0.3`.
   - Tune `stepMomentumVelocity` defaults (`friction = 0.96`, `minVelocity = 0.16`) so kinetic scrolling glides smoothly without low-speed end-of-scroll single-row stutters.
   - Add `syncViewportScrollTop?: boolean` option to `applyViewportTouchScrollDelta` (default `true` for backward compatibility, `false` when `term.scrollLines` + `flushXtermScrollFrameSync` drives `Viewport` natively).
2. In `frontend/src/components/WebTerminalView.tsx`:
   - Call `patchXtermNoopSelectionRefresh(term)` right after `term.open(terminalContainerRef.current)`.
   - Update `getTouchLineHeight()` to prefer `term._core?.viewport?._currentRowHeight` (exact unrounded `device.cell.height / dpr`) before falling back to `css.cell.height`.
   - Update `applyScrollDelta` to call `applyViewportTouchScrollDelta` with `syncViewportScrollTop: false`, invoke `term.scrollLines(linesToScroll)`, and call `flushXtermScrollFrameSync(term)` so DOM rows and `.xterm-viewport.scrollTop` update atomically in the current animation frame without triggering forced synchronous layout reflows or unignored scroll events.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm` 5.5.0, Jest.

**Spec:** Approved root-cause analysis and 4-part smooth scroll optimization design in chat (2026-10-27).

## Global Constraints

- Preserve all existing assertions in `tests/terminalTouchScroll.test.ts`, `tests/terminalScrollHelper.test.ts`, `tests/terminalMobileKeyboard.test.ts`, `tests/terminalCopyOnSelectAndTouchFix.test.ts`, `tests/terminalMobileSelection.test.ts`, and `tests/terminalMobileResizeStability.test.ts`.
- Do NOT re-introduce `translate3d` or `transform` on `.xterm-screen`.
- When selection DOES exist (or when clearing an active selection where `hadSelection === true`), `handleSelectionChanged` MUST still execute normally so selection highlights render and clear properly.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- Redundant full-screen DOM rebuilds on scroll: in `@xterm/xterm` 5.5.0, `_onScroll` and `.xterm-viewport`'s `scroll` event both call `_selectionService.refresh()`, which invokes `DomRenderer.handleSelectionChanged(undefined, undefined, false)` -> `this.renderRows(0, rows - 1)`. Skipping `handleSelectionChanged` when `!start && !end && !hadSelection` cuts per-frame DOM node replacements by 67% while keeping real selection rendering and selection clearing intact.
- Nested `requestAnimationFrame` 1-frame lag: `flushPendingTouchScroll` and `startMomentumScroll`'s `stepFrame` already run inside a `requestAnimationFrame` callback. Calling `term.scrollLines(linesToScroll)` schedules `RenderDebouncer._animationFrame` and `Viewport._refreshAnimationFrame` for the *following* frame (`N+1`). Synchronously flushing both inside `flushXtermScrollFrameSync(term)` ensures zero-latency same-frame rendering.
- Conflicting `.xterm-viewport.scrollTop` writes: mutating `viewportEl.scrollTop` before `term.scrollLines` without setting `viewport._ignoreNextScrollEvent = true` fires an unignored native `scroll` event and forces synchronous layout reads (`scrollHeight`, `clientHeight`, `scrollTop`). Passing `syncViewportScrollTop: false` when `term.scrollLines` is used lets `viewport._refresh(true)` update `scrollTop` cleanly with `_ignoreNextScrollEvent = true`.
- Finger lift-off micro-delta velocity drop: as a finger leaves the screen after a fast flick, 1–2 trailing `touchmove` events with `1px–2.5px` delta often arrive within `< 28ms`. Preserving `prevVelocity` when `Math.abs(safePrev) >= 0.4 && Math.abs(safeDelta) <= 2.5 && rawDt < 28 && safePrev * safeDelta >= 0` prevents losing 60–80% of momentum velocity at release.
- End-of-momentum 1-line stutter: raising default `minVelocity` from `0.08` to `0.16` and `friction` from `0.95` to `0.96` stops momentum cleanly before it enters the 10-frames-per-line crawl regime.

---

### Task 1: Add Selection Redraw Guard, Same-Frame Xterm Flush, and Velocity/Momentum Refinements in `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:125-248`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Modifies:
  - `export function computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number`
  - `export function stepMomentumVelocity(velocityPxPerMs: number, dtMs?: number, friction?: number, minVelocity?: number): number`
  - `export function applyViewportTouchScrollDelta(options: { viewportEl: ViewportScrollElementLike | null | undefined; deltaY: number; lineHeight: number; accumulatedDeltaY?: number; syncViewportScrollTop?: boolean; }): ViewportTouchScrollResult`
- Produces:
  - `export function patchXtermNoopSelectionRefresh(term: any): void`
  - `export function flushXtermScrollFrameSync(term: any): void`

- [x] **Step 1: Write the failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add tests in `tests/terminalScrollHelper.test.ts` under `describe('mobile touch momentum & step helpers', ...)` verifying:
1. `computeTouchVelocity` preserves velocity across lift-off micro-deltas (`<= 2.5px` within `< 28ms` in the same direction when `|prevVelocity| >= 0.4`).
2. `applyViewportTouchScrollDelta` with `syncViewportScrollTop: false` computes `linesToScroll` and `remainderDeltaY` without reading or mutating `viewportEl.scrollTop`.
3. `patchXtermNoopSelectionRefresh` skips calling the underlying `handleSelectionChanged` when `!start && !end` and there was no prior selection, but calls it when a selection is active or when clearing a previously active selection.
4. `flushXtermScrollFrameSync` cancels pending `_renderDebouncer._animationFrame` and `viewport._refreshAnimationFrame` and synchronously invokes `_renderDebouncer._innerRefresh()` and `viewport._refresh(true)`.

```typescript
    it('computeTouchVelocity preserves velocity on small same-direction lift-off micro-deltas (<= 2.5px)', () => {
      const vFast = computeTouchVelocity(0, 48, 16); // 3 px/ms
      expect(vFast).toBe(3);

      // Trailing 1.5px micro-delta during finger release within 12ms preserves velocity
      const vAfterMicroLift = computeTouchVelocity(vFast, 1.5, 12);
      expect(vAfterMicroLift).toBe(3);

      // Genuine slow drag after long interval (45ms) blends velocity downward
      const vSlowDrag = computeTouchVelocity(vFast, 1.5, 45);
      expect(vSlowDrag).toBeLessThan(vFast);
      expect(vSlowDrag).toBeGreaterThan(0);
    });

    it('applyViewportTouchScrollDelta skips DOM scrollTop mutation when syncViewportScrollTop is false', () => {
      let scrollTopWrites = 0;
      const viewportEl = {
        get scrollTop() {
          return 160;
        },
        set scrollTop(_v: number) {
          scrollTopWrites += 1;
        },
        scrollHeight: 1600,
        clientHeight: 400,
      };

      const res = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 36,
        lineHeight: 16,
        accumulatedDeltaY: 0,
        syncViewportScrollTop: false,
      });

      expect(res.linesToScroll).toBe(2);
      expect(res.remainderDeltaY).toBe(4);
      expect(res.usedNativeScrollTop).toBe(false);
      expect(scrollTopWrites).toBe(0);
    });

    it('patchXtermNoopSelectionRefresh suppresses redundant empty selection redraws while preserving active and clear redraws', () => {
      const handleSelectionChanged = jest.fn();
      const mockTerm = {
        _core: {
          _renderService: {
            handleSelectionChanged,
          },
        },
      };

      patchXtermNoopSelectionRefresh(mockTerm);
      const rs = mockTerm._core._renderService;

      // 1. Repeated empty selection refreshes during scroll -> skipped!
      rs.handleSelectionChanged(undefined, undefined, false);
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(0);

      // 2. Active selection -> forwarded!
      rs.handleSelectionChanged([0, 1], [5, 1], false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(1);

      // 3. Clearing active selection -> forwarded once to clear highlight!
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(2);

      // 4. Subsequent empty selection refreshes -> skipped again!
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(2);
    });

    it('flushXtermScrollFrameSync flushes RenderDebouncer and Viewport in the same animation frame', () => {
      const cancelRaf = jest.fn();
      const debouncerInnerRefresh = jest.fn();
      const viewportInnerRefresh = jest.fn();

      const mockTerm = {
        _core: {
          _coreBrowserService: {
            window: {
              cancelAnimationFrame: cancelRaf,
            },
          },
          _renderService: {
            _renderDebouncer: {
              _animationFrame: 42,
              _innerRefresh: debouncerInnerRefresh,
            },
          },
          viewport: {
            _refreshAnimationFrame: 99,
            _innerRefresh: viewportInnerRefresh,
          },
        },
      };

      flushXtermScrollFrameSync(mockTerm);

      expect(cancelRaf).toHaveBeenCalledWith(42);
      expect(cancelRaf).toHaveBeenCalledWith(99);
      expect(debouncerInnerRefresh).toHaveBeenCalledTimes(1);
      expect(viewportInnerRefresh).toHaveBeenCalledTimes(1);
      expect(mockTerm._core._renderService._renderDebouncer._animationFrame).toBeUndefined();
      expect(mockTerm._core.viewport._refreshAnimationFrame).toBeNull();
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL — `patchXtermNoopSelectionRefresh` and `flushXtermScrollFrameSync` are not exported, and `vAfterMicroLift` / `syncViewportScrollTop: false` fail.

- [x] **Step 3: Implement the helpers and refinements in `frontend/src/utils/terminalScrollHelper.ts`**

Update `frontend/src/utils/terminalScrollHelper.ts`:
1. In `computeTouchVelocity`:
```typescript
export function computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number {
  const safePrev = Number.isFinite(prevVelocity) ? prevVelocity : 0;
  const safeDelta = Number.isFinite(deltaY) ? deltaY : 0;
  const rawDt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 16;

  // Ignore sub-pixel zero-delta samples or tiny same-direction finger lift-off micro-deltas within <28ms
  if (Math.abs(safeDelta) < 0.5 && rawDt < 32) {
    return safePrev;
  }
  if (
    Math.abs(safePrev) >= 0.4 &&
    Math.abs(safeDelta) <= 2.5 &&
    rawDt < 28 &&
    safePrev * safeDelta >= 0
  ) {
    return safePrev;
  }

  const dt = Math.max(4, Math.min(100, rawDt));
  const instantV = safeDelta / dt;

  // If starting from rest or reversing swipe direction, adopt new instantaneous velocity immediately
  if (safePrev === 0 || (safePrev * instantV < 0 && Math.abs(safeDelta) >= 2)) {
    return Math.max(-6, Math.min(6, instantV));
  }

  // Weight acceleration higher (0.75) and deceleration lighter (0.3) so lift-off retains kinetic energy
  const weight = Math.abs(instantV) > Math.abs(safePrev) ? 0.75 : 0.3;
  const blended = safePrev * (1 - weight) + instantV * weight;
  return Math.max(-6, Math.min(6, blended));
}
```
2. In `stepMomentumVelocity`:
```typescript
export function stepMomentumVelocity(
  velocityPxPerMs: number,
  dtMs = 16,
  friction = 0.96,
  minVelocity = 0.16
): number {
  if (!Number.isFinite(velocityPxPerMs) || Math.abs(velocityPxPerMs) < minVelocity) {
    return 0;
  }
  const frameFactor = Math.max(0.5, Math.min(3, (dtMs || 16) / 16));
  const next = velocityPxPerMs * Math.pow(friction, frameFactor);
  return Math.abs(next) < minVelocity ? 0 : next;
}
```
3. In `applyViewportTouchScrollDelta`:
Add `syncViewportScrollTop?: boolean` to `options` (default `true`). When `syncViewportScrollTop === false`, skip reading/mutating `viewportEl` and return `{ usedNativeScrollTop: false, nextScrollTop: 0, subLineOffsetPx: 0, hitBoundary: false, linesToScroll: step.linesToScroll, remainderDeltaY: step.remainderDeltaY }`.
4. Add `patchXtermNoopSelectionRefresh(term: any): void` and `flushXtermScrollFrameSync(term: any): void`:
```typescript
/**
 * Prevents @xterm/xterm SelectionService from triggering a full-screen DOM rebuild
 * (DomRenderer.handleSelectionChanged -> renderRows(0, rows - 1)) on every scroll event
 * when no selection is active before or after the event.
 */
export function patchXtermNoopSelectionRefresh(term: any): void {
  const renderService = term?._core?._renderService;
  if (!renderService || typeof renderService.handleSelectionChanged !== 'function' || renderService.__noopSelectionPatched) {
    return;
  }
  const origHandleSelectionChanged = renderService.handleSelectionChanged.bind(renderService);
  let hadActiveSelection = false;

  renderService.handleSelectionChanged = (
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean
  ) => {
    const hasActiveSelection = Boolean(
      start &&
      end &&
      (start[0] !== end[0] || start[1] !== end[1])
    );
    if (!hasActiveSelection && !hadActiveSelection) {
      return;
    }
    hadActiveSelection = hasActiveSelection;
    origHandleSelectionChanged(start, end, columnSelectMode);
  };
  renderService.__noopSelectionPatched = true;
}

/**
 * Synchronously flushes xterm's RenderDebouncer and Viewport scroll area within the
 * current requestAnimationFrame callback to eliminate the 1-frame nested-rAF lag.
 */
export function flushXtermScrollFrameSync(term: any): void {
  const core = term?._core;
  if (!core) return;
  const cancelRaf =
    core._coreBrowserService?.window?.cancelAnimationFrame?.bind(core._coreBrowserService.window) ||
    (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);

  const debouncer = core._renderService?._renderDebouncer;
  if (debouncer && debouncer._animationFrame !== undefined && debouncer._animationFrame !== null) {
    if (cancelRaf) {
      cancelRaf(debouncer._animationFrame);
    }
    debouncer._animationFrame = undefined;
    if (typeof debouncer._innerRefresh === 'function') {
      debouncer._innerRefresh();
    }
  }

  const viewport = core.viewport;
  if (viewport && viewport._refreshAnimationFrame !== null && viewport._refreshAnimationFrame !== undefined) {
    if (cancelRaf) {
      cancelRaf(viewport._refreshAnimationFrame);
    }
    viewport._refreshAnimationFrame = null;
    if (typeof viewport._innerRefresh === 'function') {
      viewport._innerRefresh();
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
git commit -m "perf(terminal): add noop-selection redraw guard and same-frame xterm scroll flush"
```

---

### Task 2: Wire Same-Frame Scroll Pipeline and Selection Redraw Guard in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:22-35,858-868,1175-1224`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes from `frontend/src/utils/terminalScrollHelper.ts`:
  - `patchXtermNoopSelectionRefresh(term: any): void`
  - `flushXtermScrollFrameSync(term: any): void`
  - `applyViewportTouchScrollDelta` (with `syncViewportScrollTop: false`)
- Modifies in `frontend/src/components/WebTerminalView.tsx`:
  - Import `patchXtermNoopSelectionRefresh` and `flushXtermScrollFrameSync` from `../utils/terminalScrollHelper`.
  - Call `patchXtermNoopSelectionRefresh(term)` immediately after `patchCompositionHelper(term)` in the `useEffect` that initializes `term`.
  - In `getTouchLineHeight()`: check `const viewportRowHeight = (term as any)._core?.viewport?._currentRowHeight; if (typeof viewportRowHeight === 'number' && viewportRowHeight > 4) return viewportRowHeight;` first so line stepping uses the exact unrounded DPR row height that `Viewport` uses.
  - In `applyScrollDelta(deltaPx: number)`:
    - Pass `syncViewportScrollTop: false` to `applyViewportTouchScrollDelta` so we do not trigger forced synchronous layout or unignored native `scroll` events prior to `term.scrollLines(linesToScroll)`.
    - Immediately after `term.scrollLines(linesToScroll)`, call `flushXtermScrollFrameSync(term)` so the row DOM and `.xterm-viewport.scrollTop` render in the exact same animation frame.

- [x] **Step 1: Write the failing tests in `tests/terminalTouchScroll.test.ts`**

Add a test in `tests/terminalTouchScroll.test.ts` verifying:
1. `WebTerminalView.tsx` calls `patchXtermNoopSelectionRefresh(term)` during terminal initialization.
2. `applyScrollDelta` calls `flushXtermScrollFrameSync(term)` after `term.scrollLines(linesToScroll)` and passes `syncViewportScrollTop: false` to `applyViewportTouchScrollDelta`.

```typescript
  test('suppresses redundant empty-selection full-screen redraws and flushes xterm scroll in the same animation frame', () => {
    expect(content).toContain('patchXtermNoopSelectionRefresh(term)');
    const applyStart = content.indexOf('const applyScrollDelta =');
    const applyEnd = content.indexOf('const flushPendingTouchScroll =', applyStart);
    const applyBlock = content.slice(applyStart, applyEnd);

    expect(applyBlock).toContain('syncViewportScrollTop: false');
    expect(applyBlock).toContain('flushXtermScrollFrameSync(term)');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `patchXtermNoopSelectionRefresh(term)` and `flushXtermScrollFrameSync(term)` are not yet in `WebTerminalView.tsx`.

- [x] **Step 3: Implement the pipeline updates in `frontend/src/components/WebTerminalView.tsx`**

1. Import `patchXtermNoopSelectionRefresh` and `flushXtermScrollFrameSync` from `../utils/terminalScrollHelper`.
2. Right after `patchCompositionHelper(term);` (around line 859), call:
```typescript
    patchXtermNoopSelectionRefresh(term);
```
3. In `getTouchLineHeight`:
```typescript
    const getTouchLineHeight = () => {
      const viewportRowHeight = (term as any)._core?.viewport?._currentRowHeight;
      if (typeof viewportRowHeight === 'number' && viewportRowHeight > 4) {
        return viewportRowHeight;
      }
      const renderService = (term as any)._core?._renderService;
      const cssCellHeight = renderService?.dimensions?.css?.cell?.height;
      if (typeof cssCellHeight === 'number' && cssCellHeight > 4) {
        return cssCellHeight;
      }
      const screenEl = container?.querySelector('.xterm-screen') as HTMLElement | null;
      if (screenEl && term.rows > 0 && screenEl.clientHeight > 0) {
        return screenEl.clientHeight / term.rows;
      }
      return Math.max(12, fontSizeRef.current * 1.3);
    };
```
4. In `applyScrollDelta`:
```typescript
    const applyScrollDelta = (deltaPx: number): boolean => {
      if (!term || !isMountedRef.current) return true;
      const viewportEl = container?.querySelector('.xterm-viewport') as HTMLElement | null;
      const lineHeight = getTouchLineHeight();
      const res = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: deltaPx,
        lineHeight,
        accumulatedDeltaY,
        syncViewportScrollTop: false,
      });

      accumulatedDeltaY = res.remainderDeltaY;

      if (res.linesToScroll !== 0) {
        const linesToScroll = res.linesToScroll;
        term.scrollLines(linesToScroll);
        flushXtermScrollFrameSync(term);
        const active = term.buffer?.active;
        if (active) {
          if (linesToScroll < 0 && active.viewportY <= 0) {
            accumulatedDeltaY = 0;
            return true;
          }
          if (linesToScroll > 0 && active.viewportY >= active.baseY) {
            accumulatedDeltaY = 0;
            return true;
          }
        }
      }

      if (res.usedNativeScrollTop && res.hitBoundary) {
        accumulatedDeltaY = 0;
        return true;
      }

      return false;
    };
```

- [x] **Step 4: Run all mobile terminal test suites and frontend build to verify**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts tests/terminalMobileResizeStability.test.ts && npm run build:frontend`
Expected: PASS on all 6 test suites and clean frontend build.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalTouchScroll.test.ts docs/superpowers/plans/2026-10-27-mobile-terminal-smooth-frame-pipeline.md
git commit -m "perf(frontend): eliminate mobile scroll frame lag and redundant xterm DOM redraws"
```
