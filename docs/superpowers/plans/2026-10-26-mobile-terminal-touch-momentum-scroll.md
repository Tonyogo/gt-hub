# Mobile Terminal Touch Momentum & Smooth Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix jerky, dead-stop mobile terminal touch scrolling so vertical swipes track the finger smoothly using actual xterm cell height, never get hijacked by browser native `pan-y` gestures, and glide with natural kinetic momentum (inertia) upon finger release.

**Architecture:**
1. Add a pure kinetic momentum & fractional line accumulator helper in `frontend/src/utils/terminalScrollHelper.ts` (`stepTouchScrollLines` and `computeNextMomentumVelocity`) to compute line steps from pixel deltas using actual rendered cell height and exponential velocity decay.
2. In `frontend/src/components/WebTerminalView.tsx`, lock the terminal canvas container `touchAction` to `'none'` (preventing mobile browsers from claiming the gesture during the initial 8px drag detection window and turning `e.cancelable` to `false`), call `e.preventDefault()` on single-finger `touchmove` in standard mode, track smoothed touch velocity (`px/ms`), and run a `requestAnimationFrame` momentum loop on `touchend` that cancels immediately on the next `touchstart` or component unmount.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** Approved root-cause analysis and fix design in chat (2026-10-26).

## Global Constraints

- `tests/terminalTouchScroll.test.ts` requires `WebTerminalView.tsx` `handleTouchMove` to contain `term.scrollLines(linesToScroll)` and not translate swipes into arrow key sequences.
- Single-tap on the active cursor line (`!isDragging && elapsed < 350`) must still wake the virtual keyboard, and single-tap outside the cursor line must still suppress keyboard wake-up (`tests/terminalMobileKeyboard.test.ts`).
- When the virtual keyboard is open on mobile (`isKeyboardShowingRef.current`), swiping down (`totalDeltaY < -25`) must still dismiss the keyboard (`handleHideKeyboard()`).
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during development.

## Review Focus

- Browser gesture hijacking in the first 0–8px of touch movement: `handleTouchMove` previously returned early before `if (e.cancelable) e.preventDefault()` when `!isDragging`, while the container had `touchAction: 'pan-y'`. This caused iOS Safari / Android Chrome to start native scrolling and mark subsequent `touchmove` events `cancelable: false`. Setting `touchAction: 'none'` on the terminal canvas and calling `e.preventDefault()` throughout single-finger `touchmove` eliminates gesture hijacking.
- Cumulative drift in `deltaY` vs incremental `moveDeltaY`: `touchStartY` / `touchStartX` must separate initial touch origin (`initialTouchY` / `initialTouchX` for the 8px drag threshold and -25px keyboard dismiss check) from `lastTouchY` (for frame-by-frame scroll delta and velocity), so the first 8px of movement is not lost or miscalculated.
- Finger pause before release (hold then lift): if the user drags, holds their finger stationary for `> 80ms`, and then lifts, `handleTouchEnd` must NOT launch a momentum fling using stale velocity from earlier in the drag.
- Re-touching during active momentum glide: `handleTouchStart` must immediately cancel any running `momentumRaf` and reset velocity so the user can "catch" and stop a fast-scrolling terminal or tap without drift.
- Boundary auto-stop during momentum: when momentum scrolling reaches the very top (`term.buffer.active.viewportY <= 0` while scrolling up) or very bottom (`term.buffer.active.viewportY >= term.buffer.active.baseY` while scrolling down), the momentum RAF loop must terminate immediately instead of spinning useless frames.

---

### Task 1: Add Touch Scroll Step & Kinetic Momentum Helpers to `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts:1-100`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Produces:
  - `export interface TouchScrollStepResult { linesToScroll: number; remainderDeltaY: number; }`
  - `export function stepTouchScrollLines(accumulatedDeltaY: number, lineHeight: number): TouchScrollStepResult`
  - `export function computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number`
  - `export function stepMomentumVelocity(velocityPxPerMs: number, dtMs?: number, friction?: number, minVelocity?: number): number`

- [x] **Step 1: Write the failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add a `describe('mobile touch momentum & step helpers', ...)` block in `tests/terminalScrollHelper.test.ts` testing:
1. `stepTouchScrollLines`: converts pixel delta and remainder into integer `linesToScroll` and preserves fractional `remainderDeltaY` across frames; guards invalid/non-positive `lineHeight`.
2. `computeTouchVelocity`: blends instantaneous velocity (`deltaY / dtMs`) with previous velocity using exponential smoothing and clamps extreme spikes (`±6 px/ms`).
3. `stepMomentumVelocity`: decays velocity over frame time (`dtMs`, default `16ms`) with friction (default `0.95`) and snaps to `0` once `Math.abs(velocity) < minVelocity` (default `0.08`).

