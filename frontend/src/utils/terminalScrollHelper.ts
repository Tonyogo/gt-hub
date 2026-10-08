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

/**
 * Safely scrolls terminal to bottom with dual-phase sync (immediate + requestAnimationFrame)
 * ensuring layout reflow / flexbox expansion clamps do not truncate the scroll position.
 */
export function scrollToBottomSafe(term: TerminalLike | null | undefined): void {
  if (!term || typeof term.scrollToBottom !== 'function') {
    return;
  }
  if (term.buffer?.active?.type === 'alternate') {
    return;
  }

  term.scrollToBottom();

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
  if (raf) {
    raf(() => {
      if (term && term.buffer?.active?.type !== 'alternate' && typeof term.scrollToBottom === 'function') {
        term.scrollToBottom();
      }
    });
  }
}
