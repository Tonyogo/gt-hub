export interface KeyboardOffsetResult {
  isKeyboardShowing: boolean;
  translateY: number;
}

/**
 * Calculates whether the virtual keyboard is open and how much translateY
 * needs to be applied to push content upwards like a messaging app.
 * Requires `isInputFocused` to prevent false positives from mobile browser chrome.
 */
export function calculateKeyboardTranslateY({
  baseHeight,
  viewportHeight,
  offsetTop = 0,
  isInputFocused = true,
}: {
  baseHeight: number;
  viewportHeight: number;
  offsetTop?: number;
  isInputFocused?: boolean;
}): KeyboardOffsetResult {
  if (baseHeight <= 0 || viewportHeight <= 0) {
    return { isKeyboardShowing: false, translateY: 0 };
  }

  const rawDiff = baseHeight - viewportHeight;
  // Threshold: keyboard height is typically >= 150px or >= 18% of screen height
  const threshold = Math.min(150, baseHeight * 0.18);
  const isKeyboardShowing = isInputFocused && rawDiff > threshold;

  if (!isKeyboardShowing) {
    return { isKeyboardShowing: false, translateY: 0 };
  }

  const translateY = Math.max(0, rawDiff - (offsetTop || 0));
  return {
    isKeyboardShowing: true,
    translateY,
  };
}

/**
 * Determines whether the terminal should suppress pty resize and fitAddon.fit()
 * to prevent jarring terminal re-flows when the mobile virtual keyboard toggles.
 */
export function shouldBlockPtyResize({
  baseWidth,
  currentWidth,
  isKeyboardShowing,
  isMobile,
  standalone = true,
  isInputFocused = true,
}: {
  baseWidth: number;
  currentWidth: number;
  isKeyboardShowing: boolean;
  isMobile: boolean;
  standalone?: boolean;
  isInputFocused?: boolean;
}): boolean {
  if (!isMobile || !standalone || !isInputFocused) {
    return false;
  }

  // If width changes significantly (e.g. device rotation between portrait and landscape), allow resize
  if (Math.abs(currentWidth - baseWidth) > 20) {
    return false;
  }

  // While keyboard is showing on mobile, block PTY resize
  return isKeyboardShowing;
}
