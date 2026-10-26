# Mobile Terminal Native Viewport `scrollTop` & Sub-Pixel Smooth Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile terminal touch scrolling as smooth as dragging the native scrollbar or scrolling a WeChat chat feed by driving `.xterm-viewport.scrollTop` directly (zero forced reflow), coalescing `touchmove` updates into `requestAnimationFrame`, adding sub-line GPU `translate3d` pixel compensation, and deferring React state re-renders (`setIsAtBottom`) until touch/momentum scrolling settles.

**Architecture:**
1. In `frontend/src/utils/terminalScrollHelper.ts`, add `applyViewportTouchScrollDelta` which drives `.xterm-viewport.scrollTop` directly by pixel `deltaY` (matching xterm's native `Viewport.handleTouchMove` and scrollbar path without calling `term.scrollLines` and triggering `_innerRefresh` `offsetHeight` forced reflows), computes the sub-line pixel offset (`subLineOffsetY`) for GPU `translate3d(0, ${-subLineOffsetY}px, 0)` on `.xterm-screen`, and falls back to `stepTouchScrollLines` + `term.scrollLines(linesToScroll)` only when `.xterm-viewport` is unavailable or has no scrollable range.
2. In `frontend/src/components/WebTerminalView.tsx`, coalesce high-frequency (120Hz–240Hz) `touchmove` deltas into a single per-frame `requestAnimationFrame` flush (`scheduleTouchScrollFlush`), drive both active drag and kinetic momentum through `.xterm-viewport.scrollTop` + sub-line GPU transform, and suppress `setIsAtBottom` React state updates while touch dragging or momentum scrolling is active (syncing `isAtBottom` once scrolling stops).

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** Approved root-cause analysis and native `.xterm-viewport.scrollTop` + sub-line GPU transform design in chat (2026-10-26).

## Global Constraints

- `tests/terminalTouchScroll.test.ts` requires `WebTerminalView.tsx` `handleTouchMove` section to still contain `term.scrollLines(linesToScroll)` (used as the fallback when `.xterm-viewport` is absent or not scrollable) and not translate swipes into arrow key sequences.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard, and single-tap outside the cursor line must still suppress keyboard wake-up (`tests/terminalMobileKeyboard.test.ts`).
- When scrolling or momentum ends (or when new terminal output arrives / `scrollToBottomSafe` runs), `.xterm-screen`'s sub-line `transform` must cleanly reset to `''` so cursor positioning and selection coordinates (`getBoundingClientRect()`) are never left offset.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- Forced synchronous reflow elimination: when `.xterm-viewport` has scrollable content (`viewportEl.scrollHeight > viewportEl.clientHeight`), scrolling must mutate `viewportEl.scrollTop` directly instead of calling `term.scrollLines()`, because `term.scrollLines()` triggers `Viewport._innerRefresh()` which reads `offsetHeight` and rewrites `scrollTop` on every call.
- Boundary clamping on `.xterm-viewport.scrollTop`: clamping `nextScrollTop` to `[0, maxScrollTop]` (`maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight)`) must report `hitBoundary: true` when `deltaY < 0 && viewportEl.scrollTop <= 0` or `deltaY > 0 && viewportEl.scrollTop >= maxScrollTop`, so kinetic momentum stops immediately at the top or bottom without overshooting or vibrating.
- Sub-line GPU `translate3d` alignment with xterm's `Math.round(scrollTop / rowHeight)`: xterm's `_handleScroll` snaps `ydisp` to `Math.round(scrollTop / rowHeight)`. The sub-line visual remainder between the continuous pixel `scrollTop` and xterm's snapped row `ydisp * rowHeight` is `subLineOffsetPx = scrollTop - Math.round(scrollTop / rowHeight) * rowHeight`. Applying `translate3d(0, ${-subLineOffsetPx}px, 0)` on `.xterm-screen` makes every `1px` finger movement shift the rendered rows continuously without a 15px staircase jump, and resets to `0px` when scrolling stops.
- High-refresh-rate `touchmove` flood (120Hz–240Hz): `handleTouchMove` must accumulate `pendingTouchDeltaY += frameDeltaY` and schedule a single `requestAnimationFrame` (`touchScrollRaf`) so DOM `scrollTop` writes happen at most once per display frame.
- Mid-scroll React re-render spike: `term.onScroll` previously fired `setIsAtBottom` 100ms into a swipe, causing a full `WebTerminalView` React re-render right in the middle of a finger drag or fling. Deferring `setIsAtBottom` while `isDragging || momentumRaf !== null` and syncing it as soon as the gesture/momentum finishes eliminates the 100ms stutter.

---

### Task 1: Add `applyViewportTouchScrollDelta` Helper to `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:100-155`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Produces:
  - `export interface ViewportScrollElementLike { scrollTop: number; scrollHeight: number; clientHeight: number; }`
  - `export interface ViewportTouchScrollResult { usedNativeScrollTop: boolean; nextScrollTop: number; subLineOffsetPx: number; hitBoundary: boolean; linesToScroll: number; remainderDeltaY: number; }`
  - `export function applyViewportTouchScrollDelta(options: { viewportEl: ViewportScrollElementLike | null | undefined; deltaY: number; lineHeight: number; accumulatedDeltaY?: number; }): ViewportTouchScrollResult`

- [x] **Step 1: Write the failing unit tests in `tests/terminalScrollHelper.test.ts`**

Import `applyViewportTouchScrollDelta` in `tests/terminalScrollHelper.test.ts` and add tests covering:
1. Direct `.xterm-viewport.scrollTop` pixel update when `scrollHeight > clientHeight`, plus continuous `subLineOffsetPx` calculation (`scrollTop - Math.round(scrollTop / lineHeight) * lineHeight`).
2. Top and bottom boundary clamping (`hitBoundary: true` when scrolling up at `scrollTop === 0` or scrolling down at `scrollTop === scrollHeight - clientHeight`, with `subLineOffsetPx: 0`).
3. Fallback to `stepTouchScrollLines` (`usedNativeScrollTop: false`, `linesToScroll` / `remainderDeltaY`) when `viewportEl` is null or `scrollHeight <= clientHeight`.

```typescript
    it('applyViewportTouchScrollDelta drives viewportEl.scrollTop directly and computes sub-line offset', () => {
      const viewportEl = { scrollTop: 160, scrollHeight: 1600, clientHeight: 400 };
      // Move down by 5px with 16px lineHeight -> scrollTop = 165, nearest row = 10 (160px), subLineOffsetPx = +5
      const res = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 5,
        lineHeight: 16,
      });
      expect(res.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(165);
      expect(res.subLineOffsetPx).toBe(5);
      expect(res.hitBoundary).toBe(false);
    });

    it('applyViewportTouchScrollDelta clamps at top and bottom boundaries and reports hitBoundary', () => {
      const viewportEl = { scrollTop: 4, scrollHeight: 1600, clientHeight: 400 };
      const topRes = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: -20,
        lineHeight: 16,
      });
      expect(topRes.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(0);
      expect(topRes.hitBoundary).toBe(true);
      expect(topRes.subLineOffsetPx).toBe(0);

      viewportEl.scrollTop = 1195; // maxScrollTop = 1200
      const bottomRes = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 20,
        lineHeight: 16,
      });
      expect(viewportEl.scrollTop).toBe(1200);
      expect(bottomRes.hitBoundary).toBe(true);
      expect(bottomRes.subLineOffsetPx).toBe(0);
    });

    it('applyViewportTouchScrollDelta falls back to stepTouchScrollLines when viewportEl is not scrollable', () => {
      const unscrollableViewport = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
      const fallbackRes = applyViewportTouchScrollDelta({
        viewportEl: unscrollableViewport,
        deltaY: 20,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(fallbackRes.usedNativeScrollTop).toBe(false);
      expect(fallbackRes.linesToScroll).toBe(1);
      expect(fallbackRes.remainderDeltaY).toBe(4);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL with `applyViewportTouchScrollDelta is not a function` (or TypeScript compile error).

- [x] **Step 3: Implement `applyViewportTouchScrollDelta` in `frontend/src/utils/terminalScrollHelper.ts`**

Add `ViewportScrollElementLike`, `ViewportTouchScrollResult`, and `applyViewportTouchScrollDelta` to `frontend/src/utils/terminalScrollHelper.ts`:
- Compute `safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16`.
- Check if `viewportEl` exists and `viewportEl.scrollHeight > viewportEl.clientHeight`:
  - `const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);`
  - `const rawNext = viewportEl.scrollTop + (Number.isFinite(deltaY) ? deltaY : 0);`
  - `const nextScrollTop = Math.max(0, Math.min(maxScrollTop, rawNext));`
  - `const hitBoundary = (deltaY < 0 && nextScrollTop <= 0) || (deltaY > 0 && nextScrollTop >= maxScrollTop);`
  - `viewportEl.scrollTop = nextScrollTop;`
  - `const snappedScrollTop = Math.round(nextScrollTop / safeLineHeight) * safeLineHeight;`
  - `const subLineOffsetPx = hitBoundary ? 0 : nextScrollTop - snappedScrollTop;`
  - Return `{ usedNativeScrollTop: true, nextScrollTop, subLineOffsetPx, hitBoundary, linesToScroll: 0, remainderDeltaY: 0 }`.
- Otherwise, delegate to `stepTouchScrollLines((accumulatedDeltaY || 0) + (Number.isFinite(deltaY) ? deltaY : 0), safeLineHeight)` and return `{ usedNativeScrollTop: false, nextScrollTop: 0, subLineOffsetPx: 0, hitBoundary: false, linesToScroll: step.linesToScroll, remainderDeltaY: step.remainderDeltaY }`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "feat(terminal): add native viewport scrollTop and sub-line offset helper"
```

