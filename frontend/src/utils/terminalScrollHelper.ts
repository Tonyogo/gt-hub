export interface TerminalLikeBuffer {
  viewportY: number;
  baseY: number;
  type?: string;
}

export interface TerminalLike {
  buffer?: {
    active: TerminalLikeBuffer;
  };
  scrollToBottom?: () => void;
}

export interface ShouldScrollOptions {
  isReplaying?: boolean;
  wasAtBottom?: boolean;
  bufferType?: string;
}

/**
 * Checks if the user is currently at the bottom of the scrollback buffer.
 * If in alternate buffer (like vim, nano, htop), returns true as alternate screens do not have normal scrollback.
 * @param term Terminal instance
 * @param threshold Allowed line tolerance (default: 1 line) for layout/rounding discrepancies
 */
export function isUserAtBottom(term: TerminalLike | null | undefined, threshold = 1): boolean {
  if (!term || !term.buffer || !term.buffer.active) {
    return true;
  }
  const active = term.buffer.active;
  if (active.type === 'alternate') {
    return true;
  }
  return active.viewportY >= Math.max(0, active.baseY - threshold);
}

/**
 * Determines whether the terminal should scroll to bottom given current state.
 * - Always false in alternate screen buffer (protects curses apps).
 * - Always true during connection / session replay.
 * - True if user was already at the bottom.
 * - False if user has manually scrolled up to view historical scrollback.
 */
export function shouldScrollToBottom({
  isReplaying = false,
  wasAtBottom = true,
  bufferType,
}: ShouldScrollOptions): boolean {
  if (bufferType === 'alternate') {
    return false;
  }
  if (isReplaying) {
    return true;
  }
  return wasAtBottom;
}

const pendingRafMap = new WeakMap<TerminalLike, any>();

/**
 * Safely scrolls terminal to bottom with dual-phase sync (immediate + requestAnimationFrame)
 * ensuring layout reflow / flexbox expansion clamps do not truncate the scroll position.
 * Coalesces pending animation frames to avoid flooding the browser scheduler during streaming output.
 */
export function scrollToBottomSafe(term: TerminalLike | null | undefined): void {
  if (!term || typeof term.scrollToBottom !== 'function') {
    return;
  }
  if (term.buffer?.active?.type === 'alternate') {
    return;
  }

  try {
    term.scrollToBottom();
  } catch {}

  const getRaf = () => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame.bind(window);
    }
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).requestAnimationFrame === 'function') {
      return (globalThis as any).requestAnimationFrame;
    }
    return null;
  };

  const raf = getRaf();
  if (raf && !pendingRafMap.has(term)) {
    const handle = raf(() => {
      pendingRafMap.delete(term);
      try {
        if (term && term.buffer?.active?.type !== 'alternate' && typeof term.scrollToBottom === 'function') {
          term.scrollToBottom();
        }
      } catch {}
    });
    pendingRafMap.set(term, handle);
  }
}

export interface TouchScrollStepResult {
  linesToScroll: number;
  remainderDeltaY: number;
}

/**
 * Converts accumulated touch pixel delta into discrete integer terminal lines to scroll
 * and preserves the sub-line pixel remainder for smooth frame-by-frame continuous movement.
 */
export function stepTouchScrollLines(accumulatedDeltaY: number, lineHeight: number): TouchScrollStepResult {
  if (!Number.isFinite(accumulatedDeltaY)) {
    return { linesToScroll: 0, remainderDeltaY: 0 };
  }
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16;
  if (Math.abs(accumulatedDeltaY) < safeLineHeight) {
    return { linesToScroll: 0, remainderDeltaY: accumulatedDeltaY };
  }
  const linesToScroll = Math.trunc(accumulatedDeltaY / safeLineHeight);
  return {
    linesToScroll,
    remainderDeltaY: accumulatedDeltaY - linesToScroll * safeLineHeight,
  };
}

/**
 * Calculates smoothed touch velocity in px/ms using an exponential moving average
 * to avoid abrupt noise while tracking finger flicks.
 */
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

