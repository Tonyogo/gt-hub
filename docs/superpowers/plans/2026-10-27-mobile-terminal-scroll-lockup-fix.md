# Mobile Terminal Scroll Lockup & Gesture Reliability Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the intermittent mobile terminal scroll lockup ("sometimes cannot scroll at all and stays stuck for several attempts before recovering") while preserving smooth, flicker-free RAF-coalesced scrolling and kinetic momentum.

**Architecture:**
1. **Eliminate Native Scroll Compositor Lockup (`frontend/src/index.css` & `WebTerminalView.tsx`)**: `.xterm-viewport` has `overflow-y: scroll` in `xterm.css` and inherited `-webkit-overflow-scrolling: touch` from `#root`. When mobile WebKit/Blink compositor threads latched onto `.xterm-viewport` for a native scroll/overscroll transaction, programmatic `scrollTop` writes were ignored for multiple consecutive swipes until the native gesture state machine timed out. We add explicit CSS rules on `.xterm`, `.xterm .xterm-viewport`, and `.xterm .xterm-screen` (`touch-action: pan-x !important` on desktop or `touch-action: none !important; overscroll-behavior: none !important; -webkit-overflow-scrolling: auto !important`), and ensure `terminalContainerRef` sets `touchAction: isSelectMode || isMobile ? 'none' : undefined`.
2. **Deterministic Buffer Scrolling Without Async DOM `scroll` Event Race (`frontend/src/utils/terminalScrollHelper.ts` & `WebTerminalView.tsx`)**: Relying solely on `viewportEl.scrollTop = nextScrollTop` to asynchronously fire a DOM `scroll` event into `xterm`'s `Viewport._handleScroll` failed whenever:
   - `xterm`'s `_innerRefresh` had set `_ignoreNextScrollEvent = true` (which swallowed the user's scroll event), or
   - `scrollTop` changed by less than half a row (`Math.round(scrollTop / rowHeight) === ydisp`), leaving `ydisp` unchanged so the next `syncScrollArea()` -> `_innerRefresh()` snapped `viewportEl.scrollTop` right back to `ydisp * rowHeight`!
   We update `applyViewportTouchScrollDelta` and `applyScrollDelta` so that RAF-coalesced pixel deltas are accumulated via `stepTouchScrollLines(totalDeltaY, safeLineHeight)` into integer `linesToScroll` and fractional `remainderDeltaY`, and `term.scrollLines(linesToScroll)` is called deterministically once per animation frame whenever `linesToScroll !== 0` (synchronizing `ydisp`, `isUserScrolling`, and `.xterm-viewport.scrollTop` atomically without relying on async DOM `scroll` events).
3. **Prevent Multi-Touch / Palm-Edge and `xterm` Internal Touch Listener Conflicts (`WebTerminalView.tsx`)**: In `handleTouchStart` and `handleTouchMove`, call `e.stopPropagation()` unconditionally on single-touch so `xterm.js`'s internal `touchstart`/`touchmove` listeners on `this.element` never compete with our handler, and tolerate accidental palm-edge secondary touches (`e.touches.length >= 1` when already dragging) instead of aborting the active drag when `e.touches.length !== 1`.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Tailwind CSS, Jest.

**Spec:** Approved root-cause analysis and scroll-lockup fix design in chat (2026-10-27).

## Global Constraints

