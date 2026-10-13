# Browser Fullscreen & Mobile Landscape Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop-only standalone minimize toggle in `UnifiedTerminalView` with a cross-platform browser fullscreen button that automatically locks to landscape orientation on mobile (video player style) and protects the Escape key on desktop.

**Architecture:** Create a dedicated helper `frontend/src/utils/browserFullscreenHelper.ts` encapsulating HTML5 Fullscreen API, `screen.orientation.lock('landscape')` with iOS fallback, and `navigator.keyboard.lock(['Escape'])`. Integrate this helper into `UnifiedTerminalView.tsx` with `fullscreenchange` event subscription, bidirectional state synchronization, and terminal auto-fit on view resize.

**Tech Stack:** TypeScript, React 18, Screen Orientation API, Fullscreen API, Keyboard Lock API, Jest.

**Spec:** In-chat bounded design agreed with user.

## Global Constraints

- Never break non-fullscreen layout or existing WebSocket connection lifecycle.
- Mobile landscape orientation locking must use `screen.orientation.lock('landscape')` wrapped in `.catch(() => {})` for graceful fallback on platforms like iOS Safari.
- Desktop keyboard lock `navigator.keyboard?.lock?.(['Escape'])` must be safely feature-detected and unlocked on exit.
- Fullscreen toggle button must be visible on both mobile and desktop (remove the `!isMobile` restriction).
- Terminal dimensions must automatically recalculate (`terminalRef.current?.fit()`) after fullscreen transition.

## Review Focus

1. Mobile browsers lacking `screen.orientation.lock` (e.g. iOS Safari) must not throw unhandled promise rejections and must cleanly enter browser fullscreen.
2. Exiting fullscreen via native browser gestures (swipe, Esc, browser back) must automatically update `isFullscreen` state via the `fullscreenchange` listener.
3. Desktops without `navigator.keyboard.lock` must gracefully toggle fullscreen without errors.
4. Terminal refitting must be triggered after transition delay to account for mobile viewport animation.
5. All test suites in `tests/` must remain passing.

---

### Task 1: Create Browser Fullscreen Helper (`browserFullscreenHelper.ts`)

**Files:**
- Create: `frontend/src/utils/browserFullscreenHelper.ts`
- Test: `tests/browserFullscreenHelper.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isFullscreenActive(): boolean;
  export function enterBrowserFullscreen(isMobile?: boolean): Promise<void>;
  export function exitBrowserFullscreen(): Promise<void>;
  export function toggleBrowserFullscreen(isMobile?: boolean): Promise<boolean>;
  export function onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void;
  ```

- [x] **Step 1: Write failing tests for browserFullscreenHelper**

