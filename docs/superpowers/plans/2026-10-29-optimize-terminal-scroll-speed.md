# Terminal Alternate-Screen Scroll Speed Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate overly fast page-jumping during mouse wheel, trackpad, and mobile touch scrolling in alternate-screen TUI applications (such as Claude Code).

**Architecture:** We add a stateful/pure scroll-pacing helper `stepAlternateScreenScroll` in `frontend/src/utils/terminalScrollHelper.ts` that normalizes `WheelEvent` / touch pixel deltas, resets on direction reversals or idle gaps (`> 250ms`), uses line-by-line SGR mouse wheel sequences (`\x1b[<64;1;1M` / `\x1b[<65;1;1M`) every `40px` when terminal mouse tracking is active, and enforces a `160px` threshold + `120ms` cooldown when falling back to full-page `PageUp` / `PageDown` (`\x1b[5~` / `\x1b[6~`). On mobile touch in alternate screen mode, we also disable post-release kinetic momentum so lifting the finger stops scrolling immediately.

**Tech Stack:** TypeScript, React 18, `@xterm/xterm`, Jest.

**Spec:** In-chat root-cause analysis and scroll pacing design (2026-10-29).

## Global Constraints

- Preserve all existing unit and integration tests in `tests/terminalScrollHelper.test.ts`, `tests/terminalClaudeScrollback.test.ts`, and `tests/terminalTouchScroll.test.ts`.
- Normal buffer (`term.buffer.active.type !== 'alternate'`) wheel and touch scrolling behavior must remain completely unchanged.
- Always run targeted Jest test files (`npm test -- tests/<file>.test.ts`) during iterative development.

## Review Focus

1. **High-frequency trackpad micro-deltas (`deltaY = 1..5px` at 60Hz):** Must accumulate across events until reaching threshold (`40px` for SGR wheel line scroll, `160px` for `PageUp`/`PageDown`) rather than firing on every `wheel` event.
2. **Direction reversal during scroll:** Switching from scroll-up (`deltaY < 0`) to scroll-down (`deltaY > 0`) must immediately reset the opposite direction's remainder so the new direction responds without lag.
3. **Cooldown enforcement for `PageUp` / `PageDown` fallback:** A single strong flick must not emit multiple full-page jumps within `120ms`; excess delta during cooldown is clamped/discarded.
4. **Wheel `deltaMode` normalization:** `DOM_DELTA_LINE (1)` (`* 20px`) and `DOM_DELTA_PAGE (2)` (`* 160px`) must be normalized to pixel equivalents before threshold calculation.
5. **Mobile touch lift-off momentum in alternate screen:** Lifting the finger in `alternate` buffer mode must stop immediately without starting `startMomentumScroll`.

---

### Task 1: Add `stepAlternateScreenScroll` Pacing Helper in `terminalScrollHelper.ts`

**Files:**
- Modify: `frontend/src/utils/terminalScrollHelper.ts`
- Test: `tests/terminalScrollHelper.test.ts`

**Interfaces:**
- Produces in `frontend/src/utils/terminalScrollHelper.ts`:
  ```ts
  export interface AlternateScrollState {
    accumulatedPx: number;
    lastEventTimeMs: number;
    lastDispatchTimeMs: number;
  }

  export interface StepAlternateScrollOptions {
    state: AlternateScrollState;
    deltaY: number;
    deltaMode?: number;
    nowMs: number;
    mouseTrackingActive?: boolean;
    lineThresholdPx?: number;      // default 40
    pageThresholdPx?: number;      // default 160
    pageCooldownMs?: number;       // default 120
    idleResetMs?: number;          // default 250
    maxLineStepsPerEvent?: number; // default 3
  }

  export interface StepAlternateScrollResult {
    payload: string | null;
    nextState: AlternateScrollState;
  }

  export function normalizeWheelDeltaToPx(deltaY: number, deltaMode?: number): number;
  export function stepAlternateScreenScroll(options: StepAlternateScrollOptions): StepAlternateScrollResult;
  ```

- [x] **Step 1: Write the failing unit tests in `tests/terminalScrollHelper.test.ts`**

Add a `describe('stepAlternateScreenScroll', ...)` block in `tests/terminalScrollHelper.test.ts` testing:
1. Micro trackpad deltas (`deltaY = -15` three times) in `mouseTrackingActive: false` mode do NOT emit `\x1b[5~` until total accumulated delta reaches `-160px`.
2. When `mouseTrackingActive: false`, once `\x1b[5~` is dispatched at `t = 1000`, another `-200px` event at `t = 1050` (within `120ms` cooldown) returns `payload: null` and resets `accumulatedPx` to `0`.
3. When `mouseTrackingActive: true`, a `-45px` delta emits `\x1b[<64;1;1M` (SGR wheel up) and a `+90px` delta emits two SGR wheel down sequences `\x1b[<65;1;1M\x1b[<65;1;1M` (capped at `maxLineStepsPerEvent = 3`).
4. Reversing scroll direction or pausing longer than `idleResetMs (250ms)` resets stale `accumulatedPx` before accumulating the new delta.
5. `normalizeWheelDeltaToPx` converts `deltaMode === 1` (`* 20`) and `deltaMode === 2` (`* 160`).

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: FAIL (`stepAlternateScreenScroll` is not defined).

- [x] **Step 3: Implement `normalizeWheelDeltaToPx` and `stepAlternateScreenScroll` in `frontend/src/utils/terminalScrollHelper.ts`**

