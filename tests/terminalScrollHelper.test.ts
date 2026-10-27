import {
  isUserAtBottom,
  shouldScrollToBottom,
  scrollToBottomSafe,
  stepTouchScrollLines,
  computeTouchVelocity,
  stepMomentumVelocity,
  applyViewportTouchScrollDelta,
} from '../frontend/src/utils/terminalScrollHelper';

describe('terminalScrollHelper', () => {
  describe('isUserAtBottom', () => {
    it('returns true when viewportY === baseY (at the bottom line)', () => {
      const mockTerm = {
        buffer: {
          active: {
            viewportY: 100,
            baseY: 100,
            type: 'normal',
          },
        },
      };
      expect(isUserAtBottom(mockTerm)).toBe(true);
    });

    it('returns false when viewportY < baseY (scrolled up into history)', () => {
      const mockTerm = {
        buffer: {
          active: {
            viewportY: 50,
            baseY: 100,
            type: 'normal',
          },
        },
      };
      expect(isUserAtBottom(mockTerm)).toBe(false);
    });

    it('returns true when buffer type is alternate (e.g. vim/htop)', () => {
      const mockTerm = {
        buffer: {
          active: {
            viewportY: 0,
            baseY: 10,
            type: 'alternate',
          },
        },
      };
      expect(isUserAtBottom(mockTerm)).toBe(true);
    });

    it('returns true safely if term or buffer is null/undefined', () => {
      expect(isUserAtBottom(null)).toBe(true);
      expect(isUserAtBottom(undefined)).toBe(true);
      expect(isUserAtBottom({} as any)).toBe(true);
    });

    it('returns true when viewportY is within the tolerance threshold of baseY', () => {
      const mockTerm = {
        buffer: {
          active: {
            viewportY: 99,
            baseY: 100,
            type: 'normal',
          },
        },
      };
      // Default threshold is 1 line tolerance
      expect(isUserAtBottom(mockTerm, 1)).toBe(true);
      expect(isUserAtBottom(mockTerm, 0)).toBe(false);
    });

    it('returns false when viewportY is beyond threshold from baseY', () => {
      const mockTerm = {
        buffer: {
          active: {
            viewportY: 90,
            baseY: 100,
            type: 'normal',
          },
        },
      };
      expect(isUserAtBottom(mockTerm, 2)).toBe(false);
    });
  });

  describe('shouldScrollToBottom', () => {
    it('returns false when bufferType is alternate even during replay', () => {
      expect(
        shouldScrollToBottom({
          isReplaying: true,
          wasAtBottom: true,
          bufferType: 'alternate',
        })
      ).toBe(false);
    });

    it('returns true during replay even if user was previously scrolled up', () => {
      expect(
        shouldScrollToBottom({
          isReplaying: true,
          wasAtBottom: false,
          bufferType: 'normal',
        })
      ).toBe(true);
    });

    it('returns true when user was at bottom and replay is false', () => {
      expect(
        shouldScrollToBottom({
          isReplaying: false,
          wasAtBottom: true,
          bufferType: 'normal',
        })
      ).toBe(true);
    });

    it('returns false when user scrolled up and replay is false', () => {
      expect(
        shouldScrollToBottom({
          isReplaying: false,
          wasAtBottom: false,
          bufferType: 'normal',
        })
      ).toBe(false);
    });
  });

  describe('scrollToBottomSafe', () => {
    let originalRaf: any;

    beforeEach(() => {
      originalRaf = (global as any).requestAnimationFrame;
    });

    afterEach(() => {
      (global as any).requestAnimationFrame = originalRaf;
    });

    it('calls scrollToBottom and executes requestAnimationFrame for normal buffer', () => {
      const scrollToBottom = jest.fn();
      let rafCallback: (() => void) | null = null;
      (global as any).requestAnimationFrame = jest.fn((cb) => {
        rafCallback = cb;
        return 1;
      });

      const mockTerm = {
        scrollToBottom,
        buffer: {
          active: {
            viewportY: 50,
            baseY: 100,
            type: 'normal',
          },
        },
      };

      scrollToBottomSafe(mockTerm);
      expect(scrollToBottom).toHaveBeenCalledTimes(1);
      expect((global as any).requestAnimationFrame).toHaveBeenCalledTimes(1);

      if (rafCallback) {
        (rafCallback as () => void)();
      }
      expect(scrollToBottom).toHaveBeenCalledTimes(2);
    });

    it('does nothing if buffer is alternate', () => {
      const scrollToBottom = jest.fn();
      const mockTerm = {
        scrollToBottom,
        buffer: {
          active: {
            viewportY: 0,
            baseY: 0,
            type: 'alternate',
          },
        },
      };

      scrollToBottomSafe(mockTerm);
      expect(scrollToBottom).not.toHaveBeenCalled();
    });

    it('handles null/undefined gracefully', () => {
      expect(() => scrollToBottomSafe(null)).not.toThrow();
      expect(() => scrollToBottomSafe(undefined)).not.toThrow();
    });
  });

  describe('mobile touch momentum & step helpers', () => {
    it('stepTouchScrollLines extracts integer lines and preserves sub-line pixel remainder', () => {
      const step1 = stepTouchScrollLines(10, 16);
      expect(step1).toEqual({ linesToScroll: 0, remainderDeltaY: 10 });

      const step2 = stepTouchScrollLines(step1.remainderDeltaY + 12, 16);
      expect(step2).toEqual({ linesToScroll: 1, remainderDeltaY: 6 });

      const stepNeg = stepTouchScrollLines(-35, 15);
      expect(stepNeg).toEqual({ linesToScroll: -2, remainderDeltaY: -5 });

      // Edge cases: non-finite or non-positive lineHeight
      expect(stepTouchScrollLines(20, 0)).toEqual({ linesToScroll: 1, remainderDeltaY: 4 });
      expect(stepTouchScrollLines(NaN, 16)).toEqual({ linesToScroll: 0, remainderDeltaY: 0 });
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
      const v = 2.0;
      const nextV = stepMomentumVelocity(v, 16);
      expect(nextV).toBeLessThan(v);
      expect(nextV).toBeGreaterThan(0);

      // Below minimum threshold snaps to 0
      expect(stepMomentumVelocity(0.05, 16)).toBe(0);
      expect(stepMomentumVelocity(-0.05, 16)).toBe(0);
    });

    it('applyViewportTouchScrollDelta drives viewportEl.scrollTop directly without sub-line transform offset and preserves fractional remainder', () => {
      let internalScrollTop = 160;
      const viewportEl = {
        get scrollTop() {
          return internalScrollTop;
        },
        set scrollTop(v: number) {
          // Simulate browser integer truncation on scrollTop assignment
          internalScrollTop = Math.trunc(v);
        },
        scrollHeight: 1600,
        clientHeight: 400,
      };

      const res1 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 0.6,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(res1.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(160);
      expect(res1.subLineOffsetPx).toBe(0);
      expect(res1.remainderDeltaY).toBeCloseTo(0.6, 5);
      expect(res1.hitBoundary).toBe(false);

      const res2 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 0.7,
        lineHeight: 16,
        accumulatedDeltaY: res1.remainderDeltaY,
      });
      expect(res2.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(161);
      expect(res2.subLineOffsetPx).toBe(0);
      expect(res2.remainderDeltaY).toBeCloseTo(0.3, 5);
    });

    it('applyViewportTouchScrollDelta clamps at top and bottom boundaries and reports hitBoundary', () => {
      let internalScrollTop = 4;
      const viewportEl = {
        get scrollTop() {
          return internalScrollTop;
        },
        set scrollTop(v: number) {
          internalScrollTop = Math.trunc(v);
        },
        scrollHeight: 1600,
        clientHeight: 400,
      };
      const topRes = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: -20,
        lineHeight: 16,
      });
      expect(topRes.usedNativeScrollTop).toBe(true);
      expect(viewportEl.scrollTop).toBe(0);
      expect(topRes.hitBoundary).toBe(true);
      expect(topRes.subLineOffsetPx).toBe(0);
      expect(topRes.remainderDeltaY).toBe(0);

      viewportEl.scrollTop = 1195; // maxScrollTop = 1200
      const bottomRes = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 20,
        lineHeight: 16,
      });
      expect(viewportEl.scrollTop).toBe(1200);
      expect(bottomRes.hitBoundary).toBe(true);
      expect(bottomRes.subLineOffsetPx).toBe(0);
      expect(bottomRes.remainderDeltaY).toBe(0);
    });

    it('applyViewportTouchScrollDelta falls back to stepTouchScrollLines when viewportEl is not scrollable', () => {
      const unscrollableViewport = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
      const fallbackRes = applyViewportTouchScrollDelta({
        viewportEl: unscrollableViewport,
        deltaY: 20,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(fallbackRes.usedNativeScrollTop).toBe(false);
      expect(fallbackRes.linesToScroll).toBe(1);
      expect(fallbackRes.remainderDeltaY).toBe(4);
    });
  });
});
