# Mobile Terminal Fast-Swipe Responsiveness & Lift-Off Velocity Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix intermittent unresponsive swipes and dead fast-flicks on mobile terminal by preserving initial pre-drag pixel displacement, preventing lift-off zero-delta `touchmove` samples from wiping out momentum velocity, and locking `touch-action: none` on `.xterm-viewport`.

**Architecture:**
1. In `frontend/src/utils/terminalScrollHelper.ts`, update `computeTouchVelocity` so that zero-delta or near-zero lift-off jitter samples (`Math.abs(deltaY) < 0.5 && dtMs < 32`) preserve `prevVelocity` instead of decaying it by 65%, and same-direction fast flick spikes boost cleanly toward `instantV`.
2. In `frontend/src/components/WebTerminalView.tsx`, lower the drag activation threshold from `> 6px` to `> 3px` and only advance `lastTouchY` once `isDragging` becomes `true` (so the initial 3–6px of finger movement is applied on the very first drag frame instead of swallowed). Also synchronize `xtermViewport.style.touchAction = defaultTouchAction` alongside `.xterm` and `.xterm-screen`, and add `touch-action: none` to `.xterm-select-mode .xterm-viewport` in `frontend/src/index.css`.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Tailwind CSS, Jest.

**Spec:** Approved root-cause analysis and fast-swipe responsiveness fix design in chat (2026-10-27).

## Global Constraints

- Do NOT re-introduce `translate3d` or `transform` on `.xterm-screen` during scrolling (`tests/terminalTouchScroll.test.ts`).
- `tests/terminalTouchScroll.test.ts` requires `WebTerminalView.tsx` `handleTouchMove` section to still reference `term.scrollLines(linesToScroll)` and not translate swipes into arrow key sequences.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard, and single-tap outside the cursor line must still suppress keyboard wake-up (`tests/terminalMobileKeyboard.test.ts`).
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- Pre-drag displacement swallowing: previously, `lastTouchY = currentY` ran BEFORE `if (!isDragging) return;`. Any finger movement under the drag threshold updated `lastTouchY` without scrolling, swallowing the first `6px` of every swipe and causing quick 1-sample flicks to do nothing. Only updating `lastTouchY` and `lastTouchMoveTime` once `isDragging` is true ensures the full displacement from `touchStartY` is scrolled on drag entry.
- Lift-off zero-delta `touchmove` velocity wipeout: mobile touch hardware often fires 1–2 trailing `touchmove` events with `deltaY === 0` (within 2–15ms before `touchend`) as the finger pad lifts off the glass. `computeTouchVelocity(prevVelocity, 0, 8)` must return `prevVelocity` unchanged when `Math.abs(deltaY) < 0.5 && dtMs < 32` so fast flicks never lose their momentum on release.
- Direction reversal responsiveness: when the user reverses swipe direction (`prevVelocity * instantV < 0`), `computeTouchVelocity` must immediately adopt `instantV` (clamped to `[-6, 6]`) rather than lagging behind the old opposite-direction velocity.
- `.xterm-viewport` native scroll hijacking: `.xterm-viewport` has `overflow-y: scroll` in `xterm.css`. Explicitly setting `xtermViewport.style.touchAction = defaultTouchAction` (`'none'` on mobile or in select mode) in `WebTerminalView.tsx` and immediately after `term.open(...)` prevents mobile WebViews from firing `touchcancel` during fast vertical flicks.

---

### Task 1: Harden `computeTouchVelocity` Against Lift-Off Zero-Delta Samples and Direction Reversals in `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:125-140`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Modifies:
  - `export function computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number`

- [x] **Step 1: Write the failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add tests in `tests/terminalScrollHelper.test.ts` under `describe('mobile touch momentum & step helpers', ...)` verifying:
1. Trailing lift-off `touchmove` with `deltaY === 0` (or `Math.abs(deltaY) < 0.5`) and short `dtMs < 32` preserves `prevVelocity` instead of decaying it by 65%.
2. Genuine finger hold (`deltaY === 0` with `dtMs >= 32`) decays velocity toward `0`.
3. Direction reversal (`prevVelocity > 0` and `deltaY < 0`, or vice versa) immediately switches to the new direction without opposite-sign lag.