```typescript
  describe('mobile touch momentum & step helpers', () => {
    it('stepTouchScrollLines extracts integer lines and preserves sub-line pixel remainder', () => {
      const step1 = stepTouchScrollLines(10, 16);
      expect(step1).toEqual({ linesToScroll: 0, remainderDeltaY: 10 });

      const step2 = stepTouchScrollLines(step1.remainderDeltaY + 12, 16);
      expect(step2).toEqual({ linesToScroll: 1, remainderDeltaY: 6 });

      const stepNeg = stepTouchScrollLines(-35, 15);
      expect(stepNeg).toEqual({ linesToScroll: -2, remainderDeltaY: -5 });
    });

    it('computeTouchVelocity smooths and clamps velocity in px/ms', () => {
      const v1 = computeTouchVelocity(0, 32, 16); // 2 px/ms instantaneous
      expect(v1).toBeGreaterThan(1.0);
      expect(v1).toBeLessThanOrEqual(2.0);

      // Clamps extreme spike
      const vSpike = computeTouchVelocity(0, 500, 5);
      expect(vSpike).toBeLessThanOrEqual(6);
      expect(vSpike).toBeGreaterThanOrEqual(-6);
    });

    it('stepMomentumVelocity decays velocity smoothly and stops below threshold', () => {
      let v = 2.0;
      const nextV = stepMomentumVelocity(v, 16);
      expect(nextV).toBeLessThan(v);
      expect(nextV).toBeGreaterThan(0);

      // Below minimum threshold snaps to 0
      expect(stepMomentumVelocity(0.05, 16)).toBe(0);
      expect(stepMomentumVelocity(-0.05, 16)).toBe(0);
    });
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL with `stepTouchScrollLines is not a function` (or TypeScript compile error).

- [x] **Step 3: Implement `stepTouchScrollLines`, `computeTouchVelocity`, and `stepMomentumVelocity` in `frontend/src/utils/terminalScrollHelper.ts`**

Add to `frontend/src/utils/terminalScrollHelper.ts`:
- `stepTouchScrollLines(accumulatedDeltaY: number, lineHeight: number): TouchScrollStepResult`:
  - Safe fallback `const safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16;`
  - If `!Number.isFinite(accumulatedDeltaY)` return `{ linesToScroll: 0, remainderDeltaY: 0 }`.
  - If `Math.abs(accumulatedDeltaY) < safeLineHeight` return `{ linesToScroll: 0, remainderDeltaY: accumulatedDeltaY }`.
  - `const linesToScroll = Math.trunc(accumulatedDeltaY / safeLineHeight);`
  - `return { linesToScroll, remainderDeltaY: accumulatedDeltaY - linesToScroll * safeLineHeight };`
- `computeTouchVelocity(prevVelocity: number, deltaY: number, dtMs: number): number`:
  - Clamp `dt = Math.max(4, Math.min(100, dtMs || 16))`
  - `const instantV = deltaY / dt;`
  - Blend `const blended = prevVelocity === 0 ? instantV : prevVelocity * 0.35 + instantV * 0.65;`
  - Clamp to `[-6, 6]`.
- `stepMomentumVelocity(velocityPxPerMs: number, dtMs = 16, friction = 0.95, minVelocity = 0.08): number`:
  - If `!Number.isFinite(velocityPxPerMs) || Math.abs(velocityPxPerMs) < minVelocity` return `0`.
  - `const frameFactor = Math.max(0.5, Math.min(3, (dtMs || 16) / 16));`
  - `const next = velocityPxPerMs * Math.pow(friction, frameFactor);`
  - Return `Math.abs(next) < minVelocity ? 0 : next`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/terminalScrollHelper.ts tests/terminalScrollHelper.test.ts
git commit -m "feat(terminal): add touch velocity and momentum scroll helpers"
```

---

### Task 2: Integrate Touch-Action Lock, Actual Cell Height, and Kinetic Momentum into `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:40-45,1104-1330,1640-1665,2480-2505,2595-2610`
- Test: `tests/terminalTouchScroll.test.ts`