---

### Task 2: Wire `.xterm-viewport.scrollTop`, RAF Coalescing, Sub-Line GPU Transform, and Deferred `isAtBottom` Sync in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:41-50,965-985,1108-1400,1655-1695`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes: `applyViewportTouchScrollDelta`, `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `frontend/src/utils/terminalScrollHelper.ts`
- Modifies `WebTerminalView.tsx`:
  - Import `applyViewportTouchScrollDelta` from `../utils/terminalScrollHelper`.
  - Track `isTouchScrollingActiveRef` (true while `isDragging` or `momentumRaf !== null`) so `term.onScroll` updates `isAtBottomRef.current` immediately without triggering `setIsAtBottom` React re-renders mid-swipe; when touch/momentum scrolling ends (`syncAtBottomAfterTouchScroll()`), sync `setIsAtBottom((prev) => (prev !== isAtBottomRef.current ? isAtBottomRef.current : prev))` and reset `.xterm-screen` sub-line transform (`setSubLineTransform(0)`).
  - Add `applyScrollDelta(deltaPx: number): boolean` helper inside the xterm `useEffect`:
    - Queries `viewportEl = container?.querySelector('.xterm-viewport') as HTMLElement | null` and `screenEl = container?.querySelector('.xterm-screen') as HTMLElement | null`.
    - Calls `applyViewportTouchScrollDelta({ viewportEl, deltaY: deltaPx, lineHeight: getTouchLineHeight(), accumulatedDeltaY })`.
    - When `res.usedNativeScrollTop` is true, applies `screenEl.style.transform = res.subLineOffsetPx !== 0 ? \`translate3d(0, \${-res.subLineOffsetPx}px, 0)\` : ''` and returns `res.hitBoundary`.
    - When `res.usedNativeScrollTop` is false (fallback), updates `accumulatedDeltaY = res.remainderDeltaY`, and if `res.linesToScroll !== 0`, sets `const linesToScroll = res.linesToScroll; term.scrollLines(linesToScroll);` (preserving compatibility with `tests/terminalTouchScroll.test.ts`).
  - Coalesce `handleTouchMove` deltas via `pendingTouchDeltaY` and `touchScrollRaf` (`requestAnimationFrame`), flushing `applyScrollDelta(pendingTouchDeltaY)` once per animation frame (with immediate synchronous fallback if `requestAnimationFrame` is unavailable).
  - Update `startMomentumScroll` to call `applyScrollDelta(velocity * dt)` on each frame and stop cleanly when `velocity === 0` or `hitBoundary` is true, resetting `setSubLineTransform(0)` and calling `syncAtBottomAfterTouchScroll()`.