Implement the functions according to the interfaces above:
- `normalizeWheelDeltaToPx(deltaY, deltaMode = 0)`: returns `0` if non-finite; multiplies by `20` when `deltaMode === 1`, by `160` when `deltaMode === 2`, else `1`.
- `stepAlternateScreenScroll`:
  - Normalize `deltaPx = normalizeWheelDeltaToPx(deltaY, deltaMode)`.
  - If `deltaPx === 0`, return `{ payload: null, nextState: state }`.
  - Reset `baseAccum = (nowMs - state.lastEventTimeMs > idleResetMs || state.accumulatedPx * deltaPx < 0) ? 0 : state.accumulatedPx`.
  - Set `totalPx = baseAccum + deltaPx`.
  - If `mouseTrackingActive`:
    - `threshold = lineThresholdPx` (`40`).
    - If `Math.abs(totalPx) < threshold`, return `{ payload: null, nextState: { accumulatedPx: totalPx, lastEventTimeMs: nowMs, lastDispatchTimeMs: state.lastDispatchTimeMs } }`.
    - Compute `rawSteps = Math.trunc(totalPx / threshold)`, `remainder = totalPx - rawSteps * threshold`, `clampedSteps = Math.min(maxLineStepsPerEvent, Math.abs(rawSteps))`.
    - Sequence per step: `rawSteps < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M'`.
    - Return `{ payload: seq.repeat(clampedSteps), nextState: { accumulatedPx: remainder, lastEventTimeMs: nowMs, lastDispatchTimeMs: nowMs } }`.
  - If `!mouseTrackingActive` (`PageUp` / `PageDown` fallback):
    - `threshold = pageThresholdPx` (`160`).
    - If `Math.abs(totalPx) < threshold`, return `{ payload: null, nextState: { accumulatedPx: totalPx, lastEventTimeMs: nowMs, lastDispatchTimeMs: state.lastDispatchTimeMs } }`.
    - If `state.lastDispatchTimeMs > 0 && nowMs - state.lastDispatchTimeMs < pageCooldownMs`, return `{ payload: null, nextState: { accumulatedPx: 0, lastEventTimeMs: nowMs, lastDispatchTimeMs: state.lastDispatchTimeMs } }`.
    - Sequence: `totalPx < 0 ? '\x1b[5~' : '\x1b[6~'`.
    - Return `{ payload: seq, nextState: { accumulatedPx: 0, lastEventTimeMs: nowMs, lastDispatchTimeMs: nowMs } }`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/terminalScrollHelper.test.ts`
Expected: PASS.

---

### Task 2: Integrate Paced Alternate-Screen Scrolling in `WebTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/WebTerminalView.tsx:40-55,895-920,1245-1265,1550-1565`
- Modify: `tests/terminalClaudeScrollback.test.ts`

**Interfaces:**
- Consumes: `stepAlternateScreenScroll`, `AlternateScrollState` from `../utils/terminalScrollHelper`
- Modifies:
  - `WebTerminalView.tsx`:
    - Uses `altWheelStateRef` (`AlternateScrollState`) inside `term.attachCustomWheelEventHandler` and `applyScrollDelta`.
    - Checks `const mouseTrackingActive = Boolean(term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none');`.
    - Disables post-lift `startMomentumScroll` in `handleTouchEnd` when `term.buffer?.active?.type === 'alternate'`.

- [x] **Step 1: Update test assertions in `tests/terminalClaudeScrollback.test.ts`**

Update `tests/terminalClaudeScrollback.test.ts` to assert:
1. `WebTerminalView.tsx` imports and calls `stepAlternateScreenScroll` for both wheel and touch scrolling in alternate screen mode.
2. `handleTouchEnd` skips `startMomentumScroll` when `term.buffer?.active?.type === 'alternate'`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalClaudeScrollback.test.ts`
Expected: FAIL (`stepAlternateScreenScroll` not yet used in `WebTerminalView.tsx`).

- [x] **Step 3: Update `frontend/src/components/WebTerminalView.tsx`**

1. Import `stepAlternateScreenScroll, AlternateScrollState` from `../utils/terminalScrollHelper`.
2. Inside the xterm initialization `useEffect`:
   - Declare `let altScrollState: AlternateScrollState = { accumulatedPx: 0, lastEventTimeMs: 0, lastDispatchTimeMs: 0 };`.
   - In `term.attachCustomWheelEventHandler((domEvent: WheelEvent) => ...)`:
     ```ts
     if (term.buffer.active.type === 'alternate') {
       const mouseTrackingActive = Boolean(term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none');
       const stepRes = stepAlternateScreenScroll({
         state: altScrollState,
         deltaY: domEvent.deltaY,
         deltaMode: domEvent.deltaMode,
         nowMs: getNow(),
         mouseTrackingActive,
       });
       altScrollState = stepRes.nextState;
       if (stepRes.payload && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
         wsRef.current.send(stepRes.payload);
       }
       return false;
     }
     return true;
     ```
   - In `applyScrollDelta(deltaPx: number)`:
     ```ts
     if (term.buffer?.active?.type === 'alternate') {
       const mouseTrackingActive = Boolean(term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none');
       const stepRes = stepAlternateScreenScroll({
         state: altScrollState,
         deltaY: deltaPx,
         deltaMode: 0,
         nowMs: getNow(),
         mouseTrackingActive,
       });
       altScrollState = stepRes.nextState;
       if (stepRes.payload && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
         wsRef.current.send(stepRes.payload);
       }
       return false;
     }
     ```
   - In `handleTouchEnd`:
     Guard `startMomentumScroll` so it only runs when `term.buffer?.active?.type !== 'alternate'`.

- [x] **Step 4: Run tests and full build to verify**

Run:
- `npm test -- tests/terminalScrollHelper.test.ts tests/terminalClaudeScrollback.test.ts tests/terminalTouchScroll.test.ts`
- `npm run build`
Expected: PASS.
