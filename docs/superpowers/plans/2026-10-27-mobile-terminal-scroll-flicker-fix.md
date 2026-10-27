# Mobile Terminal Scroll Flicker & Jitter Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the visual jitter and text flickering during mobile terminal touch and momentum scrolling while preserving smooth scrollbar-parity `scrollTop` driving and fluid kinetic momentum.

**Architecture:**
1. Remove the `.xterm-screen` sub-line `translate3d` CSS transform (`setSubLineTransform` / `subLineOffsetPx`), which caused a 1-frame phase mismatch (`±16px` vertical bounce on every row boundary) because `screenEl.style.transform` applied synchronously on frame $N$ while `xterm.js`'s `Viewport._handleScroll` -> `RenderDebouncer` updated the rendered text rows asynchronously on frame $N+1$.
2. In `frontend/src/utils/terminalScrollHelper.ts`, update `applyViewportTouchScrollDelta` so that when driving `.xterm-viewport.scrollTop` directly (matching the native scrollbar path 100%), it accumulates any fractional pixel remainder (`accumulatedDeltaY + deltaY`) that gets truncated when assigning to integer `viewportEl.scrollTop` (`remainderDeltaY = targetScrollTop - viewportEl.scrollTop`), ensuring slow drags and low-velocity momentum tails never drop sub-pixel steps.
3. In `frontend/src/components/WebTerminalView.tsx`, switch touch and momentum frame timing to high-resolution `performance.now()` (fallback `Date.now()`) so 60Hz/120Hz displays advance by uniform frame deltas without `Date.now()` integer millisecond quantization jitter.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** Approved root-cause analysis and flicker-free `.xterm-viewport.scrollTop` design in chat (2026-10-27).

## Global Constraints

- Do NOT apply `translate3d` or `transform` to `.xterm-screen` during touch or momentum scrolling (`WebTerminalView.tsx` must not mutate `screenEl.style.transform`).
- `tests/terminalTouchScroll.test.ts` requires `WebTerminalView.tsx` `handleTouchMove` section to still reference `term.scrollLines(linesToScroll)` (used as the fallback when `.xterm-viewport` is absent or not scrollable) and not translate swipes into arrow key sequences.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard, and single-tap outside the cursor line must still suppress keyboard wake-up (`tests/terminalMobileKeyboard.test.ts`).
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- Cross-frame phase mismatch elimination: `.xterm-screen` must never have `style.transform` mutated during scrolling so that row updates are driven solely by `.xterm-viewport.scrollTop` -> `xterm` native `_handleScroll`, matching the native scrollbar behavior 100%.
- Integer `scrollTop` truncation on mobile WebViews: some mobile browsers round or floor `element.scrollTop` to an integer on assignment. If `deltaY` in a momentum tail frame is `0.6px` and `viewportEl.scrollTop` rounds `100.6` back to `100`, `remainderDeltaY = targetScrollTop - viewportEl.scrollTop` (`0.6px`) must be carried into `accumulatedDeltaY` for the next frame so slow scrolling never stalls prematurely.
- Boundary stop accuracy: when `targetScrollTop <= 0` (scrolling up at top) or `targetScrollTop >= maxScrollTop` (scrolling down at bottom), `hitBoundary` must be `true` and `remainderDeltaY` must reset to `0` so momentum terminates cleanly.
- High-refresh-rate timing accuracy (120Hz ProMotion / Android 120Hz): using `performance.now()` instead of `Date.now()` prevents 8.33ms frames from alternating between `8ms` and `9ms` (or `0ms` when coalesced), smoothing out both `computeTouchVelocity` and `stepMomentumVelocity`.
- Deferred `isAtBottom` sync: `isTouchScrollingActiveRef` continues to suppress mid-scroll `setIsAtBottom` React re-renders and flushes once when touch/momentum scrolling finishes.

---

