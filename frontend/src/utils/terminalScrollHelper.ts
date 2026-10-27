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

/**
 * Applies exponential friction decay to momentum velocity over elapsed frame time (dtMs).
 * Snaps to 0 when velocity falls below minVelocity threshold.
 */
export function stepMomentumVelocity(
  velocityPxPerMs: number,
  dtMs = 16,
  friction = 0.95,
  minVelocity = 0.08
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