Create `tests/browserFullscreenHelper.test.ts`:
```ts
import {
  isFullscreenActive,
  enterBrowserFullscreen,
  exitBrowserFullscreen,
  toggleBrowserFullscreen,
  onFullscreenChange,
} from '../frontend/src/utils/browserFullscreenHelper';

describe('browserFullscreenHelper', () => {
  let originalFullscreenElement: any;
  let requestFullscreenMock: jest.Mock;
  let exitFullscreenMock: jest.Mock;

  beforeEach(() => {
    originalFullscreenElement = (document as any).fullscreenElement;
    requestFullscreenMock = jest.fn().mockResolvedValue(undefined);
    exitFullscreenMock = jest.fn().mockResolvedValue(undefined);

    (document.documentElement as any).requestFullscreen = requestFullscreenMock;
    (document as any).exitFullscreen = exitFullscreenMock;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      writable: true,
      value: null,
    });
  });

  afterEach(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      writable: true,
      value: originalFullscreenElement,
    });
  });

  it('detects fullscreen status accurately', () => {
    expect(isFullscreenActive()).toBe(false);
    (document as any).fullscreenElement = document.documentElement;
    expect(isFullscreenActive()).toBe(true);
  });

  it('calls requestFullscreen on enter and locks orientation on mobile', async () => {
    const lockMock = jest.fn().mockResolvedValue(undefined);
    (global as any).screen = { orientation: { lock: lockMock } };

    await enterBrowserFullscreen(true);
    expect(requestFullscreenMock).toHaveBeenCalled();
    expect(lockMock).toHaveBeenCalledWith('landscape');
  });

  it('gracefully handles orientation.lock failures (e.g. iOS Safari)', async () => {
    const lockMock = jest.fn().mockRejectedValue(new Error('NotSupportedError'));
    (global as any).screen = { orientation: { lock: lockMock } };

    await expect(enterBrowserFullscreen(true)).resolves.not.toThrow();
    expect(requestFullscreenMock).toHaveBeenCalled();
  });

  it('calls keyboard.lock on desktop if available', async () => {
    const keyLockMock = jest.fn().mockResolvedValue(undefined);
    (global as any).navigator = { keyboard: { lock: keyLockMock } };

    await enterBrowserFullscreen(false);
    expect(requestFullscreenMock).toHaveBeenCalled();
    expect(keyLockMock).toHaveBeenCalledWith(['Escape']);
  });

  it('calls exitFullscreen and unlocks orientation and keyboard on exit', async () => {
    (document as any).fullscreenElement = document.documentElement;
    const unlockMock = jest.fn();
    const keyUnlockMock = jest.fn();
    (global as any).screen = { orientation: { unlock: unlockMock } };
    (global as any).navigator = { keyboard: { unlock: keyUnlockMock } };

    await exitBrowserFullscreen();
    expect(exitFullscreenMock).toHaveBeenCalled();
    expect(unlockMock).toHaveBeenCalled();
    expect(keyUnlockMock).toHaveBeenCalled();
  });

  it('subscribes and unregisters fullscreenchange events', () => {
    const cb = jest.fn();
    const cleanup = onFullscreenChange(cb);

    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).toHaveBeenCalledWith(false);

    (document as any).fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).toHaveBeenCalledWith(true);

    cleanup();
    cb.mockClear();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/browserFullscreenHelper.test.ts --detectOpenHandles`
Expected: FAIL with "Cannot find module '../frontend/src/utils/browserFullscreenHelper'"

- [x] **Step 3: Implement browserFullscreenHelper.ts**

Create `frontend/src/utils/browserFullscreenHelper.ts`:
```ts
/**
 * Browser Fullscreen & Mobile Landscape Orientation Helper
 */

export function isFullscreenActive(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    (document as any).msFullscreenElement
  );
}

export async function enterBrowserFullscreen(isMobile?: boolean): Promise<void> {
  if (typeof document === 'undefined') return;

  const docEl = document.documentElement as any;
  if (!isFullscreenActive()) {
    if (docEl.requestFullscreen) {
      await docEl.requestFullscreen();
    } else if (docEl.webkitRequestFullscreen) {
      await docEl.webkitRequestFullscreen();
    } else if (docEl.mozRequestFullScreen) {
      await docEl.mozRequestFullScreen();
    } else if (docEl.msRequestFullscreen) {
      await docEl.msRequestFullscreen();
    }
  }

  // Mobile: Lock to landscape orientation like video playback
  if (isMobile) {
    try {
      if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.lock === 'function') {
        await screen.orientation.lock('landscape').catch(() => {});
      }
    } catch {
      // Ignore NotSupportedError on platforms like iOS Safari
    }
  } else {
    // Desktop: Lock Escape key if supported to avoid conflicting with Vim/Nano
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).keyboard && typeof (navigator as any).keyboard.lock === 'function') {
        await (navigator as any).keyboard.lock(['Escape']).catch(() => {});
      }
    } catch {
      // Ignore unsupported browsers
    }
  }
}

export async function exitBrowserFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;

  if (isFullscreenActive()) {
    const doc = document as any;
    if (doc.exitFullscreen) {
      await doc.exitFullscreen();
    } else if (doc.webkitExitFullscreen) {
      await doc.webkitExitFullscreen();
    } else if (doc.mozCancelFullScreen) {
      await doc.mozCancelFullScreen();
    } else if (doc.msExitFullscreen) {
      await doc.msExitFullscreen();
    }
  }

  // Unlock orientation
  try {
    if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch {}

  // Unlock keyboard
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).keyboard && typeof (navigator as any).keyboard.unlock === 'function') {
      (navigator as any).keyboard.unlock();
    }
  } catch {}
}

export async function toggleBrowserFullscreen(isMobile?: boolean): Promise<boolean> {
  if (isFullscreenActive()) {
    await exitBrowserFullscreen();
    return false;
  } else {
    await enterBrowserFullscreen(isMobile);
    return true;
  }
}

export function onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};

  const handler = () => {
    callback(isFullscreenActive());
  };

  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
  document.addEventListener('mozfullscreenchange', handler);
  document.addEventListener('MSFullscreenChange', handler);

  return () => {
    document.removeEventListener('fullscreenchange', handler);
    document.removeEventListener('webkitfullscreenchange', handler);
    document.removeEventListener('mozfullscreenchange', handler);
    document.removeEventListener('MSFullscreenChange', handler);
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/browserFullscreenHelper.test.ts --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/utils/browserFullscreenHelper.ts tests/browserFullscreenHelper.test.ts
git commit -m "feat(frontend): create browserFullscreenHelper with mobile landscape and desktop keyboard lock

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Integrate Browser Fullscreen in UnifiedTerminalView

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:210-230, 430-460`
- Test: `tests/terminalUnifiedTopBarControls.test.ts`
- Test: `tests/terminalFullscreenReuse.test.ts`