- Do NOT apply `translate3d` or `transform` to `.xterm-screen` during scrolling (`tests/terminalTouchScroll.test.ts`).
- `tests/terminalTouchScroll.test.ts` requires `WebTerminalView.tsx` `handleTouchMove` section to reference `term.scrollLines(linesToScroll)` and not translate swipes into arrow key sequences.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard, and single-tap outside the cursor line must still suppress keyboard wake-up (`tests/terminalMobileKeyboard.test.ts`).
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- `xterm.js` `_innerRefresh` snap-back & `_ignoreNextScrollEvent` lockup: when `applyViewportTouchScrollDelta` only mutated `viewportEl.scrollTop` without advancing `term.buffer.active.viewportY` (`ydisp`) via `term.scrollLines`, any sub-half-line drag or `_ignoreNextScrollEvent` flag caused `_innerRefresh` to overwrite `viewportEl.scrollTop = ydisp * _currentRowHeight`, locking the user at the current line until a single frame happened to jump `>= 0.5` lines and fire an un-ignored DOM `scroll` event. Computing `linesToScroll` and calling `term.scrollLines(linesToScroll)` directly in `applyScrollDelta` updates `ydisp` and `isUserScrolling` synchronously on the spot.
- Boundary detection via `active.viewportY` and `active.baseY` (or `viewportEl`): when `linesToScroll < 0 && active.viewportY <= 0` (at top) or `linesToScroll > 0 && active.viewportY >= active.baseY` (at bottom), `applyScrollDelta` must reset `accumulatedDeltaY = 0` and return `hitBoundary = true` so momentum stops cleanly at buffer ends.
- CSS `-webkit-overflow-scrolling: touch` inheritance on `.xterm-viewport`: `index.css` sets `-webkit-overflow-scrolling: touch` on `html, body, #root`. Adding `touch-action: none !important; overscroll-behavior: none !important; -webkit-overflow-scrolling: auto !important;` to `.xterm .xterm-viewport` in `index.css` and `touchAction: isSelectMode || isMobile ? 'none' : undefined` on `terminalContainerRef` in `WebTerminalView.tsx` prevents iOS Safari / Android Chrome from ever hijacking `.xterm-viewport` into a native scroll/rubber-band state.
- `handleTouchStart` propagation leak to `xterm.js`: `xterm.js` registers its own `touchstart` and `touchmove` listeners on `.xterm`. Calling `e.stopPropagation()` in `handleTouchStart` (not only in select mode) prevents `xterm`'s internal `Viewport.handleTouchStart` from tracking a competing `_lastTouchY`.

---

### Task 1: Make `applyViewportTouchScrollDelta` Always Compute Deterministic `linesToScroll` and `remainderDeltaY` in `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:170-239`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Modifies:
  - `export function applyViewportTouchScrollDelta(options: { viewportEl: ViewportScrollElementLike | null | undefined; deltaY: number; lineHeight: number; accumulatedDeltaY?: number; }): ViewportTouchScrollResult`
  - Always computes `step = stepTouchScrollLines(totalDeltaY, safeLineHeight)` so `linesToScroll` and `remainderDeltaY` are deterministically populated on every call.
  - When `viewportEl` is provided and scrollable (`scrollHeight > clientHeight`), checks top/bottom boundaries and updates `viewportEl.scrollTop` in lockstep when `step.linesToScroll !== 0` (or clamps at boundaries with `hitBoundary: true` and `remainderDeltaY: 0`), while returning `linesToScroll: step.linesToScroll` and `remainderDeltaY: hitBoundary ? 0 : step.remainderDeltaY` so the caller can invoke `term.scrollLines(res.linesToScroll)` deterministically without waiting for an async DOM `scroll` event.

- [x] **Step 1: Update unit tests in `tests/terminalScrollHelper.test.ts`**

Update `tests/terminalScrollHelper.test.ts` so `applyViewportTouchScrollDelta` is tested for:
1. Accumulating sub-line pixel deltas across frames (`deltaY: 6` + `deltaY: 6` + `deltaY: 6` with `lineHeight: 16` -> frame 1 & 2 have `linesToScroll: 0`, `remainderDeltaY: 6` and `12`; frame 3 produces `linesToScroll: 1`, `remainderDeltaY: 2`) and never getting reset by `viewportEl.scrollTop` snap-back.
2. Reporting `hitBoundary: true` and resetting `remainderDeltaY: 0` when at the top (`scrollTop <= 0` with negative delta) or bottom (`scrollTop >= maxScrollTop` with positive delta).
3. Working identically when `viewportEl` is null or unscrollable (`scrollHeight <= clientHeight`).