/**
 * Applies exponential friction decay to momentum velocity over elapsed frame time (dtMs).
 * Snaps to 0 when velocity falls below minVelocity threshold.
 */
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

export interface ViewportScrollElementLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ViewportTouchScrollResult {
  usedNativeScrollTop: boolean;
  nextScrollTop: number;
  subLineOffsetPx: number;
  hitBoundary: boolean;
  linesToScroll: number;
  remainderDeltaY: number;
}

/**
 * Applies a touch scroll pixel delta directly to the native xterm viewport scroll position.
 * Mutates viewportEl.scrollTop directly when scrollable content exists, preserving fractional
 * remainder across frames when viewportEl.scrollTop truncates to integer pixels.
 * Falls back to discrete stepTouchScrollLines when viewportEl is absent or not scrollable.
 */
export function applyViewportTouchScrollDelta(options: {
  viewportEl: ViewportScrollElementLike | null | undefined;
  deltaY: number;
  lineHeight: number;
  accumulatedDeltaY?: number;
  syncViewportScrollTop?: boolean;
}): ViewportTouchScrollResult {
  const { viewportEl, deltaY, lineHeight, accumulatedDeltaY = 0, syncViewportScrollTop = true } = options;
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight >= 6 ? lineHeight : 16;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const prevRemainder = Number.isFinite(accumulatedDeltaY) ? (accumulatedDeltaY as number) : 0;
  const totalDeltaY = prevRemainder + safeDeltaY;
  const step = stepTouchScrollLines(totalDeltaY, safeLineHeight);

  if (!syncViewportScrollTop) {
    return {
      usedNativeScrollTop: false,
      nextScrollTop: 0,
      subLineOffsetPx: 0,
      hitBoundary: false,
      linesToScroll: step.linesToScroll,
      remainderDeltaY: step.remainderDeltaY,
    };
  }

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

/**
 * Prevents @xterm/xterm SelectionService from triggering a full-screen DOM rebuild
 * (DomRenderer.handleSelectionChanged -> renderRows(0, rows - 1)) on every scroll event
 * when no selection is active before or after the event.
 * Also suppresses noop core.scrollLines(0, true, 1) fired by Viewport when native scroll
 * stops after _ignoreNextScrollEvent.
 */
export function patchXtermNoopSelectionRefresh(term: any): void {
  const core = term?._core;
  if (!core) {
    return;
  }

  const renderService = core._renderService;
  if (renderService && typeof renderService.handleSelectionChanged === 'function' && !renderService.__noopSelectionPatched) {
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

  if (typeof core.scrollLines === 'function' && !core.__noopViewportScrollPatched) {
    const origScrollLines = core.scrollLines.bind(core);
    core.scrollLines = (disp: number, suppressScrollEvent?: boolean, source?: number) => {
      if (disp === 0 && source === 1) {
        return;
      }
      return origScrollLines(disp, suppressScrollEvent, source);
    };
    core.__noopViewportScrollPatched = true;
  }

  patchXtermTransparentScrollbar(term);
}

/**
 * Hides xterm's side scrollbar reservation (zeroes out the default 15px scrollBarWidth fallback)
 * and keeps .xterm-viewport background transparent even after runtime theme changes.
 */
export function patchXtermTransparentScrollbar(term: any): void {
  const core = term?._core;
  if (!core) return;

  const viewport = core.viewport;
  const viewportEl = core._viewportElement || viewport?._viewportElement;

  if (viewportEl && viewportEl.style) {
    viewportEl.style.backgroundColor = 'transparent';
  }

  if (viewport) {
    viewport.scrollBarWidth = 0;
    if (typeof viewport._handleThemeChange === 'function' && !viewport.__transparentScrollbarPatched) {
      const origHandleThemeChange = viewport._handleThemeChange.bind(viewport);
      viewport._handleThemeChange = (colors: any) => {
        origHandleThemeChange(colors);
        viewport.scrollBarWidth = 0;
        const el = core._viewportElement || viewport._viewportElement;
        if (el && el.style) {
          el.style.backgroundColor = 'transparent';
        }
      };
      viewport.__transparentScrollbarPatched = true;
    }
  }
}

/**
 * Synchronously flushes xterm's Viewport scroll area and RenderDebouncer within the
 * current requestAnimationFrame callback to eliminate the 1-frame nested-rAF lag.
 * Viewport is refreshed first so layout reads (offsetHeight / scrollTop) occur before
 * RenderDebouncer mutates DOM rows, avoiding forced synchronous reflows.
 */
export function flushXtermScrollFrameSync(term: any): void {
  const core = term?._core;
  if (!core) return;
  const cancelRaf =
    core._coreBrowserService?.window?.cancelAnimationFrame?.bind(core._coreBrowserService.window) ||
    (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);

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
}

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

/**
 * Normalizes wheel delta into equivalent pixel distance based on deltaMode:
 * - deltaMode 0 (DOM_DELTA_PIXEL): 1x
 * - deltaMode 1 (DOM_DELTA_LINE): 20px per line
 * - deltaMode 2 (DOM_DELTA_PAGE): 160px per page
 */
export function normalizeWheelDeltaToPx(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }
  if (deltaMode === 1) {
    return deltaY * 20;
  }
  if (deltaMode === 2) {
    return deltaY * 160;
  }
  return deltaY;
}

/**
 * Steps alternate-screen scroll state by accumulating micro-deltas, enforcing cooldowns,
 * and dispatching either line-by-line SGR mouse wheel sequences or PageUp / PageDown keys.
 */
export function stepAlternateScreenScroll(options: StepAlternateScrollOptions): StepAlternateScrollResult {
  const {
    state,
    deltaY,
    deltaMode = 0,
    nowMs,
    mouseTrackingActive = false,
    lineThresholdPx = 40,
    pageThresholdPx = 160,
    pageCooldownMs = 120,
    idleResetMs = 250,
    maxLineStepsPerEvent = 3,
  } = options;

  const deltaPx = normalizeWheelDeltaToPx(deltaY, deltaMode);
  if (deltaPx === 0) {
    return { payload: null, nextState: state };
  }

  const isIdle = state.lastEventTimeMs > 0 && nowMs - state.lastEventTimeMs > idleResetMs;
  const isReversal = state.accumulatedPx * deltaPx < 0;
  const baseAccum = (isIdle || isReversal) ? 0 : state.accumulatedPx;
  const totalPx = baseAccum + deltaPx;

  if (mouseTrackingActive) {
    const threshold = lineThresholdPx;
    if (Math.abs(totalPx) < threshold) {
      return {
        payload: null,
        nextState: {
          accumulatedPx: totalPx,
          lastEventTimeMs: nowMs,
          lastDispatchTimeMs: state.lastDispatchTimeMs,
        },
      };
    }

    const rawSteps = Math.trunc(totalPx / threshold);
    const remainder = totalPx - rawSteps * threshold;
    const clampedSteps = Math.min(maxLineStepsPerEvent, Math.abs(rawSteps));
    const seq = rawSteps < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M';
    return {
      payload: seq.repeat(clampedSteps),
      nextState: {
        accumulatedPx: remainder,
        lastEventTimeMs: nowMs,
        lastDispatchTimeMs: nowMs,
      },
    };
  }

  // Fallback to PageUp / PageDown
  const threshold = pageThresholdPx;
  if (Math.abs(totalPx) < threshold) {
    return {
      payload: null,
      nextState: {
        accumulatedPx: totalPx,
        lastEventTimeMs: nowMs,
        lastDispatchTimeMs: state.lastDispatchTimeMs,
      },
    };
  }

  if (state.lastDispatchTimeMs > 0 && nowMs - state.lastDispatchTimeMs < pageCooldownMs) {
    return {
      payload: null,
      nextState: {
        accumulatedPx: 0,
        lastEventTimeMs: nowMs,
        lastDispatchTimeMs: state.lastDispatchTimeMs,
      },
    };
  }

  const seq = totalPx < 0 ? '\x1b[5~' : '\x1b[6~';
  return {
    payload: seq,
    nextState: {
      accumulatedPx: 0,
      lastEventTimeMs: nowMs,
      lastDispatchTimeMs: nowMs,
    },
  };
}



