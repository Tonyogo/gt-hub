export interface MagnifierPosition {
  x: number;
  y: number;
  isFlippedBelow: boolean;
}

export interface MagnifierTextSlice {
  textBefore: string;
  focusChar: string;
  textAfter: string;
}

/**
 * Calculates the coordinates and vertical orientation for the touch magnifier bubble.
 * Position flips below the finger when approaching the top edge to avoid navigation bar clipping.
 */
export function calculateMagnifierPosition(
  clientX: number,
  clientY: number,
  screenWidth: number
): MagnifierPosition {
  const isFlippedBelow = clientY < 95;
  const y = isFlippedBelow ? clientY + 45 : Math.max(10, clientY - 60);

  // Clamping: minimum half bubble width (90px) from left and right edges
  const minX = 90;
  const maxX = Math.max(minX, screenWidth - 90);
  const x = Math.max(minX, Math.min(maxX, clientX));

  return { x, y, isFlippedBelow };
}

/**
 * Extracts a balanced slice of text surrounding the focused column from a terminal line.
 */
export function extractMagnifierSlice(
  lineText: string,
  col: number,
  radius: number = 6
): MagnifierTextSlice {
  if (!lineText || col < 0 || col >= lineText.length) {
    return {
      textBefore: '',
      focusChar: ' ',
      textAfter: '',
    };
  }

  const focusChar = lineText[col] || ' ';
  const startIdx = Math.max(0, col - radius);
  const endIdx = Math.min(lineText.length, col + 1 + radius);

  const textBefore = lineText.slice(startIdx, col);
  const textAfter = lineText.slice(col + 1, endIdx);

  return {
    textBefore,
    focusChar,
    textAfter,
  };
}
