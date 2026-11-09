# Mobile TUI SGR Mouse Tap & Jump-to-Bottom Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable mobile single-taps in Alternate Screen TUI applications (such as Claude Code's `Jump to bottom` button) to dispatch SGR mouse click sequences without unintentionally popping up the virtual keyboard.

**Architecture:** Add `encodeSgrMouseTap(col: number, viewportRow: number): string` in `frontend/src/utils/mobileViewportHelper.ts` to format 0-based cell coordinates into 1-based SGR left-click press + release escape sequences (`\x1b[<0;col;rowM\x1b[<0;col;rowm`). Update `handleTouchEnd` in `frontend/src/components/WebTerminalView.tsx` so that when Alternate Screen mouse tracking is active (`term.buffer.active.type === 'alternate' && isRemoteAltScreenRef.current && Boolean(term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none')`), cursor-line keyboard wake-up uses strict `tolerance: 0` (preventing adjacent TUI buttons like `Jump to bottom` from opening the keyboard) and single taps dispatch the SGR mouse tap payload over the active WebSocket.

**Tech Stack:** TypeScript, React 18, xterm.js, Jest

**Spec:** Approved bounded in-chat design (2026-11-09)

## Global Constraints

- Preserve `e.preventDefault()` on single-tap `touchend` events so synthetic browser `mousedown`/`click` events never steal focus or blur the hidden textarea 30ms later.
- Keep default `tolerance = 1` in `isTouchOnCursorLine` for normal shell buffer mode (`bash`/`zsh`), using `tolerance: 0` only when Alternate Screen mouse tracking is active.
- Run Jest tests with `--detectOpenHandles --forceExit`.

## Review Focus