```typescript
    it('computeTouchVelocity preserves velocity across short zero-delta lift-off samples and resets on direction reversal', () => {
      const vFast = computeTouchVelocity(0, 48, 16); // 3 px/ms
      expect(vFast).toBe(3);

      // Trailing lift-off sample with deltaY = 0 within 8ms must preserve velocity
      const vAfterLiftOffJitter = computeTouchVelocity(vFast, 0, 8);
      expect(vAfterLiftOffJitter).toBe(3);

      // Genuine hold (dtMs >= 40ms with deltaY = 0) decays velocity
      const vAfterHold = computeTouchVelocity(vFast, 0, 50);
      expect(vAfterHold).toBeLessThan(vFast);

      // Direction reversal immediately switches sign
      const vReversed = computeTouchVelocity(vFast, -32, 16);
      expect(vReversed).toBeLessThan(0);
    });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL — `expect(vAfterLiftOffJitter).toBe(3)` receives `1.05` (`3 * 0.35`).

- [x] **Step 3: Implement lift-off zero-delta guard and direction-reversal handling in `frontend/src/utils/terminalScrollHelper.ts`**

Update `computeTouchVelocity` in `frontend/src/utils/terminalScrollHelper.ts`:
```typescript
export function computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number {
  const safePrev = Number.isFinite(prevVelocity) ? prevVelocity : 0;
  const safeDelta = Number.isFinite(deltaY) ? deltaY : 0;
  const rawDt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 16;

  // Ignore sub-pixel zero-delta samples within <32ms (high-refresh duplicate sample or finger lift-off jitter)
  if (Math.abs(safeDelta) < 0.5 && rawDt < 32) {
    return safePrev;
  }

  const dt = Math.max(4, Math.min(100, rawDt));
  const instantV = safeDelta / dt;

  // If starting from rest or reversing swipe direction, adopt new instantaneous velocity immediately
  if (safePrev === 0 || (safePrev * instantV < 0 && Math.abs(safeDelta) >= 2)) {
    return Math.max(-6, Math.min(6, instantV));
  }

  // Weight faster flick acceleration higher (0.75) so short 2-frame flicks reach full velocity
  const weight = Math.abs(instantV) > Math.abs(safePrev) ? 0.75 : 0.6;
  const blended = safePrev * (1 - weight) + instantV * weight;
  return Math.max(-6, Math.min(6, blended));
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "fix(terminal): preserve touch velocity on lift-off jitter and fast flicks"
```

---

### Task 2: Fix Pre-Drag Displacement Swallowing and Lock `.xterm-viewport` `touch-action` in `WebTerminalView.tsx` & `index.css`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:850-860,1365-1455,1980-2020`
- Modify: `frontend/src/index.css:181-198`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes: `computeTouchVelocity`, `applyViewportTouchScrollDelta`, `stepMomentumVelocity`, `stepTouchScrollLines` from `frontend/src/utils/terminalScrollHelper.ts`
- Modifies `WebTerminalView.tsx`:
  - Immediately after `term.open(terminalContainerRef.current)`: if on mobile, set `touchAction = 'none'` on `.xterm-viewport`, `.xterm-screen`, and `.xterm` so mobile browsers never claim native scroll on `.xterm-viewport` (`overflow-y: scroll`) during fast flicks.
  - In `useEffect(..., [isSelectMode, isMobile])`: include `xtermViewport = container.querySelector('.xterm-viewport') as HTMLElement | null` and set `xtermViewport.style.touchAction = isSelectMode ? 'none' : defaultTouchAction`.
  - In `handleTouchMove`:
    - Lower drag detection threshold from `> 6` to `> 3` (`if (!isDragging && (Math.abs(deltaY) > 3 || Math.abs(deltaX) > 3))`).
    - Do NOT update `lastTouchY = currentY` while `!isDragging`! Only compute `const frameDeltaY = lastTouchY - currentY` and update `lastTouchY = currentY; lastTouchMoveTime = now;` AFTER `isDragging` is true, so the initial displacement from `touchStartY` is preserved and scrolled on the first drag frame.
- Modifies `frontend/src/index.css`:
  - Add `.terminal-select-mode .xterm-viewport` to the `.terminal-select-mode` rule block.

- [x] **Step 1: Write the failing tests in `tests/terminalTouchScroll.test.ts`**

Add a test in `tests/terminalTouchScroll.test.ts` verifying that:
1. `handleTouchMove` checks the responsive `> 3` drag threshold and only advances `lastTouchY = currentY` after the `if (!isDragging) return;` guard so initial swipe pixels are never swallowed.
2. `WebTerminalView.tsx` locks `touchAction` on `.xterm-viewport` alongside `.xterm-screen` and `.xterm`.

```typescript
  test('preserves initial pre-drag displacement and locks touch-action on .xterm-viewport', () => {
    const touchMoveSection = content.slice(content.indexOf('const handleTouchMove'), content.indexOf('const handleTouchEnd'));
    const notDraggingGuardIdx = touchMoveSection.indexOf('if (!isDragging) return;');
    const lastTouchUpdateIdx = touchMoveSection.indexOf('lastTouchY = currentY;');

    expect(notDraggingGuardIdx).toBeGreaterThan(-1);
    expect(lastTouchUpdateIdx).toBeGreaterThan(notDraggingGuardIdx);
    expect(content).toContain("xtermViewport.style.touchAction = defaultTouchAction");
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `lastTouchUpdateIdx` is currently before `notDraggingGuardIdx` and `xtermViewport.style.touchAction` is missing.

- [x] **Step 3: Implement pre-drag displacement preservation and `.xterm-viewport` `touchAction` lock in `frontend/src/components/WebTerminalView.tsx` and `frontend/src/index.css`**

1. In `frontend/src/components/WebTerminalView.tsx` inside `handleTouchMove`:
```typescript
      const deltaY = touchStartY - currentY;
      const deltaX = touchStartX - currentX;

      // Prevent browser native pan-y gesture from hijacking touch stream during initial movement
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      // When virtual keyboard is showing on mobile, swipe down to dismiss
      if (isKeyboardShowingRef.current && deltaY < -25) {
        handleHideKeyboard();
      }

      if (!isDragging && (Math.abs(deltaY) > 3 || Math.abs(deltaX) > 3)) {
        isDragging = true;
        isTouchScrollingActiveRef.current = true;
      }

      if (!isDragging) return;

      const frameDeltaY = lastTouchY - currentY;
      const now = getNow();
      const dt = Math.max(4, now - lastTouchMoveTime);
      lastTouchY = currentY;
      lastTouchMoveTime = now;

      // STANDARD MODE: terminal scrolling with velocity tracking and RAF coalescing
      touchVelocityY = computeTouchVelocity(touchVelocityY, frameDeltaY, dt);
      scheduleTouchScrollFlush(frameDeltaY);
      // Fallback path via applyScrollDelta / term.scrollLines(linesToScroll) when .xterm-viewport is not scrollable
```
2. In `frontend/src/components/WebTerminalView.tsx` inside `useEffect(..., [isSelectMode, isMobile])`:
```typescript
  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;
    const xtermViewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const xtermScreen = container.querySelector('.xterm-screen') as HTMLElement | null;
    const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
    const defaultTouchAction = isMobile ? 'none' : '';
    if (isSelectMode) {
      container.style.touchAction = 'none';
      if (xtermViewport) {
        xtermViewport.style.touchAction = 'none';
      }
      if (xtermScreen) {
        xtermScreen.style.touchAction = 'none';
        xtermScreen.style.userSelect = 'none';
        xtermScreen.style.webkitUserSelect = 'none';
      }
      if (xtermEl) {
        xtermEl.style.touchAction = 'none';
        xtermEl.style.userSelect = 'none';
        xtermEl.style.webkitUserSelect = 'none';
      }
    } else {
      container.style.touchAction = defaultTouchAction;
      if (xtermViewport) {
        xtermViewport.style.touchAction = defaultTouchAction;
      }
      if (xtermScreen) {
        xtermScreen.style.touchAction = defaultTouchAction;
        xtermScreen.style.userSelect = '';
        xtermScreen.style.webkitUserSelect = '';
      }
      if (xtermEl) {
        xtermEl.style.touchAction = defaultTouchAction;
        xtermEl.style.userSelect = '';
        xtermEl.style.webkitUserSelect = '';
      }
    }
  }, [isSelectMode, isMobile]);
```
3. Also after `term.open(terminalContainerRef.current)` in `WebTerminalView.tsx`, initialize `touchAction = 'none'` on `.xterm-viewport`, `.xterm-screen`, and `.xterm` when `isMobileRef.current` is true.
4. In `frontend/src/index.css`, add `.terminal-select-mode .xterm-viewport` to the `.terminal-select-mode` selector list.

- [x] **Step 4: Run targeted test suites and frontend build to verify**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts`
Expected: PASS on all 5 test suites.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx frontend/src/index.css tests/terminalTouchScroll.test.ts docs/superpowers/plans/2026-10-27-mobile-terminal-fast-swipe-responsiveness.md
git commit -m "fix(frontend): preserve initial swipe displacement and lock xterm-viewport touch-action"
```