### Task 1: Update `applyViewportTouchScrollDelta` in `terminalScrollHelper.ts` to Preserve Sub-Pixel `scrollTop` Remainder Without Sub-Line Transform

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:65-225`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Modifies:
  - `export interface ViewportTouchScrollResult { usedNativeScrollTop: boolean; nextScrollTop: number; subLineOffsetPx: number; hitBoundary: boolean; linesToScroll: number; remainderDeltaY: number; }` (keeps `subLineOffsetPx: 0` for backward interface compatibility while returning accurate `remainderDeltaY` when `viewportEl.scrollTop` truncates fractional pixels).
  - `export function applyViewportTouchScrollDelta(options: { viewportEl: ViewportScrollElementLike | null | undefined; deltaY: number; lineHeight: number; accumulatedDeltaY?: number; }): ViewportTouchScrollResult`
  - Clean up `resetScreenTransform` from `scrollToBottomSafe` in `frontend/src/utils/terminalScrollHelper.ts` since `.xterm-screen` transform is no longer mutated.

- [x] **Step 1: Update unit tests in `tests/terminalScrollHelper.test.ts`**

Update the `applyViewportTouchScrollDelta` tests in `tests/terminalScrollHelper.test.ts` to assert:
1. `subLineOffsetPx` is always `0` (no `.xterm-screen` CSS transform phase conflict).
2. Fractional pixel remainder (`accumulatedDeltaY + deltaY`) is preserved in `remainderDeltaY` when `viewportEl.scrollTop` truncates to an integer (e.g. a getter/setter on `viewportEl.scrollTop` that `Math.trunc`s assigned values), and carries over across frames to advance `scrollTop`.
3. Top and bottom boundaries clamp `scrollTop`, report `hitBoundary: true`, and reset `remainderDeltaY` to `0`.

```typescript
    it('applyViewportTouchScrollDelta drives viewportEl.scrollTop directly without sub-line transform offset and preserves fractional remainder', () => {
      let internalScrollTop = 160;
      const viewportEl = {
        get scrollTop() {
          return internalScrollTop;
        },
        set scrollTop(v: number) {
          // Simulate browser integer truncation on scrollTop assignment
          internalScrollTop = Math.trunc(v);
        },
        scrollHeight: 1600,
        clientHeight: 400,
      };

      const res1 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 0.6,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(res1.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(160);
      expect(res1.subLineOffsetPx).toBe(0);
      expect(res1.remainderDeltaY).toBeCloseTo(0.6, 5);
      expect(res1.hitBoundary).toBe(false);

      const res2 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 0.7,
        lineHeight: 16,
        accumulatedDeltaY: res1.remainderDeltaY,
      });
      expect(res2.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(161);
      expect(res2.subLineOffsetPx).toBe(0);
      expect(res2.remainderDeltaY).toBeCloseTo(0.3, 5);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL — `res1.remainderDeltaY` is `0` instead of `0.6` (or `subLineOffsetPx` is non-zero).

- [x] **Step 3: Implement fractional remainder preservation in `frontend/src/utils/terminalScrollHelper.ts`**

In `frontend/src/utils/terminalScrollHelper.ts`:
1. Remove `resetScreenTransform` from `scrollToBottomSafe`.
2. In `applyViewportTouchScrollDelta`:
```typescript
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const prevRemainder = Number.isFinite(accumulatedDeltaY) ? (accumulatedDeltaY as number) : 0;
  const totalDeltaY = prevRemainder + safeDeltaY;

  if (viewportEl && viewportEl.scrollHeight > viewportEl.clientHeight) {
    const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
    const rawNext = viewportEl.scrollTop + totalDeltaY;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, rawNext));
    const hitBoundary =
      (totalDeltaY < 0 && nextScrollTop <= 0) ||
      (totalDeltaY > 0 && nextScrollTop >= maxScrollTop);

    viewportEl.scrollTop = nextScrollTop;
    const actualScrollTop = viewportEl.scrollTop;
    const remainderDeltaY = hitBoundary ? 0 : nextScrollTop - actualScrollTop;

    return {
      usedNativeScrollTop: true,
      nextScrollTop: actualScrollTop,
      subLineOffsetPx: 0,
      hitBoundary,
      linesToScroll: 0,
      remainderDeltaY,
    };
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "fix(terminal): remove sub-line transform offset and preserve fractional scrollTop remainder"
```

---

### Task 2: Remove `.xterm-screen` `translate3d` and Use High-Precision Frame Timing in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:930-945,1140-1520,1835-1848,2035-2050`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes: `applyViewportTouchScrollDelta`, `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `frontend/src/utils/terminalScrollHelper.ts`
- Modifies `WebTerminalView.tsx`:
  - Remove `setSubLineTransform` and all `screenEl.style.transform` mutations from `WebTerminalView.tsx`.
  - In `applyScrollDelta(deltaPx: number)`: pass `accumulatedDeltaY` into `applyViewportTouchScrollDelta` and always update `accumulatedDeltaY = res.remainderDeltaY` whether `res.usedNativeScrollTop` is true or false.
  - Use `const getNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());` for `touchStartTime`, `lastTouchMoveTime`, and `lastFrameTime` in `startMomentumScroll` so velocity and frame deltas have sub-millisecond accuracy on 60Hz/120Hz screens.

- [x] **Step 1: Update tests in `tests/terminalTouchScroll.test.ts`**

Update `tests/terminalTouchScroll.test.ts` to verify that `WebTerminalView.tsx`:
1. Drives `.xterm-viewport` via `applyViewportTouchScrollDelta` and `pendingTouchDeltaY` RAF coalescing.
2. Does NOT mutate `.xterm-screen` with `translate3d(0,` or `setSubLineTransform` (preventing cross-frame phase-mismatch flicker).
3. Uses high-resolution timing (`performance.now`) and `isTouchScrollingActiveRef` to defer `setIsAtBottom` re-renders during active scrolling.

```typescript
  test('drives .xterm-viewport scrollTop directly with RAF coalescing and without .xterm-screen translate3d flicker', () => {
    expect(content).toContain('applyViewportTouchScrollDelta');
    expect(content).toContain('.xterm-viewport');
    expect(content).toContain('pendingTouchDeltaY');
    expect(content).not.toContain('setSubLineTransform');
    expect(content).not.toContain('translate3d(0,');
  });

  test('defers setIsAtBottom React re-renders while touch scrolling or momentum is active', () => {
    expect(content).toContain('isTouchScrollingActiveRef');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `WebTerminalView.tsx` still contains `setSubLineTransform` and `translate3d(0,`.

- [x] **Step 3: Remove `.xterm-screen` `translate3d` mutations and upgrade timing in `frontend/src/components/WebTerminalView.tsx`**

In `frontend/src/components/WebTerminalView.tsx`:
1. Remove `setSubLineTransform` definition and all calls to `setSubLineTransform(0)` / `setSubLineTransform(res.subLineOffsetPx)`.
2. Remove the `screenEl.style.transform = ''` blocks in `writeSchedulerRef` callback and `handleScrollToBottom`.
3. In `applyScrollDelta(deltaPx: number)`:
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
      });

      accumulatedDeltaY = res.remainderDeltaY;

      if (res.usedNativeScrollTop) {
        return res.hitBoundary;
      }

      if (res.linesToScroll !== 0) {
        const linesToScroll = res.linesToScroll;
        term.scrollLines(linesToScroll);
        const active = term.buffer?.active;
        if (active) {
          if (linesToScroll < 0 && active.viewportY <= 0) return true;
          if (linesToScroll > 0 && active.viewportY >= active.baseY) return true;
        }
      }
      return false;
    };
```
4. Add `const getNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());` and use `getNow()` in `startMomentumScroll`, `handleTouchStart`, `handleTouchMove`, and `handleTouchEnd`.

- [x] **Step 4: Run targeted test suites and frontend build to verify**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts`
Expected: PASS on all 5 test suites.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalTouchScroll.test.ts docs/superpowers/plans/2026-10-27-mobile-terminal-scroll-flicker-fix.md
git commit -m "fix(frontend): eliminate mobile terminal scroll flicker by removing sub-line screen transform"
```