- `encodeSgrMouseTap` must guard against negative or non-finite coordinates by returning `''` and convert 0-based `(col, viewportRow)` to 1-based integer coordinates (`\x1b[<0;${col + 1};${viewportRow + 1}M\x1b[<0;${col + 1};${viewportRow + 1}m`).
- Tapping `Jump to bottom` (1 row above `cursorY` in Claude Code's Alternate Screen TUI) must NOT trigger `textarea.focus()` (`tolerance: 0`) and MUST send the SGR mouse tap sequence over `wsRef.current`.
- Tapping the exact cursor row (`cell.bufferRow === cursorBufferRow`) in Alternate Screen TUI must send the SGR mouse tap sequence AND focus the terminal/textarea to open the mobile keyboard.
- In normal shell buffer mode (`term.buffer.active.type !== 'alternate'`), tapping outside the cursor line must NOT send SGR mouse sequences.

---

### Task 1: Add `encodeSgrMouseTap` Helper and Wire Mobile TUI Single-Tap Dispatch

**Files:**
- Modify: `frontend/src/utils/mobileViewportHelper.ts:74-103`
- Modify: `frontend/src/components/WebTerminalView.tsx:45-55,1615-1645`
- Test: `tests/terminalMobileKeyboard.test.ts`

**Interfaces:**
- Consumes: `isTouchOnCursorLine({ touchBufferRow, cursorBufferRow, tolerance }: CursorLineHitOptions): boolean`
- Produces: `encodeSgrMouseTap(col: number, viewportRow: number): string` in `frontend/src/utils/mobileViewportHelper.ts`

- [x] **Step 1: Write the failing tests in `tests/terminalMobileKeyboard.test.ts`**

Add `encodeSgrMouseTap` to the import from `../frontend/src/utils/mobileViewportHelper` in `tests/terminalMobileKeyboard.test.ts`, and add unit tests asserting:
```ts
describe('Mobile TUI SGR Mouse Tap Helper (encodeSgrMouseTap)', () => {
  test('encodes 0-based cell coordinates into 1-based SGR left-button press and release sequence', () => {
    expect(encodeSgrMouseTap(0, 0)).toBe('\x1b[<0;1;1M\x1b[<0;1;1m');
    expect(encodeSgrMouseTap(14, 22)).toBe('\x1b[<0;15;23M\x1b[<0;15;23m');
  });

  test('truncates fractional coordinates and returns empty string for negative or non-finite inputs', () => {
    expect(encodeSgrMouseTap(4.8, 9.2)).toBe('\x1b[<0;5;10M\x1b[<0;5;10m');
    expect(encodeSgrMouseTap(-1, 5)).toBe('');
    expect(encodeSgrMouseTap(5, -1)).toBe('');
    expect(encodeSgrMouseTap(NaN, 5)).toBe('');
    expect(encodeSgrMouseTap(5, Infinity)).toBe('');
  });

  test('WebTerminalView dispatches SGR mouse tap in alternate screen with mouse tracking and uses tolerance 0 for cursor line', () => {
    const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
    const content = fs.readFileSync(webTerminalPath, 'utf-8');

    expect(content).toMatch(
      /import\s*\{[^}]*encodeSgrMouseTap[^}]*\}\s*from\s*['"]\.\.\/utils\/mobileViewportHelper['"]/
    );

    const singleTapStart = content.indexOf('if (!isDragging && elapsed < 350) {');
    const singleTapEnd = content.indexOf('const handleTouchCancel =', singleTapStart);
    const singleTapBlock = content.slice(singleTapStart, singleTapEnd);

    expect(singleTapBlock).toContain('encodeSgrMouseTap(cell.col, cell.viewportRow)');
    expect(singleTapBlock).toContain('tolerance: isAltMouseTracking ? 0 : 1');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalMobileKeyboard.test.ts`
Expected: FAIL with `encodeSgrMouseTap is not a function`

- [x] **Step 3: Implement `encodeSgrMouseTap` in `frontend/src/utils/mobileViewportHelper.ts` and wire `handleTouchEnd` in `frontend/src/components/WebTerminalView.tsx`**

In `frontend/src/utils/mobileViewportHelper.ts`, export:
```ts
/**
 * Encodes a 0-based terminal viewport cell coordinate (col, viewportRow) into a 1-based
 * SGR (1006) mouse left-click press + release sequence for TUI apps (e.g. Claude Code).
 */
export function encodeSgrMouseTap(col: number, viewportRow: number): string {
  if (!Number.isFinite(col) || !Number.isFinite(viewportRow) || col < 0 || viewportRow < 0) {
    return '';
  }
  const col1 = Math.trunc(col) + 1;
  const row1 = Math.trunc(viewportRow) + 1;
  return `\x1b[<0;${col1};${row1}M\x1b[<0;${col1};${row1}m`;
}
```

In `frontend/src/components/WebTerminalView.tsx`:
1. Import `encodeSgrMouseTap` from `../utils/mobileViewportHelper`.
2. In `handleTouchEnd` inside `if (!isDragging && elapsed < 350)`:
```ts
      if (!isDragging && elapsed < 350) {
        const cell = getCellCoordsFromTouch(touchStartX, touchStartY);
        const cursorBufferRow = (term.buffer.active.baseY || 0) + (term.buffer.active.cursorY || 0);
        const isAltMouseTracking =
          term.buffer?.active?.type === 'alternate' &&
          isRemoteAltScreenRef.current &&
          Boolean(term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none');

        if (isAltMouseTracking && cell && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const sgrTap = encodeSgrMouseTap(cell.col, cell.viewportRow);
          if (sgrTap) {
            wsRef.current.send(sgrTap);
          }
        }

        if (
          cell &&
          isTouchOnCursorLine({
            touchBufferRow: cell.bufferRow,
            cursorBufferRow,
            tolerance: isAltMouseTracking ? 0 : 1,
          })
        ) {
          // Single tap on cursor input line -> Focus terminal & wake on-screen virtual keyboard synchronously.
          // Prevent synthetic mousedown/click 30ms later on canvas from blurring textarea.
          if (e.cancelable) {
            e.preventDefault();
          }
          term.focus();
          const textarea = container?.querySelector('textarea');
          if (textarea) {
            textarea.focus({ preventScroll: true });
          }
          isTouchScrollingActiveRef.current = false;
        } else {
          // Tapped outside cursor input line on mobile: suppress synthetic click/mousedown focus
          if (e.cancelable) {
            e.preventDefault();
          }
          syncAtBottomAfterTouchScroll();
        }
      }
```

- [x] **Step 4: Run tests and build to verify it passes**

Run: `npm test -- tests/terminalMobileKeyboard.test.ts && npm run build:frontend`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/mobileViewportHelper.ts frontend/src/components/WebTerminalView.tsx tests/terminalMobileKeyboard.test.ts docs/superpowers/plans/2026-11-09-mobile-tui-sgr-tap-fix.md
git commit -m "fix(mobile): dispatch SGR mouse tap in alternate screen TUI for Jump to bottom"
```