- [x] **Step 1: Write the failing tests in `tests/terminalTouchScroll.test.ts`**

Add tests in `tests/terminalTouchScroll.test.ts` verifying that `WebTerminalView.tsx`:
1. Imports and calls `applyViewportTouchScrollDelta` to drive `.xterm-viewport` `scrollTop` directly.
2. Uses `requestAnimationFrame` coalescing (`pendingTouchDeltaY` / `touchScrollRaf`) for `touchmove` updates and applies sub-line `translate3d` transform on `.xterm-screen`.
3. Defers `setIsAtBottom` React state updates while touch dragging or momentum scrolling is active (`isTouchScrollingActiveRef`).

```typescript
  test('drives .xterm-viewport scrollTop directly with RAF coalescing and sub-line translate3d', () => {
    expect(content).toContain('applyViewportTouchScrollDelta');
    expect(content).toContain('.xterm-viewport');
    expect(content).toContain('pendingTouchDeltaY');
    expect(content).toContain('translate3d(0,');
  });

  test('defers setIsAtBottom React re-renders while touch scrolling or momentum is active', () => {
    expect(content).toContain('isTouchScrollingActiveRef');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `WebTerminalView.tsx` does not yet contain `applyViewportTouchScrollDelta`, `pendingTouchDeltaY`, or `isTouchScrollingActiveRef`.

- [x] **Step 3: Implement `.xterm-viewport.scrollTop` driving, RAF coalescing, sub-line transform, and deferred `setIsAtBottom` in `frontend/src/components/WebTerminalView.tsx`**

Update `frontend/src/components/WebTerminalView.tsx`:
1. Import `applyViewportTouchScrollDelta` from `../utils/terminalScrollHelper`.
2. Add `let isTouchScrollingActive = false;` (or `isTouchScrollingActiveRef`) inside the xterm `useEffect` before `term.onScroll` so `term.onScroll` skips scheduling `setIsAtBottom` while `isTouchScrollingActiveRef.current` is `true`, and `syncAtBottomAfterTouchScroll()` flushes `setIsAtBottom` once scrolling stops.
3. Implement `setSubLineTransform(offsetPx: number)` and `applyScrollDelta(deltaPx: number)` using `applyViewportTouchScrollDelta` (with the `const linesToScroll = res.linesToScroll; term.scrollLines(linesToScroll);` fallback kept inside `flushPendingTouchScroll` / `handleTouchMove` scope so `touchMoveSection` in `tests/terminalTouchScroll.test.ts` still contains `term.scrollLines(linesToScroll)`).
4. Coalesce `handleTouchMove` pixel deltas per animation frame via `pendingTouchDeltaY` and `touchScrollRaf`, and cancel `touchScrollRaf` inside `stopMomentumScroll()` and effect cleanup.

- [x] **Step 4: Run targeted test suites and frontend build to verify**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts`
Expected: PASS on all 5 test suites.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalTouchScroll.test.ts docs/superpowers/plans/2026-10-26-mobile-terminal-viewport-scrolltop-smooth-scroll.md
git commit -m "perf(frontend): drive xterm-viewport scrollTop with RAF coalescing and sub-line GPU transform"
```