**Interfaces:**
- Consumes: `browserFullscreenHelper.ts`
- Produces: Universal browser fullscreen toggle on mobile and desktop top bar with dynamic icon (`Maximize2` / `Minimize2`).

- [x] **Step 1: Write integration test assertions**

Update `tests/terminalUnifiedTopBarControls.test.ts` to assert that:
- `UnifiedTerminalView` imports `toggleBrowserFullscreen`, `isFullscreenActive`, `onFullscreenChange`.
- The fullscreen button is rendered without being wrapped in `!isMobile`.
- Fullscreen button toggles browser fullscreen and updates icon based on `isBrowserFullscreen`.

Update `tests/terminalFullscreenReuse.test.ts` line 42 to expect `isBrowserFullscreen` or `handleFullscreenToggle`.

- [x] **Step 2: Run tests to verify failure**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts tests/terminalFullscreenReuse.test.ts --detectOpenHandles`
Expected: FAIL

- [x] **Step 3: Update UnifiedTerminalView.tsx**

1. Import from `../utils/browserFullscreenHelper`:
   ```ts
   import {
     isFullscreenActive,
     toggleBrowserFullscreen,
     onFullscreenChange,
   } from '../utils/browserFullscreenHelper';
   ```
2. Add state and effect:
   ```ts
   const [isBrowserFullscreen, setIsBrowserFullscreen] = useState<boolean>(() => isFullscreenActive());

   useEffect(() => {
     return onFullscreenChange((active) => {
       setIsBrowserFullscreen(active);
       setTimeout(() => {
         terminalRef.current?.fit(true);
       }, 150);
     });
   }, []);
   ```
3. Update `handleFullscreenToggle`:
   ```ts
   const handleFullscreenToggle = useCallback(() => {
     toggleBrowserFullscreen(isMobile).catch(() => {});
   }, [isMobile]);
   ```
4. Update the toggle button JSX (remove `{!isMobile && (...) }` container so it shows on all devices):
   ```tsx
   {/* Fullscreen Toggle (All devices, landscape mode on mobile) */}
   <button
     type="button"
     data-testid="fullscreen-toggle-btn"
     onClick={handleFullscreenToggle}
     className={`p-1 sm:p-1.5 rounded-lg border transition-all ${
       isBrowserFullscreen
         ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
         : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
     }`}
     title={isBrowserFullscreen ? t('webTerminal.exitFullscreen') : t('webTerminal.fullscreen')}
   >
     {isBrowserFullscreen ? <Minimize2 className="w-3.5 h-3.5 text-indigo-400" /> : <Maximize2 className="w-3.5 h-3.5" />}
   </button>
   ```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts tests/terminalFullscreenReuse.test.ts --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/UnifiedTerminalView.tsx tests/terminalUnifiedTopBarControls.test.ts tests/terminalFullscreenReuse.test.ts
git commit -m "feat(frontend): integrate browser fullscreen and mobile landscape mode into UnifiedTerminalView

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Full Verification & Build Validation

**Files:**
- All project files.

- [x] **Step 1: Run all test suites**

Run: `npm test`
Expected: 112+ test suites PASS with 0 failures.

- [x] **Step 2: Run production build**

Run: `npm run build`
Expected: Clean build of frontend Vite bundle, backend TypeScript, and CLI executable.

- [x] **Step 3: Commit any lingering build configs**

```bash
git commit -m "chore: verify full test suite and build for browser fullscreen feature

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