```typescript
    it('applyViewportTouchScrollDelta accumulates sub-line deltas into deterministic linesToScroll without snap-back loss', () => {
      const viewportEl = { scrollTop: 160, scrollHeight: 1600, clientHeight: 400 };

      // Frame 1: +6px (< 16px lineHeight) -> 0 lines, +6px remainder preserved
      const res1 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(res1.linesToScroll).toBe(0);
      expect(res1.remainderDeltaY).toBe(6);
      expect(res1.subLineOffsetPx).toBe(0);
      expect(res1.hitBoundary).toBe(false);

      // Frame 2: +6px (total 12px < 16px) -> 0 lines, +12px remainder preserved even if xterm kept scrollTop at 160
      const res2 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: res1.remainderDeltaY,
      });
      expect(res2.linesToScroll).toBe(0);
      expect(res2.remainderDeltaY).toBe(12);

      // Frame 3: +6px (total 18px >= 16px) -> 1 line to scroll, +2px remainder preserved
      const res3 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: res2.remainderDeltaY,
      });
      expect(res3.linesToScroll).toBe(1);
      expect(res3.remainderDeltaY).toBe(2);
      expect(res3.hitBoundary).toBe(false);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL — `res1.remainderDeltaY` was `0` when `viewportEl.scrollTop` accepted integer `166` without advancing `linesToScroll`.

- [x] **Step 3: Implement deterministic line-step + boundary logic in `frontend/src/utils/terminalScrollHelper.ts`**

Update `applyViewportTouchScrollDelta` in `frontend/src/utils/terminalScrollHelper.ts`:
```typescript
export function applyViewportTouchScrollDelta(options: {
  viewportEl: ViewportScrollElementLike | null | undefined;
  deltaY: number;
  lineHeight: number;
  accumulatedDeltaY?: number;
}): ViewportTouchScrollResult {
  const { viewportEl, deltaY, lineHeight, accumulatedDeltaY = 0 } = options;
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const prevRemainder = Number.isFinite(accumulatedDeltaY) ? (accumulatedDeltaY as number) : 0;
  const totalDeltaY = prevRemainder + safeDeltaY;
  const step = stepTouchScrollLines(totalDeltaY, safeLineHeight);

  if (
    viewportEl &&
    Number.isFinite(viewportEl.scrollHeight) &&
    Number.isFinite(viewportEl.clientHeight) &&
    viewportEl.scrollHeight > viewportEl.clientHeight
  ) {
    const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
    const rawNext = viewportEl.scrollTop + step.linesToScroll * safeLineHeight;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, rawNext));
    const hitBoundary =
      (totalDeltaY < 0 && viewportEl.scrollTop <= 0) ||
      (totalDeltaY > 0 && viewportEl.scrollTop >= maxScrollTop) ||
      (step.linesToScroll < 0 && nextScrollTop <= 0) ||
      (step.linesToScroll > 0 && nextScrollTop >= maxScrollTop);

    if (step.linesToScroll !== 0 || hitBoundary) {
      viewportEl.scrollTop = hitBoundary
        ? totalDeltaY < 0
          ? 0
          : maxScrollTop
        : nextScrollTop;
    }

    return {
      usedNativeScrollTop: true,
      nextScrollTop: viewportEl.scrollTop,
      subLineOffsetPx: 0,
      hitBoundary,
      linesToScroll: step.linesToScroll,
      remainderDeltaY: hitBoundary ? 0 : step.remainderDeltaY,
    };
  }

  return {
    usedNativeScrollTop: false,
    nextScrollTop: 0,
    subLineOffsetPx: 0,
    hitBoundary: false,
    linesToScroll: step.linesToScroll,
    remainderDeltaY: step.remainderDeltaY,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "fix(terminal): make applyViewportTouchScrollDelta compute deterministic line steps"
```

---

### Task 2: Fix `applyScrollDelta` Direct `term.scrollLines` Sync, Stop `touchstart` Propagation, and Lock CSS `touch-action` in `WebTerminalView.tsx` & `index.css`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:1179-1215,1360-1450,2805-2816`
- Modify: `frontend/src/index.css:193-210`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes: `applyViewportTouchScrollDelta`, `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `frontend/src/utils/terminalScrollHelper.ts`
- Modifies `WebTerminalView.tsx`:
  - In `applyScrollDelta(deltaPx: number)`:
    - Always execute `if (res.linesToScroll !== 0) { const linesToScroll = res.linesToScroll; term.scrollLines(linesToScroll); ... }` regardless of `res.usedNativeScrollTop`, so `term.buffer.active.viewportY` (`ydisp`) and `isUserScrolling` are updated synchronously on every scrolled line without relying on an asynchronous DOM `scroll` event (which `xterm`'s `_ignoreNextScrollEvent` or sub-row rounding could swallow).
    - Check boundary via both `res.hitBoundary` and `active.viewportY <= 0` / `active.viewportY >= active.baseY`, resetting `accumulatedDeltaY = 0` when a boundary is hit.
  - In `handleTouchStart`:
    - Call `e.stopPropagation()` unconditionally when `e.touches.length >= 1` so `xterm.js`'s internal `touchstart` listener on `.xterm` never activates.
  - In `handleTouchMove`:
    - Allow `e.touches.length >= 1` when `isDragging` is already active (using `e.touches[0]`) so an accidental palm/thumb-edge touch during a swipe does not freeze the ongoing scroll gesture.
  - On `terminalContainerRef` `div` (`WebTerminalView.tsx:2809`):
    - Change `touchAction: isSelectMode ? 'none' : undefined` to `touchAction: isSelectMode || isMobile ? 'none' : undefined`.
- Modifies `frontend/src/index.css`:
  - In `.xterm .xterm-viewport`, add `touch-action: none !important; overscroll-behavior: none !important; -webkit-overflow-scrolling: auto !important;` so `.xterm-viewport` never inherits `-webkit-overflow-scrolling: touch` from `#root`.

- [x] **Step 1: Write the failing tests in `tests/terminalTouchScroll.test.ts`**

Add tests in `tests/terminalTouchScroll.test.ts` verifying:
1. `applyScrollDelta` invokes `term.scrollLines(linesToScroll)` unconditionally when `res.linesToScroll !== 0` (not skipped behind `if (res.usedNativeScrollTop) return`).
2. `handleTouchStart` calls `e.stopPropagation()` to block `xterm`'s internal touch listener from competing.
3. `index.css` disables `-webkit-overflow-scrolling` and locks `touch-action: none` on `.xterm .xterm-viewport`.

```typescript
  test('applyScrollDelta always calls term.scrollLines(linesToScroll) so xterm ydisp never desyncs or snaps back', () => {
    const applyStart = content.indexOf('const applyScrollDelta =');
    const applyEnd = content.indexOf('const flushPendingTouchScroll =', applyStart);
    const applyBlock = content.slice(applyStart, applyEnd);

    const scrollLinesIdx = applyBlock.indexOf('term.scrollLines(linesToScroll)');
    const usedNativeIdx = applyBlock.indexOf('if (res.usedNativeScrollTop)');
    expect(scrollLinesIdx).toBeGreaterThan(-1);
    // term.scrollLines must NOT be bypassed by an early return on res.usedNativeScrollTop
    expect(usedNativeIdx === -1 || scrollLinesIdx < usedNativeIdx).toBe(true);
  });

  test('index.css locks touch-action and disables momentum overflow-scrolling on .xterm-viewport', () => {
    const cssPath = path.resolve(__dirname, '../frontend/src/index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toMatch(/\.xterm\s+\.xterm-viewport\s*\{[\s\S]*?touch-action:\s*none\s*!important/);
    expect(cssContent).toMatch(/\.xterm\s+\.xterm-viewport\s*\{[\s\S]*?overscroll-behavior:\s*none\s*!important/);
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `if (res.usedNativeScrollTop) return res.hitBoundary;` currently returns BEFORE `term.scrollLines(linesToScroll)`, and `.xterm .xterm-viewport` in `index.css` lacks `touch-action: none !important`.

- [x] **Step 3: Implement deterministic `applyScrollDelta`, `handleTouchStart` isolation, and `.xterm-viewport` CSS lock in `frontend/src/components/WebTerminalView.tsx` and `frontend/src/index.css`**

1. In `frontend/src/components/WebTerminalView.tsx`, update `applyScrollDelta`:
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

      if (res.linesToScroll !== 0) {
        const linesToScroll = res.linesToScroll;
        term.scrollLines(linesToScroll);
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
2. In `handleTouchStart`:
   Call `e.stopPropagation()` when `e.touches.length >= 1` so `xterm.js`'s internal `touchstart` listener does not run.
3. In `handleTouchMove`:
   Change `if (e.touches.length !== 1) return;` to `if (e.touches.length < 1 || (!isDragging && e.touches.length > 1)) return;` so an already-active single-finger drag is not killed if a second finger/palm edge grazes the screen.
4. On `terminalContainerRef` `div` (`WebTerminalView.tsx`):
   Set `touchAction: isSelectMode || isMobile ? 'none' : undefined`.
5. In `frontend/src/index.css`, update `.xterm .xterm-viewport`:
```css
.xterm .xterm-viewport {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  touch-action: none !important;
  overscroll-behavior: none !important;
  -webkit-overflow-scrolling: auto !important;
}
```

- [x] **Step 4: Run targeted test suites and frontend build to verify**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts tests/terminalMobileResizeStability.test.ts`
Expected: PASS on all 6 test suites.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/index.css tests/terminalTouchScroll.test.ts docs/superpowers/plans/2026-10-27-mobile-terminal-scroll-lockup-fix.md
git commit -m "fix(frontend): resolve mobile terminal scroll lockup and xterm ydisp snap-back"
```