**Interfaces:**
- Consumes: `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `frontend/src/utils/terminalScrollHelper.ts`
- Modifies `WebTerminalView.tsx`:
  - Import `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `../utils/terminalScrollHelper`.
  - Helper `getTouchLineHeight()`: reads xterm's rendered CSS cell height `(term as any)._core?._renderService?.dimensions?.css?.cell?.height` (fallback to `screenEl.clientHeight / term.rows`, then `Math.max(12, fontSizeRef.current * 1.3)`).
  - Momentum RAF controller (`momentumRaf: number | null`, `stopMomentumScroll()`): cancels any active momentum animation on `touchstart`, selection mode entry, or unmount.
  - `handleTouchStart`: calls `stopMomentumScroll()`, records `touchStartY`, `touchStartX`, `lastTouchY = touchStartY`, `lastTouchTime = Date.now()`, `touchVelocityY = 0`, `isDragging = false`, `accumulatedDeltaY = 0`.
  - `handleTouchMove`:
    - Separates `totalDeltaY = touchStartY - currentY` / `totalDeltaX = touchStartX - currentX` (for the 8px drag threshold and `-25px` swipe-down keyboard dismiss) from `frameDeltaY = lastTouchY - currentY` (for smooth scrolling and velocity tracking).
    - Calls `if (e.cancelable) e.preventDefault()` on single-finger touchmove so mobile browsers never hijack the gesture during the initial 8px movement.
    - Once `isDragging` is true, updates `touchVelocityY = computeTouchVelocity(touchVelocityY, frameDeltaY, dt)` and steps lines via `stepTouchScrollLines(accumulatedDeltaY + frameDeltaY, getTouchLineHeight())`, calling `term.scrollLines(linesToScroll)` when `linesToScroll !== 0`.
  - `handleTouchEnd`:
    - If `isDragging` and `Date.now() - lastTouchMoveTime < 80` and `Math.abs(touchVelocityY) >= 0.15`, starts a `requestAnimationFrame` momentum loop that advances `stepMomentumVelocity`, accumulates `velocity * dt`, calls `term.scrollLines(linesToScroll)`, and stops automatically when velocity reaches `0` or the buffer hits top (`viewportY <= 0 && linesToScroll < 0`) or bottom (`viewportY >= baseY && linesToScroll > 0`).
  - Canvas wrapper `div` and `terminalContainerRef` `div`: set `touchAction: 'none'` on mobile (`isSelectMode || isMobile ? 'none' : 'pan-y'`) so mobile browser native pan-y never competes with the terminal touch scroller.

- [x] **Step 1: Write the failing tests in `tests/terminalTouchScroll.test.ts`**

Expand `tests/terminalTouchScroll.test.ts` to verify:
1. `WebTerminalView.tsx` imports and uses `stepTouchScrollLines`, `computeTouchVelocity`, and `stepMomentumVelocity`.
2. `handleTouchStart` cancels any in-flight momentum animation (`stopMomentumScroll()`).
3. `handleTouchEnd` initiates a `requestAnimationFrame` momentum scroll loop when releasing a swipe with velocity, and stops at buffer boundaries.
4. Mobile canvas container sets `touchAction` to `'none'` when `isMobile` is active so native browser pan-y does not hijack touch scrolling.

```typescript
  test('implements kinetic momentum scrolling and cancels on touchstart', () => {
    expect(content).toContain('computeTouchVelocity');
    expect(content).toContain('stepMomentumVelocity');
    expect(content).toContain('stepTouchScrollLines');
    expect(content).toContain('stopMomentumScroll');
  });

  test('prevents browser pan-y gesture hijacking on mobile terminal canvas', () => {
    expect(content).toContain("touchAction: isSelectMode || isMobile ? 'none' : 'pan-y'");
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalTouchScroll.test.ts`
Expected: FAIL — `WebTerminalView.tsx` does not yet contain `computeTouchVelocity`, `stepMomentumVelocity`, or `touchAction: isSelectMode || isMobile ? 'none' : 'pan-y'`.

- [x] **Step 3: Implement smooth touch tracking, momentum loop, and `touchAction` lock in `frontend/src/components/WebTerminalView.tsx`**

Update `frontend/src/components/WebTerminalView.tsx` with:
1. Import `stepTouchScrollLines`, `computeTouchVelocity`, `stepMomentumVelocity` from `../utils/terminalScrollHelper`.
2. In the xterm `useEffect` touch section:
   - Add `momentumRaf`, `stopMomentumScroll()`, `getTouchLineHeight()`, `lastTouchY`, `lastTouchMoveTime`, `touchVelocityY`.
   - Update `handleTouchStart`, `handleTouchMove`, `handleTouchEnd`, and also register `touchcancel` to clean up state.
   - Call `stopMomentumScroll()` inside the `useEffect` cleanup function.
3. Update the xterm canvas wrapper `style.touchAction` to `isSelectMode || isMobile ? 'none' : 'pan-y'`.

- [x] **Step 4: Run targeted test suites to verify all pass**

Run: `npm test -- tests/terminalTouchScroll.test.ts tests/terminalScrollHelper.test.ts tests/terminalMobileKeyboard.test.ts tests/terminalCopyOnSelectAndTouchFix.test.ts tests/terminalMobileSelection.test.ts`
Expected: PASS on all 5 test suites.

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/WebTerminalView.tsx tests/terminalTouchScroll.test.ts
git commit -m "feat(frontend): add kinetic momentum scrolling and fix mobile touch-action conflict"
```
